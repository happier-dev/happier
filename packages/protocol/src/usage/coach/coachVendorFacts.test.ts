import { describe, expect, it } from 'vitest';

import { PROMPT_CACHE_DURATIONS } from './coachVendorFacts.js';

describe('prompt cache windows', () => {
    it('exposes only finite positive durations for cache-window choices', () => {
        for (const durations of Object.values(PROMPT_CACHE_DURATIONS)) {
            for (const duration of Object.values(durations)) {
                expect(typeof duration === 'number' && Number.isFinite(duration) && duration > 0).toBe(true);
            }
        }
    });
});
