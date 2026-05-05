import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import { createTerminalRemoteModeController } from '../createModeController';

type Mode = 'local' | 'remote';

function createSessionHarness() {
  let agentState: Record<string, unknown> = { controlledByUser: false, marker: 'keep-me' };
  let switchHandler: ((params: unknown) => Promise<boolean>) | null = null;

  return {
    session: {
      sendSessionEvent: vi.fn(),
      updateAgentState: vi.fn((updater: (state: any) => any) => {
        agentState = updater(agentState);
      }),
      keepAlive: vi.fn(),
      rpcHandlerManager: {
        registerHandler: vi.fn((name: string, handler: (params: unknown) => Promise<boolean>) => {
          if (name === 'switch') switchHandler = handler;
        }),
      },
    },
    readAgentState: () => agentState,
    invokeSwitch: async (params: unknown) => {
      if (!switchHandler) throw new Error('switch handler not registered');
      return await switchHandler(params);
    },
  };
}

describe('createTerminalRemoteModeController', () => {
  it('publishes remote mode state and keeps remote UI in sync', async () => {
    const harness = createSessionHarness();
    const resolveTerminalSwitchAvailability = vi.fn(async () => ({ ok: true as const }));
    const mountRemoteUi = vi.fn();
    const unmountRemoteUi = vi.fn(async () => undefined);
    const setRemoteUiAllowsSwitchToTerminal = vi.fn();

    const controller = createTerminalRemoteModeController({
      session: harness.session,
      getKeepAliveActive: () => true,
      resolveTerminalSwitchAvailability,
      requestSwitchToTerminalIfSupported: vi.fn(async () => true),
      mountRemoteUi,
      unmountRemoteUi,
      setRemoteUiAllowsSwitchToTerminal,
    });

    await controller.publishModeState('remote');
    await controller.publishModeState('remote');

    expect(harness.session.sendSessionEvent).not.toHaveBeenCalled();
    expect(harness.readAgentState()).toMatchObject({
      controlledByUser: false,
      marker: 'keep-me',
      localControl: {
        attached: false,
        topology: 'exclusive',
        remoteWritable: true,
      },
    });
    expect(harness.session.keepAlive).toHaveBeenCalledTimes(2);
    expect(harness.session.keepAlive).toHaveBeenNthCalledWith(1, true, 'remote');
    expect(harness.session.keepAlive).toHaveBeenNthCalledWith(2, true, 'remote');
    expect(resolveTerminalSwitchAvailability).toHaveBeenCalledTimes(2);
    expect(setRemoteUiAllowsSwitchToTerminal).toHaveBeenNthCalledWith(1, true);
    expect(setRemoteUiAllowsSwitchToTerminal).toHaveBeenNthCalledWith(2, true);
    expect(mountRemoteUi).toHaveBeenCalledTimes(2);
    expect(unmountRemoteUi).not.toHaveBeenCalled();
  });

  it('publishes terminal mode state and unmounts remote UI', async () => {
    const harness = createSessionHarness();
    const controller = createTerminalRemoteModeController({
      session: harness.session,
      getKeepAliveActive: () => false,
      resolveTerminalSwitchAvailability: vi.fn(async () => ({ ok: true as const })),
      requestSwitchToTerminalIfSupported: vi.fn(async () => true),
      mountRemoteUi: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      setRemoteUiAllowsSwitchToTerminal: vi.fn(),
    });

    await controller.publishModeState('remote');
    await controller.publishModeState('local');

    expect(harness.session.sendSessionEvent).toHaveBeenCalledTimes(1);
    expect(harness.session.sendSessionEvent).toHaveBeenCalledWith({ type: 'switch', mode: 'local' });
    expect(harness.readAgentState()).toMatchObject({
      controlledByUser: true,
      localControl: {
        attached: true,
        topology: 'exclusive',
        remoteWritable: false,
      },
    });
    expect(harness.session.keepAlive).toHaveBeenLastCalledWith(false, 'local');
  });

  it('publishes remote mode as non-attachable when terminal switching is unavailable', async () => {
    const harness = createSessionHarness();
    const resolveTerminalSwitchAvailability = vi.fn(async () => ({ ok: false as const, reason: 'started-by-daemon' }));
    const setRemoteUiAllowsSwitchToTerminal = vi.fn();

    const controller = createTerminalRemoteModeController({
      session: harness.session,
      getKeepAliveActive: () => false,
      resolveTerminalSwitchAvailability,
      requestSwitchToTerminalIfSupported: vi.fn(async () => false),
      mountRemoteUi: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      setRemoteUiAllowsSwitchToTerminal,
    });

    await controller.publishModeState('remote');

    expect(resolveTerminalSwitchAvailability).toHaveBeenCalledTimes(1);
    expect(setRemoteUiAllowsSwitchToTerminal).toHaveBeenCalledWith(false);
    expect(harness.readAgentState()).toMatchObject({
      controlledByUser: false,
      localControl: {
        attached: false,
        topology: 'exclusive',
        remoteWritable: true,
        canAttach: false,
        canDetach: false,
      },
    });
  });

  it('supports agent-specific runtime-switch state publication', async () => {
    const harness = createSessionHarness();
    const controller = createTerminalRemoteModeController({
      session: harness.session,
      getKeepAliveActive: () => false,
      resolveTerminalSwitchAvailability: vi.fn(async () => ({ ok: true as const })),
      requestSwitchToTerminalIfSupported: vi.fn(async () => true),
      mountRemoteUi: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      setRemoteUiAllowsSwitchToTerminal: vi.fn(),
      buildAgentStateForMode: (currentState, nextMode) => ({
        ...currentState,
        controlledByUser: false,
        localControl: {
          attached: nextMode === 'local',
          topology: 'shared',
          remoteWritable: true,
          canAttach: true,
          canDetach: nextMode === 'local',
        },
      }),
    });

    await controller.publishModeState('remote');
    await controller.publishModeState('local');

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
  });

  it('registers one switch handler and routes only terminal-switch requests', async () => {
    const harness = createSessionHarness();
    const requestSwitchToTerminalIfSupported = vi.fn(async () => true);

    const controller = createTerminalRemoteModeController({
      session: harness.session,
      getKeepAliveActive: () => false,
      resolveTerminalSwitchAvailability: vi.fn(async () => ({ ok: true as const })),
      requestSwitchToTerminalIfSupported,
      mountRemoteUi: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      setRemoteUiAllowsSwitchToTerminal: vi.fn(),
    });

    controller.registerRemoteSwitchHandler();
    expect(harness.session.rpcHandlerManager.registerHandler).toHaveBeenCalledTimes(1);

    await expect(harness.invokeSwitch({ to: 'remote' })).resolves.toBe(true);
    expect(requestSwitchToTerminalIfSupported).not.toHaveBeenCalled();

    await expect(harness.invokeSwitch({ to: 'local' })).resolves.toBe(true);
    await expect(harness.invokeSwitch(undefined)).resolves.toBe(true);
    expect(requestSwitchToTerminalIfSupported).toHaveBeenCalledTimes(2);

    // Simulate a terminal-mode launcher overriding the switch handler, then ensure remote
    // mode can re-register its handler to regain terminal-switch support.
    const terminalModeSwitchHandler = vi.fn(async () => true);
    harness.session.rpcHandlerManager.registerHandler('switch', terminalModeSwitchHandler);
    await expect(harness.invokeSwitch({ to: 'local' })).resolves.toBe(true);
    expect(terminalModeSwitchHandler).toHaveBeenCalledTimes(1);

    controller.registerRemoteSwitchHandler();
    expect(harness.session.rpcHandlerManager.registerHandler).toHaveBeenCalledTimes(3);

    await expect(harness.invokeSwitch({ to: 'local' })).resolves.toBe(true);
    expect(requestSwitchToTerminalIfSupported).toHaveBeenCalledTimes(3);
  });
});
