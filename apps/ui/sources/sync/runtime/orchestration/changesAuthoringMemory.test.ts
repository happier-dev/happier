import { describe, expect, it, vi } from 'vitest';
import { log } from '@/log';
import { planSyncActionsFromChanges } from './changesPlanner';
import { applyPlannedChangeActions } from './changesApplier';
import { createStore } from 'zustand/vanilla';
import { createAuthoringMemoryDomain, type AuthoringMemoryDomain } from '@/sync/store/domains/authoringMemory';
import { createAuthoringMemorySync } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';

describe('authoring memory durable changes', () => {
    it('materializes the exact row before advancing the durable cursor, without settings refresh', async () => {
        const planned = planSyncActionsFromChanges([{ cursor: 7, kind: 'account', entityId: 'authoring-memory:lastUsedProfile',
            changedAt: 1, hint: { authoringMemory: true, key: 'lastUsedProfile', revision: 2 } }]);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
        const refreshed: string[] = [];
        const secondClient = createStore<AuthoringMemoryDomain>()((set, get) => createAuthoringMemoryDomain({ set, get }));
        let profile = 'first-profile';
        let offline = false;
        const owner = createAuthoringMemorySync({
            transport: {
                list: async () => ({ rows: [{ key: 'lastUsedProfile', revision: 1, content: { t: 'plain', v: profile } }] }),
                read: async (key) => {
                    if (offline) throw new Error('offline');
                    refreshed.push(key);
                    return { status: 'present', revision: 2, content: { t: 'plain', v: profile } };
                },
                mutate: async () => { throw new Error('Second client only observes server rows'); },
            },
            cipher: createAuthoringMemoryCipher({ mode: 'plain', material: null, randomBytes: () => { throw new Error('keyless'); } }),
            isCurrent: () => true,
            apply: (delta) => secondClient.getState().applyAuthoringMemory(delta),
        });
        await owner.bootstrap();
        expect(secondClient.getState().authoringMemory.lastUsedProfile).toBe('first-profile');
        profile = 'changed-by-first-client';
        const base = {
            planned, credentials: { token: 'token', secret: 'secret' }, isSessionMessagesLoaded: () => false,
            invalidate: {}, invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }),
        };
        offline = true;
        const logged = vi.spyOn(log, 'log');
        const failed = await applyPlannedChangeActions({ ...base, materializeAuthoringMemory: owner.refresh });
        expect(failed).toMatchObject({ status: 'partial', safeAdvanceCursor: null, blockedCursor: '7' });
        // The stopped cursor is diagnosable: one line names the failed row class, not its content.
        expect(logged.mock.calls.filter(([line]) => line.includes('authoring memory')).length).toBe(1);
        logged.mockRestore();
        offline = false;
        const result = await applyPlannedChangeActions({ ...base, materializeAuthoringMemory: owner.refresh });
        expect(result).toMatchObject({ status: 'complete', safeAdvanceCursor: '7' });
        expect(refreshed).toEqual(['lastUsedProfile']);
        expect(secondClient.getState().authoringMemory.lastUsedProfile).toBe('changed-by-first-client');
    });
});
