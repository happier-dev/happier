import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalServicePreviewResourceV1Schema, DaemonLocalServicePreviewSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, flushHookEffects } from '@/dev/testkit';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Daemon transport is the boundary; subscription lifecycle and snapshot normalization stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});

import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';

import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import {
    getLocalServicePreviewState,
    invalidateLocalServicePreviewStore,
    publishLocalServicePreviewSnapshot,
    resetLocalServicePreviewStoreForTests,
    subscribeLocalServicePreviewStore,
} from './sharedStore';
import { selectLocalServicePreviewRows, type LocalServicePreviewSnapshot } from './store';

function previewResource(previewId: string): LocalServicePreviewResourceV1 {
    return LocalServicePreviewResourceV1Schema.parse({
        previewId,
        sessionId: 'session_1',
        machineId: 'machine_1',
        owner: { kind: 'session', id: 'session_1' },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        initialPath: { pathname: '/', search: '' },
        display: { title: 'Vite', addressLabel: 'localhost:5173' },
        originMode: 'host',
        browserTarget: {
            kind: 'localServicePreview',
            targetId: previewId,
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: { title: 'Vite', addressLabel: 'localhost:5173' },
        },
    });
}

function snapshotWith(previewId: string): LocalServicePreviewSnapshot {
    return {
        generatedAt: 1_000,
        refreshState: 'idle',
        previews: [{
            previewId,
            resource: previewResource(previewId),
            accessUrl: 'http://127.0.0.1:5173/',
            expiresAt: null,
            diagnostics: [],
        }],
        diagnostics: [],
    };
}

async function flushMicrotasks(): Promise<void> {
    await flushHookEffects();
}

function snapshotResponse(snapshot: LocalServicePreviewSnapshot) {
    return DaemonLocalServicePreviewSnapshotResponseV1Schema.parse({ protocolVersion: 1,
        snapshot: { ...snapshot, v: 1, machineId: 'machine_1', resources: snapshot.previews.map(row => row.resource) },
    });
}

