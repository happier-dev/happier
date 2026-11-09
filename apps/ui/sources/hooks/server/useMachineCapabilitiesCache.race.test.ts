import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { act, flushHookEffects, renderHook } from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});

import { getMachineCapabilitiesCacheState, prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale, subscribeMachineCapabilitiesCacheState, useMachineCapabilitiesCache } from './useMachineCapabilitiesCache';

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

describe('machine capabilities cache races at the RPC boundary', () => {
    it('keeps failed finite capability reads finite with passive presenters, and recovers on real demand', async () => {
        vi.useFakeTimers();
        boundary.rpc.mockRejectedValue(new Error('Transient transport failure'));
        const targets = Array.from({ length: 22 }, (_, index) => ({
            machineId: `passive-finite-error-${index}`, serverId: 'passive-finite-home', request,
        }));
        let presenterRenders = 0;
        const presenters: Array<{
            getCurrent(): ReturnType<typeof useMachineCapabilitiesCache>;
            unmount(): Promise<void>;
        }> = [];
        try {
            for (const target of targets) presenters.push(await renderHook(() => {
                presenterRenders++;
                return useMachineCapabilitiesCache({ ...target, enabled: false });
            }));
            expect(boundary.rpc).not.toHaveBeenCalled();
            await act(async () => { await Promise.all(targets.map(target => prefetchMachineCapabilities(target))); });
            expect(boundary.rpc).toHaveBeenCalledTimes(22);
            expect(presenters.every(presenter => presenter.getCurrent().state.status === 'error')).toBe(true);
            const settledRenders = presenterRenders;

            // A display-only observer does not turn a completed finite collector
            // into a recurring RPC/publication owner, even over several backoffs.
            await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
            expect(boundary.rpc).toHaveBeenCalledTimes(22);
            expect(presenterRenders).toBe(settledRenders);
            expect(vi.getTimerCount()).toBe(0);

            boundary.rpc.mockResolvedValue(response('explicit-recovery'));
            await act(async () => presenters[0]!.getCurrent().refresh());
            expect(boundary.rpc).toHaveBeenCalledTimes(23);
            expect(presenters[0]!.getCurrent().state.status).toBe('loaded');
            const active = await renderHook(() => useMachineCapabilitiesCache({ ...targets[1]!, enabled: true }));
            try {
                expect(boundary.rpc).toHaveBeenCalledTimes(24);
                expect(active.getCurrent().state.status).toBe('loaded');
            } finally { await active.unmount(); }
        } finally {
            for (const presenter of presenters) await presenter.unmount();
        }
    });

    it.each([
        { label: 'request', request: { requests: [{ id: 'cli.codex', params: { includeLoginStatus: true } }] } },
        { label: 'override', request: { checklistId: CHECKLIST_IDS.MACHINE_DETAILS,
            overrides: { 'cli.codex': { params: { includeLoginStatus: true } } } } },
    ] satisfies ReadonlyArray<{ label: string; request: CapabilitiesDetectRequest }>)('retries a failed login probe from $label only on new demand, then reuses the successful answer with optional facts omitted', async ({ label, request: loginRequest }) => {
        boundary.rpc.mockResolvedValueOnce({ protocolVersion: 1, results: {
            'cli.codex': { ok: false, checkedAt: Date.now(), error: { code: 'probe_failed', message: 'Temporarily unavailable' } },
        } }).mockResolvedValue(response('recovered'));
        const target = { machineId: `failed-login-new-demand-${label}`, serverId: 'login-probe-home', request: loginRequest, enabled: true };
        const first = await renderHook(() => useMachineCapabilitiesCache(target));
        expect(first.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: { response: { results: { 'cli.codex': { ok: false } } } } });
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        await first.unmount();
        const reopened = await renderHook(() => useMachineCapabilitiesCache(target));
        expect(reopened.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: { response: { results: { 'cli.codex': { ok: true, data: { version: 'recovered' } } } } } });
        await reopened.unmount();
        const cached = await renderHook(() => useMachineCapabilitiesCache(target));
        expect(cached.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: { response: { results: { 'cli.codex': { ok: true } } } } });
        expect(boundary.rpc).toHaveBeenCalledTimes(2);
        await cached.unmount();
    });

    it('settles one capability set across mounts even when the daemon omits a requested optional fact, and probes a new readiness epoch', async () => {
        const optionalRequest: CapabilitiesDetectRequest = { requests: [{ id: 'cli.codex', params: { includeLatestVersion: true } }] };
        boundary.rpc.mockResolvedValue({ protocolVersion: 1, results: {
            'cli.codex': { ok: true, checkedAt: 1, data: { updateSupported: true } },
        } });
        const target = { machineId: 'settled-optional-fact', serverId: 'settled-home', request: optionalRequest, enabled: true };
        for (let mount = 0; mount < 6; mount++) {
            const hook = await renderHook(() => useMachineCapabilitiesCache({ ...target, cacheKeySalt: 1 }));
            expect(hook.getCurrent().state.status).toBe('loaded');
            await hook.unmount();
        }
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        const invalidated = await renderHook(() => useMachineCapabilitiesCache({ ...target, cacheKeySalt: 2 }));
        expect(invalidated.getCurrent().state.status).toBe('loaded');
        expect(boundary.rpc).toHaveBeenCalledTimes(2);
        await invalidated.unmount();
    });

    it('settles each cancelled reader without aborting a joined read, then recovers after the last reader leaves', async () => {
        const account = lifetime('consumer-signals');
        const firstController = new AbortController();
        const secondController = new AbortController();
        const target = { machineId: 'cache-consumer-signals', serverId: account.value.scope.serverId, accountLifetime: account.value, request };
        let transportSignal: AbortSignal | undefined;
        const reply = createDeferred<unknown>();
        boundary.rpc.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
            transportSignal = signal;
            // A late transport reply must not keep a cancelled cache flight reusable.
            return reply.promise;
        });
        let firstSettled = false;
        const first = prefetchMachineCapabilities({ ...target, signal: firstController.signal }).then(() => { firstSettled = true; });
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
        let secondSettled = false;
        const second = prefetchMachineCapabilitiesIfStale({ ...target, staleMs: 1000, signal: secondController.signal }).then(() => { secondSettled = true; });
        await Promise.resolve();
        expect(secondSettled).toBe(false);
        firstController.abort();
        await vi.waitFor(() => expect(firstSettled).toBe(true));
        expect(transportSignal?.aborted).toBe(false);
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId, undefined, account.value.scope.accountId)?.status).toBe('loading');
        secondController.abort();
        await Promise.all([first, second]);
        expect(transportSignal?.aborted).toBe(true);
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId, undefined, account.value.scope.accountId)?.status).toBe('idle');
        boundary.rpc.mockResolvedValueOnce(response('retried'));
        await prefetchMachineCapabilities(target);
        reply.resolve(response('cancelled-late'));
        await Promise.resolve();
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId, undefined, account.value.scope.accountId)).toMatchObject({ status: 'loaded', snapshot: { response: { results: { 'cli.codex': { data: { version: 'retried' } } } } } });
    });

    it('cancels a mounted capability reader on cleanup and lets the next mount retry', async () => {
        let transportSignal: AbortSignal | undefined;
        boundary.rpc.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
            transportSignal = signal;
            return new Promise(() => {});
        });
        const target = { machineId: 'cache-hook-cleanup', serverId: 'cache-hook-home', request, enabled: true };
        const first = await renderHook(() => useMachineCapabilitiesCache(target));
        expect(first.getCurrent().state.status).toBe('loading');
        await first.unmount();
        expect(transportSignal?.aborted).toBe(true);
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId)?.status).toBe('idle');
        boundary.rpc.mockResolvedValueOnce(response('remounted'));
        const next = await renderHook(() => useMachineCapabilitiesCache(target));
        expect(next.getCurrent().state.status).toBe('loaded');
        await next.unmount();
    });

    it('keeps the existing error retry owned by a remaining mounted reader after its issuer closes', async () => {
        vi.useFakeTimers();
        const reply = createDeferred<unknown>();
        boundary.rpc.mockReturnValueOnce(reply.promise).mockResolvedValueOnce(response('surviving-retry'));
        const target = { machineId: 'cache-surviving-retry', serverId: 'cache-surviving-home', request, enabled: true };
        const first = await renderHook(() => useMachineCapabilitiesCache(target));
        const second = await renderHook(() => useMachineCapabilitiesCache(target));
        await first.unmount();
        await act(async () => reply.reject(new Error('Transient transport failure')));
        expect(second.getCurrent().state.status).toBe('error');
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(second.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: { response: { results: { 'cli.codex': { data: { version: 'surviving-retry' } } } } } });
        await second.unmount();
    });

    it('cancels error retry when active detection ends even if a passive presenter remains', async () => {
        vi.useFakeTimers();
        boundary.rpc.mockRejectedValue(new Error('Transient transport failure'));
        const target = { machineId: 'active-error-with-passive', serverId: 'active-error-home', request };
        const passive = await renderHook(() => useMachineCapabilitiesCache({ ...target, enabled: false }));
        const active = await renderHook(() => useMachineCapabilitiesCache({ ...target, enabled: true }));
        try {
            expect(active.getCurrent().state.status).toBe('error');
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            await active.unmount();
            expect(vi.getTimerCount()).toBe(0);
            await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expect(passive.getCurrent().state.status).toBe('error');
        } finally { await passive.unmount(); }
    });

    it('transfers pending error recovery to a newly enabled reader without restarting the existing deadline', async () => {
        vi.useFakeTimers();
        boundary.rpc.mockRejectedValueOnce(new Error('Transient transport failure')).mockResolvedValue(response('newly-enabled-retry'));
        const target = { machineId: 'error-demand-successor', serverId: 'error-demand-successor-home', request, enabled: true };
        const first = await renderHook(() => useMachineCapabilitiesCache(target));
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        const successor = await renderHook(() => useMachineCapabilitiesCache(target));
        try {
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            await first.unmount();
            await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
            expect(boundary.rpc).toHaveBeenCalledTimes(2);
            expect(successor.getCurrent().state.status).toBe('loaded');
        } finally { await successor.unmount(); }
    });

    it('transfers pending error recovery across a finite acquisition after a successful active read', async () => {
        vi.useFakeTimers();
        boundary.rpc.mockResolvedValueOnce(response('initially-ready'));
        const target = { machineId: 'active-finite-overlap', serverId: 'active-finite-overlap-home', request };
        await prefetchMachineCapabilities(target);
        const active = await renderHook(() => useMachineCapabilitiesCache({ ...target, enabled: true }));
        try {
            expect(active.getCurrent().state.status).toBe('loaded');
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            boundary.rpc.mockRejectedValueOnce(new Error('Finite refresh failed')).mockResolvedValue(response('recovered-active-demand'));
            await act(async () => { await prefetchMachineCapabilities(target); });
            expect(active.getCurrent().state.status).toBe('error');
            expect(boundary.rpc).toHaveBeenCalledTimes(2);
            await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            expect(boundary.rpc).toHaveBeenCalledTimes(3);
            expect(active.getCurrent().state.status).toBe('loaded');
        } finally { await active.unmount(); }
    });

    it('disposes scoped recurring retry demand on Account retirement while a passive presenter remains', async () => {
        vi.useFakeTimers();
        boundary.rpc.mockRejectedValue(new Error('Transient transport failure'));
        const account = lifetime('retired-retry-demand');
        const recurring = new AbortController();
        const target = { machineId: 'retired-recurring-error', serverId: account.value.scope.serverId,
            accountLifetime: account.value, retryWhileObserved: recurring.signal, request };
        let publications = 0;
        const stop = subscribeMachineCapabilitiesCacheState(target.machineId, target.serverId, undefined,
            () => { publications++; }, account.value.scope.accountId);
        try {
            await prefetchMachineCapabilities(target);
            expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId, undefined, account.value.scope.accountId)?.status).toBe('error');
            expect(account.retirementObservers()).toBe(1);
            const settledPublications = publications;
            account.retire();
            expect(account.retirementObservers()).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(180_000);
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expect(publications).toBe(settledPublications);
        } finally { recurring.abort(); stop(); }
    });

    it('disposes scoped recurring retry demand after success without retaining a timer or retirement listener', async () => {
        vi.useFakeTimers();
        boundary.rpc.mockResolvedValue(response('ready-with-live-demand'));
        const account = lifetime('successful-retry-demand');
        const recurring = new AbortController();
        const target = { machineId: 'successful-recurring-demand', serverId: account.value.scope.serverId,
            accountLifetime: account.value, signal: recurring.signal, retryWhileObserved: recurring.signal, request };
        await prefetchMachineCapabilities(target);
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId, undefined, account.value.scope.accountId)?.status).toBe('loaded');
        expect(vi.getTimerCount()).toBe(0);
        expect(account.retirementObservers()).toBe(1);
        recurring.abort();
        expect(account.retirementObservers()).toBe(0);
        await vi.advanceTimersByTimeAsync(180_000);
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
    });

    it('releases Updates collection loading when its actual collector is cancelled', async () => {
        const { ensureMachineUpdateFactsBackground } = await import('@/capabilities/ensureAgentInstallablesBackground');
        const controller = new AbortController();
        let transportSignal: AbortSignal | undefined;
        boundary.rpc.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
            transportSignal = signal;
            return new Promise(() => {});
        });
        const target = { machineIds: ['cache-updates-collector'], serverId: 'cache-updates-home', signal: controller.signal };
        let settled = false;
        const pending = ensureMachineUpdateFactsBackground(target).then(() => { settled = true; });
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
        controller.abort();
        await vi.waitFor(() => expect(settled).toBe(true));
        await pending;
        expect(transportSignal?.aborted).toBe(true);
        const { MACHINE_UPDATE_FACTS_CACHE_SALT } = await import('@/updates/machineUpdateFacts');
        expect(getMachineCapabilitiesCacheState(target.machineIds[0]!, target.serverId, MACHINE_UPDATE_FACTS_CACHE_SALT)?.status).toBe('idle');
    });

    it('supersedes the mounted reader on explicit refresh so a stalled request can recover', async () => {
        let firstSignal: AbortSignal | undefined;
        boundary.rpc.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
            firstSignal = signal;
            return new Promise(() => {});
        });
        const target = { machineId: 'cache-explicit-retry', serverId: 'cache-explicit-home', request, enabled: true };
        const hook = await renderHook(() => useMachineCapabilitiesCache(target));
        boundary.rpc.mockResolvedValueOnce(response('explicit-retry'));
        await act(async () => hook.getCurrent().refresh());
        expect(firstSignal?.aborted).toBe(true);
        expect(hook.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: { response: { results: { 'cli.codex': { data: { version: 'explicit-retry' } } } } } });
        await hook.unmount();
    });

    it('ends the background install collector with its owner while projection discovery is pending', async () => {
        const { ensureAgentInstallablesBackground } = await import('@/capabilities/ensureAgentInstallablesBackground');
        const controller = new AbortController();
        let transportSignal: AbortSignal | undefined;
        boundary.rpc.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
            transportSignal = signal;
            return new Promise(() => {});
        });
        let settled = false;
        const pending = ensureAgentInstallablesBackground({
            agentId: 'codex', machineId: 'cache-install-collector', serverId: 'cache-install-home',
            settings: settingsParse({}), pluginSettings: { account: { codexBackendMode: 'acp' } },
            resumeSessionId: '', signal: controller.signal,
        }).then(() => { settled = true; });
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        controller.abort();
        await vi.waitFor(() => expect(settled).toBe(true));
        await pending;
        expect(transportSignal?.aborted).toBe(true);
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
    });

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

    it.each([true, false])('preserves the live predecessor and its partial result when a queued middle reader cancels (successor already queued: %s)', async (successorAlreadyQueued) => {
        const firstReply = createDeferred<unknown>();
        const lastReply = createDeferred<unknown>();
        boundary.rpc.mockReturnValueOnce(firstReply.promise).mockReturnValueOnce(lastReply.promise);
        const target = { machineId: `cache-cancelled-middle-${successorAlreadyQueued}`, serverId: 'cache-cancelled-middle-home' };
        const first = prefetchMachineCapabilities({ ...target, request });
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
        const controller = new AbortController();
        const middle = prefetchMachineCapabilities({ ...target, signal: controller.signal,
            request: { requests: [{ id: 'cli.codex', params: { includeLoginStatus: true } }] } });
        const lastParams = { ...target, request: { requests: [{ id: 'cli.claude' as const }] } };
        const queuedLast = successorAlreadyQueued ? prefetchMachineCapabilities(lastParams) : null;
        controller.abort();
        await middle;
        const last = queuedLast ?? prefetchMachineCapabilities(lastParams);
        // Cancelling an unused queue slot cannot release the still-owned predecessor.
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        firstReply.resolve(response('retained-predecessor'));
        await first;
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(2));
        lastReply.resolve({ protocolVersion: 1, results: { 'cli.claude': { ok: true, checkedAt: 1, data: { version: 'successor' } } } });
        await last;
        expect(getMachineCapabilitiesCacheState(target.machineId, target.serverId)).toMatchObject({ status: 'loaded', snapshot: { response: { results: {
            'cli.codex': { data: { version: 'retained-predecessor' } }, 'cli.claude': { data: { version: 'successor' } },
        } } } });
    });

    it('settles a failed agent update probe across repeated background demands until its retry cadence or inputs change', async () => {
        const { ensureMachineUpdateFactsBackground } = await import('@/capabilities/ensureAgentInstallablesBackground');
        const { buildMachineUpdateFactsRequest } = await import('@/capabilities/requests');
        const ids = (buildMachineUpdateFactsRequest().requests ?? []).map(({ id }) => id);
        const answer = (codex: Record<string, unknown>) => ({ protocolVersion: 1, results: Object.fromEntries(ids.map(id => [id,
            id === 'cli.codex' ? codex : { ok: true, checkedAt: Date.now(), data: { updateSupported: true, latestVersion: '1.0.0', version: '1.0.0' } }])) });
        // The daemon checked codex and its probe failed: a typed, settled answer.
        boundary.rpc.mockImplementation(async () => answer({ ok: false, checkedAt: Date.now(), error: { code: 'probe_failed', message: 'Temporarily unavailable' } }));
        const target = { machineIds: ['cache-updates-failed-probe'], serverId: 'cache-updates-failed-home' };
        await ensureMachineUpdateFactsBackground(target);
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        // Each Machine wake re-runs the background reader with unchanged inputs.
        for (let wake = 0; wake < 5; wake += 1) await ensureMachineUpdateFactsBackground(target);
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        // The shared failure cadence, not the wake, decides the next ask.
        const { LATEST_VERSION_CHECK_RETRY_MS } = await import('@/updates/latestVersionCheckFreshness');
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now + LATEST_VERSION_CHECK_RETRY_MS + 1);
        try {
            await ensureMachineUpdateFactsBackground(target);
            await ensureMachineUpdateFactsBackground(target);
            expect(boundary.rpc).toHaveBeenCalledTimes(2);
        } finally { clock.mockRestore(); }
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
