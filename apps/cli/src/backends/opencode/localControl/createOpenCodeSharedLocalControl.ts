import { createAgentLocalControlState } from '@/agent/localControl/createAgentLocalControlState';
import { createLocalRemoteModeController } from '@/agent/localControl/createLocalRemoteModeController';
import { resolveSwitchRequestTarget } from '@/agent/localControl/switchRequestTarget';
import type { ApiSessionClient } from '@/api/session/sessionClient';

import { createOpenCodeTuiSupervisor, type OpenCodeTuiSupervisor } from './openCodeTuiSupervisor';
import type { OpenCodeLocalControlSupport } from './resolveOpenCodeLocalControlSupport';

type Mode = 'local' | 'remote';

export function createOpenCodeSharedLocalControl(params: Readonly<{
  support: OpenCodeLocalControlSupport;
  startingMode: Mode;
  getSession: () => ApiSessionClient | null;
  getSessionId: () => string | null;
  getDirectory: () => string;
  getServerBaseUrl: () => Promise<string | null> | string | null;
  supervisor?: OpenCodeTuiSupervisor;
  mountRemoteUi?: () => void;
  unmountRemoteUi?: () => Promise<void>;
}>): Readonly<{
  resolveKeepAliveMode: () => Mode;
  shouldRenderTerminalDisplay: () => boolean;
  onAfterStart: () => Promise<void>;
  onSessionSwap: (session: ApiSessionClient) => Promise<void>;
  dispose: () => Promise<void>;
}> {
  let currentMode: Mode = params.support.ok && params.startingMode === 'local' ? 'local' : 'remote';
  let attachedProviderSessionId: string | null = null;
  const supervisor = params.supervisor ?? createOpenCodeTuiSupervisor({
    onExit: async () => {
      currentMode = 'remote';
      attachedProviderSessionId = null;
      const session = params.getSession();
      if (!session) return;
      const controller = buildController(session);
      await controller.publishModeState('remote');
      controller.registerRemoteSwitchHandler();
    },
  });

  const attachLocal = async (): Promise<boolean> => {
    if (!params.support.ok) return false;
    const session = params.getSession();
    const sessionId = params.getSessionId();
    const baseUrl = await params.getServerBaseUrl();
    if (!session || !sessionId || !baseUrl) return false;
    if (supervisor.isAttached() && attachedProviderSessionId !== sessionId) {
      await supervisor.detach();
      attachedProviderSessionId = null;
    }
    const attached = await supervisor.attach({
      baseUrl,
      directory: params.getDirectory(),
      sessionId,
    });
    if (!attached) return false;
    attachedProviderSessionId = sessionId;
    currentMode = 'local';
    const controller = buildController(session);
    await controller.publishModeState('local');
    registerLocalSwitchHandler(session);
    return true;
  };

  const detachLocal = async (): Promise<boolean> => {
    const session = params.getSession();
    if (!session) return false;
    await supervisor.detach();
    attachedProviderSessionId = null;
    currentMode = 'remote';
    const controller = buildController(session);
    await controller.publishModeState('remote');
    controller.registerRemoteSwitchHandler();
    return true;
  };

  const buildController = (session: ApiSessionClient) => createLocalRemoteModeController({
    session,
    getThinking: () => false,
    resolveLocalSwitchAvailability: async () => params.support,
    requestSwitchToLocalIfSupported: attachLocal,
    mountRemoteUi: params.mountRemoteUi ?? (() => undefined),
    unmountRemoteUi: params.unmountRemoteUi ?? (async () => undefined),
    setRemoteUiAllowsSwitchToLocal: () => undefined,
    buildAgentStateForMode: (currentState, nextMode) => ({
      ...currentState,
      controlledByUser: false,
      localControl: createAgentLocalControlState({
        attached: nextMode === 'local',
        topology: 'shared',
        canAttach: params.support.ok,
        canDetach: nextMode === 'local',
        remoteWritable: true,
      }),
    }),
  });

  const registerLocalSwitchHandler = (session: ApiSessionClient): void => {
    session.rpcHandlerManager.registerHandler('switch', async (requestParams: unknown) => {
      const to = resolveSwitchRequestTarget(requestParams);
      if (to === 'local') return true;
      return await detachLocal();
    });
  };

  const publishCurrentMode = async (session: ApiSessionClient): Promise<void> => {
    const controller = buildController(session);
    await controller.publishModeState(currentMode);
    if (currentMode === 'local') {
      registerLocalSwitchHandler(session);
    } else {
      controller.registerRemoteSwitchHandler();
    }
  };

  return {
    resolveKeepAliveMode: () => currentMode,
    shouldRenderTerminalDisplay: () => currentMode === 'remote',
    onAfterStart: async () => {
      const session = params.getSession();
      if (!session) return;
      if (currentMode === 'local') {
        const attached = await attachLocal();
        if (attached) return;
        currentMode = 'remote';
      }
      await publishCurrentMode(session);
    },
    onSessionSwap: async (session) => {
      if (currentMode === 'local') {
        const attached = await attachLocal();
        if (attached) return;
        currentMode = 'remote';
      }
      await publishCurrentMode(session);
    },
    dispose: async () => {
      attachedProviderSessionId = null;
      await supervisor.dispose();
    },
  };
}