describe('shared local-service preview store (PRV-4)', () => {
    it('publishes nothing for equal receipts and replaces only changed preview facts', async () => {
        const initial = snapshotWith('preview_1');
        rpc.machine.mockResolvedValue(snapshotResponse(initial));
        const key = { machineId: 'machine_1' };
        const listener = vi.fn();
        const release = subscribeLocalServicePreviewStore(key, listener);
        try {
            await flushMicrotasks();
            const ready = getLocalServicePreviewState(key);
            listener.mockClear();
            for (let receipt = 0; receipt < 10; receipt++) {
                publishLocalServicePreviewSnapshot(key, structuredClone(initial));
            }
            expect(listener).toHaveBeenCalledTimes(0);
            expect(getLocalServicePreviewState(key)).toBe(ready);

            publishLocalServicePreviewSnapshot(key, { ...initial, generatedAt: 2_000 });
            const newer = getLocalServicePreviewState(key);
            expect(listener).toHaveBeenCalledTimes(1);
            expect(newer.generatedAt).toBe(2_000);
            expect(newer.previewIds).toBe(ready.previewIds);
            expect(newer.previewsById).toBe(ready.previewsById);
            expect(newer.diagnostics).toBe(ready.diagnostics);

            publishLocalServicePreviewSnapshot(key, { ...initial, generatedAt: 2_000,
                previews: initial.previews.map(row => ({ ...row, expiresAt: 3_000 })) });
            const changed = getLocalServicePreviewState(key);
            expect(listener).toHaveBeenCalledTimes(2);
            expect(changed.previewIds).toBe(ready.previewIds);
            expect(changed.previewsById.get('preview_1')?.expiresAt).toBe(3_000);
            expect(changed.previewsById).not.toBe(ready.previewsById);

            publishLocalServicePreviewSnapshot(key, { ...initial, generatedAt: 3_000, refreshState: 'error',
                diagnostics: [{ v: 1, code: 'path_mode_degraded', severity: 'warning', scope: 'privatePreview' }] });
            expect(listener).toHaveBeenCalledTimes(3);
            expect(getLocalServicePreviewState(key)).toMatchObject({ refreshState: 'error',
                diagnostics: [expect.objectContaining({ code: 'path_mode_degraded' })] });
        } finally { release(); }
    });
    it('shares one admitted preview across a Home profile alias without crossing Accounts', async () => {
        const { upsertServerProfile, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        const home = await upsertServerProfile({ serverUrl: 'https://preview-scope.test' });
        await setServerProfileIdentityForUrl(home.serverUrl, 'srv_preview_scope');
        const firstAccount = { machineId: 'machine_1', serverId: home.id, accountId: 'account-a' };
        const canonical = { ...firstAccount, serverId: 'srv_preview_scope' };
        rpc.machine.mockResolvedValue(snapshotResponse(snapshotWith('preview_1')));
        const release = subscribeLocalServicePreviewStore(firstAccount, () => {});
        try {
            await flushMicrotasks();
            expect(getLocalServicePreviewState(firstAccount).previewIds).toEqual(['preview_1']);
            expect(getLocalServicePreviewState(canonical)).toBe(getLocalServicePreviewState(firstAccount));
            expect(getLocalServicePreviewState({ ...canonical, accountId: 'account-b' }).previewIds).toEqual([]);
        } finally { release(); }
    });

    it('retires credential-owned previews and rejects a preceding Account read that settles late', async () => {
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
        const home = await upsertServerProfile({ serverUrl: 'https://preview-retirement.test' });
        const credentials = { token: createAccountTokenForTests('account-a', { currentAccount: true }) };
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials)).toBe(true);
        const key = { machineId: 'machine_1', serverId: home.id, accountId: 'account-a',
            credentialKey: resolveAuthCredentialsScopeKey(credentials) };
        const pending = createDeferred<unknown>();
        rpc.machine.mockReturnValue(pending.promise);
        const release = subscribeLocalServicePreviewStore(key, () => {});
        try {
            await flushMicrotasks();
            publishLocalServicePreviewSnapshot(key, snapshotWith('preview_1'));
            expect(getLocalServicePreviewState(key).previewIds).toEqual(['preview_1']);
            expect(getLocalServicePreviewState({ ...key, accountId: 'account-b' }).previewIds).toEqual([]);
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl,
                { serverId: home.id }, { token: createAccountTokenForTests('account-b', { currentAccount: true }) })).toBe(true);
            expect(getLocalServicePreviewState(key).previewIds).toEqual([]);
            pending.resolve(snapshotResponse(snapshotWith('preview_late')));
            await flushMicrotasks();
            expect(getLocalServicePreviewState(key).previewIds).toEqual([]);
        } finally { release(); }
    });
    it.each(['snapshot', 'failure', 'rejection'] as const)('preserves a newer publication when an older read settles with %s', async (outcome) => {
        const pending = createDeferred<unknown>();
        rpc.machine.mockImplementation(async () => {
            const response = await pending.promise;
            if (outcome === 'rejection') throw new Error('transport failed');
            return response;
        });
        const key = { machineId: 'machine_1' };
        const release = subscribeLocalServicePreviewStore(key, () => {});
        await flushMicrotasks();
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        const newer = { ...snapshotWith('preview_new'), generatedAt: 2_000 };
        publishLocalServicePreviewSnapshot(key, newer);
        const published = getLocalServicePreviewState(key);
        if (outcome === 'snapshot') pending.resolve(snapshotResponse(snapshotWith('preview_old')));
        else if (outcome === 'failure') pending.resolve({ ok: false, error: 'request_failed' });
        else pending.resolve(undefined);
        await flushMicrotasks();
        expect(getLocalServicePreviewState(key)).toBe(published);
        release();
    });
    beforeEach(() => { rpc.machine.mockReset(); });
    afterEach(() => {
        resetLocalServicePreviewStoreForTests();
    });

    it('fetches once for a key regardless of how many panes subscribe', async () => {
        const snapshotClient = rpc.machine.mockResolvedValue(snapshotResponse(snapshotWith('preview_1')));
        const key = { machineId: 'machine_1', serverId: 'server_1' };

        const unsubA = subscribeLocalServicePreviewStore(key, () => {});
        const unsubB = subscribeLocalServicePreviewStore(key, () => {});
        await flushMicrotasks();

        // One backing model, one fetch — not one timer/fetch per mount.
        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT,
            serverId: 'server_1', payload: { machineId: 'machine_1' },
        }));
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toHaveLength(1);

        unsubA();
        unsubB();
    });

    it('refreshes an open pane when an action publishes a snapshot (no polling)', async () => {
        const snapshotClient = rpc.machine.mockResolvedValue(snapshotResponse({ generatedAt: 1_000, refreshState: 'idle', previews: [], diagnostics: [] }));
        const key = { machineId: 'machine_1' };
        const listener = vi.fn();

        const unsub = subscribeLocalServicePreviewStore(key, listener);
        await flushMicrotasks();
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toHaveLength(0);
        listener.mockClear();

        // An openOrCreate/revoke/status dispatch publishes its snapshot into the same store.
        publishLocalServicePreviewSnapshot(key, snapshotWith('preview_1'));

        expect(listener).toHaveBeenCalled();
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toEqual([
            expect.objectContaining({ previewId: 'preview_1' }),
        ]);
        // No additional fetch was issued — the refresh was driven by the action, not a timer.
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        unsub();
    });

    it('drops the keyed entry once the last subscriber leaves', async () => {
        const snapshotClient = rpc.machine.mockResolvedValue(snapshotResponse(snapshotWith('preview_1')));
        const key = { machineId: 'machine_1' };

        const unsub = subscribeLocalServicePreviewStore(key, () => {});
        await flushMicrotasks();
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toHaveLength(1);

        unsub();
        // A publish to a key with no live subscriber is a safe no-op (nothing to refresh into).
        publishLocalServicePreviewSnapshot(key, snapshotWith('preview_2'));
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toHaveLength(0);
    });

    it('invalidation re-fetches for a live key only', async () => {
        const snapshotClient = rpc.machine.mockResolvedValue(snapshotResponse(snapshotWith('preview_1')));
        const key = { machineId: 'machine_1' };

        // No subscriber → invalidation is a no-op.
        invalidateLocalServicePreviewStore(key);
        expect(snapshotClient).not.toHaveBeenCalled();

        const unsub = subscribeLocalServicePreviewStore(key, () => {});
        await flushMicrotasks();
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        invalidateLocalServicePreviewStore(key);
        await flushMicrotasks();
        expect(snapshotClient).toHaveBeenCalledTimes(2);

        unsub();
    });

    it('a rejecting daemon transport marks the refresh failed and does not wedge later refreshes', async () => {
        const snapshotClient = rpc.machine
            .mockRejectedValueOnce(new Error('machine rpc transport failure'))
            .mockResolvedValue(snapshotResponse(snapshotWith('preview_recovered')));
        const key = { machineId: 'machine_1' };

        const unsub = subscribeLocalServicePreviewStore(key, () => {}, { nowMs: () => 5_000 });
        await flushMicrotasks();

        // A thrown transport error must surface as a failed refresh, not leave the key stuck
        // in `refreshing` with the in-flight latch held forever.
        expect(getLocalServicePreviewState(key).refreshState).toBe('error');

        invalidateLocalServicePreviewStore(key);
        await flushMicrotasks();
        expect(snapshotClient).toHaveBeenCalledTimes(2);
        expect(selectLocalServicePreviewRows(getLocalServicePreviewState(key))).toEqual([
            expect.objectContaining({ previewId: 'preview_recovered' }),
        ]);

        unsub();
    });

    it('does not re-fetch previews on a wall clock while subscribed (PRV-4 DONE gate)', async () => {
        const snapshotClient = rpc.machine.mockResolvedValue(snapshotResponse(snapshotWith('preview_1')));
        const key = { machineId: 'machine_1', serverId: 'server_1' };

        await expectNoWallClockPolling({
            subscribe: () => subscribeLocalServicePreviewStore(key, () => {}),
            fetchSpy: snapshotClient,
        });
    });
});
