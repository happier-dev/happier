import { renderHook } from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseDirectSessionRuntimeResult } from './useDirectSessionRuntime';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineDirectSessionTakeoverSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const machineDirectSessionTakeoverPersistSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, converted: true })));
const refreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async () => {}));
const refreshSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const showDirectSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ action: 'direct' | 'persisted' | null; forceStop: boolean }>>(async () => ({ action: null, forceStop: false })),
);
const modalAlertSpy = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdSpy = vi.hoisted(() => vi.fn());

let activeServerId = 'server-1';

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
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdSpy(sessionId),
}));
vi.mock('@/sync/ops/machineDirectSessions', () => ({
  machineDirectSessionTakeover: machineDirectSessionTakeoverSpy,
  machineDirectSessionTakeoverPersist: machineDirectSessionTakeoverPersistSpy,
}));
vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessionMessages: refreshSessionMessagesSpy,
    refreshSessions: refreshSessionsSpy,
  },
}));

type HookValue = ReturnType<typeof import('./useDirectSessionTakeover')['useDirectSessionTakeover']>;

async function renderHarness(
  directSessionRuntime: Pick<UseDirectSessionRuntimeResult, 'directSessionLink' | 'status' | 'refreshNow'>,
): Promise<{ getCurrent: () => HookValue; unmount: () => void }> {
  const { useDirectSessionTakeover } = await import('./useDirectSessionTakeover');

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
    resolvePreferredServerIdForSessionIdSpy.mockReset();
    resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-owned');
    machineDirectSessionTakeoverSpy.mockReset();
    machineDirectSessionTakeoverPersistSpy.mockReset();
    machineDirectSessionTakeoverSpy.mockResolvedValue({ ok: true });
    machineDirectSessionTakeoverPersistSpy.mockResolvedValue({ ok: true, converted: true });
    refreshSessionMessagesSpy.mockReset();
    refreshSessionMessagesSpy.mockResolvedValue(undefined);
    refreshSessionsSpy.mockReset();
    refreshSessionsSpy.mockResolvedValue(undefined);
    showDirectSessionTakeoverDialogSpy.mockReset();
    showDirectSessionTakeoverDialogSpy.mockResolvedValue({ action: null, forceStop: false });
    modalAlertSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the owning session server when footer takeover is requested after an active-server switch', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({ directSessionLink, status, refreshNow });

    activeServerId = 'server-2';
    await act(async () => {
      await harness.getCurrent().requestTakeover('direct');
    });

    expect(machineDirectSessionTakeoverSpy).toHaveBeenCalledWith(
      { machineId: 'machine-1', sessionId: 's1' },
      { serverId: 'server-owned' },
    );
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
    expect(machineDirectSessionTakeoverSpy).not.toHaveBeenCalled();
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
    expect(machineDirectSessionTakeoverSpy).toHaveBeenCalledWith(
      { machineId: 'machine-1', sessionId: 's1' },
      { serverId: 'server-owned' },
    );
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
    expect(machineDirectSessionTakeoverSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });
});
