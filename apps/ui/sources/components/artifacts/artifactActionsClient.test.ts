import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { useArtifactStorageUsage } from './artifactActionsClient';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

const initialState = getStorage().getState();
let disposeHome: (() => void) | undefined;
afterEach(async () => {
    await act(async () => {
        disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialState, true);
    });
    vi.restoreAllMocks();
});

describe('Artifacts storage meter', () => {
    it('re-reads authoritative usage after mutations while the meter remains mounted', async () => {
        let usedBytes = 100;
        let usageUnavailable = false;
        const served = await serveActionHomes({
            homes: [{ key: 'owner', serverUrl: 'https://artifact-meter-mutations.test', accountId: 'owner' }],
            route: (request) => request.path === '/v1/artifacts/storage/usage'
                ? usageUnavailable ? Response.json({ error: 'unavailable' }, { status: 503 })
                    : Response.json({ usedBytes, limitBytes: 1000, documentLimitBytes: null, revisionRetentionCount: 10 })
                : undefined,
        });
        disposeHome = served.dispose;
        const artifact: DecryptedArtifact = { id: 'document', title: 'Notes', isDecrypted: true,
            header: { title: 'Notes' }, headerVersion: 1, bodyVersion: 1, seq: 1,
            body: 'Notes', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain' };
        const hook = await renderHook(useArtifactStorageUsage);
        await flushHookEffects();
        expect(hook.getCurrent()?.usedBytes).toBe(100);

        usedBytes = 300;
        await act(async () => { getStorage().getState().addArtifact(artifact); });
        await flushHookEffects();
        expect(hook.getCurrent()?.usedBytes).toBe(300);

        usedBytes = 550;
        await act(async () => { getStorage().getState().updateArtifact({ ...artifact, body: 'Updated', bodyVersion: 2 }); });
        await flushHookEffects();
        expect(hook.getCurrent()?.usedBytes).toBe(550);

        usageUnavailable = true;
        await act(async () => { getStorage().getState().updateArtifact({ ...artifact, bodyVersion: 3 }); });
        await flushHookEffects();
        expect(hook.getCurrent()?.usedBytes).toBe(550);

        // Revision restore uses the same canonical updateArtifact writer as an ordinary update.
        usedBytes = 800;
        usageUnavailable = false;
        await act(async () => { getStorage().getState().updateArtifact({ ...artifact, bodyVersion: 4 }); });
        await flushHookEffects();
        expect(hook.getCurrent()?.usedBytes).toBe(800);

        usedBytes = 0;
        await act(async () => { getStorage().getState().deleteArtifact(artifact.id); });
        await flushHookEffects();
        expect(hook.getCurrent()?.usedBytes).toBe(0);
        await hook.unmount();
    });

    it('never carries another Home\'s budget into the active Account when its usage read fails', async () => {
        const usage = { usedBytes: 321, limitBytes: 1000, documentLimitBytes: null, revisionRetentionCount: 10 };
        const served = await serveActionHomes({
            homes: [
                { key: 'first', serverUrl: 'https://artifact-meter-first.test', accountId: 'first-owner' },
                { key: 'second', serverUrl: 'https://artifact-meter-second.test', accountId: 'second-owner' },
            ],
            route: (request) => request.path === '/v1/artifacts/storage/usage'
                ? request.home === 'first' ? Response.json(usage) : Response.json({ error: 'unavailable' }, { status: 503 })
                : undefined,
        });
        disposeHome = served.dispose;
        const firstScope = { serverId: served.homes.first!.id, accountId: 'first-owner' };
        const secondScope = { serverId: served.homes.second!.id, accountId: 'second-owner' };
        getStorage().setState({ profileScope: firstScope, settingsScope: firstScope });
        const hook = await renderHook(useArtifactStorageUsage);
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(usage);

        await act(async () => { getStorage().setState({ profileScope: secondScope, settingsScope: secondScope }); });
        await hook.rerender();
        await flushHookEffects();
        expect(hook.getCurrent()).toBeNull();
        expect(served.requests.filter((request) => request.path === '/v1/artifacts/storage/usage')
            .map((request) => [request.home, request.accountId])).toEqual([
                ['first', 'first-owner'], ['second', 'second-owner'],
            ]);
        await hook.unmount();
    });
});
