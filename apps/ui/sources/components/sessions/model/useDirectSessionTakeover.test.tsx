import { renderHook, createSessionFixture, flushHookEffects, createDeferred } from '@/dev/testkit';
import { projectRetainedSessionLink } from '@/sync/domains/session/directSessions/retainedSessionLink';
import { storage } from '@/sync/domains/state/storage';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { RpcError } from '@/sync/runtime/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseDirectSessionRuntimeResult } from './useDirectSessionRuntime';
import { useDirectSessionTakeover } from './useDirectSessionTakeover';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const patchMetadataSpy = vi.hoisted(() => vi.fn());
const machineRpcSpy = vi.hoisted(() => vi.fn());
const refreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async () => {}));
const refreshSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const showDirectSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ action: 'direct' | 'persisted' | null; forceStop: boolean }>>(async () => ({ action: null, forceStop: false })),
);
const modalAlertSpy = vi.hoisted(() => vi.fn());

let activeServerId = 'server-1';
let accountId = '';
let testNumber = 0;
function operation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
  return { version: 1, operationId: `import-${accountId}`, requestId: 'import-request', revision: 1,
    actionId: 'session.direct.takeover_persist', scope: { accountId, machineId: 'machine-1', sessionId: 's1' },
    title: 'Import session history', state: 'running', createdAt: 100, startedAt: 101, cancellation: 'supported',
    progress: { kind: 'determinate', current: 5, total: 23, label: 'Importing' }, ...overrides };
}
async function push(snapshot: ActionOperationSnapshotV1) {
  await act(async () => { actionOperationStore.merge(snapshot); });
}

vi.mock('@/components/sessions/directSessions/takeover/showDirectSessionTakeoverDialog', () => ({
  showDirectSessionTakeoverDialog: showDirectSessionTakeoverDialogSpy,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalAlertSpy,
            confirm: vi.fn(async () => false),
        },
    }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});
vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: activeServerId }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcSpy,
}));
vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessionMessages: refreshSessionMessagesSpy,
    refreshSessions: refreshSessionsSpy,
    patchSessionMetadataWithRetry: patchMetadataSpy,
  },
}));

async function renderHarness(
  directSessionRuntime: Pick<UseDirectSessionRuntimeResult, 'directSessionLink' | 'status' | 'refreshNow'>,
) {
  return renderHook(
    (runtime: Pick<UseDirectSessionRuntimeResult, 'directSessionLink' | 'status' | 'refreshNow'>) =>
      useDirectSessionTakeover({ sessionId: 's1', hasWriteAccess: true, directSessionRuntime: runtime }),
    {
      initialProps: directSessionRuntime,
    },
  );
}

