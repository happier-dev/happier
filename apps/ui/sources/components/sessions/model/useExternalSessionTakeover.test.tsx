import { renderHook } from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineExternalSessionTakeoverSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const machineExternalSessionTakeoverPersistSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, converted: true })));
const refreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async () => {}));
const refreshSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const showExternalSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ action: 'direct' | 'persisted' | null; forceStop: boolean }>>(async () => ({ action: null, forceStop: false })),
);
const modalAlertSpy = vi.hoisted(() => vi.fn());

let activeServerId = 'server-1';

vi.mock('@/components/sessions/external/takeover/showExternalSessionTakeoverDialog', () => ({
  showExternalSessionTakeoverDialog: showExternalSessionTakeoverDialogSpy,
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
vi.mock('@/sync/ops/machineExternalSessions', () => ({
  machineExternalSessionTakeover: machineExternalSessionTakeoverSpy,
  machineExternalSessionTakeoverPersist: machineExternalSessionTakeoverPersistSpy,
}));
vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessionMessages: refreshSessionMessagesSpy,
    refreshSessions: refreshSessionsSpy,
  },
}));

type HookValue = ReturnType<typeof import('./useExternalSessionTakeover')['useExternalSessionTakeover']>;
type ExternalSessionRuntimeLike = Parameters<typeof import('./useExternalSessionTakeover')['useExternalSessionTakeover']>[0]['externalSessionRuntime'];

async function renderHarness(
  externalSessionRuntime: ExternalSessionRuntimeLike,
): Promise<{ getCurrent: () => HookValue; unmount: () => void }> {
  const { useExternalSessionTakeover } = await import('./useExternalSessionTakeover');

  return renderHook(
    (runtime: ExternalSessionRuntimeLike) =>
      useExternalSessionTakeover({ sessionId: 's1', hasWriteAccess: true, externalSessionRuntime: runtime }),
    {
      initialProps: externalSessionRuntime,
    },
  );
}

describe('useExternalSessionTakeover', () => {
  const externalSessionLink: NonNullable<ExternalSessionRuntimeLike['externalSessionLink']> = {
    v: 1,
    providerId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: 'vendor-session-1',
    source: { kind: 'codexHome', home: 'user' },
  };
  const status: NonNullable<ExternalSessionRuntimeLike['status']> = {
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
    machineExternalSessionTakeoverSpy.mockReset();
    machineExternalSessionTakeoverPersistSpy.mockReset();
    machineExternalSessionTakeoverSpy.mockResolvedValue({ ok: true });
    machineExternalSessionTakeoverPersistSpy.mockResolvedValue({ ok: true, converted: true });
    refreshSessionMessagesSpy.mockReset();
    refreshSessionMessagesSpy.mockResolvedValue(undefined);
    refreshSessionsSpy.mockReset();
    refreshSessionsSpy.mockResolvedValue(undefined);
    showExternalSessionTakeoverDialogSpy.mockReset();
    showExternalSessionTakeoverDialogSpy.mockResolvedValue({ action: null, forceStop: false });
    modalAlertSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the owning session server when footer takeover is requested after an active-server switch', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-owned' });

    activeServerId = 'server-2';
    await act(async () => {
      await harness.getCurrent().requestTakeover('direct');
    });

    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledWith(
      { machineId: 'machine-1', sessionId: 's1' },
      { serverId: 'server-owned' },
    );
    await harness.unmount();
  });

  it('uses the runtime-provided session server id for takeover requests', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-runtime' });

    await act(async () => {
      await harness.getCurrent().requestTakeover('direct');
    });

    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledWith(
      { machineId: 'machine-1', sessionId: 's1' },
      { serverId: 'server-runtime' },
    );
    await harness.unmount();
  });

  it('re-checks direct-session status before manual takeover after a server switch', async () => {
    const refreshNow = vi.fn(async () => ({
      ...status,
      machineOnline: false,
    }));
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-owned' });

    activeServerId = 'server-2';
    let ready = true;
    await act(async () => {
      ready = await harness.getCurrent().requestTakeover('direct');
    });

    expect(ready).toBe(false);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'chatFooter.externalSessionMachineOffline');
    await harness.unmount();
  });

  it('uses the owning session server when send takeover is confirmed after an active-server switch', async () => {
    const refreshNow = vi.fn(async () => status);
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-owned' });

    activeServerId = 'server-2';
    await act(async () => {
      await harness.getCurrent().ensureReadyForSend();
    });

    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledWith(
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
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-owned' });

    activeServerId = 'server-2';
    let ready = false;
    await act(async () => {
      ready = await harness.getCurrent().ensureReadyForSend();
    });

    expect(ready).toBe(true);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });
});
