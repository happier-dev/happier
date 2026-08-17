import { describe, expect, it } from 'vitest';

import {
    buildMachineDisplayCacheEntryFromRenderable,
    buildMachineDisplayRenderableFromCacheEntry,
} from './machineDisplayWarmCacheAdapters';

describe('machineDisplayWarmCacheAdapters', () => {
    it('roundtrips replacement and locked tombstone facts through the machine display cache', () => {
        const entry = buildMachineDisplayCacheEntryFromRenderable({
            id: 'm1',
            updatedAt: 20,
            active: false,
            activeAt: 10,
            revokedAt: null,
            replacedByMachineId: 'm2',
            replacedAt: 19,
            replacementReason: 'reinstalled',
            replacementSource: 'automatic',
            replacementActorUserId: 'user-1',
            availability: { kind: 'locked', reason: 'decryption_failed' },
            metadataVersion: 3,
            metadata: { displayName: 'Old machine' },
        });

        expect(buildMachineDisplayRenderableFromCacheEntry(entry)).toEqual(expect.objectContaining({
            id: 'm1',
            replacedByMachineId: 'm2',
            replacedAt: 19,
            replacementReason: 'reinstalled',
            replacementSource: 'automatic',
            replacementActorUserId: 'user-1',
            availability: { kind: 'locked', reason: 'decryption_failed' },
        }));
    });
});
