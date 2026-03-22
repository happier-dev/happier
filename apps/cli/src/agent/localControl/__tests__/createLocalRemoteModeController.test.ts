import { describe, expect, it, vi } from 'vitest';

import { createLocalRemoteModeController } from '../createLocalRemoteModeController';

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

describe('createLocalRemoteModeController', () => {
  it('publishes remote mode state and keeps remote UI in sync', async () => {
    const harness = createSessionHarness();
    const resolveLocalSwitchAvailability = vi.fn(async () => ({ ok: true as const }));
    const mountRemoteUi = vi.fn();
    const unmountRemoteUi = vi.fn(async () => undefined);
    const setRemoteUiAllowsSwitchToLocal = vi.fn();

    const controller = createLocalRemoteModeController({
      session: harness.session,
      getThinking: () => true,
      resolveLocalSwitchAvailability,
      requestSwitchToLocalIfSupported: vi.fn(async () => true),
      mountRemoteUi,
      unmountRemoteUi,
      setRemoteUiAllowsSwitchToLocal,
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
    expect(resolveLocalSwitchAvailability).toHaveBeenCalledTimes(2);
    expect(setRemoteUiAllowsSwitchToLocal).toHaveBeenNthCalledWith(1, true);
    expect(setRemoteUiAllowsSwitchToLocal).toHaveBeenNthCalledWith(2, true);
    expect(mountRemoteUi).toHaveBeenCalledTimes(2);
    expect(unmountRemoteUi).not.toHaveBeenCalled();
  });

  it('publishes local mode state and unmounts remote UI', async () => {
    const harness = createSessionHarness();
    const controller = createLocalRemoteModeController({
      session: harness.session,
      getThinking: () => false,
      resolveLocalSwitchAvailability: vi.fn(async () => ({ ok: true as const })),
      requestSwitchToLocalIfSupported: vi.fn(async () => true),
      mountRemoteUi: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      setRemoteUiAllowsSwitchToLocal: vi.fn(),
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

  it('publishes remote mode as non-attachable when local control support is unavailable', async () => {
    const harness = createSessionHarness();
    const resolveLocalSwitchAvailability = vi.fn(async () => ({ ok: false as const, reason: 'started-by-daemon' }));
    const setRemoteUiAllowsSwitchToLocal = vi.fn();

    const controller = createLocalRemoteModeController({
      session: harness.session,
      getThinking: () => false,
      resolveLocalSwitchAvailability,
      requestSwitchToLocalIfSupported: vi.fn(async () => false),
      mountRemoteUi: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      setRemoteUiAllowsSwitchToLocal,
    });

    await controller.publishModeState('remote');

    expect(resolveLocalSwitchAvailability).toHaveBeenCalledTimes(1);
    expect(setRemoteUiAllowsSwitchToLocal).toHaveBeenCalledWith(false);
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

  it('supports provider-specific local-control state publication', async () => {
    const harness = createSessionHarness();
    const controller = createLocalRemoteModeController({
      session: harness.session,
      getThinking: () => false,
      resolveLocalSwitchAvailability: vi.fn(async () => ({ ok: true as const })),
      requestSwitchToLocalIfSupported: vi.fn(async () => true),
      mountRemoteUi: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      setRemoteUiAllowsSwitchToLocal: vi.fn(),
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

  it('registers one switch handler and routes only local-switch requests', async () => {
    const harness = createSessionHarness();
    const requestSwitchToLocalIfSupported = vi.fn(async () => true);

    const controller = createLocalRemoteModeController({
      session: harness.session,
      getThinking: () => false,
      resolveLocalSwitchAvailability: vi.fn(async () => ({ ok: true as const })),
      requestSwitchToLocalIfSupported,
      mountRemoteUi: vi.fn(),
      unmountRemoteUi: vi.fn(async () => undefined),
      setRemoteUiAllowsSwitchToLocal: vi.fn(),
    });

    controller.registerRemoteSwitchHandler();
    expect(harness.session.rpcHandlerManager.registerHandler).toHaveBeenCalledTimes(1);

    await expect(harness.invokeSwitch({ to: 'remote' })).resolves.toBe(true);
    expect(requestSwitchToLocalIfSupported).not.toHaveBeenCalled();

    await expect(harness.invokeSwitch({ to: 'local' })).resolves.toBe(true);
    await expect(harness.invokeSwitch(undefined)).resolves.toBe(true);
    expect(requestSwitchToLocalIfSupported).toHaveBeenCalledTimes(2);

    // Simulate a local-mode launcher overriding the switch handler, then ensure remote
    // mode can re-register its handler to regain local-switch support.
    const localModeSwitchHandler = vi.fn(async () => true);
    harness.session.rpcHandlerManager.registerHandler('switch', localModeSwitchHandler);
    await expect(harness.invokeSwitch({ to: 'local' })).resolves.toBe(true);
    expect(localModeSwitchHandler).toHaveBeenCalledTimes(1);

    controller.registerRemoteSwitchHandler();
    expect(harness.session.rpcHandlerManager.registerHandler).toHaveBeenCalledTimes(3);

    await expect(harness.invokeSwitch({ to: 'local' })).resolves.toBe(true);
    expect(requestSwitchToLocalIfSupported).toHaveBeenCalledTimes(3);
  });
});
