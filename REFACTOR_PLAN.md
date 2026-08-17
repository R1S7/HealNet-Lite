# HealNet-Lite — Status Brief & Refactor Plan

**Date:** 2026-08-17
**Scope:** Full codebase audit + a plan to reach a genuinely usable donation-matching site for hospitals and individual donors.

---

## 1. Executive summary

The repository builds and deploys, and the landing page renders. Beyond that, **none of the
product's core loops actually work.** Nobody can create an account, no organization can post a
need, no donation can be submitted, and the matching engine cannot return a valid result. The
dashboard is hardcoded placeholder data.

The build passing is not evidence of health: `vite build` does not typecheck, so 14 type errors —
including the one that breaks registration — ship to production silently.

### Verified check results

| Check | Command | Result |
|---|---|---|
| Production build | `npm run build` | **Passes** (exit 0) — but performs no typechecking |
| Typecheck | `npx tsc --noEmit -p tsconfig.app.json` | **14 errors** |
| Lint | `npm run lint` | **Fails** — 16 errors, 9 warnings |
| Tests | — | **No test framework, no test files, no CI** |
| Runtime (no env vars) | headless Chromium | **White screen** — `Error: supabaseUrl is required` |
| Runtime (env vars set) | headless Chromium | Landing page renders; `Error loading needs` toast on load |

TypeScript strictness is disabled repo-wide (`strict: false`, `strictNullChecks: false`,
`noImplicitAny: false`), which is why a much larger class of defects stays invisible.

---

## 2. Blocking defects

Ordered by severity. Each is verified against the code, the compiler, or the browser.

### P0-1 — Registration is dead on arrival
`src/contexts/AuthContext.tsx:208,225` calls `supabase.auth.user()`, a **Supabase v1 API removed in
v2** (this project uses `@supabase/supabase-js` ^2.50.2). The compiler confirms it:
`Property 'user' does not exist on type 'SupabaseAuthClient'`. Every signup attempt throws.

It is also redundant: the `handle_new_user_registration` database trigger already creates the
organization/donor row from auth metadata. The client-side insert duplicates the trigger and would
double-insert if it worked.

**Nobody can create an account. This alone makes the site unusable.**

### P0-2 — Migrations cannot run from scratch
`npx supabase migration up` on a clean database fails on the first file.

- **Ordering is broken.** `20231222121800_add_donor_support.sql` sorts first and runs
  `ALTER TABLE public.user_auth ADD COLUMN donor_id UUID REFERENCES public.donors(id)` — but
  `user_auth` is created in `20250713215912` and `donors` in `20250101000001`, both *later*.
- **`donors` is created twice**, in two migrations, with **incompatible schemas** (one keyed by
  `email`, one by `user_id`).
- **`donations` and `geocoding_cache` have no `CREATE TABLE` anywhere.** The geospatial migration
  only `ALTER`s `donations`. Application code reads and writes both tables.
- **`user_auth.organization_id` is `NOT NULL`**, but the donor branch of the trigger inserts only
  `donor_id` → constraint violation. Donor signup fails even if P0-1 were fixed.
- **The live database has drifted.** Generated `types.ts` contains a `profiles` table that no
  migration creates. The migrations are not the source of truth, so the environment is not
  reproducible by anyone.

### P0-3 — Two conflicting identity models
The DB trigger writes `donors(email, ...)` linked through `user_auth.donor_id`. The client writes
`donors(user_id, ...)`. `fetchUserData` reads `user_auth`. `Index.tsx` queries a `profiles` table.
Four different notions of "who is this user" coexist. None of them agree.

### P0-4 — Donation submission is wired to nothing
`src/pages/Index.tsx:323` renders `<DonationForm onSubmit={...} loading={...} />`, but
`DonationForm` accepts only `onSuccess` / `redirectOnSuccess`. Compiler-confirmed prop mismatch.

Consequently `Index.handleDonationSubmit` (75 lines, including a query against the nonexistent
`profiles` table) and `Index.findMatches` are **dead code**, and the "Matches Found" tab can never
populate. Meanwhile `DonationForm` performs its own insert against a table with no migration.

### P0-5 — Location input is fake
`DonationForm` offers a dropdown of invented districts — "Downtown District", "Westside", "North
District" — and then feeds those strings to a real geocoder. Nominatim cannot resolve them, so
`quality === 'failed'` and the form throws *"Could not determine the location"* on every submit.

