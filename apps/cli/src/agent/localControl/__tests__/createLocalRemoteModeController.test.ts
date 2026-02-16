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

    expect(harness.session.sendSessionEvent).toHaveBeenCalledTimes(1);
    expect(harness.session.sendSessionEvent).toHaveBeenCalledWith({ type: 'switch', mode: 'remote' });
    expect(harness.readAgentState()).toMatchObject({ controlledByUser: false, marker: 'keep-me' });
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

    expect(harness.session.sendSessionEvent).toHaveBeenCalledTimes(2);
    expect(harness.session.sendSessionEvent).toHaveBeenNthCalledWith(1, { type: 'switch', mode: 'remote' });
    expect(harness.session.sendSessionEvent).toHaveBeenNthCalledWith(2, { type: 'switch', mode: 'local' });
    expect(harness.readAgentState()).toMatchObject({ controlledByUser: true });
    expect(harness.session.keepAlive).toHaveBeenLastCalledWith(false, 'local');
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
    controller.registerRemoteSwitchHandler();

    expect(harness.session.rpcHandlerManager.registerHandler).toHaveBeenCalledTimes(1);

    await expect(harness.invokeSwitch({ to: 'remote' })).resolves.toBe(false);
    expect(requestSwitchToLocalIfSupported).not.toHaveBeenCalled();

    await expect(harness.invokeSwitch({ to: 'local' })).resolves.toBe(true);
    await expect(harness.invokeSwitch(undefined)).resolves.toBe(true);
    expect(requestSwitchToLocalIfSupported).toHaveBeenCalledTimes(2);
  });
});
