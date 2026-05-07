import type { LocalTurnLifecycleController } from './localTurnLifecycleTypes';

export type DeferredRemoteSwitchSource =
  | 'queued_message'
  | 'rpc_switch'
  | 'process_exit'
  | 'startup_pending'
  | 'server_pending_queue';

export type DeferredRemoteSwitchController<Mode, Message> = Readonly<{
  onQueuedMessage: (message: Message, mode: Mode) => void;
  requestRemoteSwitch: (source: DeferredRemoteSwitchSource) => Promise<boolean>;
  cancel: (reason: string) => void;
  dispose: () => void;
}>;

export function createDeferredRemoteSwitchController<Mode, Message = string>(opts: Readonly<{
  lifecycle: LocalTurnLifecycleController;
  providerLabel: string;
  requestSwitchToRemote: (source: DeferredRemoteSwitchSource) => Promise<boolean>;
  onQueuedMessageMode?: (mode: Mode) => void;
  sendStatusMessage?: (message: string) => void;
}>): DeferredRemoteSwitchController<Mode, Message> {
  let disposed = false;
  let pendingSwitchPromise: Promise<boolean> | null = null;
  let immediateSwitchPromise: Promise<boolean> | null = null;

  const runSwitch = async (source: DeferredRemoteSwitchSource): Promise<boolean> => {
    if (disposed) return false;
    if (!immediateSwitchPromise) {
      immediateSwitchPromise = opts.requestSwitchToRemote(source).finally(() => {
        immediateSwitchPromise = null;
      });
    }
    return await immediateSwitchPromise;
  };

  const requestRemoteSwitch = async (source: DeferredRemoteSwitchSource): Promise<boolean> => {
    if (disposed) return false;

    const snapshot = opts.lifecycle.snapshot();
    if (!snapshot.active || snapshot.terminal) {
      return await runSwitch(source);
    }

    if (!pendingSwitchPromise) {
      opts.sendStatusMessage?.(`Waiting for ${opts.providerLabel} to finish the current local turn before switching to remote.`);
      pendingSwitchPromise = (async () => {
        await opts.lifecycle.waitForSafeRemoteHandoff();
        return await runSwitch(source);
      })().finally(() => {
        pendingSwitchPromise = null;
      });
    }

    return await pendingSwitchPromise;
  };

  const onQueuedMessage = (_message: Message, mode: Mode): void => {
    if (disposed) return;
    opts.onQueuedMessageMode?.(mode);
    void requestRemoteSwitch('queued_message').catch(() => undefined);
  };

  const cancel = (_reason: string): void => {
    disposed = true;
  };

  const dispose = (): void => {
    disposed = true;
  };

  return {
    onQueuedMessage,
    requestRemoteSwitch,
    cancel,
    dispose,
  };
}
