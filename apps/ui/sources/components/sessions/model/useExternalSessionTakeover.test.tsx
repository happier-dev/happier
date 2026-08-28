import { createDeferred, renderHook } from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MachineExternalSessionTakeoverStart =
  typeof import('@/sync/ops/machineExternalSessions').machineExternalSessionTakeoverStart;
type MachineExternalSessionTakeoverResponse = Awaited<ReturnType<MachineExternalSessionTakeoverStart>>;
type MachineExternalSessionTakeoverMockResponse =
  | Pick<Extract<MachineExternalSessionTakeoverResponse, { ok: true }>, 'ok'>
  | Extract<MachineExternalSessionTakeoverResponse, { ok: false }>;
type MachineExternalSessionTakeoverMock = (
  ...args: Parameters<MachineExternalSessionTakeoverStart>
) => Promise<MachineExternalSessionTakeoverMockResponse>;

const machineExternalSessionTakeoverSpy = vi.hoisted(() =>
  vi.fn<MachineExternalSessionTakeoverMock>(async () => ({ ok: true })),
);
const machineExternalSessionTakeoverPersistSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, converted: true })));
const refreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async () => {}));
const refreshSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const randomUUIDSpy = vi.hoisted(() => vi.fn(() => 'takeover-idempotency-1'));
const showExternalSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{
    action: 'direct' | 'persisted' | 'recheck' | null;
    targetDirectory?: string;
  }>>(async () => ({ action: null })),
);
const modalAlertSpy = vi.hoisted(() => vi.fn());

let activeServerId = 'server-1';
let activeAccountIsCurrent = true;
const TARGET_DIRECTORY = '/local/selected/workspace';
const TARGET_HOME_DIRECTORY = '/Users/tester';

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
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
  captureActiveServerAccountScopeCurrentness: () => ({
    isCurrent: () => activeAccountIsCurrent,
    onRetire: () => ({ dispose() {} }),
  }),
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
  randomUUID: randomUUIDSpy,
}));

type HookValue = ReturnType<typeof import('./useExternalSessionTakeover')['useExternalSessionTakeover']>;
type ExternalSessionRuntimeLike = Parameters<typeof import('./useExternalSessionTakeover')['useExternalSessionTakeover']>[0]['externalSessionRuntime'];

