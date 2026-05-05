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
  opts?: { allowSwitchToTerminal?: boolean },
): { action: RemoteModeKeypressAction } {
  if (state.actionInProgress) return { action: 'none' };

  const allowSwitchToTerminal = opts?.allowSwitchToTerminal !== false;

  if (key.ctrl && input === 'c') {
    return { action: state.confirmationMode === 'exit' ? 'exit' : 'confirm-exit' };
  }

  if (allowSwitchToTerminal && key.ctrl && input === 't') {
    return { action: 'switch' };
  }

  if (key.ctrl && input === 'l') {
    return { action: 'redraw' };
  }

  if (allowSwitchToTerminal && input === ' ') {
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
  allowSwitchToTerminal?: boolean;
  onExit?: () => void | Promise<void>;
  onSwitchToTerminal?: () => void | Promise<void>;
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
      allowSwitchToTerminal: params.allowSwitchToTerminal === true,
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
      startAction('switching', params.onSwitchToTerminal);
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
  allowSwitchToTerminal: boolean;
  snapshot?: RemoteModeControlSnapshot;
}>): string {
  const snapshot = params.snapshot ?? { confirmationMode: null, actionInProgress: null };
  const header = `Remote session running (${params.providerName}).`;

  if (snapshot.actionInProgress === 'switching') {
    return `${header}\nSwitching to terminal mode...`;
  }
  if (snapshot.actionInProgress === 'exiting') {
    return `${header}\nExiting session...`;
  }
  if (snapshot.confirmationMode === 'switch') {
    return `${header}\nPress Space again or Ctrl-T to switch to terminal mode.`;
  }
  if (snapshot.confirmationMode === 'exit') {
    return `${header}\nPress Ctrl-C again to exit this session.`;
  }

  const lines = [
    header,
    'This session is running in remote mode. You can access it from the Happier UI.',
  ];
  if (params.allowSwitchToTerminal) {
    lines.push('Press Space twice or Ctrl-T to switch to terminal mode.');
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
    if (char === ' ') {
      events.push({ input: ' ', key: {} });
    }
  }
  return events;
}

function writeStaticBanner(
  stdout: NodeJS.WriteStream,
  providerName: string,
  allowSwitchToTerminal: boolean,
  snapshot?: RemoteModeControlSnapshot,
): void {
  stdout.write(`\r\x1b[2K${formatRemoteModeStaticBanner({ providerName, allowSwitchToTerminal, snapshot })}\n`);
}

export function startRemoteModeStaticControl(params: Readonly<{
  providerName: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  allowSwitchToTerminal?: boolean;
  onExit?: () => void | Promise<void>;
  onSwitchToTerminal?: () => void | Promise<void>;
}>): RemoteModeStaticControl {
  const allowSwitchToTerminal = params.allowSwitchToTerminal === true;
  const controller = createRemoteModeControlController({
    allowSwitchToTerminal,
    onExit: params.onExit,
    onSwitchToTerminal: params.onSwitchToTerminal,
    onStateChange: (snapshot) => {
      writeStaticBanner(params.stdout, params.providerName, allowSwitchToTerminal, snapshot);
    },
  });

  const onData = (chunk: string | Buffer | Uint8Array): void => {
    for (const event of decodeStaticControlInput(chunk)) {
      controller.handleKeypress(event.input, event.key);
    }
  };

  writeStaticBanner(params.stdout, params.providerName, allowSwitchToTerminal, controller.getSnapshot());
  params.stdin.resume();
  if (params.stdin.isTTY && typeof params.stdin.setRawMode === 'function') {
    params.stdin.setRawMode(true);
  }
  if (typeof params.stdin.setEncoding === 'function') {
    params.stdin.setEncoding('utf8');
  }
  params.stdin.on('data', onData);

  return {
    stop: async () => {
      params.stdin.off('data', onData);
      controller.dispose();
      if (params.stdin.isTTY && typeof params.stdin.setRawMode === 'function') {
        try {
          params.stdin.setRawMode(false);
        } catch {
          // Ignore best-effort terminal cleanup failures.
        }
      }
      try {
        params.stdin.pause();
      } catch {
        // Ignore best-effort terminal cleanup failures.
      }
    },
  };
}
