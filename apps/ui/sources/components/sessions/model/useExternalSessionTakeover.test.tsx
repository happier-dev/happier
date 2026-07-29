import { createDeferred, renderHook } from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineExternalSessionTakeoverSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const machineExternalSessionTakeoverPersistSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, converted: true })));
const refreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async () => {}));
const refreshSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const showExternalSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ action: 'direct' | 'persisted' | 'recheck' | null; forceStop: boolean }>>(async () => ({ action: null, forceStop: false })),
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
  machineExternalSessionTakeoverStart: machineExternalSessionTakeoverSpy,
  machineExternalSessionTakeoverPersist: machineExternalSessionTakeoverPersistSpy,
}));
vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessionMessages: refreshSessionMessagesSpy,
    refreshSessions: refreshSessionsSpy,
  },
}));
vi.mock('@/platform/randomUUID', () => ({
  randomUUID: () => 'takeover-idempotency-1',
}));

type HookValue = ReturnType<typeof import('./useExternalSessionTakeover')['useExternalSessionTakeover']>;
type ExternalSessionRuntimeLike = Parameters<typeof import('./useExternalSessionTakeover')['useExternalSessionTakeover']>[0]['externalSessionRuntime'];

async function renderHarness(
  externalSessionRuntime: ExternalSessionRuntimeLike,
): Promise<{
  getCurrent: () => HookValue;
  rerender: (runtime: ExternalSessionRuntimeLike) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  const { useExternalSessionTakeover } = await import('./useExternalSessionTakeover');

  const hook = await renderHook(
    (runtime: ExternalSessionRuntimeLike) =>
      useExternalSessionTakeover({ sessionId: 's1', hasWriteAccess: true, externalSessionRuntime: runtime }),
    {
      initialProps: externalSessionRuntime,
    },
  );
  return {
    getCurrent: hook.getCurrent,
    rerender: async (runtime) => {
      await hook.rerender(runtime);
    },
    unmount: hook.unmount,
  };
}

