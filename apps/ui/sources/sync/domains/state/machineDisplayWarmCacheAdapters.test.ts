import { describe, expect, it } from 'vitest';

import {
    buildMachineDisplayCacheEntryFromRenderable,
    buildMachineDisplayRenderableFromCacheEntry,
} from './machineDisplayWarmCacheAdapters';
import { MachineDisplayCacheEntryV1Schema } from './warmCachePersistence';

describe('machineDisplayWarmCacheAdapters', () => {
    it('retains published platform and architecture through the persisted display projection', () => {
        const machine = { id: 'build', updatedAt: 20, active: false, activeAt: 10,
            metadataVersion: 3, metadata: { host: 'Build', platform: 'linux', arch: 'x64' } };
        const entry = buildMachineDisplayCacheEntryFromRenderable(machine);
        const restored = buildMachineDisplayRenderableFromCacheEntry(MachineDisplayCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry))));
        expect(restored.metadata).toMatchObject({ platform: 'linux', arch: 'x64' });
        expect(buildMachineDisplayCacheEntryFromRenderable({ ...machine, metadata: null }, entry)).toBe(entry);
        const changed = buildMachineDisplayCacheEntryFromRenderable({ ...machine, metadata: { ...machine.metadata, arch: 'arm64' } }, entry);
        expect(changed).not.toBe(entry);
        expect(buildMachineDisplayRenderableFromCacheEntry(changed).metadata?.arch).toBe('arm64');
    });
    it.each(['recipient_key_pending', 'recipient_access_refused', 'content_unpublished', 'custodian_only', 'daemon_upgrade_required'] as const)(
        'roundtrips the current %s lock through persisted machine display state', (reason) => {
            const entry = buildMachineDisplayCacheEntryFromRenderable({
                id: 'recipient-machine', updatedAt: 20, active: true, activeAt: 10,
                revokedAt: null, availability: { kind: 'locked', reason },
                metadataVersion: 3, metadata: null,
            });

            const restored = buildMachineDisplayRenderableFromCacheEntry(MachineDisplayCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry))));
            expect(restored.availability).toEqual({ kind: 'locked', reason });
        },
    );

    it.each([undefined, null])('keeps older cache entries with %s lock state readable', (lockedReason) => {
        const entry = MachineDisplayCacheEntryV1Schema.parse({
            machineId: 'older-machine', metadataVersion: 1, updatedAt: 20,
            active: false, activeAt: 10, revokedAt: null,
            ...(lockedReason === undefined ? {} : { lockedReason }),
        });
        expect(buildMachineDisplayRenderableFromCacheEntry(entry).availability).toBeUndefined();
    });

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
            metadata: { displayName: 'Old machine', agentInventory: { checkedAt: 12, installedAgentIds: ['codex'] } },
        });

        expect(buildMachineDisplayRenderableFromCacheEntry(MachineDisplayCacheEntryV1Schema.parse(entry))).toEqual(expect.objectContaining({
            id: 'm1',
            replacedByMachineId: 'm2',
            replacedAt: 19,
            replacementReason: 'reinstalled',
            replacementSource: 'automatic',
            replacementActorUserId: 'user-1',
            availability: { kind: 'locked', reason: 'decryption_failed' },
            metadata: expect.objectContaining({ agentInventory: { checkedAt: 12, installedAgentIds: ['codex'] } }),
        }));
    });
});