async function renderHarness(
  externalSessionRuntime: ExternalSessionRuntimeLike,
): Promise<{
  getCurrent: () => HookValue;
  rerender: (runtime: ExternalSessionRuntimeLike) => Promise<void>;
  rerenderWithoutPassiveEffects: (runtime: ExternalSessionRuntimeLike) => void;
  unmount: () => Promise<void>;
}> {
  const { useExternalSessionTakeover } = await import('./useExternalSessionTakeover');

  const hook = await renderHook(
    (runtime: ExternalSessionRuntimeLike) =>
      useExternalSessionTakeover({
        sessionId: 's1',
        hasWriteAccess: true,
        externalSessionRuntime: runtime,
        targetMachineHomeDir: TARGET_HOME_DIRECTORY,
        targetDirectorySuggestion: TARGET_DIRECTORY,
        targetMachinePlatform: 'darwin',
      }),
    {
      initialProps: externalSessionRuntime,
    },
  );
  return {
    getCurrent: hook.getCurrent,
    rerender: async (runtime) => {
      await hook.rerender(runtime);
    },
    rerenderWithoutPassiveEffects: (runtime) => {
      const hookHarness = hook.tree.root;
      if (typeof hookHarness.type !== 'function') {
        throw new Error('Expected the testkit hook harness root');
      }
      const tree = hook.tree as typeof hook.tree & {
        unstable_flushSync: (callback: () => void) => void;
      };
      tree.unstable_flushSync(() => {
        tree.update(React.createElement(
          hookHarness.type,
          { hookProps: runtime },
        ));
      });
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
    activeAccountIsCurrent = true;
    machineExternalSessionTakeoverSpy.mockReset();
    machineExternalSessionTakeoverPersistSpy.mockReset();
    machineExternalSessionTakeoverSpy.mockResolvedValue({ ok: true });
    machineExternalSessionTakeoverPersistSpy.mockResolvedValue({ ok: true, converted: true });
    refreshSessionMessagesSpy.mockReset();
    refreshSessionMessagesSpy.mockResolvedValue(undefined);
    refreshSessionsSpy.mockReset();
    refreshSessionsSpy.mockResolvedValue(undefined);
    randomUUIDSpy.mockReset();
    randomUUIDSpy.mockReturnValue('takeover-idempotency-1');
    showExternalSessionTakeoverDialogSpy.mockReset();
    showExternalSessionTakeoverDialogSpy.mockResolvedValue({ action: null });
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
      await harness.getCurrent().requestTakeover('direct', TARGET_DIRECTORY);
    });

    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledWith(
      {
        machineId: 'machine-1',
        request: expect.objectContaining({
          sessionId: 's1',
          targetStorageMode: 'external-linked',
          targetDirectory: TARGET_DIRECTORY,
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
      await harness.getCurrent().requestTakeover('direct', TARGET_DIRECTORY);
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
      await harness.getCurrent().requestTakeover('direct', TARGET_DIRECTORY);
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
      ready = await harness.getCurrent().requestTakeover('persisted', TARGET_DIRECTORY);
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
        targetDirectory: TARGET_DIRECTORY,
        targetRuntimeMode: 'terminal',
      },
    }, { serverId: 'server-runtime' });
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('keeps an idempotency key only for an outcome-uncertain retry of the exact takeover intent', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({
      externalSessionLink,
      status,
      refreshNow,
      sessionServerId: 'server-runtime',
    });
    randomUUIDSpy
      .mockReturnValueOnce('attempt-a')
      .mockReturnValueOnce('attempt-b')
      .mockReturnValueOnce('attempt-c')
      .mockReturnValueOnce('attempt-d')
      .mockReturnValueOnce('attempt-e');
    machineExternalSessionTakeoverSpy
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'internal_error', message: 'typed failure' },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('transport outcome uncertain'))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    await act(async () => {
      await harness.getCurrent().requestTakeover('direct', '/work/repo');
      await harness.getCurrent().requestTakeover('direct', '/work/repo');
      await harness.getCurrent().requestTakeover('direct', '/work/repo');
      await harness.getCurrent().requestTakeover('direct', '/work/repo ');
      await harness.getCurrent().requestTakeover('direct', '/work/repo ');
      await harness.getCurrent().requestTakeover('direct', '/work/other-repo');
    });

    expect(machineExternalSessionTakeoverSpy.mock.calls.map(([input]) => ({
      idempotencyKey: input.request.idempotencyKey,
      targetDirectory: input.request.targetDirectory,
    }))).toEqual([
      { idempotencyKey: 'attempt-a', targetDirectory: '/work/repo' },
      { idempotencyKey: 'attempt-b', targetDirectory: '/work/repo' },
      { idempotencyKey: 'attempt-c', targetDirectory: '/work/repo' },
      { idempotencyKey: 'attempt-d', targetDirectory: '/work/repo ' },
      { idempotencyKey: 'attempt-d', targetDirectory: '/work/repo ' },
      { idempotencyKey: 'attempt-e', targetDirectory: '/work/other-repo' },
    ]);
    await harness.unmount();
  });

  it('preserves selected target path bytes after home-directory expansion', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({
      externalSessionLink,
      status,
      refreshNow,
      sessionServerId: 'server-runtime',
    });

    await act(async () => {
      await harness.getCurrent().requestTakeover('direct', '~/repo ');
    });

    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          targetDirectory: '/Users/tester/repo ',
        }),
      }),
      { serverId: 'server-runtime' },
    );
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
      ready = await harness.getCurrent().requestTakeover('persisted', TARGET_DIRECTORY);
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
      ready = await harness.getCurrent().requestTakeover('direct', TARGET_DIRECTORY);
    });

    expect(ready).toBe(false);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'chatFooter.externalSessionMachineOffline');
    await harness.unmount();
  });

  it('uses the owning session server when send takeover is confirmed after an active-server switch', async () => {
    const refreshNow = vi.fn(async () => status);
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({
      action: 'direct',
      targetDirectory: TARGET_DIRECTORY,
    });
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
      target: {
        machineId: 'machine-1',
        machineHomeDir: TARGET_HOME_DIRECTORY,
        initialDirectory: TARGET_DIRECTORY,
        machinePlatform: 'darwin',
        serverId: 'server-owned',
      },
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
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: null });
    const harness = await renderHarness({ externalSessionLink, status: null, refreshNow, sessionServerId: 'server-owned' });

    await act(async () => {
      await harness.getCurrent().requestTakeoverPreflight();
    });

    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(refreshNow).toHaveBeenCalledWith();
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: false,
      canTakeOverPersist: true,
      target: {
        machineId: 'machine-1',
        machineHomeDir: TARGET_HOME_DIRECTORY,
        initialDirectory: TARGET_DIRECTORY,
        machinePlatform: 'darwin',
        serverId: 'server-owned',
      },
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
      .mockResolvedValueOnce({ action: 'recheck' })
      .mockResolvedValueOnce({ action: null });
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
    expect(refreshNow).toHaveBeenNthCalledWith(1);
    expect(refreshNow).toHaveBeenNthCalledWith(2);
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenNthCalledWith(1, {
      canTakeOverDirect: false,
      canTakeOverPersist: false,
      runningProcessPid: 12_345,
    });
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenNthCalledWith(2, {
      canTakeOverDirect: false,
      canTakeOverPersist: true,
      target: {
        machineId: 'machine-1',
        machineHomeDir: TARGET_HOME_DIRECTORY,
        initialDirectory: TARGET_DIRECTORY,
        machinePlatform: 'darwin',
        serverId: 'server-owned',
      },
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

  it('does not admit send readiness when the exact external link changes before passive effects flush', async () => {
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
    const readyForSend = harness.getCurrent().ensureReadyForSend();
    await act(async () => {
      await Promise.resolve();
    });

    // `act` flushes passive effects, which would miss the render-phase scope gap.
    const actEnvironment = (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      harness.rerenderWithoutPassiveEffects({
        ...firstRuntime,
        externalSessionLink: {
          ...firstRuntime.externalSessionLink,
          linkData: { projectId: 'project-b' },
        },
        refreshNow: vi.fn(async () => status),
      });
    } finally {
      (globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }

    firstRefresh.resolve({ ...status, runnerActive: true });
    await expect(readyForSend).resolves.toBe(false);

    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(refreshSessionMessagesSpy).not.toHaveBeenCalled();
    expect(refreshSessionsSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('suppresses a late terminal-auth rejection from a stale explicit preflight', async () => {
    const refresh = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const firstRuntime = {
      externalSessionLink,
      status: null,
      refreshNow: vi.fn(async () => await refresh.promise),
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
      refresh.reject({ kind: 'auth', canTryAgain: false });
      await expect(stalePreflight).resolves.toBe(false);
    });

    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('propagates a terminal-auth rejection from a current explicit preflight', async () => {
    const terminalAuthError = { kind: 'auth', canTryAgain: false };
    const harness = await renderHarness({
      externalSessionLink,
      status: null,
      refreshNow: vi.fn(async () => {
        throw terminalAuthError;
      }),
      sessionServerId: 'server-owned',
    });

    await act(async () => {
      await expect(harness.getCurrent().requestTakeoverPreflight()).rejects.toBe(terminalAuthError);
    });

    expect(modalAlertSpy).not.toHaveBeenCalled();
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

  it('blocks a stale send-status failure without presenting an alert after unmount', async () => {
    const refresh = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const harness = await renderHarness({
      externalSessionLink,
      status: null,
      refreshNow: vi.fn(async () => await refresh.promise),
      sessionServerId: 'server-owned',
    });

    const readyForSend = harness.getCurrent().ensureReadyForSend();
    await act(async () => {
      await Promise.resolve();
    });
    await harness.unmount();

    let ready = true;
    await act(async () => {
      refresh.reject(new Error('Failed to fetch'));
      ready = await readyForSend;
    });

    expect(ready).toBe(false);
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
  });

  it('suppresses a late terminal-auth rejection after the external link is replaced', async () => {
    const refresh = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const firstRuntime = {
      externalSessionLink,
      status: null,
      refreshNow: vi.fn(async () => await refresh.promise),
      sessionServerId: 'server-owned',
    };
    const harness = await renderHarness(firstRuntime);

    const readyForSend = harness.getCurrent().ensureReadyForSend();
    await act(async () => {
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
      refresh.reject({ kind: 'auth', canTryAgain: false });
      await expect(readyForSend).resolves.toBe(false);
    });

    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('propagates a terminal-auth rejection while send scope is current', async () => {
    const terminalAuthError = { kind: 'auth', canTryAgain: false };
    const harness = await renderHarness({
      externalSessionLink,
      status: null,
      refreshNow: vi.fn(async () => {
        throw terminalAuthError;
      }),
      sessionServerId: 'server-owned',
    });

    await act(async () => {
      await expect(harness.getCurrent().ensureReadyForSend()).rejects.toBe(terminalAuthError);
    });

    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('does not admit a late successful send status refresh after unmount', async () => {
    const refresh = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const harness = await renderHarness({
      externalSessionLink,
      status: null,
      refreshNow: vi.fn(async () => await refresh.promise),
      sessionServerId: 'server-owned',
    });

    const readyForSend = harness.getCurrent().ensureReadyForSend();
    await act(async () => {
      await Promise.resolve();
    });
    await harness.unmount();

    let ready = true;
    await act(async () => {
      refresh.resolve({ ...status, runnerActive: true });
      ready = await readyForSend;
    });

    expect(ready).toBe(false);
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
  });

  it('does not present takeover UI when a successful send status refresh belongs to a replaced link', async () => {
    const refresh = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const firstRuntime = {
      externalSessionLink,
      status: null,
      refreshNow: vi.fn(async () => await refresh.promise),
      sessionServerId: 'server-owned',
    };
    const harness = await renderHarness(firstRuntime);

    const readyForSend = harness.getCurrent().ensureReadyForSend();
    await act(async () => {
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

    let ready = true;
    await act(async () => {
      refresh.resolve(status);
      ready = await readyForSend;
    });

    expect(ready).toBe(false);
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('does not start takeover when its confirmation refresh resolves for a replaced link', async () => {
    const confirmationRefresh = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const confirmationReadStarted = createDeferred<void>();
    let refreshCount = 0;
    const refreshNow = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount === 1) return status;
      confirmationReadStarted.resolve();
      return await confirmationRefresh.promise;
    });
    const firstRuntime = {
      externalSessionLink,
      status: null,
      refreshNow,
      sessionServerId: 'server-owned',
    };
    showExternalSessionTakeoverDialogSpy.mockResolvedValueOnce({
      action: 'direct',
      targetDirectory: TARGET_DIRECTORY,
    });
    const harness = await renderHarness(firstRuntime);

    let readyForSend: Promise<boolean> | null = null;
    await act(async () => {
      readyForSend = harness.getCurrent().ensureReadyForSend();
      await confirmationReadStarted.promise;
    });
    await harness.rerender({
      ...firstRuntime,
      externalSessionLink: {
        ...externalSessionLink,
        remoteSessionId: 'vendor-session-2',
      },
      refreshNow: vi.fn(async () => status),
    });

    if (!readyForSend) {
      throw new Error('The takeover confirmation refresh did not start');
    }
    const pendingReadyForSend = readyForSend;

    let ready = true;
    await act(async () => {
      confirmationRefresh.resolve(status);
      ready = await pendingReadyForSend;
    });

    expect(ready).toBe(false);
    expect(refreshNow).toHaveBeenCalledTimes(2);
    expect(showExternalSessionTakeoverDialogSpy).toHaveBeenCalledTimes(1);
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(refreshSessionMessagesSpy).not.toHaveBeenCalled();
    expect(refreshSessionsSpy).not.toHaveBeenCalled();
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

  it('blocks send without requesting takeover when the direct-session status refresh has a transient connectivity failure', async () => {
    const refreshNow = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-owned' });

    let ready = false;
    await act(async () => {
      ready = await harness.getCurrent().ensureReadyForSend();
    });

    expect(ready).toBe(false);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(refreshSessionMessagesSpy).not.toHaveBeenCalled();
    expect(refreshSessionsSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'chatFooter.externalSessionStatusUnavailable',
    );
    await harness.unmount();
  });

  it('blocks send without reusing a stale status when the direct-session status refresh returns no status', async () => {
    const refreshNow = vi.fn(async () => null);
    const harness = await renderHarness({ externalSessionLink, status, refreshNow, sessionServerId: 'server-owned' });

    let ready = true;
    await act(async () => {
      ready = await harness.getCurrent().ensureReadyForSend();
    });

    expect(ready).toBe(false);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(refreshSessionMessagesSpy).not.toHaveBeenCalled();
    expect(refreshSessionsSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      'chatFooter.externalSessionStatusUnavailable',
    );
    await harness.unmount();
  });

  it('never starts a takeover after the Account retires during the status read', async () => {
    const statusRead = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const refreshNow = vi.fn(async () => await statusRead.promise);
    const harness = await renderHarness({
      externalSessionLink,
      status: null,
      refreshNow,
      sessionServerId: 'server-owned',
    });

    let ready = true;
    await act(async () => {
      const pending = harness.getCurrent().requestTakeover('direct', TARGET_DIRECTORY);
      await Promise.resolve();
      activeAccountIsCurrent = false;
      statusRead.resolve(status);
      ready = await pending;
    });

    expect(ready).toBe(false);
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverPersistSpy).not.toHaveBeenCalled();
    expect(refreshSessionsSpy).not.toHaveBeenCalled();
    expect(refreshSessionMessagesSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('never prompts for send takeover after the Account retires during the status read', async () => {
    const statusRead = createDeferred<NonNullable<ExternalSessionRuntimeLike['status']>>();
    const refreshNow = vi.fn(async () => await statusRead.promise);
    const harness = await renderHarness({
      externalSessionLink,
      status: null,
      refreshNow,
      sessionServerId: 'server-owned',
    });

    let ready = true;
    await act(async () => {
      const pending = harness.getCurrent().ensureReadyForSend();
      await Promise.resolve();
      activeAccountIsCurrent = false;
      statusRead.resolve(status);
      ready = await pending;
    });

    expect(ready).toBe(false);
    expect(showExternalSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineExternalSessionTakeoverSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('keeps an accepted takeover accepted when best-effort projection refresh fails', async () => {
    const refreshNow = vi.fn(async () => status);
    refreshSessionsSpy.mockRejectedValue(new Error('projection refresh unavailable'));
    const harness = await renderHarness({
      externalSessionLink,
      status,
      refreshNow,
      sessionServerId: 'server-runtime',
    });

    let ready = false;
    await act(async () => {
      ready = await harness.getCurrent().requestTakeover('direct', TARGET_DIRECTORY);
    });

    expect(ready).toBe(true);
    expect(machineExternalSessionTakeoverSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });
});
