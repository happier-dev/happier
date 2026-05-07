export type RemoteModeConfirmation = 'exit' | 'switch' | null;
export type RemoteModeActionInProgress = 'exiting' | 'switching' | null;

export type RemoteModeKeypressAction =
  | 'none'
  | 'reset'
  | 'redraw'
  | 'confirm-exit'
  | 'confirm-switch'
  | 'exit'
  | 'switch';

export type RemoteModeKeypress = Readonly<{
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}>;

export type RemoteModeControlSnapshot = Readonly<{
  confirmationMode: RemoteModeConfirmation;
  actionInProgress: RemoteModeActionInProgress;
}>;

export type RemoteModeControlSurface = 'ink' | 'static' | 'none';

const CONFIRMATION_TIMEOUT_MS = 15_000;
const ACTION_DELAY_MS = 100;

export function resolveRemoteModeControlSurface(params: Readonly<{
  stdoutIsTTY: unknown;
  stdinIsTTY: unknown;
  startedBy?: 'daemon' | 'terminal';
  terminalMode?: string | null;
}>): RemoteModeControlSurface {
  if (!params.stdoutIsTTY || !params.stdinIsTTY) return 'none';
  if (params.startedBy === 'daemon') {
    return params.terminalMode === 'tmux' ? 'static' : 'none';
  }
  return 'ink';
}

export function interpretRemoteModeKeypress(
  state: RemoteModeControlSnapshot,
  input: string,
  key: RemoteModeKeypress = {},
  opts?: { allowSwitchToLocal?: boolean },
): { action: RemoteModeKeypressAction } {
  if (state.actionInProgress) return { action: 'none' };

  const allowSwitchToLocal = opts?.allowSwitchToLocal !== false;

  if (key.ctrl && input === 'c') {
    return { action: state.confirmationMode === 'exit' ? 'exit' : 'confirm-exit' };
  }

  if (allowSwitchToLocal && key.ctrl && input === 't') {
    return { action: 'switch' };
  }

  if (key.ctrl && input === 'l') {
    return { action: 'redraw' };
  }

  if (allowSwitchToLocal && input === ' ') {
    return { action: state.confirmationMode === 'switch' ? 'switch' : 'confirm-switch' };
  }

  if (state.confirmationMode) {
    return { action: 'reset' };
  }

  return { action: 'none' };
}

export type RemoteModeControlController = Readonly<{
  getSnapshot: () => RemoteModeControlSnapshot;
  handleKeypress: (input: string, key?: RemoteModeKeypress) => void;
  dispose: () => void;
}>;

export function createRemoteModeControlController(params: Readonly<{
  allowSwitchToLocal?: boolean;
  onExit?: () => void | Promise<void>;
  onSwitchToLocal?: () => void | Promise<void>;
  onStateChange?: (snapshot: RemoteModeControlSnapshot) => void;
}>): RemoteModeControlController {
  let confirmationMode: RemoteModeConfirmation = null;
  let actionInProgress: RemoteModeActionInProgress = null;
  let confirmationTimeout: NodeJS.Timeout | null = null;
  let actionTimeout: NodeJS.Timeout | null = null;

  const getSnapshot = (): RemoteModeControlSnapshot => ({
    confirmationMode,
    actionInProgress,
  });

  const notify = (): void => {
    params.onStateChange?.(getSnapshot());
  };

  const clearConfirmationTimeout = (): void => {
    if (!confirmationTimeout) return;
    clearTimeout(confirmationTimeout);
    confirmationTimeout = null;
  };

  const clearActionTimeout = (): void => {
    if (!actionTimeout) return;
    clearTimeout(actionTimeout);
    actionTimeout = null;
  };

  const resetConfirmation = (): void => {
    clearConfirmationTimeout();
    if (confirmationMode === null) return;
    confirmationMode = null;
    notify();
  };

  const setConfirmationWithTimeout = (mode: Exclude<RemoteModeConfirmation, null>): void => {
    clearConfirmationTimeout();
    confirmationMode = mode;
    notify();
    confirmationTimeout = setTimeout(() => {
      confirmationTimeout = null;
      resetConfirmation();
    }, CONFIRMATION_TIMEOUT_MS);
  };

  const startAction = (
    mode: Exclude<RemoteModeActionInProgress, null>,
    callback: (() => void | Promise<void>) | undefined,
  ): void => {
    clearConfirmationTimeout();
    clearActionTimeout();
    confirmationMode = null;
    actionInProgress = mode;
    notify();
    actionTimeout = setTimeout(() => {
      actionTimeout = null;
      void callback?.();
    }, ACTION_DELAY_MS);
  };

  const handleKeypress = (input: string, key: RemoteModeKeypress = {}): void => {
    const { action } = interpretRemoteModeKeypress(getSnapshot(), input, key, {
      allowSwitchToLocal: params.allowSwitchToLocal === true,
    });

    if (action === 'none') return;
    if (action === 'reset') {
      resetConfirmation();
      return;
    }
    if (action === 'redraw') {
      notify();
      return;
    }
    if (action === 'confirm-exit') {
      setConfirmationWithTimeout('exit');
      return;
    }
    if (action === 'confirm-switch') {
      setConfirmationWithTimeout('switch');
      return;
    }
    if (action === 'exit') {
      startAction('exiting', params.onExit);
      return;
    }
    if (action === 'switch') {
      startAction('switching', params.onSwitchToLocal);
    }
  };

  const dispose = (): void => {
    clearConfirmationTimeout();
    clearActionTimeout();
  };

  return {
    getSnapshot,
    handleKeypress,
    dispose,
  };
}

