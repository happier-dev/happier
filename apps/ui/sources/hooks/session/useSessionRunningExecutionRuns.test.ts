import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { HomeCredentialMutationEvent } from '@/auth/storage/tokenStorage';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const rpc = vi.hoisted(() => vi.fn());
const credentialListeners = vi.hoisted(() => new Set<(event: HomeCredentialMutationEvent) => void>());
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        subscribeHomeCredentialMutations: (listener) => {
            credentialListeners.add(listener);
            return () => { credentialListeners.delete(listener); };
        },
    });
});
// Complete network boundary: importing its live implementation here recursively
// boots UI sync. List parsing, roster projection and activity delivery stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => rpc(params),
    sessionRpcWithServerAccountScope: (params: unknown) => rpc(params),
} satisfies typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc')));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ storage: { getState: () => ({ sessions: {}, settings: {} }) } });
});

import { resolveRunningExecutionRunsFromListResult, useSessionRunningExecutionRuns } from './useSessionRunningExecutionRuns';
import { notifyExecutionRunActivity, notifyExecutionRunActivityFromUpdate, notifyExecutionRunActivityReconnect } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

function run(runId = 'run_1', status: ExecutionRunPublicState['status'] = 'running'): ExecutionRunPublicState {
    return {
        runId, callId: runId, sidechainId: runId, intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
        ioMode: 'request_response', status, startedAtMs: 123,
    };
}

function roster(serverId = 'server-a', sessionId = 's1') {
    return renderHook(() => useSessionRunningExecutionRuns({ serverId, sessionId, enabled: true }));
}

describe('resolveRunningExecutionRunsFromListResult', () => {
    it('projects only the owner states that are running', () => {
        expect(resolveRunningExecutionRunsFromListResult({
            runs: [run(), run('run_2', 'failed'), run('run_3', 'succeeded')],
        }).map((item) => item.runId)).toEqual(['run_1']);
        expect(resolveRunningExecutionRunsFromListResult({ ok: false, error: 'offline' })).toEqual([]);
    });
});

