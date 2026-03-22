import { resolveSwitchRequestTarget } from '@/agent/localControl/switchRequestTarget';
import type { AgentState } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { createAgentLocalControlState } from '@/agent/localControl/createAgentLocalControlState';

type Mode = 'local' | 'remote';

type LocalSwitchAvailabilityResult =
  | { ok: true }
  | { ok: false; reason: string };

type SessionSwitchHandler = (params: unknown) => Promise<boolean>;

export type LocalRemoteModeControllerSession = {
  sendSessionEvent: (event: { type: 'switch'; mode: Mode }) => void;
  updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
  keepAlive: (thinking: boolean, mode: Mode) => void;
  rpcHandlerManager: {
    registerHandler: (name: 'switch', handler: SessionSwitchHandler) => void;
  };
};

export function createLocalRemoteModeController(params: {
  session: LocalRemoteModeControllerSession;
  getThinking: () => boolean;
  resolveLocalSwitchAvailability: () => Promise<LocalSwitchAvailabilityResult>;
  requestSwitchToLocalIfSupported: () => Promise<boolean>;
  mountRemoteUi: () => void;
  unmountRemoteUi: () => Promise<void>;
  setRemoteUiAllowsSwitchToLocal: (allowed: boolean) => void;
  buildAgentStateForMode?: (
    currentState: AgentState,
    nextMode: Mode,
    context: Readonly<{ canSwitchToLocalFromRemote: boolean }>,
  ) => AgentState;
}) {
  let lastPublishedMode: Mode | null = null;

  const publishModeState = async (nextMode: Mode): Promise<void> => {
    const canSwitchToLocalFromRemote =
      nextMode === 'remote' ? (await params.resolveLocalSwitchAvailability()).ok : false;

    if (lastPublishedMode !== null && lastPublishedMode !== nextMode) {
      params.session.sendSessionEvent({ type: 'switch', mode: nextMode });
    }
    lastPublishedMode = nextMode;

    updateAgentStateBestEffort(
      params.session,
      (currentState) => (params.buildAgentStateForMode
        ? params.buildAgentStateForMode(currentState, nextMode, { canSwitchToLocalFromRemote })
        : {
          ...currentState,
          controlledByUser: nextMode === 'local',
          localControl: createAgentLocalControlState({
            attached: nextMode === 'local',
            topology: 'exclusive',
            canAttach: canSwitchToLocalFromRemote,
          }),
        }),
      '[localControl]',
      'publish_mode_state',
    );
    params.session.keepAlive(params.getThinking(), nextMode);

    if (nextMode === 'remote') {
      params.setRemoteUiAllowsSwitchToLocal(canSwitchToLocalFromRemote);
      params.mountRemoteUi();
    } else {
      params.setRemoteUiAllowsSwitchToLocal(false);
      await params.unmountRemoteUi();
    }
  };

  const registerRemoteSwitchHandler = (): void => {
    params.session.rpcHandlerManager.registerHandler('switch', async (requestParams: unknown) => {
      const to = resolveSwitchRequestTarget(requestParams);

      // Remote launcher is already in remote mode, so {to:'remote'} is a no-op.
      if (to === 'remote') return true;
      return await params.requestSwitchToLocalIfSupported();
    });
  };

  return {
    publishModeState,
    registerRemoteSwitchHandler,
  };
}
