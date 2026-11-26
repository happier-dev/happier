import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

// The Machine RPC transport is the only boundary: `get` answers like the daemon, with the result a list omits.
const rpc = vi.hoisted(() => ({ calls: [] as Array<{ method: string; payload: unknown; machineId: string }>, stored: null as unknown }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (input: { method: string; payload: unknown; machineId: string }) => {
        rpc.calls.push(input);
        return { kind: 'found', operation: rpc.stored };
    },
}));

const scope = { serverId: 'home', accountId: 'account', machineId: 'machine', sessionId: 'session' };
function open(overrides: Record<string, unknown> = {}) {
    return ActionOperationSnapshotV1Schema.parse({
        version: 1, operationId: 'open-1', revision: 1, actionId: 'browser.view.open', state: 'running',
        title: 'Open Browser', createdAt: 1, startedAt: 2, cancellation: 'unsupported',
        scope: { accountId: scope.accountId, machineId: scope.machineId, sessionId: scope.sessionId }, ...overrides,
    });
}
const sandboxResult = { v: 1, commandId: 'c', status: 'failed', adapterKind: 'chromiumSidecar',
    error: { code: 'sandbox_unavailable', message: 'Managed Chromium sandbox is unavailable.' } };

const { useBoundBrowserOpenOperation, useBrowserOpenFirstUse } = await import('./useBrowserOpenFirstUse');

beforeEach(() => { rpc.calls = []; rpc.stored = null; });
afterEach(() => actionOperationStore.reset());

describe('a bound Browser open operation', () => {
    it('follows its exact operation from preparing to connecting to opened', async () => {
        const hook = await renderHook(() => useBoundBrowserOpenOperation({ ...scope, operationId: 'open-1' }));
        expect(hook.getCurrent()).toBeNull();
        await act(async () => actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({
            progress: { kind: 'phase', phase: 'browser_runtime_provisioning', label: 'Preparing' } })] }));
        expect(hook.getCurrent()).toEqual({ kind: 'preparing' });
        await act(async () => actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({ revision: 2 })] }));
        expect(hook.getCurrent()).toEqual({ kind: 'connecting' });
        await act(async () => actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({
            revision: 3, state: 'succeeded', settledAt: 4,
            result: { v: 1, commandId: 'c', status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } })] }));
        expect(hook.getCurrent()).toEqual({ kind: 'opened' });
        expect(rpc.calls).toEqual([]);
        await hook.unmount();
    });

    it('never answers for another Account, Machine, Home or operation', async () => {
        const snapshot = open({ revision: 2 });
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [snapshot] });
        for (const binding of [
            { ...scope, accountId: 'other', operationId: 'open-1' },
            { ...scope, machineId: 'other', operationId: 'open-1' },
            { ...scope, serverId: 'other-home', operationId: 'open-1' },
            { ...scope, operationId: 'other' },
        ]) {
            const hook = await renderHook(() => useBoundBrowserOpenOperation(binding));
            expect(hook.getCurrent()).toBeNull();
            await hook.unmount();
        }
    });

    it('recovers a settled operation\'s typed result with get, since the list omits it', async () => {
        const listed = open({ revision: 2, state: 'succeeded', settledAt: 3 });
        rpc.stored = open({ revision: 2, state: 'succeeded', settledAt: 3, result: sandboxResult });
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [listed] });
        const hook = await renderHook(() => useBoundBrowserOpenOperation({ ...scope, operationId: 'open-1' }));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(hook.getCurrent()).toEqual({ kind: 'sandboxUnavailable', code: 'sandbox_unavailable' });
        expect(rpc.calls).toHaveLength(1);
        expect(rpc.calls[0]).toMatchObject({ method: ACTION_OPERATION_RPC_METHODS_V2.get, machineId: scope.machineId,
            payload: { operationId: 'open-1' } });
        await hook.unmount();
    });
});

describe('the Session Browser first-use state', () => {
    it('keeps the Machine’s failed provisioning cause in the mounted Session Browser prerequisite', async () => {
        const failure = { errorCode: 'browser_runtime_provisioning_failed', error: 'Private installation trace',
            requestId: 'browser-provisioning-refused', effectAttempted: false,
            failureCause: { phase: 'action.owner', errorClass: 'HttpStatusError', errorCode: 'forbidden', httpStatus: 403 },
        };
        const hook = await renderHook(() => useBrowserOpenFirstUse(scope));
        try {
            await act(async () => actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({
                revision: 2, state: 'failed', settledAt: 3, error: failure,
            })] }));
            expect(hook.getCurrent()).toMatchObject({ kind: 'installFailed', actionFailure: { ok: false, ...failure } });
            expect(rpc.calls).toEqual([]);
        } finally {
            await hook.unmount();
        }
    });

    it('recovers a settled open\'s sandbox result after a reload and never calls get for a live open', async () => {
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open()] });
        const live = await renderHook(() => useBrowserOpenFirstUse(scope));
        expect(live.getCurrent()).toEqual({ kind: 'connecting' });
        expect(rpc.calls).toEqual([]);
        await live.unmount();

        actionOperationStore.reset();
        rpc.stored = open({ revision: 2, state: 'succeeded', settledAt: 3, result: sandboxResult });
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [open({ revision: 2, state: 'succeeded', settledAt: 3 })] });
        const reloaded = await renderHook(() => useBrowserOpenFirstUse(scope));
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(reloaded.getCurrent()).toEqual({ kind: 'sandboxUnavailable' });
        expect(rpc.calls).toHaveLength(1);
        await reloaded.unmount();
    });
});
