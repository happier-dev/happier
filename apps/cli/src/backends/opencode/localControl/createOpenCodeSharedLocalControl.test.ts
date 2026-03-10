import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeSharedLocalControl } from './createOpenCodeSharedLocalControl';
import type { OpenCodeTuiSupervisor } from './openCodeTuiSupervisor';

function createSessionHarness(sessionId: string) {
  let agentState: Record<string, unknown> = {};
  let switchHandler: ((params: unknown) => Promise<boolean>) | null = null;

  return {
    session: {
      sessionId,
      sendSessionEvent: vi.fn(),
      updateAgentState: vi.fn((updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
        agentState = updater(agentState);
      }),
      keepAlive: vi.fn(),
      rpcHandlerManager: {
        registerHandler: vi.fn((name: string, handler: (params: unknown) => Promise<boolean>) => {
          if (name === 'switch') switchHandler = handler;
        }),
      },
      getMetadataSnapshot: vi.fn(() => ({ path: '/tmp/workspace' })),
    },
    readAgentState: () => agentState,
    invokeSwitch: async (params: unknown) => {
      if (!switchHandler) throw new Error('switch handler not registered');
      return await switchHandler(params);
    },
  };
}

function createSupervisorHarness(): OpenCodeTuiSupervisor & {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  let attached = false;

  return {
    isAttached: () => attached,
    attach: vi.fn(async () => {
      attached = true;
      return true;
    }),
    detach: vi.fn(async () => {
      attached = false;
    }),
    dispose: vi.fn(async () => {
      attached = false;
    }),
  };
}

describe('createOpenCodeSharedLocalControl', () => {
  it('renders the remote terminal UI only while the session stays in remote mode', async () => {
    const harness = createSessionHarness('happy-session-1');
    const supervisor = createSupervisorHarness();
    const mountRemoteUi = vi.fn();
    const unmountRemoteUi = vi.fn(async () => undefined);
    const localControl = createOpenCodeSharedLocalControl({
      support: { ok: true },
      startingMode: 'remote',
      getSession: () => harness.session as any,
      getSessionId: () => 'opencode-session-1',
      getDirectory: () => '/tmp/workspace',
      getServerBaseUrl: () => 'http://127.0.0.1:4096',
      supervisor,
      mountRemoteUi,
      unmountRemoteUi,
    });

    expect(localControl.shouldRenderTerminalDisplay()).toBe(true);
    await localControl.onAfterStart();
    expect(mountRemoteUi).toHaveBeenCalledTimes(1);

    await expect(harness.invokeSwitch({ to: 'local' })).resolves.toBe(true);
    expect(unmountRemoteUi).toHaveBeenCalledTimes(1);
    expect(localControl.shouldRenderTerminalDisplay()).toBe(false);

    await expect(harness.invokeSwitch({ to: 'remote' })).resolves.toBe(true);
    expect(mountRemoteUi).toHaveBeenCalledTimes(2);
    expect(localControl.shouldRenderTerminalDisplay()).toBe(true);
  });

  it('attaches in local mode and publishes shared writable local-control state', async () => {
    const harness = createSessionHarness('happy-session-1');
    const supervisor = createSupervisorHarness();
    const localControl = createOpenCodeSharedLocalControl({
      support: { ok: true },
      startingMode: 'local',
      getSession: () => harness.session as any,
      getSessionId: () => 'opencode-session-1',
      getDirectory: () => '/tmp/workspace',
      getServerBaseUrl: () => 'http://127.0.0.1:4096',
      supervisor,
    });

    await localControl.onAfterStart();

    expect(supervisor.attach).toHaveBeenCalledTimes(1);
    expect(supervisor.attach).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'opencode-session-1',
    });
    expect(harness.readAgentState()).toMatchObject({
      controlledByUser: false,
      localControl: {
        attached: true,
        topology: 'shared',
        remoteWritable: true,
        canAttach: true,
        canDetach: true,
      },
    });
    expect(harness.session.keepAlive).toHaveBeenCalledWith(false, 'local');
  });

  it('detaches when switching to remote from an attached local session', async () => {
    const harness = createSessionHarness('happy-session-1');
    const supervisor = createSupervisorHarness();
    const localControl = createOpenCodeSharedLocalControl({
      support: { ok: true },
      startingMode: 'local',
      getSession: () => harness.session as any,
      getSessionId: () => 'opencode-session-1',
      getDirectory: () => '/tmp/workspace',
      getServerBaseUrl: () => 'http://127.0.0.1:4096',
      supervisor,
    });

    await localControl.onAfterStart();
    await expect(harness.invokeSwitch({ to: 'remote' })).resolves.toBe(true);

    expect(supervisor.detach).toHaveBeenCalledTimes(1);
    expect(harness.readAgentState()).toMatchObject({
      controlledByUser: false,
      localControl: {
        attached: false,
        topology: 'shared',
        remoteWritable: true,
      },
    });
    expect(harness.session.keepAlive).toHaveBeenLastCalledWith(false, 'remote');
  });

  it('reattaches to the latest provider session after a session swap while local mode is active', async () => {
    const firstSession = createSessionHarness('happy-session-1');
    const secondSession = createSessionHarness('happy-session-2');
    const supervisor = createSupervisorHarness();
    let currentSession = firstSession.session as any;
    let currentProviderSessionId = 'opencode-session-1';

    const localControl = createOpenCodeSharedLocalControl({
      support: { ok: true },
      startingMode: 'local',
      getSession: () => currentSession,
      getSessionId: () => currentProviderSessionId,
      getDirectory: () => '/tmp/workspace',
      getServerBaseUrl: () => 'http://127.0.0.1:4096',
      supervisor,
    });

    await localControl.onAfterStart();

    currentSession = secondSession.session as any;
    currentProviderSessionId = 'opencode-session-2';

    await localControl.onSessionSwap(secondSession.session as any);

    expect(supervisor.detach).toHaveBeenCalledTimes(1);
    expect(supervisor.attach).toHaveBeenCalledTimes(2);
    expect(supervisor.attach).toHaveBeenLastCalledWith({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'opencode-session-2',
    });
    expect(secondSession.readAgentState()).toMatchObject({
      controlledByUser: false,
      localControl: {
        attached: true,
        topology: 'shared',
        remoteWritable: true,
      },
    });
  });

  it('falls back to remote mode when local attach fails during startup', async () => {
    const harness = createSessionHarness('happy-session-1');
    const supervisor = createSupervisorHarness();
    supervisor.attach.mockResolvedValue(false);
    const mountRemoteUi = vi.fn();

    const localControl = createOpenCodeSharedLocalControl({
      support: { ok: true },
      startingMode: 'local',
      getSession: () => harness.session as any,
      getSessionId: () => 'opencode-session-1',
      getDirectory: () => '/tmp/workspace',
      getServerBaseUrl: () => 'http://127.0.0.1:4096',
      supervisor,
      mountRemoteUi,
    });

    await localControl.onAfterStart();

    expect(harness.readAgentState()).toMatchObject({
      controlledByUser: false,
      localControl: {
        attached: false,
        topology: 'shared',
        remoteWritable: true,
      },
    });
    expect(mountRemoteUi).toHaveBeenCalledTimes(1);
    expect(localControl.shouldRenderTerminalDisplay()).toBe(true);
  });
});
