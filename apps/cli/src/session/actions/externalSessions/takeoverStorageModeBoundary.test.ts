import { describe, expect, it } from 'vitest';

import { mapExternalSessionTakeoverStorageModeToTranscriptStorage } from './takeoverStorageModeBoundary';

describe('external-session takeover storage-mode boundary', () => {
    it('maps each takeover target to the corresponding transcript-storage mode without reinterpreting it', () => {
        expect([
            mapExternalSessionTakeoverStorageModeToTranscriptStorage('external-linked'),
            mapExternalSessionTakeoverStorageModeToTranscriptStorage('persisted'),
        ]).toEqual(['direct', 'persisted']);
    });
});