export function formatRemoteModeStaticBanner(params: Readonly<{
  providerName: string;
  allowSwitchToLocal: boolean;
  snapshot?: RemoteModeControlSnapshot;
}>): string {
  const snapshot = params.snapshot ?? { confirmationMode: null, actionInProgress: null };
  const header = `Remote session running (${params.providerName}).`;

  if (snapshot.actionInProgress === 'switching') {
    return `${header}\nSwitching to local mode...`;
  }
  if (snapshot.actionInProgress === 'exiting') {
    return `${header}\nExiting session...`;
  }
  if (snapshot.confirmationMode === 'switch') {
    return `${header}\nPress Space again or Ctrl-T to switch to local mode.`;
  }
  if (snapshot.confirmationMode === 'exit') {
    return `${header}\nPress Ctrl-C again to exit this session.`;
  }

  const lines = [
    header,
    'This session is running in remote mode. You can access it from the Happier UI.',
  ];
  if (params.allowSwitchToLocal) {
    lines.push('Press Space twice or Ctrl-T to switch to local mode.');
  }
  lines.push('Press Ctrl-C twice to exit this session.');
  return lines.join('\n');
}

export type RemoteModeStaticControl = Readonly<{
  stop: () => Promise<void>;
}>;

function decodeStaticControlInput(chunk: string | Buffer | Uint8Array): ReadonlyArray<{
  input: string;
  key: RemoteModeKeypress;
}> {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const events: Array<{ input: string; key: RemoteModeKeypress }> = [];
  for (const char of text) {
    if (char === '\u0003') {
      events.push({ input: 'c', key: { ctrl: true } });
      continue;
    }
    if (char === '\u0014') {
      events.push({ input: 't', key: { ctrl: true } });
      continue;
    }
    if (char === '\u000c') {
      events.push({ input: 'l', key: { ctrl: true } });
      continue;
    }
    events.push({ input: char, key: {} });
  }
  return events;
}

export function startRemoteModeStaticControl(params: Readonly<{
  providerName: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  allowSwitchToLocal: boolean;
  onExit?: () => void | Promise<void>;
  onSwitchToLocal?: () => void | Promise<void>;
}>): RemoteModeStaticControl {
  const writeBanner = (snapshot?: RemoteModeControlSnapshot): void => {
    params.stdout.write(`\n${formatRemoteModeStaticBanner({
      providerName: params.providerName,
      allowSwitchToLocal: params.allowSwitchToLocal,
      snapshot,
    })}\n`);
  };

  const controller = createRemoteModeControlController({
    allowSwitchToLocal: params.allowSwitchToLocal,
    onExit: params.onExit,
    onSwitchToLocal: params.onSwitchToLocal,
    onStateChange: writeBanner,
  });

  const onData = (chunk: string | Buffer | Uint8Array): void => {
    for (const event of decodeStaticControlInput(chunk)) {
      controller.handleKeypress(event.input, event.key);
    }
  };

  params.stdin.on('data', onData);
  params.stdin.resume();
  if (params.stdin.isTTY && typeof params.stdin.setRawMode === 'function') {
    params.stdin.setRawMode(true);
  }
  params.stdin.setEncoding('utf8');
  writeBanner(controller.getSnapshot());

  return {
    stop: async () => {
      params.stdin.off('data', onData);
      controller.dispose();
      if (params.stdin.isTTY && typeof params.stdin.setRawMode === 'function') {
        try {
          params.stdin.setRawMode(false);
        } catch {
          // ignore best-effort terminal cleanup failures
        }
      }
      try {
        params.stdin.pause();
      } catch {
        // ignore best-effort terminal cleanup failures
      }
    },
  };
}
