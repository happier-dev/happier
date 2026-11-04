import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { act } from 'react-test-renderer';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext } from '@happier-dev/protocol/testing/accountScopedCipherFixtures';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { createDeferredResponse, createLegacyQuotaAuthWrapper, createLegacyQuotaTestHarness, makeQuotaSnapshot,
    plainQuotaResponse, resetConnectedServiceQuotaSnapshotsTestState, stableCredentials } from './useConnectedServiceQuotaSnapshots.testkit';

describe('useConnectedServiceQuotaSnapshots credential authority', () => {
    let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
    const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);
    beforeEach(async () => { await resetConnectedServiceQuotaSnapshotsTestState(); boundary = await createLegacyQuotaTestHarness(); });
    afterEach(async () => { standardCleanup(); await boundary.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });

    it('does not render a mounted quota reader for unrelated Account profile changes', async () => {
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const refs = [{ serviceId: 'anthropic', profileId: 'work' }] as const;
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useConnectedServiceQuotaSnapshots(refs, { fetchPolicy: 'cache_only' });
        }, { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        const before = renders;
        for (let index = 0; index < 5; index++) {
            await act(async () => {
                storage.setState(state => ({ profile: { ...state.profile, firstName: `name-${index}` } }));
            });
        }
        expect(renders - before).toBe(0);
        await hook.unmount();
    });

    it('does not render mounted quota summaries for unrelated Account profile changes', async () => {
        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useConnectedServiceQuotaSummaries({ fetchPolicy: 'cache_only' });
        }, { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        const before = renders;
        for (let index = 0; index < 5; index++) {
            await act(async () => storage.setState(state => ({ profile: { ...state.profile, firstName: `summary-${index}` } })));
        }
        expect(renders - before).toBe(0);
        await hook.unmount();
    });

    it('observes the active pooled account and its replacement through the narrowed Profile subscription', async () => {
        const { useConnectedServiceQuotaSummaries } = await import('./useConnectedServiceQuotaSummaries');
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const group = QualifiedConnectedAccountGroupV4Schema.parse({
            v: 1, ref: { service, groupId: 'work' }, displayName: 'Work', incarnation: 'work:1',
            generation: 1, runtimeStateRevision: 1, policy: {}, activeConnectedAccountId: 'personal',
            state: {}, members: [], createdAt: 0, updatedAt: 0,
        });
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountGroupsV4: [group] } }));
        const hook = await renderHook(() => useConnectedServiceQuotaSummaries({ fetchPolicy: 'cache_only' }), { wrapper: Wrapper });
        expect(hook.getCurrent().inUseAccountKeys).toEqual(new Set(['happier.agent.codex%2Fopenai-codex/personal']));
        await act(async () => storage.setState(state => ({ profile: { ...state.profile,
            connectedAccountGroupsV4: [{ ...group, activeConnectedAccountId: 'work' }],
        } })));
        expect(hook.getCurrent().inUseAccountKeys).toEqual(new Set(['happier.agent.codex%2Fopenai-codex/work']));
        await hook.unmount();
    });

    it.each(['token', 'secret'] as const)('refetches and rejects an old in-flight read when %s changes', async field => {
        if (field === 'secret') {
            await boundary.dispose();
            boundary = await createLegacyQuotaTestHarness({ accountMode: 'e2ee' });
        }
        const response = (meterId: string) => {
            const snapshot = makeQuotaSnapshot({ serviceId: 'anthropic', meterId });
            const credentials = boundary.account.credentials;
            if (!isLegacyAuthCredentials(credentials)) return plainQuotaResponse(snapshot);
            return Response.json({ sealed: { format: 'account_scoped_v1',
                ciphertext: sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
                    material: { type: 'legacy', secret: decodeBase64(credentials.secret, 'base64url') },
                    payload: snapshot, randomBytes: length => new Uint8Array(length).fill(6),
                }) }, metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' } });
        };
        const read = field === 'secret' ? boundary.sealedRead : boundary.plainRead;
        const held = createDeferredResponse();
        read.mockImplementationOnce(() => held.promise);
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(read).toHaveBeenCalledTimes(1);
        const oldResponse = response('old-credential');
        const nextCredentials = field === 'token'
            ? { ...stableCredentials, token: stableCredentials.token + '-renewed' }
            : { ...boundary.account.credentials, secret: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url') };
        const basis = getActiveServerSnapshot();
        // InjectedAuthProvider is the real controlled-credential boundary. Keep
        // Home generation fixed so reconnect invalidation cannot prove this test.
        boundary.account.credentials = nextCredentials;
        read.mockImplementation(async () => response('new-credential'));
        await hook.rerender(); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(getActiveServerSnapshot()).toEqual(basis);
        expect(read).toHaveBeenCalled();
        expect(new Headers(read.mock.lastCall?.[1]?.headers).get('Authorization')).toBe(`Bearer ${nextCredentials.token}`);
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId,
            JSON.stringify(hook.getCurrent().errorsByKey)).toBe('new-credential');
        await act(async () => { held.resolve(oldResponse); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('new-credential');
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
    });

    it('withdraws a cached snapshot in the first render after credential replacement', async () => {
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'old-account' })));
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const rendered: Array<string | null> = [];
        let capture = false;
        const hook = await renderHook(() => {
            const result = useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]);
            if (capture) rendered.push(result.snapshotsByKey['anthropic/work']?.meters[0]?.meterId ?? null);
            return result;
        }, { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('old-account');
        const held = createDeferredResponse();
        boundary.account.credentials = { ...stableCredentials, token: stableCredentials.token + '-new' };
        boundary.plainRead.mockImplementation(() => held.promise.then(response => response.clone())); capture = true;
        await hook.rerender();
        expect(rendered[0]).toBeNull();
        await act(async () => { held.resolve(plainQuotaResponse(null)); });
    });

    it('does not let an old account-mode response choose the endpoint of replacement credentials', async () => {
        const heldMode = createDeferredResponse();
        boundary.modeRead.mockImplementation(() => heldMode.promise.then(response => response.clone()));
        const basis = getActiveServerSnapshot();
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.modeRead).toHaveBeenCalled();
        expect(boundary.plainRead).not.toHaveBeenCalled();
        boundary.account.credentials = { ...stableCredentials, token: stableCredentials.token + '-new' };
        boundary.modeRead.mockImplementation(async () => Response.json({ mode: 'plain', updatedAt: 2 }));
        await hook.rerender(); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(getActiveServerSnapshot()).toEqual(basis);
        expect(boundary.plainRead).toHaveBeenCalled();
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', fetchedAt: Date.now() + 1 })));
        await act(async () => { heldMode.resolve(Response.json({ mode: 'e2ee', updatedAt: 1 })); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(boundary.sealedRead).not.toHaveBeenCalled();
    });

    it('treats a plaintext miss as authoritative without trying a sealed representation', async () => {
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(null));
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).toHaveBeenCalledTimes(1);
        expect(boundary.sealedRead).not.toHaveBeenCalled();
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']).toBeNull();
        expect(hook.getCurrent().readByKey['anthropic/work']).toBe(true);
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
    });
});
