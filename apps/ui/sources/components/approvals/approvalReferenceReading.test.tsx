import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';

// The one system boundary here: an exact Session read goes to the Home's server.
const exactRead = vi.hoisted(() => vi.fn());
vi.mock('@/sync/sync', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/sync')>(),
    sync: { ensureSessionVisibleForMessageRoute: exactRead },
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { storage } = await import('@/sync/domains/state/storage');
const { useApprovalSessionReading } = await import('./useApprovalSessionReading');

describe('approval session reference resolution', () => {
    beforeEach(async () => {
        standardCleanup();
        await harness.reset();
        storage.setState({ sessionListRowsByServerId: {}, concurrentSessionListCacheByServerId: {} });
    });
    afterEach(() => standardCleanup());

    it('keeps a requester neutral while its exact Home list resolves, then names the arriving Session', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://requester.example',
            accountId: 'account-1', serverIdentityId: 'srv_requester' });
        const hook = await renderHook(() => useApprovalSessionReading(home, 'requester'));
        expect(hook.getCurrent()).toMatchObject({ status: 'resolving', name: null });
        await act(async () => {
            const row = buildSessionListRenderableFromSession(createSessionFixture({ id: 'requester', serverId: home,
                metadata: { path: '/repo', host: 'requester.example', name: 'The requesting Session' } }));
            storage.setState(state => ({
                sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [home]: { requester: row } },
                concurrentSessionListCacheByServerId: { ...state.concurrentSessionListCacheByServerId,
                    [home]: { serverName: 'Approval Home', listObservation: { phase: 'ready', lastSuccessAt: 1 } } },
            }));
        });
        expect(hook.getCurrent()).toMatchObject({
            status: 'ready', name: 'The requesting Session',
        });
    });

    it.each(['ready', 'offline', 'error'] as const)('settles an absent requester when its Home list is %s', async phase => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://requester.example',
            accountId: 'account-1', serverIdentityId: 'srv_requester' });
        const hook = await renderHook(() => useApprovalSessionReading(home, 'requester'));
        await act(async () => {
            storage.setState(state => ({ concurrentSessionListCacheByServerId: {
                ...state.concurrentSessionListCacheByServerId,
                [home]: { serverName: 'Approval Home', listObservation: { phase, lastSuccessAt: phase === 'ready' ? 1 : null } },
            } }));
        });
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', name: null });
    });

    it('keeps a requester reading still when another Home changes', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://requester.example',
            accountId: 'account-1', serverIdentityId: 'srv_requester' });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useApprovalSessionReading(home, 'requester');
        });
        const before = renders;
        await act(async () => {
            storage.setState(state => ({ concurrentSessionListCacheByServerId: {
                ...state.concurrentSessionListCacheByServerId,
                other: { serverName: 'Other Home', listObservation: { phase: 'ready', lastSuccessAt: 1 } },
            } }));
        });
        expect(renders).toBe(before);
        expect(hook.getCurrent().status).toBe('resolving');
    });

    it('settles the detail requester when its captured Home resolution becomes unavailable', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://requester.example',
            accountId: 'account-1', serverIdentityId: 'srv_requester' });
        type Resolution = import('@/sync/domains/scope/useServerCredentialAccountScopes').ServerCredentialAccountScopeResolution;
        const hook = await renderHook<ReturnType<typeof useApprovalSessionReading>, { resolution: Resolution }>(
            ({ resolution }) => useApprovalSessionReading(home, 'requester', resolution),
            { initialProps: { resolution: { kind: 'resolving' } } },
        );
        expect(hook.getCurrent().status).toBe('resolving');
        await hook.rerender({ resolution: { kind: 'signed_out' } });
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', name: null });
    });

    it('fences a cached detail requester until its captured Home resolves and after sign-out', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://requester.example',
            accountId: 'account-1', serverIdentityId: 'srv_requester' });
        const row = buildSessionListRenderableFromSession(createSessionFixture({ id: 'requester', serverId: home,
            metadata: { path: '/repo', host: 'requester.example', name: 'The requesting Session' } }));
        storage.setState({ sessionListRowsByServerId: { [home]: { requester: row } } });
        type Resolution = import('@/sync/domains/scope/useServerCredentialAccountScopes').ServerCredentialAccountScopeResolution;
        const hook = await renderHook<ReturnType<typeof useApprovalSessionReading>, { resolution: Resolution }>(
            ({ resolution }) => useApprovalSessionReading(home, 'requester', resolution),
            { initialProps: { resolution: { kind: 'resolving' } } },
        );
        expect(hook.getCurrent()).toMatchObject({ status: 'resolving', name: null, session: null });
        await hook.rerender({ resolution: { kind: 'bound', scope: { serverId: 'srv_requester', accountId: 'account-1' } } });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', name: 'The requesting Session' });
        await hook.rerender({ resolution: { kind: 'signed_out' } });
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', name: null, session: null });
        // The cached row remains: the detail's captured resolution, not deletion in
        // a fixture, must prevent its title from leaking after credential loss.
        expect(storage.getState().sessionListRowsByServerId[home]?.requester).toBe(row);
    });

    describe('a requester outside the Home list pages already read', () => {
        beforeEach(() => exactRead.mockReset());
        afterEach(() => exactRead.mockReset());

        async function addLoadingHome() {
            const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://requester.example',
                accountId: 'account-1', serverIdentityId: 'srv_requester' });
            // A large Account's list is still on its first pages: the Home never settles as "read".
            storage.setState({ concurrentSessionListCacheByServerId: { [home]: {
                serverName: 'Approval Home', listObservation: { phase: 'loading', lastSuccessAt: null } } } });
            return home;
        }
        const bound = { kind: 'bound', scope: { serverId: 'srv_requester', accountId: 'account-1' } } as const;

        it('names it from one exact read of that Session instead of waiting for the whole list', async () => {
            const home = await addLoadingHome();
            exactRead.mockImplementation(async (sessionId) => {
                const row = buildSessionListRenderableFromSession(createSessionFixture({ id: sessionId, serverId: home,
                    metadata: { path: '/repo', host: 'requester.example', name: 'The requesting Session' } }));
                storage.setState(state => ({ sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [home]: { [sessionId]: row } } }));
                return { kind: 'available', sessionId, serverId: home };
            });
            const hook = await renderHook(() => useApprovalSessionReading(home, 'requester', bound, { exactRead: true }));
            await act(async () => {});
            expect(exactRead).toHaveBeenCalledWith('requester', expect.objectContaining({ serverId: home, hydrateMessages: false }));
            expect(hook.getCurrent()).toMatchObject({ status: 'ready', name: 'The requesting Session' });
        });

        it('settles as unavailable when the Home answers that the Session is not there', async () => {
            const home = await addLoadingHome();
            exactRead.mockResolvedValue({ kind: 'missing', sessionId: 'requester', serverId: home, cause: 'not_found' });
            const hook = await renderHook(() => useApprovalSessionReading(home, 'requester', bound, { exactRead: true }));
            await act(async () => {});
            expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', name: null });
        });

        it('settles as unavailable, not loading, when the exact read failed and is retrying', async () => {
            const home = await addLoadingHome();
            exactRead.mockResolvedValue({ kind: 'retryable_failure', sessionId: 'requester', serverId: home, cause: 'network' });
            const hook = await renderHook(() => useApprovalSessionReading(home, 'requester', bound, { exactRead: true }));
            await act(async () => {});
            expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', name: null });
        });

        it('stays resolving, without a claim, while the exact read is in flight', async () => {
            const home = await addLoadingHome();
            exactRead.mockReturnValue(new Promise(() => {}));
            const hook = await renderHook(() => useApprovalSessionReading(home, 'requester', bound, { exactRead: true }));
            await act(async () => {});
            expect(hook.getCurrent()).toMatchObject({ status: 'resolving', name: null });
        });

        it('settles as unavailable, never resolving, once the detail knows its Home is unavailable', async () => {
            const home = await addLoadingHome();
            exactRead.mockReturnValue(new Promise(() => {}));
            const hook = await renderHook(() => useApprovalSessionReading(home, 'requester', bound, { exactRead: true, homeUnavailable: true }));
            await act(async () => {});
            expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', name: null });
            expect(exactRead).not.toHaveBeenCalled();
        });

        it('leaves list rows to the list: a row never starts an exact read', async () => {
            const home = await addLoadingHome();
            await renderHook(() => useApprovalSessionReading(home, 'requester', bound));
            await act(async () => {});
            expect(exactRead).not.toHaveBeenCalled();
        });
    });
});
