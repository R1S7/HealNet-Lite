import { createClient } from '@supabase/supabase-js';

interface DistanceResult {
  distanceKm: number;
  straightLineKm: number;
  drivingTimeMinutes: number;
  logisticsCost: number;
}

class DistanceService {
  private supabase;
  
  constructor() {
    this.supabase = createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY
    );
  }

  /**
   * Calculate straight-line distance between two points using Haversine formula
   */
  calculateStraightLineDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number
  ): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.deg2rad(lat2 - lat1);
    const dLng = this.deg2rad(lng2 - lng1);
    
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
  }

  /**
   * Calculate driving distance and time using OSRM (Open Source Routing Machine).
   * Free, no API key required, powered by OpenStreetMap.
   * Falls back to Haversine straight-line estimate if the request fails.
   */
  async calculateDrivingDistance(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
    profile: 'driving' | 'walking' | 'cycling' = 'driving'
  ): Promise<DistanceResult> {
    const straightLineKm = this.calculateStraightLineDistance(
      origin.lat, origin.lng,
      destination.lat, destination.lng
    );

    // Map profile names to OSRM equivalents
    const osrmProfile = profile === 'cycling' ? 'bike' : profile === 'walking' ? 'foot' : 'car';

    try {
      const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
      const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${coords}?overview=false`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'HealNet-Lite/1.0 (https://github.com/rickyg242/healnet-lite)'
        }
      });

      if (!response.ok) {
        throw new Error(`OSRM API error: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.routes || data.routes.length === 0) {
        throw new Error('No route found');
      }

      const route = data.routes[0];
      const distanceKm = route.distance / 1000;       // meters → km
      const drivingTimeMinutes = route.duration / 60; // seconds → minutes

      return {
        distanceKm,
        straightLineKm,
        drivingTimeMinutes,
        logisticsCost: this.estimateLogisticsCost(distanceKm)
      };
    } catch (error) {
      console.warn('OSRM routing unavailable, falling back to straight-line estimate:', error);

      return {
        distanceKm: straightLineKm,
        straightLineKm,
        drivingTimeMinutes: this.estimateDrivingTime(straightLineKm),
        logisticsCost: this.estimateLogisticsCost(straightLineKm)
      };
    }
  }

  /**
   * Find needs within a certain radius of a location
   */
  async findNeedsWithinRadius(
    lat: number,
    lng: number,
    radiusKm: number = 50, // Default 50km radius
    limit: number = 50
  ) {
    try {
      const { data, error } = await this.supabase.rpc('find_needs_within_radius', {
        search_lat: lat,
        search_lng: lng,
        radius_meters: radiusKm * 1000 // Convert km to meters
      });

      if (error) throw error;
      
      return (data || []).slice(0, limit);
    } catch (error) {
      console.error('Error finding needs within radius:', error);
      return [];
    }
  }

  /**
   * Estimate driving time based on distance
   */
  private estimateDrivingTime(distanceKm: number): number {
    // Average speed including stops and traffic: ~50 km/h in urban areas
    const averageSpeedKph = 50;
    return (distanceKm / averageSpeedKph) * 60; // Convert hours to minutes
  }

  /**
   * Estimate logistics cost based on distance
   */
  private estimateLogisticsCost(distanceKm: number): number {
    // Simple cost model - adjust based on your requirements
    const baseCost = 5; // Base cost per delivery
    const costPerKm = 0.5; // Cost per km
    
    return baseCost + (distanceKm * costPerKm);
  }

  /**
   * Convert degrees to radians
   */
  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}

export const distanceService = new DistanceService();