describe('useSessionRunningExecutionRuns', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        rpc.mockReset();
    });
    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('updates running and terminal rosters on activity without timer reads', async () => {
        rpc.mockResolvedValueOnce({ runs: [run()] }).mockResolvedValueOnce({ runs: [run('run_1', 'succeeded')] });
        const hook = await roster();
        expect(hook.getCurrent().map((item) => item.runId)).toEqual(['run_1']);
        await flushHookEffects({ advanceTimersMs: 60_000 });
        expect(rpc).toHaveBeenCalledTimes(1);
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' }, { runId: 'run_1' });
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual([]);
        expect(rpc).toHaveBeenCalledTimes(2);
        await flushHookEffects({ advanceTimersMs: 60_000 });
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('shares one baseline and activity read between simultaneous visible consumers', async () => {
        rpc.mockResolvedValueOnce({ runs: [run()] }).mockResolvedValueOnce({ runs: [] });
        const first = await roster();
        const second = await roster();
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(second.getCurrent()).toBe(first.getCurrent());
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' });
        await flushHookEffects();
        expect(first.getCurrent()).toEqual([]);
        expect(second.getCurrent()).toBe(first.getCurrent());
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('does not read demanded rosters for 1,000 detailed unrelated Account arrivals', async () => {
        rpc.mockResolvedValue({ runs: [run()] });
        const first = await roster();
        const second = await roster('server-a', 's2');
        const previous = first.getCurrent();
        expect(rpc).toHaveBeenCalledTimes(2);
        for (let index = 0; index < 1_000; index++) {
            publishHomeAccountChange('server-a', [`artifact-${index}`, `session-${index}`], {
                changeKinds: ['artifact', 'session', 'machine', 'account'],
            });
        }
        await flushHookEffects({ advanceTimersMs: 60_000 });
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(first.getCurrent()).toBe(previous);

        // A collaborator gets no live Run hints: a published content page is its
        // only signal, so it still reads once per page for a Session it does not own.
        publishHomeAccountChange('server-a', ['s1'], { feedPageConsumed: true, changeKinds: ['session'] });
        await flushHookEffects();
        expect(rpc).toHaveBeenCalledTimes(3);
        // Own-Session access changes and coarse wakes can still change admission.
        publishHomeAccountChange('server-a', ['s1'], { changeKinds: ['share'] });
        await flushHookEffects();
        expect(rpc).toHaveBeenCalledTimes(4);
        publishHomeAccountChange('server-a');
        await flushHookEffects();
        expect(rpc).toHaveBeenCalledTimes(6);

        rpc.mockResolvedValueOnce({ runs: [] });
        notifyExecutionRunActivityFromUpdate('server-a', {
            type: 'execution-run-updated', sessionId: 's1', run: run('run_1', 'succeeded'),
        });
        await flushHookEffects();
        expect(first.getCurrent()).toEqual([]);
        expect(second.getCurrent().map(item => item.runId)).toEqual(['run_1']);
        expect(rpc).toHaveBeenCalledTimes(7);

        notifyExecutionRunActivityReconnect('server-a');
        await flushHookEffects();
        expect(rpc).toHaveBeenCalledTimes(9);
    });

    it('keeps unchanged rows and snapshots stable and does not render siblings', async () => {
        rpc.mockResolvedValue({ runs: [run()] });
        const hook = await roster();
        const first = hook.getCurrent();
        notifyExecutionRunActivity({ serverId: 'server-b', sessionId: 's1' });
        await flushHookEffects();
        expect(rpc).toHaveBeenCalledTimes(1);
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(first);
        rpc.mockResolvedValue({ runs: [run(), run('run_2')] });
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' });
        await flushHookEffects();
        expect(hook.getCurrent()[0]).toBe(first[0]);
    });

    it('catches up missed terminal activity on the existing Home reconnect wake', async () => {
        rpc.mockResolvedValueOnce({ runs: [run()] })
            .mockResolvedValueOnce({ ok: false, error: 'disconnected' })
            .mockResolvedValueOnce({ runs: [] });
        const hook = await roster();
        const lastKnown = hook.getCurrent();
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(lastKnown);
        await flushHookEffects({ advanceTimersMs: 60_000 });
        expect(rpc).toHaveBeenCalledTimes(2);
        notifyExecutionRunActivityReconnect('server-b');
        await flushHookEffects();
        expect(rpc).toHaveBeenCalledTimes(2);
        notifyExecutionRunActivityReconnect('server-a');
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual([]);
        expect(rpc).toHaveBeenCalledTimes(3);
    });

    it('recovers a failed empty baseline on reconnect without retry timers', async () => {
        rpc.mockResolvedValueOnce({ ok: false, error: 'disconnected' }).mockResolvedValueOnce({ runs: [run()] });
        const hook = await roster();
        await flushHookEffects({ advanceTimersMs: 60_000 });
        expect(rpc).toHaveBeenCalledTimes(1);
        notifyExecutionRunActivityReconnect('server-a');
        await flushHookEffects();
        expect(hook.getCurrent().map((item) => item.runId)).toEqual(['run_1']);
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('subscribes before the baseline and coalesces activity during an in-flight read', async () => {
        let resolveBaseline!: (result: { runs: ExecutionRunPublicState[] }) => void;
        rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveBaseline = resolve; }))
            .mockResolvedValueOnce({ runs: [run()] });
        const first = await roster();
        const second = await roster();
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' });
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' });
        resolveBaseline({ runs: [] });
        await flushHookEffects();
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(first.getCurrent().map((item) => item.runId)).toEqual(['run_1']);
        expect(second.getCurrent()).toBe(first.getCurrent());
    });

    it('isolates equal Session ids in different Homes', async () => {
        rpc.mockImplementation(({ serverId }) => Promise.resolve({ runs: [run(serverId)] }));
        const homeA = await roster();
        const homeB = await roster('server-b');
        expect(homeA.getCurrent().map((item) => item.runId)).toEqual(['server-a']);
        expect(homeB.getCurrent().map((item) => item.runId)).toEqual(['server-b']);
        expect(rpc).toHaveBeenCalledWith({
            serverId: 'server-b', sessionId: 's1', method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, payload: {},
        });
        rpc.mockResolvedValueOnce({ runs: [] });
        const update = {
            type: 'execution-run-updated', sessionId: 's1', run: run('server-b', 'succeeded'),
        };
        notifyExecutionRunActivityFromUpdate('server-b', update);
        await flushHookEffects();
        expect(homeB.getCurrent()).toEqual([]);
        expect(homeA.getCurrent().map((item) => item.runId)).toEqual(['server-a']);
        expect(rpc).toHaveBeenCalledTimes(3);
    });

    it('clears the old address and does not lose the new baseline behind an old in-flight read', async () => {
        let resolveOld!: (result: { runs: ExecutionRunPublicState[] }) => void;
        rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
            .mockResolvedValueOnce({ runs: [run('new')] });
        const hook = await renderHook(({ sessionId }) => useSessionRunningExecutionRuns({
            sessionId, serverId: 'server-a', enabled: true,
        }), { initialProps: { sessionId: 'old' } });
        await hook.rerender({ sessionId: 'new' });
        expect(hook.getCurrent().map((item) => item.runId)).toEqual(['new']);
        resolveOld({ runs: [run('old')] });
        await flushHookEffects();
        expect(hook.getCurrent().map((item) => item.runId)).toEqual(['new']);
    });

    it('keeps the shared projection until the last consumer detaches then catches up on remount', async () => {
        rpc.mockResolvedValueOnce({ runs: [run()] }).mockResolvedValueOnce({ runs: [] }).mockResolvedValueOnce({ runs: [run('new')] });
        const first = await roster();
        const second = await roster();
        await first.unmount();
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' });
        await flushHookEffects();
        expect(second.getCurrent()).toEqual([]);
        await second.unmount();
        publishHomeAccountChange('server-a');
        await flushHookEffects();
        expect(rpc).toHaveBeenCalledTimes(2);
        const remounted = await roster();
        expect(remounted.getCurrent().map((item) => item.runId)).toEqual(['new']);
        expect(rpc).toHaveBeenCalledTimes(3);
    });

    it('withdraws disabled demand and catches up when enabled again', async () => {
        rpc.mockResolvedValueOnce({ runs: [run()] }).mockResolvedValueOnce({ runs: [] });
        const hook = await renderHook(({ enabled }) => useSessionRunningExecutionRuns({
            sessionId: 's1', serverId: 'server-a', enabled,
        }), { initialProps: { enabled: true } });
        await hook.rerender({ enabled: false });
        expect(hook.getCurrent()).toEqual([]);
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' });
        publishHomeAccountChange('server-a');
        await flushHookEffects();
        expect(rpc).toHaveBeenCalledTimes(1);
        await hook.rerender({ enabled: true });
        expect(hook.getCurrent()).toEqual([]);
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('refreshes on a changed transcript key without duplicating the initial baseline', async () => {
        rpc.mockResolvedValueOnce({ runs: [] }).mockResolvedValueOnce({ runs: [run()] });
        const hook = await renderHook(({ refreshKey }) => useSessionRunningExecutionRuns({
            sessionId: 's1', serverId: 'server-a', enabled: true, refreshKey,
        }), { initialProps: { refreshKey: 'before' } });
        expect(rpc).toHaveBeenCalledTimes(1);
        await hook.rerender({ refreshKey: 'after' });
        expect(hook.getCurrent().map((item) => item.runId)).toEqual(['run_1']);
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('retires Account data and rejects an old in-flight response when credentials change', async () => {
        let resolveOld!: (result: { runs: ExecutionRunPublicState[] }) => void;
        rpc.mockResolvedValueOnce({ runs: [run('account-a')] })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
            .mockResolvedValueOnce({ runs: [run('account-b')] });
        const hook = await roster();
        notifyExecutionRunActivity({ serverId: 'server-a', sessionId: 's1' });
        const event: HomeCredentialMutationEvent = {
            kind: 'credentials_set', serverId: 'server-a', serverUrl: 'https://server-a.test',
        };
        await act(async () => {
            for (const listener of [...credentialListeners]) listener(event);
        });
        await flushHookEffects();
        expect(hook.getCurrent().map((item) => item.runId)).toEqual(['account-b']);
        resolveOld({ runs: [run('account-a')] });
        await flushHookEffects();
        expect(hook.getCurrent().map((item) => item.runId)).toEqual(['account-b']);
        await act(async () => {
            for (const listener of [...credentialListeners]) listener({ ...event, kind: 'credentials_removed' });
        });
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual([]);
    });
});
