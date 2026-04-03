import { createClient } from '@supabase/supabase-js';
import { geocodingService } from '../services/geocodingService';

const BATCH_SIZE = 10; // Number of records to process in each batch
const DELAY_BETWEEN_BATCHES = 5000; // 5 seconds

class GeocodeWorker {
  private supabase;
  private isRunning = false;
  private shouldStop = false;
  
  constructor() {
    this.supabase = createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY
    );
  }
  
  /**
   * Start the geocoding worker
   */
  async start() {
    if (this.isRunning) {
      console.log('Geocode worker is already running');
      return;
    }
    
    this.isRunning = true;
    this.shouldStop = false;
    console.log('Starting geocode worker...');
    
    await this.processBatches();
  }
  
  /**
   * Stop the geocoding worker
   */
  stop() {
    console.log('Stopping geocode worker...');
    this.shouldStop = true;
  }
  
  /**
   * Process records in batches with a delay between batches
   */
  private async processBatches() {
    while (!this.shouldStop) {
      try {
        // Process donations first
        const donationsProcessed = await this.processDonationsBatch();
        
        // Then process needs
        const needsProcessed = await this.processNeedsBatch();
        
        // If nothing was processed in this cycle, wait longer before checking again
        const waitTime = (donationsProcessed === 0 && needsProcessed === 0) 
          ? DELAY_BETWEEN_BATCHES * 5 // Wait longer if nothing to process
          : DELAY_BETWEEN_BATCHES;
        
        await this.delay(waitTime);
      } catch (error) {
        console.error('Error in geocode worker batch:', error);
        // Wait a bit longer on error before retrying
        await this.delay(DELAY_BETWEEN_BATCHES * 2);
      }
    }
    
    this.isRunning = false;
    console.log('Geocode worker stopped');
  }
  
  /**
   * Process a batch of donations that need geocoding
   * @returns Number of donations processed
   */
  private async processDonationsBatch(): Promise<number> {
    try {
      // Get a batch of donations that need geocoding
      const { data: donations, error } = await this.supabase
        .from('donations')
        .select('id, location, lat, lng, geocoded_at')
        .or('lat.is.null,lng.is.null,geocoded_at.is.null')
        .limit(BATCH_SIZE);
      
      if (error) throw error;
      if (!donations || donations.length === 0) return 0;
      
      console.log(`Processing ${donations.length} donations for geocoding...`);
      
      // Process each donation
      const updates = [];
      
      for (const donation of donations) {
        if (!donation.location) continue;
        
        try {
          const result = await geocodingService.geocode(donation.location);
          
          if (result.quality !== 'failed') {
            updates.push({
              id: donation.id,
              lat: result.lat,
              lng: result.lng,
              formatted_address: result.formattedAddress,
              geocode_quality: result.quality,
              geocoded_at: new Date().toISOString(),
            });
          } else {
            console.warn(`Failed to geocode donation ${donation.id}: ${donation.location}`);
            // Mark as attempted to avoid retrying failed geocodes too often
            updates.push({
              id: donation.id,
              geocoded_at: new Date().toISOString(),
            });
          }
        } catch (error) {
          console.error(`Error geocoding donation ${donation.id}:`, error);
        }
      }
      
      // Batch update the donations
      if (updates.length > 0) {
        const { error: updateError } = await this.supabase
          .from('donations')
          .upsert(updates);
          
        if (updateError) throw updateError;
        console.log(`Updated ${updates.length} donations with geocoding data`);
      }
      
      return donations.length;
    } catch (error) {
      console.error('Error processing donations batch:', error);
      return 0;
    }
  }
  
  /**
   * Process a batch of needs that need geocoding
   * @returns Number of needs processed
   */
  private async processNeedsBatch(): Promise<number> {
    try {
      // Get a batch of needs that need geocoding
      const { data: needs, error } = await this.supabase
        .from('needs')
        .select('id, location, lat, lng, geocoded_at')
        .or('lat.is.null,lng.is.null,geocoded_at.is.null')
        .limit(BATCH_SIZE);
      
      if (error) throw error;
      if (!needs || needs.length === 0) return 0;
      
      console.log(`Processing ${needs.length} needs for geocoding...`);
      
      // Process each need
      const updates = [];
      
      for (const need of needs) {
        if (!need.location) continue;
        
        try {
          const result = await geocodingService.geocode(need.location);
          
          if (result.quality !== 'failed') {
            updates.push({
              id: need.id,
              lat: result.lat,
              lng: result.lng,
              formatted_address: result.formattedAddress,
              geocode_quality: result.quality,
              geocoded_at: new Date().toISOString(),
            });
          } else {
            console.warn(`Failed to geocode need ${need.id}: ${need.location}`);
            // Mark as attempted to avoid retrying failed geocodes too often
            updates.push({
              id: need.id,
              geocoded_at: new Date().toISOString(),
            });
          }
        } catch (error) {
          console.error(`Error geocoding need ${need.id}:`, error);
        }
      }
      
      // Batch update the needs
      if (updates.length > 0) {
        const { error: updateError } = await this.supabase
          .from('needs')
          .upsert(updates);
          
        if (updateError) throw updateError;
        console.log(`Updated ${updates.length} needs with geocoding data`);
      }
      
      return needs.length;
    } catch (error) {
      console.error('Error processing needs batch:', error);
      return 0;
    }
  }
  
  /**
   * Helper function to delay execution
   * @param ms Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export a singleton instance
export const geocodeWorker = new GeocodeWorker();

// Start the worker automatically if this is the main module
if (import.meta.env.MODE !== 'test' && typeof window !== 'undefined') {
  // In a real app, you might want to control this more carefully
  // For example, only run in the main browser tab, not in service workers, etc.
  geocodeWorker.start().catch(console.error);
}
