import type { Metadata } from '@/api/types';
import { parseTmuxSessionIdentifier } from '@/integrations/tmux';
import { join } from 'node:path';

export type TerminalAttachPlan =
  | { type: 'not-attachable'; reason: string }
  | {
      type: 'tmux';
      sessionName: string;
      target: string;
      selectWindowArgs: string[];
      attachSessionArgs: string[];
      tmuxCommandEnv: Record<string, string>;
      /**
       * True when we should clear TMUX/TMUX_PANE from the environment for tmux
       * commands (e.g. isolated tmux server selected via TMUX_TMPDIR).
       */
      shouldUnsetTmuxEnv: boolean;
      /**
       * True when we should run `tmux attach-session ...` after selecting the window.
       * When already inside a shared tmux server, selecting the window is sufficient.
       */
      shouldAttach: boolean;
    };

export function createTerminalAttachPlan(params: {
  terminal: NonNullable<Metadata['terminal']>;
  insideTmux: boolean;
  /**
   * When inside tmux, pass the current tmux socket path (from $TMUX env var).
   * If it matches the session's isolated tmux server, we can avoid forcing an attach-session.
   */
  currentTmuxSocketPath?: string | null;
  /**
   * Optional explicit uid for deterministic tests/callers. When omitted, this is resolved
   * from process.getuid() when available.
   */
  currentUid?: number | null;
}): TerminalAttachPlan {
  if (params.terminal.mode === 'plain') {
    return {
      type: 'not-attachable',
      reason: 'Session was not started in tmux.',
    };
  }

  const target = params.terminal.tmux?.target;
  if (typeof target !== 'string' || target.trim().length === 0) {
    return {
      type: 'not-attachable',
      reason: 'Session does not include a tmux target.',
    };
  }

  let parsed: ReturnType<typeof parseTmuxSessionIdentifier>;
  try {
    parsed = parseTmuxSessionIdentifier(target);
  } catch {
    return {
      type: 'not-attachable',
      reason: 'Session includes an invalid tmux target.',
    };
  }

  const tmpDir = params.terminal.tmux?.tmpDir;
  const tmuxCommandEnv: Record<string, string> =
    typeof tmpDir === 'string' && tmpDir.trim().length > 0 ? { TMUX_TMPDIR: tmpDir } : {};

  const hasTmpDir = Object.prototype.hasOwnProperty.call(tmuxCommandEnv, 'TMUX_TMPDIR');

  let shouldUnsetTmuxEnv = hasTmpDir;
  let shouldAttach = !params.insideTmux || shouldUnsetTmuxEnv;

  // If the session was started in an isolated tmux server (TMUX_TMPDIR),
  // we historically forced `tmux attach-session` even when already inside tmux.
  //
  // However, when the current process is already inside that *same* isolated server
  // (TMUX socket path matches), selecting the window is sufficient and avoids
  // unnecessary/interactive attach behavior.
  if (params.insideTmux && hasTmpDir && typeof params.currentTmuxSocketPath === 'string' && params.currentTmuxSocketPath.trim().length > 0) {
    const processUid = typeof process.getuid === 'function' ? process.getuid() : null;
    const uid = typeof params.currentUid === 'number' ? params.currentUid : processUid;
    if (typeof uid === 'number') {
      const expectedSocketPath = join(tmpDir as string, `tmux-${uid}`, 'default');
      if (params.currentTmuxSocketPath === expectedSocketPath) {
        shouldUnsetTmuxEnv = false;
        shouldAttach = false;
        // No need to force TMUX_TMPDIR for tmux commands; they can use the current tmux server via $TMUX.
        for (const k of Object.keys(tmuxCommandEnv)) delete tmuxCommandEnv[k];
      }
    }
  }

  return {
    type: 'tmux',
    sessionName: parsed.session,
    target,
    shouldAttach,
    shouldUnsetTmuxEnv,
    tmuxCommandEnv,
    selectWindowArgs: ['select-window', '-t', target],
    attachSessionArgs: ['attach-session', '-t', parsed.session],
  };
}
