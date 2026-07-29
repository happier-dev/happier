import type { BrowserStoragePartitionV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

async function loadStoragePartitionsModule() {
    return import('./partitions').catch(() => null);
}

const partition = {
    partitionId: 'partition_1',
    profileId: 'profile_1',
    originKey: 'https://preview.example.test',
    targetKind: 'localServicePreview',
    persistence: 'session',
    state: 'active',
    createdAt: 1_000,
    updatedAt: 1_000,
} satisfies BrowserStoragePartitionV1;

describe('browser storage partitions', () => {
    it('drops session-bound partitions without touching other profile partitions', async () => {
        const mod = await loadStoragePartitionsModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.dropBrowserStoragePartitionsForProfiles({
            partitionsById: {
                partition_1: partition,
                partition_2: {
                    ...partition,
                    partitionId: 'partition_2',
                    profileId: 'profile_2',
                },
            },
        }, new Set(['profile_1']))).toEqual({
            partitionsById: {
                partition_2: {
                    ...partition,
                    partitionId: 'partition_2',
                    profileId: 'profile_2',
                },
            },
        });
    });
});