describe('useExternalSessionTakeover', () => {
  const externalSessionLink: NonNullable<ExternalSessionRuntimeLike['externalSessionLink']> = {
    v: 1,
    agentId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: 'vendor-session-1',
    source: { kind: 'codexHome', home: 'user' },
    linkedAtMs: 1_000,
    qualifiedIdentity: {
      v: 1,
      agent: { pluginId: 'happier.codex', localId: 'codex' },
      source: { kind: 'codexHome', contractVersion: 1 },
    },
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
      {
        machineId: 'machine-1',
        request: expect.objectContaining({
          sessionId: 's1',
          targetStorageMode: 'external-linked',
        }),
      },
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
      {
        machineId: 'machine-1',
        request: expect.objectContaining({
          sessionId: 's1',
          targetStorageMode: 'external-linked',
        }),
      },
      { serverId: 'server-runtime' },
    );
    await harness.unmount();
  });

  it('refreshes the session summary after direct takeover so immediate sends see the owned runtime state', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-runtime' });

    await act(async () => {
      await harness.getCurrent().requestTakeover('direct');
    });

    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledWith(
      {
        machineId: 'machine-1',
        request: expect.objectContaining({
          sessionId: 's1',
          targetStorageMode: 'external-linked',
        }),
      },
      { serverId: 'server-runtime' },
    );
    expect(refreshSessionsSpy).toHaveBeenCalledTimes(1);
    expect(refreshSessionMessagesSpy).toHaveBeenCalledWith('s1');
    await harness.unmount();
  });

  it('starts persisted takeover with public link intent and no private generations', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({
      externalSessionLink,
      status,
      refreshNow,
      sessionServerId: 'server-runtime',
    });

    let ready = true;
    await act(async () => {
      ready = await harness.getCurrent().requestTakeover('persisted');
    });

    expect(ready).toBe(true);
    expect(machineExternalSessionTakeoverPersistSpy).toHaveBeenCalledWith({
      machineId: 'machine-1',
      request: {
        v: 1,
        idempotencyKey: 'takeover-idempotency-1',
        sessionId: 's1',
        source: {
          machineId: 'machine-1',
          remoteSessionId: 'vendor-session-1',
          qualifiedIdentity: externalSessionLink.qualifiedIdentity,
          linkGeneration: '1000',
        },
        plan: 'takeover',
        targetStorageMode: 'persisted',
        targetRuntimeMode: 'terminal',
      },
    }, { serverId: 'server-runtime' });
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('fails persisted takeover before RPC when the public link identity is incomplete', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({
      externalSessionLink: {
        ...externalSessionLink,
        qualifiedIdentity: undefined,
      },
      status,
      refreshNow,
      sessionServerId: 'server-runtime',
    });

    let ready = true;
    await act(async () => {
      ready = await harness.getCurrent().requestTakeover('persisted');
    });

    expect(ready).toBe(false);
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'chatFooter.externalSessionStatusUnavailable',
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
    let ready = true;
    await act(async () => {
      ready = await harness.getCurrent().ensureReadyForSend();
    });

    expect(ready).toBe(false);
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledWith(
      {
        machineId: 'machine-1',
        request: expect.objectContaining({
          sessionId: 's1',
          targetStorageMode: 'external-linked',
        }),
      },
      { serverId: 'server-owned' },
    );
    await harness.unmount();
  });

  it('offers persisted takeover when the daemon activation fence admits it', async () => {
    const refreshNow = vi.fn(async () => ({
      ...status,
      canTakeOverDirect: false,
      canTakeOverPersist: true,
    }));
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: null, forceStop: false });
    const harness = await renderHarness({ externalSessionLink, status: null, refreshNow, sessionServerId: 'server-owned' });

    await act(async () => {
      await harness.getCurrent().requestTakeoverPreflight();
    });

    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(refreshNow).toHaveBeenCalledWith({ takeoverReadiness: 'fresh' });
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: false,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('fails the explicit footer preflight closed with a blocking reason when quiescence is unverified', async () => {
    const refreshNow = vi.fn(async () => ({
      ...status,
      canTakeOverDirect: false,
      canTakeOverPersist: false,
    }));
    const harness = await renderHarness({ externalSessionLink, status: null, refreshNow, sessionServerId: 'server-owned' });

    await act(async () => {
      await harness.getCurrent().requestTakeoverPreflight();
    });

    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'chatFooter.externalSessionTakeoverBlocked',
    );
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('shows verified-running process guidance and re-checks through the existing explicit refresh path', async () => {
    const refreshNow = vi.fn()
      .mockResolvedValueOnce({
        ...status,
        runnerActive: true,
        trustedPid: 12_345,
        canTakeOverDirect: false,
        canTakeOverPersist: false,
      })
      .mockResolvedValueOnce({
        ...status,
        runnerActive: false,
        trustedPid: null,
        canTakeOverDirect: false,
        canTakeOverPersist: true,
      });
    showExternalSessionTakeoverDialogSpy
      .mockResolvedValueOnce({ action: 'recheck', forceStop: false })
      .mockResolvedValueOnce({ action: null, forceStop: false });
    const harness = await renderHarness({
      externalSessionLink,
      status: null,
      refreshNow,
      sessionServerId: 'server-owned',
    });

    await act(async () => {
      await harness.getCurrent().requestTakeoverPreflight();
    });

    expect(refreshNow).toHaveBeenCalledTimes(2);
    expect(refreshNow).toHaveBeenNthCalledWith(1, { takeoverReadiness: 'fresh' });
    expect(refreshNow).toHaveBeenNthCalledWith(2, { takeoverReadiness: 'fresh' });
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenNthCalledWith(1, {
      canTakeOverDirect: false,
      canTakeOverPersist: false,
      canForceStop: false,
      runningProcessPid: 12_345,
    });
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenNthCalledWith(2, {
      canTakeOverDirect: false,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    expect(modalAlertSpy).not.toHaveBeenCalledWith(
      'common.error',
      'chatFooter.externalSessionAlreadyControlled',
    );
    await harness.unmount();
  });

  it('does not reuse prior takeover capabilities when the explicit refresh attempt fails', async () => {
    const refreshNow = vi.fn(async () => null);
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-owned' });

    await act(async () => {
      await harness.getCurrent().requestTakeoverPreflight();
    });

    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'chatFooter.externalSessionStatusUnavailable',
    );
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('drops a stale explicit preflight when the linked external session changes', async () => {
    const firstRefresh = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const firstRuntime = {
      externalSessionLink,
      status: null,
      refreshNow: vi.fn(async () => await firstRefresh.promise),
      sessionServerId: 'server-owned',
    };
    const harness = await renderHarness(firstRuntime);
    let stalePreflight: Promise<boolean> | null = null;
    await act(async () => {
      stalePreflight = harness.getCurrent().requestTakeoverPreflight();
      await Promise.resolve();
    });

    await harness.rerender({
      ...firstRuntime,
      externalSessionLink: {
        ...externalSessionLink,
        remoteSessionId: 'vendor-session-2',
      },
      refreshNow: vi.fn(async () => status),
    });

    await act(async () => {
      firstRefresh.resolve(status);
      await stalePreflight;
    });

    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('drops a stale explicit preflight when only canonical linkData changes', async () => {
    const firstRefresh = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const firstRuntime = {
      externalSessionLink: {
        ...externalSessionLink,
        linkedAtMs: 1_000,
        qualifiedIdentity: {
          v: 1 as const,
          agent: { pluginId: 'happier.codex', localId: 'codex' },
          source: { kind: 'codexHome' as const, contractVersion: 1 as const },
        },
        linkData: { projectId: 'project-a' },
      },
      status: null,
      refreshNow: vi.fn(async () => await firstRefresh.promise),
      sessionServerId: 'server-owned',
    };
    const harness = await renderHarness(firstRuntime);
    let stalePreflight: Promise<boolean> | null = null;
    await act(async () => {
      stalePreflight = harness.getCurrent().requestTakeoverPreflight();
      await Promise.resolve();
    });

    await harness.rerender({
      ...firstRuntime,
      externalSessionLink: {
        ...firstRuntime.externalSessionLink,
        linkData: { projectId: 'project-b' },
      },
      refreshNow: vi.fn(async () => status),
    });

    await act(async () => {
      firstRefresh.resolve(status);
      await stalePreflight;
    });

    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('does not present takeover UI after an explicit preflight unmounts', async () => {
    const refresh = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const harness = await renderHarness({
      externalSessionLink,
      status: null,
      refreshNow: vi.fn(async () => await refresh.promise),
      sessionServerId: 'server-owned',
    });
    let preflight: Promise<boolean> | null = null;
    await act(async () => {
      preflight = harness.getCurrent().requestTakeoverPreflight();
      await Promise.resolve();
    });

    await harness.unmount();
    await act(async () => {
      refresh.resolve(status);
      await preflight;
    });

    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
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

  it('does not block send when the direct-session status refresh has a transient connectivity failure', async () => {
    const refreshNow = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-owned' });

    let ready = false;
    await act(async () => {
      ready = await harness.getCurrent().ensureReadyForSend();
    });

    expect(ready).toBe(true);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });
});
