import { describe, expect, it } from 'vitest';

import { selectManagedLocalServiceCleanupIds } from './cleanup';

describe('selectManagedLocalServiceCleanupIds', () => {
    it('selects only terminal services whose cleanup window has elapsed', () => {
        const ids = selectManagedLocalServiceCleanupIds({
            now: 2_000,
            services: [
                { id: 'running', phase: 'running', updatedAt: 1_000, staleAfterMs: 100 },
                { id: 'fresh-stopped', phase: 'stopped', updatedAt: 1_950, staleAfterMs: 100 },
                { id: 'old-failed', phase: 'failed', updatedAt: 1_000, staleAfterMs: 500 },
            ],
        });

        expect(ids).toEqual(['old-failed']);
    });
});
