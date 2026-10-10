import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});

import { getMachineCapabilitiesCacheState, prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale } from './useMachineCapabilitiesCache';

const response = (version: string) => ({ protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: { version } } } });
const request: CapabilitiesDetectRequest = { checklistId: CHECKLIST_IDS.NEW_SESSION, requests: [{ id: 'cli.codex', params: { includeLoginStatus: false } }] };

function lifetime(accountId: string) {
    let current = true;
    const callbacks = new Set<() => void>();
    const value: ServerAccountScopeLifetime = { scope: { serverId: 'cache-accounts', accountId }, isCurrent: () => current,
        onRetire(cancel) { callbacks.add(cancel); return { dispose() { callbacks.delete(cancel); } }; } };
    return { value, retire() { current = false; for (const cancel of callbacks) cancel(); } };
}

afterEach(() => { boundary.rpc.mockReset(); vi.useRealTimers(); });

describe('machine capabilities cache races at the RPC boundary', () => {
    it.each([
        { label: 'machine-details', request: { checklistId: CHECKLIST_IDS.MACHINE_DETAILS } },
        { label: 'execution-runs', request: { requests: [{ id: 'tool.executionRuns' }] } },
        { label: 'login-status', request: { checklistId: CHECKLIST_IDS.NEW_SESSION,
            overrides: { 'cli.codex': { params: { includeLoginStatus: true } } } } },
    ] satisfies ReadonlyArray<{ label: string; request: CapabilitiesDetectRequest }>)('keeps $label detection pending beyond the retired default deadlines and publishes its result', async ({ label, request }) => {
        vi.useFakeTimers();
        const reply = createDeferred<unknown>();
        // Model the transport honoring an explicit deadline; cache and capability
        // operations remain real, so restoring their old defaults fails this case.
        boundary.rpc.mockImplementation(({ timeoutMs }: { timeoutMs?: number }) => {
            if (typeof timeoutMs !== 'number') return reply.promise;
            return Promise.race([reply.promise, new Promise((resolve) => {
                setTimeout(() => resolve({ error: 'Timeout' }), timeoutMs);
            })]);
        });
        const target = { machineId: `cache-unbounded-${label}`, serverId: 'cache-unbounded-home' };
        const pending = prefetchMachineCapabilities({ ...target, request });
        try {
            await vi.advanceTimersByTimeAsync(21_000);
            expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId)).toMatchObject({ status: 'loading' });
        } finally {
            reply.resolve(response('completed-after-retired-deadline'));
            await pending;
        }
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId)).toMatchObject({ status: 'loaded', snapshot: {
            response: { results: { 'cli.codex': { data: { version: 'completed-after-retired-deadline' } } } },
        } });
    });

    it('keeps a shared Account read alive when one presenter closes and another remains current', async () => {
        const firstReader = lifetime('shared-account');
        const secondReader = lifetime('shared-account');
        const target = { machineId: 'cache-shared-readers', serverId: firstReader.value.scope.serverId, request };
        boundary.rpc.mockResolvedValueOnce(response('cached-version'));
        await prefetchMachineCapabilities({ ...target, accountLifetime: firstReader.value });
        const pending = createDeferred<unknown>();
        boundary.rpc.mockImplementation(({ signal }: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
            void pending.promise.then(resolve, reject);
        }));
        const first = prefetchMachineCapabilities({ ...target, accountLifetime: firstReader.value });
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(2));
        const second = prefetchMachineCapabilitiesIfStale({ ...target, staleMs: 1000, accountLifetime: secondReader.value });
        firstReader.retire();
        pending.resolve(response('shared-version'));
        await Promise.all([first, second]);
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId, undefined, secondReader.value.scope.accountId)).toMatchObject({ status: 'loaded', snapshot: { response: { results: { 'cli.codex': { data: { version: 'shared-version' } } } } } });
    });

    it('serializes overlapping requests and keeps the newest loaded state', async () => {
        const firstResponse = createDeferred<unknown>();
        const secondResponse = createDeferred<unknown>();
        boundary.rpc.mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(secondResponse.promise);
        const target = { machineId: 'cache-queued', serverId: 'cache-server' };
        const first = prefetchMachineCapabilities({ ...target, request, timeoutMs: 10_000 });
        const second = prefetchMachineCapabilities({ ...target, request: { ...request, requests: [{ id: 'cli.codex', params: { includeLoginStatus: true } }] }, timeoutMs: 10_000 });
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
        firstResponse.resolve(response('1'));
        await first;
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(2));
        secondResponse.resolve(response('2'));
        await second;
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId)).toMatchObject({ status: 'loaded', snapshot: { response: { results: { 'cli.codex': { data: { version: '2' } } } } } });
    });

    it('keeps the successor Account independent and rejects a retired late result', async () => {
        const a = lifetime('account-a');
        const b = lifetime('account-b');
        const pending = createDeferred<unknown>();
        let currentAccount = 'account-a';
        boundary.rpc.mockImplementation(({ accountId }: { accountId?: string | null }) => {
            if (accountId !== currentAccount) return Promise.reject(new Error('Account credential changed'));
            return accountId === 'account-a' ? pending.promise : Promise.resolve(response('account-b-version'));
        });
        const target = { machineId: 'cache-switched', serverId: a.value.scope.serverId, cacheKeySalt: 'daemon-version-1', request };
        const first = prefetchMachineCapabilities({ ...target, accountLifetime: a.value });
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalled());
        a.retire();
        currentAccount = 'account-b';
        await prefetchMachineCapabilities({ ...target, accountLifetime: b.value });
        pending.resolve(response('retired-account-a-version'));
        await first;
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId, target.cacheKeySalt, b.value.scope.accountId)).toMatchObject({ status: 'loaded', snapshot: { response: { results: { 'cli.codex': { data: { version: 'account-b-version' } } } } } });
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId, target.cacheKeySalt, a.value.scope.accountId)).not.toMatchObject({ status: 'loaded' });
    });
});