describe('useDirectSessionTakeover', () => {
  const directSessionLink: NonNullable<UseDirectSessionRuntimeResult['directSessionLink']> = {
    v: 1,
    providerId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: 'vendor-session-1',
    source: { kind: 'codexHome', home: 'user' },
  };
  const status: NonNullable<UseDirectSessionRuntimeResult['status']> = {
    ok: true,
    machineOnline: true,
    runnerActive: false,
    activity: 'running',
    canTakeOverDirect: true,
    canTakeOverPersist: true,
    canForceStop: false,
  };

  beforeEach(() => {
    activeServerId = 'server-1';
    accountId = `import-account-${++testNumber}`;
    storage.setState({ profileScope: { serverId: 'server-owned', accountId }, sessions: { s1: createSessionFixture({ id: 's1', serverId: 'server-owned' }) }, machines: {} });
    machineRpcSpy.mockReset();
    machineRpcSpy.mockImplementation(async ({ method }) => method === 'actionOperation.list.v1'
      ? { items: [], nextCursor: null } : { ok: true });
    refreshSessionMessagesSpy.mockReset();
    refreshSessionMessagesSpy.mockResolvedValue(undefined);
    refreshSessionsSpy.mockReset();
    refreshSessionsSpy.mockResolvedValue(undefined);
    showDirectSessionTakeoverDialogSpy.mockReset();
    showDirectSessionTakeoverDialogSpy.mockResolvedValue({ action: null, forceStop: false });
    modalAlertSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('writes the derived link before consulting the daemon capability for cloud conversion', async () => {
    const initial = storage.getState().sessions.s1!;
    const retained = projectRetainedSessionLink({
      ...initial, cloudCopyLeftAt: 150,
      metadata: { ...initial.metadata!, flavor: 'codex', codexSessionId: 'vendor-session-1', machineId: 'machine-1' },
    });
    expect(JSON.parse(JSON.stringify(retained.metadata)).directSessionV1).toBeUndefined();
    storage.setState({ sessions: { s1: retained } });
    const unavailable = { ...status, canTakeOverPersist: false };
    let persisted = false;
    patchMetadataSpy.mockImplementationOnce(async (_id, updater) => {
      const metadata = updater(retained.metadata);
      persisted = JSON.parse(JSON.stringify(metadata)).directSessionV1?.remoteSessionId === 'vendor-session-1';
      storage.setState({ sessions: { s1: { ...retained, metadata } } });
    });
    const refreshNow = async () => (persisted ? status : unavailable);
    const harness = await renderHarness({ directSessionLink, status: unavailable, refreshNow });
    machineRpcSpy.mockResolvedValue({ ok: true, operation: operation({
      state: 'succeeded', settledAt: 110, cancellation: 'unsupported',
    }) });
    await act(async () => { expect(await harness.getCurrent().requestTakeover('persisted')).toBe(true); });
    expect(persisted).toBe(true);
    expect(patchMetadataSpy).toHaveBeenCalledTimes(1);
    await harness.unmount();
  });

  it('restores shared import progress, accepts pushed revisions and exposes connection failures', async () => {
    const initial = operation();
    machineRpcSpy.mockResolvedValue({ items: [initial], nextCursor: null });
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    expect(harness.getCurrent().importOperation).toEqual(initial);
    machineRpcSpy.mockClear();
    await push({ ...initial, revision: 2, progress: { kind: 'determinate', current: 17, total: 23 } });
    expect(harness.getCurrent().importOperation?.progress).toMatchObject({ current: 17 });
    await act(async () => { actionOperationStore.setObservation(initial.scope, 'status_unavailable'); });
    expect(harness.getCurrent().importStatusError).not.toBeNull();
    expect(harness.getCurrent().takeoverInFlight).toBeNull();
    expect(machineRpcSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it.each(['cancelled', 'succeeded', 'failed'] as const)('settles pending send on shared %s and uses shared Stop', async (terminalState) => {
    const initial = operation();
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockImplementation(async ({ method }) => {
      if (method === 'actionOperation.cancel.v1') {
        await push({ ...initial, revision: 2, progress: { kind: 'phase', phase: 'cancelling', label: 'Stopping' } });
        return { kind: 'requested' };
      }
      return { ok: true, operation: initial };
    });
    let ready: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then(value => { ready = value; }); });
    expect(ready).toBeUndefined();
    if (terminalState === 'cancelled') {
      await act(async () => { await harness.getCurrent().cancelImport(); });
      expect(harness.getCurrent().importOperation?.progress).toMatchObject({ phase: 'cancelling' });
      expect(ready).toBeUndefined();
    }
    await push({ ...initial, revision: 3, state: terminalState, settledAt: 110, cancellation: 'unsupported',
      ...(terminalState === 'failed' ? { error: { errorCode: 'failed', error: 'Import failed' } } : {}) });
    expect(ready).toBe(terminalState === 'succeeded');
    expect(harness.getCurrent().takeoverInFlight).toBeNull();
    expect(refreshSessionMessagesSpy).toHaveBeenCalledWith('s1');
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method.includes('import.status') || request.method.includes('import.cancel'))).toBe(false);
    await harness.unmount();
  });

  it('observes pushed completion after metadata conversion and permits later sends', async () => {
    const initial = operation();
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockResolvedValue({ ok: true, operation: initial });
    let ready: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then(value => { ready = value; }); });
    await harness.rerender({ directSessionLink: null, status: null, refreshNow: vi.fn(async () => null) });
    await push({ ...initial, revision: 2, state: 'succeeded', settledAt: 110, cancellation: 'unsupported', result: { ok: true, converted: true } });
    expect(ready).toBe(true);
    await act(async () => { expect(await harness.getCurrent().ensureReadyForSend()).toBe(true); });
    await harness.unmount();
  });

  it('settles draft readiness false when shared reconciliation loses the active operation', async () => {
    const initial = operation();
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockResolvedValue({ ok: true, operation: initial });
    let ready: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then(value => { ready = value; }); });
    await act(async () => { actionOperationStore.reconcileMachineList(initial.scope, new Set()); });
    expect(ready).toBe(false);
    expect(harness.getCurrent().importStatusError).not.toBeNull();
    expect(harness.getCurrent().takeoverInFlight).toBeNull();
    expect(harness.getCurrent().importOperation?.state).toBe('running');
    const retry = operation({ operationId: 'retry-operation', createdAt: 120, startedAt: 121, settledAt: 130,
      state: 'succeeded', cancellation: 'unsupported' });
    machineRpcSpy.mockResolvedValue({ ok: true, operation: retry });
    await act(async () => { expect(await harness.getCurrent().requestTakeover('persisted')).toBe(true); });
    expect(harness.getCurrent().importOperation?.operationId).toBe(retry.operationId);
    expect(harness.getCurrent().takeoverInFlight).toBeNull();
    await harness.unmount();
  });

  it('recovers a lost acknowledgement by shared request identity without launching twice', async () => {
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    let admitted = operation();
    machineRpcSpy.mockImplementation(async ({ method, payload }) => {
      if (method === 'daemon.directSessions.takeoverPersist.start') {
        admitted = operation({ requestId: payload.requestId, state: 'succeeded', settledAt: 110, cancellation: 'unsupported' });
        throw new Error('transport disconnected');
      }
      return { items: [admitted], nextCursor: null };
    });
    await act(async () => { expect(await harness.getCurrent().requestTakeover('persisted')).toBe(true); });
    expect(typeof admitted.requestId).toBe('string');
    expect(machineRpcSpy.mock.calls.filter(([request]) => request.method === 'daemon.directSessions.takeoverPersist.start')).toHaveLength(1);
    await harness.unmount();
  });

  it('recovers a lost acknowledgement that joined another active import request', async () => {
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    const joined = operation({ requestId: 'other-client-request' });
    machineRpcSpy.mockImplementation(async ({ method }) => {
      if (method === 'daemon.directSessions.takeoverPersist.start') throw new Error('acknowledgement disconnected');
      return { items: [joined], nextCursor: null };
    });
    let ready: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then(value => { ready = value; }); });
    expect(harness.getCurrent().importOperation?.operationId).toBe(joined.operationId);
    expect(ready).toBeUndefined();
    await push({ ...joined, revision: 2, state: 'succeeded', settledAt: 110, cancellation: 'unsupported' });
    expect(ready).toBe(true);
    await harness.unmount();
  });

  it('settles from pushed terminal truth when START acknowledgement arrives late and stale', async () => {
    const initial = operation();
    const ack = createDeferred<{ ok: true; operation: ActionOperationSnapshotV1 }>();
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockReturnValue(ack.promise);
    let ready: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then(value => { ready = value; }); });
    await push({ ...initial, revision: 2, state: 'succeeded', settledAt: 110, cancellation: 'unsupported' });
    expect(ready).toBeUndefined();
    await act(async () => { ack.resolve({ ok: true, operation: initial }); });
    expect(ready).toBe(true);
    await harness.unmount();
  });

  it('retains the original route and error until explicit terminal refresh succeeds after conversion', async () => {
    const initial = operation();
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockResolvedValue({ ok: true, operation: initial });
    let ready: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then(value => { ready = value; }); });
    await harness.rerender({ directSessionLink: null, status: null, refreshNow: vi.fn(async () => null) });
    const terminal = { ...initial, revision: 2, state: 'succeeded' as const, settledAt: 110, cancellation: 'unsupported' as const };
    refreshSessionsSpy.mockRejectedValueOnce(new Error('refresh disconnected'));
    await push(terminal);
    expect(ready).toBe(false);
    expect(harness.getCurrent().importStatusError).not.toBeNull();
    machineRpcSpy.mockResolvedValue({ kind: 'found', operation: terminal });
    await act(async () => { await harness.getCurrent().refreshImport(); });
    expect(harness.getCurrent().importStatusError).toBeNull();
    expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1', serverId: 'server-owned', method: 'actionOperation.get.v1' }));
    await harness.unmount();
  });

  it('ignores an old Refresh response after Retry admits a newer import', async () => {
    const old = operation({ state: 'failed', settledAt: 110, cancellation: 'unsupported',
      error: { errorCode: 'failed', error: 'Import failed' } });
    actionOperationStore.merge(old);
    refreshSessionsSpy.mockRejectedValueOnce(new Error('projection refresh failed'));
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    expect(harness.getCurrent().importStatusError).not.toBeNull();
    const get = createDeferred<{ kind: 'found'; operation: ActionOperationSnapshotV1 }>();
    const retry = operation({ operationId: 'new-import-after-refresh', createdAt: 120, startedAt: 121 });
    machineRpcSpy.mockImplementation(async ({ method }) => method === 'actionOperation.get.v1'
      ? get.promise : { ok: true, operation: retry });
    let refresh: Promise<void> | undefined;
    await act(async () => { refresh = harness.getCurrent().refreshImport(); });
    let ready: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then(value => { ready = value; }); });
    expect(harness.getCurrent().importOperation?.operationId).toBe(retry.operationId);
    refreshSessionMessagesSpy.mockClear();
    refreshSessionsSpy.mockClear();
    await act(async () => { get.resolve({ kind: 'found', operation: old }); await refresh; });
    expect(ready).toBeUndefined();
    expect(refreshSessionMessagesSpy).not.toHaveBeenCalled();
    expect(refreshSessionsSpy).not.toHaveBeenCalled();
    await push({ ...retry, revision: 2, state: 'succeeded', settledAt: 130, cancellation: 'unsupported' });
    expect(ready).toBe(true);
    await harness.unmount();
  });

  it('keeps terminal recovery visible when Get returns an older running revision', async () => {
    const running = operation();
    actionOperationStore.merge(running);
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    await act(async () => { actionOperationStore.markUnavailable(running.operationId); });
    const get = createDeferred<{ kind: 'found'; operation: ActionOperationSnapshotV1 }>();
    machineRpcSpy.mockReturnValue(get.promise);
    let refresh: Promise<void> | undefined;
    await act(async () => { refresh = harness.getCurrent().refreshImport(); });
    await harness.rerender({ directSessionLink: null, status: null, refreshNow: vi.fn(async () => null) });
    refreshSessionsSpy.mockRejectedValue(new Error('projection refresh failed'));
    await push({ ...running, revision: 2, state: 'succeeded', settledAt: 110, cancellation: 'unsupported' });
    expect(harness.getCurrent().importStatusError).not.toBeNull();
    await act(async () => { get.resolve({ kind: 'found', operation: running }); await refresh; });
    expect(harness.getCurrent().importOperation?.state).toBe('succeeded');
    expect(harness.getCurrent().importStatusError).not.toBeNull();
    refreshSessionsSpy.mockResolvedValue(undefined);
    machineRpcSpy.mockResolvedValue({ kind: 'found', operation: running });
    await act(async () => { await harness.getCurrent().refreshImport(); });
    expect(harness.getCurrent().importStatusError).toBeNull();
    await harness.unmount();
  });

  it('does not admit retry during a recovered terminal projection refresh', async () => {
    const refresh = createDeferred<void>();
    refreshSessionsSpy.mockReturnValueOnce(refresh.promise);
    const terminal = operation({ state: 'failed', settledAt: 110, error: { errorCode: 'failed', error: 'Import failed' } });
    actionOperationStore.merge(terminal);
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    await act(async () => { expect(await harness.getCurrent().requestTakeover('persisted')).toBe(false); });
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeoverPersist.start')).toBe(false);
    await act(async () => { refresh.resolve(); });
    await harness.unmount();
  });

  it('drops pending send ownership when the active account changes', async () => {
    const initial = operation();
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockResolvedValue({ ok: true, operation: initial });
    let ready: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then(value => { ready = value; }); });
    await act(async () => { storage.setState({ profileScope: { serverId: 'server-owned', accountId: 'other-account' } }); });
    expect(ready).toBe(false);
    expect(harness.getCurrent().importOperation).toBeNull();
    await harness.unmount();
  });

  it('requires a daemon update without falling back to synchronous import', async () => {
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockRejectedValue(new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));
    await act(async () => { expect(await harness.getCurrent().requestTakeover('persisted')).toBe(false); });
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'chatFooter.directImportRequiresDaemonUpgrade');
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeoverPersist')).toBe(false);
    await harness.unmount();
  });

  it('acknowledges intent while preflight is pending', async () => {
    const latestStatus = createDeferred<NonNullable<UseDirectSessionRuntimeResult['status']>>();
    const harness = await renderHarness({ directSessionLink, status, refreshNow: () => latestStatus.promise });
    let ready: Promise<boolean> | undefined;
    await act(async () => { ready = harness.getCurrent().requestTakeover('persisted'); });
    expect(harness.getCurrent().takeoverInFlight).toBe('persisted');
    await act(async () => { latestStatus.resolve({ ...status, machineOnline: false }); await ready; });
    expect(harness.getCurrent().takeoverInFlight).toBeNull();
    await harness.unmount();
  });

  it('uses the owning session server when footer takeover is requested after an active-server switch', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({ directSessionLink, status, refreshNow });

    activeServerId = 'server-2';
    await act(async () => {
      await harness.getCurrent().requestTakeover('direct');
    });

    expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      payload: { machineId: 'machine-1', sessionId: 's1' },
      method: 'daemon.directSessions.takeover', serverId: 'server-owned',
    }));
    await harness.unmount();
  });

  it('re-checks direct-session status before manual takeover after a server switch', async () => {
    const refreshNow = vi.fn(async () => ({
      ...status,
      machineOnline: false,
    }));
    const harness = await renderHarness({ directSessionLink, status, refreshNow });

    activeServerId = 'server-2';
    let ready = true;
    await act(async () => {
      ready = await harness.getCurrent().requestTakeover('direct');
    });

    expect(ready).toBe(false);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeover')).toBe(false);
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'chatFooter.directSessionMachineOffline');
    await harness.unmount();
  });

  it('uses the owning session server when send takeover is confirmed after an active-server switch', async () => {
    const refreshNow = vi.fn(async () => status);
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });
    const harness = await renderHarness({ directSessionLink, status, refreshNow });

    activeServerId = 'server-2';
    await act(async () => {
      await harness.getCurrent().ensureReadyForSend();
    });

    expect(showDirectSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      payload: { machineId: 'machine-1', sessionId: 's1' },
      method: 'daemon.directSessions.takeover', serverId: 'server-owned',
    }));
    await harness.unmount();
  });

  it('re-checks direct-session status before prompting for send takeover after a server switch', async () => {
    const refreshNow = vi.fn(async () => ({
      ...status,
      runnerActive: true,
    }));
    const harness = await renderHarness({ directSessionLink, status, refreshNow });

    activeServerId = 'server-2';
    let ready = false;
    await act(async () => {
      ready = await harness.getCurrent().ensureReadyForSend();
    });

    expect(ready).toBe(true);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(showDirectSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeover')).toBe(false);
    await harness.unmount();
  });
});
