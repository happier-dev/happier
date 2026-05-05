import { describe, expect, it } from 'vitest';

import { createSyncGenerationGuard } from './syncGenerationGuard';

describe('createSyncGenerationGuard', () => {
    it('continues only while the captured generation remains current', () => {
        let generation = 7;
        const guard = createSyncGenerationGuard({
            getCurrentGeneration: () => generation,
            capturedGeneration: generation,
        });

        expect(guard.capturedGeneration).toBe(7);
        expect(guard.shouldContinue()).toBe(true);

        generation += 1;

        expect(guard.shouldContinue()).toBe(false);
    });
});
