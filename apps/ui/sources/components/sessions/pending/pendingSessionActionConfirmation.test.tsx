import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { usePendingInputInterruptAndRunAction } = await import('./usePendingInputInterruptAndRunAction');
const { useTerminalComposerClearAction } = await import('../terminalComposer/useTerminalComposerClearAction');

const rpc = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const alert = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: rpc,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm, alert } }).module;
});

describe('pending Session Actions admission ownership', () => {
    let serverId = '';
    beforeEach(async () => {
        rpc.mockReset();
        confirm.mockReset().mockResolvedValue(true);
        alert.mockReset();
        await homes.reset();
        serverId = await homes.addHome({ name: 'Pending owner', serverUrl: 'https://pending-owner.test', accountId: 'owner' });
    });
    afterEach(async () => {
        await standardCleanup();
        await homes.reset();
    });

    it.each(['clear', 'interrupt'] as const)('dispatches the present user’s reversible %s intent without a duplicate dialog', async kind => {
        rpc.mockResolvedValue(kind === 'clear'
            ? { ok: true, sessionId: 'session-1', status: 'cleared' }
            : { ok: true, sessionId: 'session-1', localId: 'pending-1', status: 'interrupted' });
        const hook = await renderHook(() => kind === 'clear'
            ? useTerminalComposerClearAction('session-1', serverId).clearTerminalComposer
            : usePendingInputInterruptAndRunAction('session-1', serverId).interruptAndRun);
        await act(async () => { await hook.getCurrent()({ localId: 'pending-1', expectedStateAtMs: 42 }); });
        expect(rpc).toHaveBeenCalledWith({ sessionId: 'session-1', serverId,
            signal: expect.any(AbortSignal),
            method: kind === 'clear' ? 'session.terminalComposer.clear' : 'session.pendingInput.interruptAndRun',
            payload: { sessionId: 'session-1', expectedStateAtMs: 42, ...(kind === 'interrupt' ? { localId: 'pending-1' } : {}) } });
        expect(confirm).not.toHaveBeenCalled();
        expect(alert).not.toHaveBeenCalled();
    });

    it.each(['clear', 'interrupt'] as const)('keeps %s behind explicit Ask without a caller dialog', async kind => {
        const actionId = kind === 'clear' ? 'session.terminalComposer.clear' : 'session.pendingInput.interruptAndRun';
        await homes.requireUiApproval(serverId, actionId);
        const hook = await renderHook(() => kind === 'clear'
            ? useTerminalComposerClearAction('session-1', serverId).clearTerminalComposer
            : usePendingInputInterruptAndRunAction('session-1', serverId).interruptAndRun);
        await act(async () => { await hook.getCurrent()({ localId: 'pending-1', expectedStateAtMs: 42 }); });
        expect(confirm).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
        const artifacts = homes.artifacts(serverId).list();
        expect(artifacts).toHaveLength(1);
        expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifacts[0]!.id)!)).toMatchObject({ actionId, status: 'open' });
        expect(alert).not.toHaveBeenCalled();
    });

});