### P0-6 — Organizations have no way to post a need
There is no need-creation form, no need-management view, and no route for either. The `needs` table
and its RLS policies exist; nothing in the UI writes to them. **The entire hospital-side workflow —
the reason a hospital would use this — is absent.**

### P0-7 — The dashboard is a mock
`src/pages/Dashboard.tsx:61-72` hardcodes `upcomingNeeds` and `recentActivities` with 2024 dates.
Three of four action buttons fire *"Feature Coming Soon"* toasts; the fourth has no handler. This is
the page a logged-in hospital lands on.

---

### Security

### P1-1 — Service-role key path in client code
`src/workers/geocodeWorker.ts:15` reads `import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY`. **Every
`VITE_`-prefixed variable is inlined into the public JavaScript bundle.** If anyone ever sets this
variable, a full RLS-bypassing database key is published to every visitor. The code path must be
deleted, not merely left unset.

### P1-2 — Unauthenticated visitors run an infinite DB polling loop
`src/App.tsx:23` gates the geocoding worker on `process.env.NODE_ENV === 'production'`. esbuild
folds this to `true` in production builds — **verified in the shipped bundle** (`Xd(!0)`, i.e.
`useGeocodeWorker(true)`). Every anonymous landing-page visitor therefore starts a permanent 5-second
polling loop against `donations` and `needs`, plus browser-side calls to Nominatim. This is a
denial-of-service vector against your own database and a terms-of-service problem with Nominatim.

### P1-3 — Source maps published to production
`vite.config.ts:25` sets `sourcemap: true`. The build emits 3 `.map` files (~2.1 MB) exposing full
original source.

---

### Correctness

### P2-1 — The matching pipeline cannot return a valid result
Three independent faults, any one of which is fatal:
- The RPC `find_needs_within_radius` filters `n.status = 'active'`, but `needs.status` defaults to
  `'open'` and RLS only exposes `'open'` rows. **The query always returns zero rows.**
- The RPC's return signature omits `lat`, `lng`, `created_at`, and all organization contact fields —
  yet `matchingService.scoreMatch` reads `need.lat` / `need.lng` / `need.created_at`, and
  `DonationMatches` renders `selectedMatch.need.organization.name` / `.email` / `.phone`. If rows
  ever came back, scores would be `NaN` and the details panel would throw.
- `scoreMatch` issues **one Mapbox Directions API call per candidate need** (N+1), from the browser,
  with the token exposed.

### P2-2 — Six Supabase clients
One guarded singleton plus five ad-hoc `createClient()` calls: three at module scope in
`services/`, one in the worker, and one **constructed on every render** in `DonationMatches.tsx:32`.

