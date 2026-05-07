import { describe, expect, it } from 'vitest';

import { createSyncGenerationGuard } from './syncGenerationGuard';

describe('createSyncGenerationGuard', () => {
    it('allows work only while the captured generation remains current', () => {
        let currentGeneration = 7;
        const guard = createSyncGenerationGuard({
            capturedGeneration: 7,
            getCurrentGeneration: () => currentGeneration,
        });

        expect(guard.shouldContinue()).toBe(true);

        currentGeneration = 8;

        expect(guard.shouldContinue()).toBe(false);
    });
});
