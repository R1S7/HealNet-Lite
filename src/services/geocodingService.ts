import { createClient } from '@supabase/supabase-js';

interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  quality: 'exact' | 'approximate' | 'failed';
  confidence: number;
}

class GeocodingService {
  private supabase;
  
  constructor() {
    this.supabase = createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY
    );
  }

  // Main geocoding function with caching
  async geocode(address: string): Promise<GeocodeResult> {
    if (!address) {
      throw new Error('Address is required for geocoding');
    }

    // Check cache first
    const cached = await this.checkCache(address);
    if (cached) {
      return cached;
    }

    // Try Mapbox first (more accurate but rate limited)
    try {
      const result = await this.geocodeMapbox(address);
      if (result.quality === 'exact' || result.quality === 'approximate') {
        await this.cacheResult(address, result);
        return result;
      }
    } catch (error) {
      console.warn('Mapbox geocoding failed, falling back to OpenStreetMap', error);
    }

    // Fallback to OpenStreetMap (Nominatim)
    try {
      const result = await this.geocodeNominatim(address);
      await this.cacheResult(address, result);
      return result;
    } catch (error) {
      console.error('All geocoding providers failed', error);
      throw new Error('Could not geocode address');
    }
  }

  private async geocodeMapbox(address: string): Promise<GeocodeResult> {
    const apiKey = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
    if (!apiKey) {
      throw new Error('Mapbox API key not configured');
    }

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json`;
    const params = new URLSearchParams({
      access_token: apiKey,
      limit: '1',
      types: 'address,poi,place,postcode,locality,neighborhood',
      country: 'US', // Optional: set based on your target region
    });

    const response = await fetch(`${url}?${params}`);
    if (!response.ok) {
      throw new Error(`Mapbox API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.features || data.features.length === 0) {
      return {
        lat: 0,
        lng: 0,
        formattedAddress: address,
        quality: 'failed',
        confidence: 0
      };
    }

    const feature = data.features[0];
    const [lng, lat] = feature.center;
    
    return {
      lat,
      lng,
      formattedAddress: feature.place_name || address,
      quality: this.determineMapboxQuality(feature),
      confidence: feature.relevance || 0.7
    };
  }

  private async geocodeNominatim(address: string): Promise<GeocodeResult> {
    const url = 'https://nominatim.openstreetmap.org/search';
    const params = new URLSearchParams({
      q: address,
      format: 'json',
      limit: '1',
      addressdetails: '1',
      'accept-language': 'en',
      countrycodes: 'us', // Optional: set based on your target region
    });

    const response = await fetch(`${url}?${params}`, {
      headers: {
        'User-Agent': 'HealNet-Lite/1.0 (https://github.com/rickyg242/healnet-lite)'
      }
    });

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!Array.isArray(data) || data.length === 0) {
      return {
        lat: 0,
        lng: 0,
        formattedAddress: address,
        quality: 'failed',
        confidence: 0
      };
    }

    const result = data[0];
    return {
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
      formattedAddress: result.display_name || address,
      quality: this.determineNominatimQuality(result),
      confidence: 0.7
    };
  }

  private determineMapboxQuality(feature: any): 'exact' | 'approximate' | 'failed' {
    // Mapbox place types: https://docs.mapbox.com/api/search/geocoding/#data-types
    const exactTypes = ['address', 'poi', 'postcode'];
    const approximateTypes = ['place', 'locality', 'neighborhood', 'region'];
    
    const featureType = feature.place_type?.[0];
    
    if (exactTypes.includes(featureType)) return 'exact';
    if (approximateTypes.includes(featureType)) return 'approximate';
    return 'failed';
  }

  private determineNominatimQuality(result: any): 'exact' | 'approximate' | 'failed' {
    // Nominatim result types: https://nominatim.org/release-docs/develop/api/Output/
    const exactTypes = ['house', 'building', 'commercial', 'retail', 'industrial', 'apartments'];
    const approximateTypes = ['road', 'neighbourhood', 'suburb', 'village', 'town', 'city'];
    
    if (exactTypes.includes(result.type) || exactTypes.includes(result.category)) {
      return 'exact';
    }
    
    if (approximateTypes.includes(result.type) || approximateTypes.includes(result.category)) {
      return 'approximate';
    }
    
    return result.lat && result.lon ? 'approximate' : 'failed';
  }

  private async checkCache(address: string): Promise<GeocodeResult | null> {
    if (!address) return null;
    
    const { data, error } = await this.supabase
      .from('geocoding_cache')
      .select('*')
      .eq('address', address.toLowerCase().trim())
      .single();

    if (error || !data) return null;

    // Check if cache is still valid (30 days)
    const cacheDate = new Date(data.updated_at);
    const now = new Date();
    const diffDays = (now.getTime() - cacheDate.getTime()) / (1000 * 60 * 60 * 24);
    
    if (diffDays > 30) {
      return null; // Cache expired
    }

    return {
      lat: data.lat,
      lng: data.lon,
      formattedAddress: data.formatted_address || address,
      quality: data.quality,
      confidence: data.confidence || 0.7
    };
  }

  private async cacheResult(address: string, result: GeocodeResult): Promise<void> {
    if (!address || result.quality === 'failed') return;

    await this.supabase
      .from('geocoding_cache')
      .upsert({
        address: address.toLowerCase().trim(),
        lat: result.lat,
        lon: result.lng,
        formatted_address: result.formattedAddress,
        quality: result.quality,
        confidence: result.confidence,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'address'
      });
  }
}

export const geocodingService = new GeocodingService();
