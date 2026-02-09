import { resolveSwitchRequestTarget } from '@/agent/localControl/switchRequestTarget';

type Mode = 'local' | 'remote';

type LocalSwitchAvailabilityResult =
  | { ok: true }
  | { ok: false; reason: string };

type SessionSwitchHandler = (params: unknown) => Promise<boolean>;

export type LocalRemoteModeControllerSession = {
  sendSessionEvent: (event: { type: 'switch'; mode: Mode }) => void;
  updateAgentState: (updater: (state: Record<string, unknown>) => Record<string, unknown>) => void;
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
}) {
  let lastPublishedMode: Mode | null = null;
  let switchHandlerRegistered = false;

  const publishModeState = async (nextMode: Mode): Promise<void> => {
    if (lastPublishedMode !== nextMode) {
      params.session.sendSessionEvent({ type: 'switch', mode: nextMode });
      lastPublishedMode = nextMode;
    }

    params.session.updateAgentState((currentState) => ({
      ...currentState,
      controlledByUser: nextMode === 'local',
    }));
    params.session.keepAlive(params.getThinking(), nextMode);

    if (nextMode === 'remote') {
      params.setRemoteUiAllowsSwitchToLocal((await params.resolveLocalSwitchAvailability()).ok);
      params.mountRemoteUi();
    } else {
      params.setRemoteUiAllowsSwitchToLocal(false);
      await params.unmountRemoteUi();
    }
  };

  const registerRemoteSwitchHandler = (): void => {
    if (switchHandlerRegistered) return;
    switchHandlerRegistered = true;
    params.session.rpcHandlerManager.registerHandler('switch', async (requestParams: unknown) => {
      const to = resolveSwitchRequestTarget(requestParams);

      // Remote launcher is already in remote mode, so {to:'remote'} is a no-op.
      if (to === 'remote') return false;
      return await params.requestSwitchToLocalIfSupported();
    });
  };

  return {
    publishModeState,
    registerRemoteSwitchHandler,
  };
}
