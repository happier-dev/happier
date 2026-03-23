import type { TerminalMode } from './terminalConfig';

export type TerminalRuntimeFlags = {
  mode?: TerminalMode;
  requested?: TerminalMode | 'console';
  fallbackReason?: string;
  tmuxTarget?: string;
  tmuxTmpDir?: string;
  windowId?: string;
};

function parseTerminalMode(value: string | undefined): TerminalMode | undefined {
  if (value === 'plain' || value === 'tmux' || value === 'windows_terminal' || value === 'windows_console') return value;
  return undefined;
}

function parseTerminalRequestedMode(value: string | undefined): TerminalMode | 'console' | undefined {
  if (value === 'console') return value;
  return parseTerminalMode(value);
}

function consumeFlagValue(argv: string[], index: number): { value: string | undefined; nextIndex: number } {
  const next = argv[index + 1];
  if (typeof next === 'string' && !next.startsWith('-')) {
    return { value: next, nextIndex: index + 1 };
  }
  return { value: undefined, nextIndex: index };
}

export function parseAndStripTerminalRuntimeFlags(argv: string[]): {
  terminal: TerminalRuntimeFlags | null;
  argv: string[];
} {
  const terminal: TerminalRuntimeFlags = {};
  const remaining: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--happy-terminal-mode') {
      const consumed = consumeFlagValue(argv, i);
      i = consumed.nextIndex;
      terminal.mode = parseTerminalMode(consumed.value);
      continue;
    }
    if (arg === '--happy-terminal-requested') {
      const consumed = consumeFlagValue(argv, i);
      i = consumed.nextIndex;
      terminal.requested = parseTerminalRequestedMode(consumed.value);
      continue;
    }
    if (arg === '--happy-terminal-fallback-reason') {
      const consumed = consumeFlagValue(argv, i);
      i = consumed.nextIndex;
      const value = consumed.value;
      if (typeof value === 'string' && value.trim().length > 0) {
        terminal.fallbackReason = value;
      }
      continue;
    }
    if (arg === '--happy-tmux-target') {
      const consumed = consumeFlagValue(argv, i);
      i = consumed.nextIndex;
      const value = consumed.value;
      if (typeof value === 'string' && value.trim().length > 0) {
        terminal.tmuxTarget = value;
      }
      continue;
    }
    if (arg === '--happy-tmux-tmpdir') {
      const consumed = consumeFlagValue(argv, i);
      i = consumed.nextIndex;
      const value = consumed.value;
      if (typeof value === 'string' && value.trim().length > 0) {
        terminal.tmuxTmpDir = value;
      }
      continue;
    }
    if (arg === '--happy-terminal-window-id') {
      const consumed = consumeFlagValue(argv, i);
      i = consumed.nextIndex;
      const value = consumed.value;
      if (typeof value === 'string' && value.trim().length > 0) {
        terminal.windowId = value;
      }
      continue;
    }

    remaining.push(arg);
  }

  const hasAny =
    terminal.mode !== undefined ||
    terminal.requested !== undefined ||
    terminal.fallbackReason !== undefined ||
    terminal.tmuxTarget !== undefined ||
    terminal.tmuxTmpDir !== undefined ||
    terminal.windowId !== undefined;

  return { terminal: hasAny ? terminal : null, argv: remaining };
}
