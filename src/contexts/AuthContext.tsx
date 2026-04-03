import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { User as SupabaseUser, Session } from '@supabase/supabase-js';

export interface Organization {
  id: string;
  email: string;
  organization_name: string;
  contact_person: string;
  phone: string;
  location: string;
  organization_type: 'hospital' | 'partner';
  verified: boolean;
  created_at: string;
  updated_at: string;
}

export interface Donor {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  phone?: string;
  location?: string;
  preferences?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  email: string;
  organization?: Organization;
  donor?: Donor;
  accountType: 'organization' | 'donor';
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (userData: RegisterData) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  isLoading: boolean;
}

export interface RegisterData {
  email: string;
  password: string;
  confirmPassword: string;
  accountType: 'organization' | 'donor';
  // Organization fields
  organizationName?: string;
  contactPerson?: string;
  organizationType?: 'hospital' | 'partner';
  // Donor fields
  firstName?: string;
  lastName?: string;
  // Common fields
  phone: string;
  location: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch user data for authenticated user
  const fetchUserData = async (userId: string): Promise<{ organization?: Organization; donor?: Donor }> => {
    try {
      const { data: userAuth } = await supabase
        .from('user_auth')
        .select('organization_id, donor_id')
        .eq('user_id', userId)
        .single();

      if (!userAuth) return {};

      if (userAuth.organization_id) {
        const { data: organization } = await supabase
          .from('organizations')
          .select('*')
          .eq('id', userAuth.organization_id)
          .single();
        return { organization };
      } else if (userAuth.donor_id) {
        const { data: donor } = await supabase
          .from('donors')
          .select('*')
          .eq('id', userAuth.donor_id)
          .single();
        return { donor };
      }

      return {};
    } catch (error) {
      console.error('Error fetching user data:', error);
      return {};
    }
  };

  useEffect(() => {
    // Set up auth state listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        setSession(session);
        
        if (session?.user) {
          const { organization, donor } = await fetchUserData(session.user.id);
          setUser({
            id: session.user.id,
            email: session.user.email!,
            organization,
            donor,
            accountType: organization ? 'organization' : 'donor'
          });
        } else {
          setUser(null);
        }
        
        setIsLoading(false);
      }
    );

    // Check for existing session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      
      if (session?.user) {
        const { organization, donor } = await fetchUserData(session.user.id);
        setUser({
          id: session.user.id,
          email: session.user.email!,
          organization,
          donor,
          accountType: organization ? 'organization' : 'donor'
        });
      }
      
      setIsLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const register = async (userData: RegisterData): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);

    try {
      // Validation
      if (userData.password !== userData.confirmPassword) {
        return { success: false, error: 'Passwords do not match' };
      }

      if (userData.password.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters long' };
      }

      const redirectUrl = `${window.location.origin}/`;

      // Prepare user metadata based on account type
      const userMetadata = userData.accountType === 'donor' ? {
        account_type: 'donor',
        first_name: userData.firstName,
        last_name: userData.lastName,
        phone: userData.phone,
        location: userData.location
      } : {
        account_type: 'organization',
        organization_name: userData.organizationName,
        contact_person: userData.contactPerson,
        phone: userData.phone,
        location: userData.location,
        organization_type: userData.organizationType
      };

      // Sign up user with Supabase Auth
      const { data: signUpData, error } = await supabase.auth.signUp({
        email: userData.email,
        password: userData.password,
        options: {
          emailRedirectTo: redirectUrl,
          data: userMetadata
        }
      });

      if (error) {
        return { success: false, error: error.message };
      }

      const userId = signUpData.user?.id;

      // Create donor or organization record
      if (userData.accountType === 'donor') {
        const { error: donorError } = await supabase
          .from('donors')
          .insert([
            {
              user_id: userId,
              first_name: userData.firstName,
              last_name: userData.lastName,
              phone: userData.phone,
              location: userData.location
            }
          ]);

        if (donorError) {
          console.error('Error creating donor record:', donorError);
          return { success: false, error: 'Registration failed. Please try again.' };
        }
      } else {
        const { error: organizationError } = await supabase
          .from('organizations')
          .insert([
            {
              user_id: userId,
              organization_name: userData.organizationName,
              contact_person: userData.contactPerson,
              phone: userData.phone,
              location: userData.location,
              organization_type: userData.organizationType
            }
          ]);

        if (organizationError) {
          console.error('Error creating organization record:', organizationError);
          return { success: false, error: 'Registration failed. Please try again.' };
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Registration error:', error);
      return { success: false, error: 'Registration failed. Please try again.' };
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: 'Login failed. Please try again.' };
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async (): Promise<void> => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
  };

  const value: AuthContextType = {
    user,
    session,
    login,
    register,
    logout,
    isLoading,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