The module-scope calls throw at *import* time when env vars are missing — which is why the app
white-screens before `client.ts`'s validation can help (verified: `PAGEERROR: Error: supabaseUrl is
required`). Multiple GoTrue clients also contend over the same localStorage auth token.

### P2-3 — Two parallel matching implementations
`Index.findMatches` (0-100 integer scoring, dead code) and `services/matchingService` (0-1 weighted
scoring) implement matching differently and produce incompatible shapes. `MatchResults` consumes the
first, `MatchResultsList` the second.

### P2-4 — Broken navigation and dead files
`DonationMatches.tsx:103` navigates to `/donations`, which is not a registered route → 404.
`src/pages/Register.tsx` (224 lines) is not routed at all and is missing a required `accountType`
field — orphaned duplicate of `OrganizationRegister.tsx`.

---

### Presentation & documentation

### P3-1 — The documentation describes software that does not exist
README and `docs/GEOSPATIAL_MATCHING.md` claim pgvector semantic search, Xenova Transformers
embeddings, WebSocket realtime updates, and a `matches` table. **None of these exist** — no
dependency, no migration, no code. README also links to `LICENSE` and `CONTRIBUTING.md`; neither
file is in the repository.

### P3-2 — Inconsistent, incoherent branding
Login, Register, and Dashboard label the logo `alt="Kids Cancer Foundation Logo"` — a different
organization. Two different logo files are used across pages. The landing page is purple, the auth
pages are orange gradients, and the shared shadcn design tokens are used inconsistently alongside
both. This is the visual incoherence that reads as "AI slop."

### P3-3 — Accessibility gaps
Password show/hide toggles have no `aria-label`. The main tab navigation uses bare `<button>`s with
no `role="tablist"` / `aria-selected`. Toast-only error reporting is not announced to screen readers.

---

## 3. What "usable by hospitals and regular people" actually requires

The current model — donations float free and are speculatively matched — is the wrong primitive.
A hospital does not want an algorithm's opinion; it wants to state a need and see who can fill it.

**The minimum honest product loop:**

| Actor | Flow |
|---|---|
| **Hospital / partner** | register → get verified → post a need → receive offers → accept or decline → mark fulfilled |
| **Donor** | register → browse & search nearby needs → offer an item against a specific need → receive dropoff instructions → confirm handoff |
| **Both** | receive an email when something requires their attention |

This requires one entity the schema does not have: an **`offers`** table (a donor's commitment
against a specific need). That single addition turns a speculative matching demo into a working
marketplace.

---

## 4. The plan

Six phases. Phases 0–3 constitute the real MVP; 4–5 are what make it trustworthy and pleasant.
Estimates assume one focused developer.

### Phase 0 — Make the truth visible *(~0.5 day)*
Nothing else is safe to change until broken code can't pass.

1. Add `vitest` + React Testing Library + `@testing-library/jest-dom`.
2. Add a `typecheck` script; add a GitHub Actions workflow running `typecheck`, `lint`, `test`,
   `build` on every push, blocking merge.
3. Enable `strict` and `strictNullChecks` in `tsconfig.app.json`. Expect new errors — they are the
   point.
4. Remove `sourcemap: true` from the production build.
5. Delete the `define: { 'process.env': ... }` block in `vite.config.ts`; standardize on
   `import.meta.env`.
6. Write the first real tests against the pure functions that already exist and are trivially
   testable: `distanceService.calculateStraightLineDistance` (Haversine) and the six `scoreX`
   methods in `matchingService`.

**Exit criteria:** CI is green on a branch where `tsc`, `eslint`, and `vitest` all pass.

### Phase 1 — One database, one schema *(~1.5 days)*
7. **Squash the five migrations into a single coherent baseline.** The existing history is not
   salvageable and has already diverged from the live database.
8. **Collapse the identity model to one table:** `profiles`, keyed by `auth.users.id`, with a `role`
   column (`'hospital' | 'partner' | 'donor'`) and role-specific nullable columns. Drop `user_auth`
   and the `organizations`/`donors` split. This removes an entire class of join bugs.
9. Baseline schema: `profiles`, `needs`, `offers` *(new)*, `donations`, `geocoding_cache`.
10. Make the `handle_new_user_registration` trigger the **single** source of profile creation.
11. Write RLS policies deliberately, and test each one (donor cannot read another donor's offers; an
    org can only mutate its own needs; anonymous users can read open needs only).
12. Regenerate `types.ts` **from the migrations**, not from the drifted remote project.

**Exit criteria:** `supabase db reset` succeeds on a clean database and the app runs against it.

### Phase 2 — One client, working auth *(~1 day)*
13. Single exported Supabase client. Delete all five ad-hoc `createClient()` calls.
14. Replace the `document.createElement` error banner with a proper React error boundary that fails
    fast and legibly.
15. **Fix registration:** delete the `supabase.auth.user()` inserts entirely and rely on the trigger.
16. Handle the email-confirmation state honestly in the UI — currently the app says "please sign in"
    when Supabase may still be awaiting confirmation.
17. Delete the orphaned `src/pages/Register.tsx`.
18. Tests: register → confirm → login → logout, against a mocked client.

**Exit criteria:** A new hospital account and a new donor account can both be created and signed in.

### Phase 3 — The actual product loop *(~4 days)*
19. **Hospital:** `/needs/new` creation form and `/needs` management list (edit, close, mark
    fulfilled). *This is the missing half of the product.*
20. **Donor:** real `/needs` browse page with text search, category filter, urgency sort, and
    distance sort.
21. **Offers:** "Offer to help" action on a need → creates an `offers` row. Hospital sees offers on
    their need and can accept/decline. Acceptance reveals dropoff instructions to that donor. Both
    parties can mark the handoff complete.
22. **Replace the mock dashboard** with real role-aware data. Delete every "Coming Soon" toast and
    every hardcoded array.
23. **Real address input:** free-text address with geocode-on-blur and a confirmation step. Delete
    the fake district dropdown.
24. Fix the `/donations` dead link.

**Exit criteria:** A hospital posts a need, a donor finds it and offers, the hospital accepts, both
mark it complete — end to end, in a browser, against a real database.

### Phase 4 — Matching, honestly scoped *(~1.5 days)*
25. **Move matching server-side** into one Postgres function returning fully-populated rows:
    category match + text similarity (`pg_trgm`) + PostGIS distance + urgency + recency. One round
    trip instead of N+1.
26. Fix `status = 'active'` → `'open'`; return `lat`, `lng`, `created_at`, and organization contact
    fields.
27. **Delete the browser geocoding worker.** Geocode in a database trigger or Edge Function on
    insert, where the rate limit is controllable and no key is exposed.
28. Drop the per-candidate Mapbox Directions calls. Straight-line distance is already implemented,
    free, and sufficient. Reintroduce driving time later for the *single selected* match only.
29. Delete the dead `Index.findMatches` and consolidate on one match shape.

**Exit criteria:** Matching returns correct, fully-populated results in one query, with unit tests
on the scoring function.

### Phase 5 — Trust and polish *(~2 days)*
30. **Organization verification.** The `verified` flag exists and nothing ever sets it. A hospital
    must not be exposed to unvetted suppliers, and donors must know who is receiving their goods.
    For a healthcare-facing tool this is table stakes, not polish. Add an admin review path.
31. **Email notifications** on offer-received and offer-accepted (Edge Function + a transactional
    email provider).
32. **One design system.** Pick a single palette, apply the shadcn tokens consistently, and remove
    the purple/orange conflict. Fix the "Kids Cancer Foundation" alt text and consolidate to one
    logo.
33. **Accessibility pass:** `aria-label` on icon buttons, proper tablist semantics, live-region error
    announcements, focus management on route change.
34. **Rewrite the documentation to describe what exists.** Remove the pgvector/Xenova/WebSocket
    claims from README and `docs/GEOSPATIAL_MATCHING.md`. Add `LICENSE` and `CONTRIBUTING.md` or
    remove the links.

**Exit criteria:** An outside developer can clone, follow the README, and reach a working local
instance without asking a question.

---

## 5. Recommended sequencing

**Ship Phases 0–3 first.** They convert a demo into a product.

The "intelligent semantic matching" in Phase 4 is the most impressive-sounding part of the codebase
and delivers the least user value today. A hospital procurement officer wants a searchable,
filterable list of nearby people who can supply a specific item. That is Phase 3. Ranking quality
only matters once there is enough supply for ranking to be a real problem.

**Do not skip Phase 0.** Every defect in this brief reached production because `vite build` exits 0
regardless of type errors, and there is no test or CI gate behind it.

### Cut list

Delete rather than repair — each is dead, duplicated, or actively harmful:

| File / code | Reason |
|---|---|
| `src/pages/Register.tsx` | Orphaned duplicate, not routed, doesn't compile |
| `src/workers/geocodeWorker.ts` | Service-role key path + public DoS loop; move server-side |
| `src/hooks/useGeocodeWorker.ts` | Only consumer of the above |
| `Index.handleDonationSubmit`, `Index.findMatches` | Dead code — props never matched |
| `Dashboard` mock arrays + 3 "Coming Soon" handlers | Placeholder content |
| 5 of 6 `createClient()` call sites | Duplicate clients |
| `docs/GEOSPATIAL_MATCHING.md` | Describes unimplemented software |
| All 5 migration files | Unrunnable; replace with a squashed baseline |

---

## 6. Effort summary

| Phase | Focus | Estimate |
|---|---|---|
| 0 | Tests, CI, strict types | 0.5 day |
| 1 | Schema & migrations | 1.5 days |
| 2 | Client & auth | 1 day |
| 3 | **Core product loop** | 4 days |
| 4 | Matching, server-side | 1.5 days |
| 5 | Trust, design, docs | 2 days |
| | **Total** | **~10.5 days** |

Phases 0–3 (**~7 days**) produce a site that hospitals and individuals can genuinely use.
