import { resolveTerminalRemoteSwitchRequestTarget } from './switchTarget';
import type { AgentState } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { createAgentRuntimeSwitchState } from './createSwitchState';

type TerminalRemoteMode = 'local' | 'remote';

type TerminalSwitchAvailabilityResult =
  | { ok: true }
  | { ok: false; reason: string };

type SessionSwitchHandler = (params: unknown) => Promise<boolean>;

export type TerminalRemoteModeControllerSession = {
  sendSessionEvent: (event: { type: 'switch'; mode: TerminalRemoteMode }) => void;
  updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
  keepAlive: (activityActive: boolean, mode: TerminalRemoteMode) => void;
  rpcHandlerManager: {
    registerHandler: (name: 'switch', handler: SessionSwitchHandler) => void;
  };
};

export function createTerminalRemoteModeController(params: {
  session: TerminalRemoteModeControllerSession;
  getKeepAliveActive: () => boolean;
  resolveTerminalSwitchAvailability: () => Promise<TerminalSwitchAvailabilityResult>;
  requestSwitchToTerminalIfSupported: () => Promise<boolean>;
  mountRemoteUi: () => void;
  unmountRemoteUi: () => Promise<void>;
  setRemoteUiAllowsSwitchToTerminal: (allowed: boolean) => void;
  buildAgentStateForMode?: (
    currentState: AgentState,
    nextMode: TerminalRemoteMode,
    context: Readonly<{ canSwitchToTerminalFromRemote: boolean }>,
  ) => AgentState;
}) {
  let lastPublishedMode: TerminalRemoteMode | null = null;

  const publishModeState = async (nextMode: TerminalRemoteMode): Promise<void> => {
    const canSwitchToTerminalFromRemote =
      nextMode === 'remote' ? (await params.resolveTerminalSwitchAvailability()).ok : false;

    if (lastPublishedMode !== null && lastPublishedMode !== nextMode) {
      params.session.sendSessionEvent({ type: 'switch', mode: nextMode });
    }
    lastPublishedMode = nextMode;

    updateAgentStateBestEffort(
      params.session,
      (currentState) => (params.buildAgentStateForMode
        ? params.buildAgentStateForMode(currentState, nextMode, { canSwitchToTerminalFromRemote })
        : {
          ...currentState,
          controlledByUser: nextMode === 'local',
          localControl: createAgentRuntimeSwitchState({
            attached: nextMode === 'local',
            topology: 'exclusive',
            canAttach: canSwitchToTerminalFromRemote,
            remoteWritable: nextMode === 'remote',
          }),
        }),
      '[runtime/mode/switching]',
      'publish_mode_state',
    );
    params.session.keepAlive(params.getKeepAliveActive(), nextMode);

    if (nextMode === 'remote') {
      params.setRemoteUiAllowsSwitchToTerminal(canSwitchToTerminalFromRemote);
      params.mountRemoteUi();
    } else {
      params.setRemoteUiAllowsSwitchToTerminal(false);
      await params.unmountRemoteUi();
    }
  };

  const registerRemoteSwitchHandler = (): void => {
    params.session.rpcHandlerManager.registerHandler('switch', async (requestParams: unknown) => {
      const to = resolveTerminalRemoteSwitchRequestTarget(requestParams);

      // Remote launcher is already in remote mode, so {to:'remote'} is a no-op.
      if (to === 'remote') return true;
      return await params.requestSwitchToTerminalIfSupported();
    });
  };

  return {
    publishModeState,
    registerRemoteSwitchHandler,
  };
}
