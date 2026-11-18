import { posix as pathPosix } from 'node:path';
import type { SessionAuthoringTerminalV1 } from '@happier-dev/protocol/sessions/authoring/creationFieldsV1';
import type { TerminalHostKind } from '@happier-dev/agents';

export const TERMINAL_MODES = ['plain', 'tmux', 'zellij', 'herdr', 'windows_terminal', 'windows_console', 'pty'] as const;

export type TerminalMode = typeof TERMINAL_MODES[number];

/** A realized mode some terminal host serves; `plain` is the only mode no host realizes. */
export type HostedTerminalMode = Exclude<TerminalMode, 'plain'>;

/**
 * The `pty` host serves Windows Terminal, the hidden Windows console and the plain holder PTY; every
 * other host realizes only its own kind. Readers of a recorded mode derive from this one owner (a
 * hand-copied list missing `pty` caused ba4361af702).
 */
const PTY_HOSTED_TERMINAL_MODES = ['windows_terminal', 'windows_console', 'pty'] as const satisfies readonly HostedTerminalMode[];

export function isTerminalMode(value: unknown): value is TerminalMode {
  return (TERMINAL_MODES as readonly unknown[]).includes(value);
}

export function isHostedTerminalMode(value: unknown): value is HostedTerminalMode {
  return value !== 'plain' && isTerminalMode(value);
}

export function terminalModesRealizedByHostKind(kind: TerminalHostKind): readonly HostedTerminalMode[] {
  return kind === 'pty' ? PTY_HOSTED_TERMINAL_MODES : [kind];
}

export type TerminalTmuxSpawnOptions = {
  /**
   * tmux session to create/select.
   *
   * Note: empty string is allowed for legacy behavior ("current/most recent session"),
   * but should only be used for terminal-initiated flows where "current" is well-defined.
   */
  sessionName?: string;
  /**
   * When true, prefer an isolated tmux server socket (via TMUX_TMPDIR) to avoid
   * interfering with the user's global tmux server.
   */
  isolated?: boolean;
  /**
   * Optional override for TMUX_TMPDIR. When null/undefined and isolated=true, we derive
   * a deterministic directory under happyHomeDir.
   */
  tmpDir?: string | null;
};

export type TerminalSpawnOptions = {
  mode?: TerminalMode;
  tmux?: TerminalTmuxSpawnOptions;
  herdr?: { sessionName?: string };
};

/** Integrated authoring uses the app's terminal, so no native host may be inherited. */
export function projectSessionAuthoringTerminalForSpawn(
  terminal: SessionAuthoringTerminalV1 | null | undefined,
): TerminalSpawnOptions | undefined {
  if (!terminal) return undefined;
  const { mode, windows: _windows, ...options } = terminal;
  return { ...options, ...(mode ? { mode: mode === 'integrated' ? 'plain' : mode } : {}) };
}

export type ResolvedTerminalRequest =
  | { requested: 'plain' }
  | { requested: 'zellij' }
  | { requested: 'herdr'; herdr: { sessionName: string; socketPath?: string } }
  | {
    requested: 'tmux';
    tmux: {
      sessionName: string;
      isolated: boolean;
      tmpDir: string | null;
      source: 'typed' | 'legacy';
    };
  }
  | { requested: null };

function normalizeOptionalPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveTerminalRequestFromSpawnOptions(params: {
  happyHomeDir: string;
  terminal?: TerminalSpawnOptions;
  environmentVariables?: Record<string, string>;
}): ResolvedTerminalRequest {
  const terminal = params.terminal;
  if (terminal?.mode === 'plain') {
    return { requested: 'plain' };
  }

  if (terminal?.mode === 'zellij') {
    return { requested: 'zellij' };
  }

  if (terminal?.mode === 'herdr') {
    return { requested: 'herdr', herdr: { sessionName: terminal.herdr?.sessionName?.trim() || 'default' } };
  }

  if (terminal?.mode === 'tmux') {
    const sessionName = terminal.tmux?.sessionName ?? 'happy';
    const isolated = terminal.tmux?.isolated ?? true;
    const tmpDirOverride = normalizeOptionalPath(terminal.tmux?.tmpDir ?? null);
    const tmpDir = isolated
      ? (tmpDirOverride ?? pathPosix.join(params.happyHomeDir, 'tmux'))
      : tmpDirOverride;

    return {
      requested: 'tmux',
      tmux: {
        sessionName,
        isolated,
        tmpDir,
        source: 'typed',
      },
    };
  }

  const env = params.environmentVariables ?? {};
  if (Object.prototype.hasOwnProperty.call(env, 'TMUX_SESSION_NAME')) {
    const sessionName = env.TMUX_SESSION_NAME;
    const tmpDir = normalizeOptionalPath(env.TMUX_TMPDIR ?? null);
    return {
      requested: 'tmux',
      tmux: {
        sessionName,
        isolated: false,
        tmpDir,
        source: 'legacy',
      },
    };
  }

  return { requested: null };
}
