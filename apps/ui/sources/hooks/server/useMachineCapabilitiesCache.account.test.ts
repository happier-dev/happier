import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { act, renderHook } from '@/dev/testkit';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});

import { getMachineCapabilitiesCacheState, prefetchMachineCapabilities, useMachineCapabilitiesCache } from './useMachineCapabilitiesCache';

const response = (version: string) => ({ protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: { version } } } });
const request: CapabilitiesDetectRequest = { checklistId: CHECKLIST_IDS.NEW_SESSION, requests: [{ id: 'cli.codex', params: { includeLoginStatus: false } }] };

function lifetime(accountId: string) {
    let current = true;
    const callbacks = new Set<() => void>();
    const value: ServerAccountScopeLifetime = { scope: { serverId: 'cache-accounts', accountId }, isCurrent: () => current,
        onRetire(cancel) { callbacks.add(cancel); return { dispose() { callbacks.delete(cancel); } }; } };
    return { value, retirementObservers: () => callbacks.size,
        retire() { current = false; for (const cancel of callbacks) cancel(); } };
}

afterEach(() => { boundary.rpc.mockReset(); vi.useRealTimers(); });

describe('public machine capability Account lifetime', () => {
    it('keeps public hook observations scoped to the current Account during a switch', async () => {
        const a = lifetime('public-cached-a');
        const b = lifetime('public-cached-b');
        const target = { machineId: 'public-cached-account-switch', serverId: a.value.scope.serverId, request };
        boundary.rpc.mockResolvedValueOnce(response('cached-a')).mockResolvedValueOnce(response('cached-b'));
        await prefetchMachineCapabilities({ ...target, accountLifetime: a.value });
        await prefetchMachineCapabilities({ ...target, accountLifetime: b.value });
        const observations: unknown[] = [];
        const hook = await renderHook(({ accountLifetime }: { accountLifetime: ServerAccountScopeLifetime }) => {
            const result = useMachineCapabilitiesCache({ ...target, enabled: false, accountLifetime });
            observations.push(result.state);
            return result;
        }, { initialProps: { accountLifetime: a.value } });
        try {
            expect(hook.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: { response: { results: {
                'cli.codex': { data: { version: 'cached-a' } },
            } } } });
            observations.length = 0;
            await hook.rerender({ accountLifetime: b.value });
            expect(observations.length).toBeGreaterThan(0);
            for (const state of observations) expect(state).toMatchObject({ status: 'loaded', snapshot: { response: { results: {
                'cli.codex': { data: { version: 'cached-b' } },
            } } } });
        } finally { await hook.unmount(); }
    });

    it('passes the public hook Account lifetime through detection and refresh and retires old callbacks', async () => {
        const a = lifetime('public-live-a');
        const b = lifetime('public-live-b');
        const target = { machineId: 'public-live-account-switch', serverId: a.value.scope.serverId, request };
        boundary.rpc.mockImplementation(({ accountId }: { accountId?: string | null }) => Promise.resolve(response(accountId ?? 'unscoped')));
        const hook = await renderHook(({ accountLifetime }: { accountLifetime: ServerAccountScopeLifetime }) => (
            useMachineCapabilitiesCache({ ...target, enabled: true, accountLifetime })
        ), { initialProps: { accountLifetime: a.value } });
        try {
            expect(hook.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: { response: { results: {
                'cli.codex': { data: { version: 'public-live-a' } },
            } } } });
            const retiredRefresh = hook.getCurrent().refresh;
            boundary.rpc.mockResolvedValueOnce(response('refreshed-a'));
            await act(async () => { hook.getCurrent().refresh(); });
            expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId, undefined, a.value.scope.accountId)).toMatchObject({
                status: 'loaded', snapshot: { response: { results: { 'cli.codex': { data: { version: 'refreshed-a' } } } } },
            });
            a.retire();
            await hook.rerender({ accountLifetime: b.value });
            expect(hook.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: { response: { results: {
                'cli.codex': { data: { version: 'public-live-b' } },
            } } } });
            const requestsBeforeRetiredRefresh = boundary.rpc.mock.calls.length;
            await act(async () => { retiredRefresh(); });
            expect(boundary.rpc).toHaveBeenCalledTimes(requestsBeforeRetiredRefresh);
        } finally { await hook.unmount(); }
    });

});
