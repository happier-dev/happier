import { spawn, type SpawnOptions } from 'child_process';
import { mkdir } from 'node:fs/promises';

import { logger } from '@/ui/logger';
import type { TerminalHostLaunchFailure } from '@/integrations/terminalHost/_types';

import {
  buildPosixShellCommand,
  isTmuxWindowIndexConflict,
  normalizeExitCode,
  readNonNegativeIntegerEnv,
  readPositiveIntegerEnv,
  resolveTmuxCommandTimeoutMs,
} from './env';
import {
  formatTmuxSessionIdentifier,
  parseTmuxSessionIdentifier,
  TmuxSessionIdentifierError,
} from './identifiers';
import { COMMANDS_SUPPORTING_TARGET, CONTROL_SEQUENCES, WIN_OPS } from './operations';
import {
  TmuxControlState,
  type TmuxCommandResult,
  type TmuxControlSequence,
  type TmuxEnvironment,
  type TmuxSessionIdentifier,
  type TmuxSessionInfo,
  type TmuxWindowOperation,
} from './types';
import {
  buildTmuxSpawnScriptCommand,
  measureTmuxCommandArgsLength,
  removeTmuxSpawnScript,
  resolveTmuxInlineSpawnMaxChars,
  writeTmuxSpawnScript,
} from './spawnScript';
import { parseTmuxCursorPosition, type TmuxCursorPosition } from './cursorPosition';

export interface TmuxSpawnOptions extends Omit<SpawnOptions, 'env'> {
  /** Target tmux session name */
  sessionName?: string;
  /** Custom tmux socket path */
  socketPath?: string;
  /** Create new window in existing session */
  createWindow?: boolean;
  /** Window name for new windows */
  windowName?: string;
  /** Create a new owned session whose initial window runs the command; fail if the name exists. */
  requireNewSession?: boolean;
  // Note: env is intentionally excluded from this interface.
  // It's passed as a separate parameter to spawnInTmux() for clarity
  // and efficiency - only variables that differ from the tmux server
  // environment need to be passed via -e flags.
}

export type TmuxSpawnResult = Readonly<{
  sessionId?: string;
  sessionName?: string;
  windowName?: string;
  windowId?: string;
  pid?: number;
  error?: string;
}> & (Readonly<{ success: true }> | (Readonly<{ success: false }> & TerminalHostLaunchFailure));

export class TmuxUtilities {
  /** Default session name to prevent interference */
  public static readonly DEFAULT_SESSION_NAME = 'happy';

  private controlState: TmuxControlState = TmuxControlState.NORMAL;
  public readonly sessionName: string;
  private readonly tmuxCommandEnv?: Record<string, string>;
  private readonly tmuxSocketPath?: string;

  /**
   * Build the leading argv for every tmux client this class spawns.
   *
   * `-u` declares the client UTF-8 capable. Without it tmux derives that flag from
   * TMUX/LC_ALL/LC_CTYPE/LANG and, for a non-UTF-8 client, rewrites every control or
   * non-ASCII byte of printed output (`-P`, `display-message -p`, `list-*`) as `_`.
   * That silently corrupts the TAB-separated formats parsed here (pane pid + window
   * id, cursor position, session selection) whenever the daemon inherits no locale,
   * e.g. when it was started over SSH.
   */
  private static clientArgs(socketPath?: string): string[] {
    return socketPath ? ['tmux', '-u', '-S', socketPath] : ['tmux', '-u'];
  }

  /** Index of the tmux command name in an argv built from `clientArgs()`. */
  private static commandIndex(args: readonly string[]): number {
    let index = 1;
    while (index < args.length) {
      const arg = args[index];
      if (arg === '-S') {
        index += 2;
      } else if (arg?.startsWith('-')) {
        index += 1;
      } else {
        break;
      }
    }
    return index;
  }

  private static operationName(args: readonly string[]): string {
    return args[TmuxUtilities.commandIndex(args)] ?? 'unknown';
  }

  constructor(sessionName?: string, tmuxCommandEnv?: Record<string, string>, tmuxSocketPath?: string) {
    this.sessionName = sessionName || TmuxUtilities.DEFAULT_SESSION_NAME;
    this.tmuxCommandEnv = tmuxCommandEnv;
    this.tmuxSocketPath = tmuxSocketPath;
  }

  /**
   * Detect tmux environment from TMUX environment variable
   */
  detectTmuxEnvironment(): TmuxEnvironment | null {
    const tmuxEnv = process.env.TMUX;
    if (!tmuxEnv) {
      return null;
    }

    // TMUX environment format: socket_path,server_pid,pane_id
    // NOTE: session name / window are NOT encoded in TMUX. Query tmux formats for those.
    try {
      const parts = tmuxEnv.split(',');
      if (parts.length < 3) return null;

      const socketPath = parts[0]?.trim();
      const serverPidStr = parts[1]?.trim();
      // Prefer TMUX_PANE (pane id like %0). Fallback to TMUX env var third component (often pane index).
      const pane = (process.env.TMUX_PANE ?? parts[2])?.trim();

      if (!socketPath || !serverPidStr || !pane) return null;
      if (!/^\d+$/.test(serverPidStr)) return null;

      return {
        socket_path: socketPath,
        server_pid: Number.parseInt(serverPidStr, 10),
        pane,
      };
    } catch (error) {
      logger.debug('[TMUX] Failed to parse TMUX environment variable:', error);
    }

    return null;
  }

  /**
   * Execute tmux command with proper session targeting and socket handling
   */
  async executeTmuxCommand(
    cmd: string[],
    session?: string,
    window?: string,
    pane?: string,
    socketPath?: string,
    stdin?: string,
    options?: Readonly<{ timeoutMs?: number }>,
  ): Promise<TmuxCommandResult | null> {
    const targetSession = session || this.sessionName;

    const baseCmd = TmuxUtilities.clientArgs(socketPath ?? this.tmuxSocketPath);

    // Add the default target for commands that support it, immediately after the command name.
    // tmux does not permute arguments: a `-t` placed after a positional operand (`send-keys` text,
    // the `display-message` format) is rejected as an extra argument instead of being parsed.
    const commandName = cmd[0];
    const hasExplicitTarget = cmd.slice(1).includes('-t');
    const fullCmd = [...baseCmd, ...cmd];
    if (commandName !== undefined && !hasExplicitTarget && COMMANDS_SUPPORTING_TARGET.has(commandName)) {
      let target = targetSession;
      if (window) target += `:${window}`;
      if (pane) target += `.${pane}`;
      fullCmd.splice(baseCmd.length + 1, 0, '-t', target);
    }

    const detachedCreation = (commandName === 'new-session' || commandName === 'new-window') && cmd.includes('-d');
    const printCreation = cmd.includes('-P');
    if (detachedCreation) {
      // Detached new-window does not change the native queue's current window.
      // Capture the immutable created ID instead of resizing the previous window.
      const formatIndex = fullCmd.indexOf('-F', baseCmd.length);
      const format = formatIndex >= 0 ? fullCmd[formatIndex + 1] : commandName === 'new-session'
        ? '#{session_name}:' : '#{session_name}:#{window_index}.#{pane_index}';
      if (formatIndex >= 0) fullCmd.splice(formatIndex, 2);
      fullCmd.splice(baseCmd.length + 1, 0, '-P', '-F', `#{window_id}\t${format ?? ''}`);
    }

    const result = await this.executeCommand(fullCmd, {
      ...(stdin !== undefined ? { stdin } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (detachedCreation && result) {
      const createdWindow = /^(@\d+)\t/.exec(result.stdout);
      if (createdWindow) {
        result.stdout = printCreation ? result.stdout.slice(createdWindow[0].length) : '';
        // tmux 3.4's initial latest sizing includes unrelated sessions' clients.
        // Native -a scopes sizing to this window, falling back to default-size.
        // Restore inheritance immediately so later attached clients still resize it.
        const windowId = createdWindow[1];
        const localPolicy = await this.executeCommand([...baseCmd, 'show-options', '-w', '-t', windowId, 'window-size'], options);
        if (!localPolicy || localPolicy.returncode !== 0) {
          logger.warn('[TMUX] Failed to read detached window sizing policy', { windowId, stderr: localPolicy?.stderr });
          return result;
        }
        const restorePolicy = localPolicy.stdout.trim() === 'window-size latest'
          ? `set-option -w -t ${windowId} window-size latest`
          : `set-option -wu -t ${windowId} window-size`;
        const sizing = await this.executeCommand([...baseCmd, 'if-shell', '-F', '-t', windowId,
          '#{&&:#{==:#{window-size},latest},#{==:#{session_attached},0}}',
          `resize-window -a -t ${windowId} ; ${restorePolicy}`,
        ], options);
        if (!sizing || sizing.returncode !== 0) {
          // Creation succeeded; do not convert this into a retryable launch error.
          logger.warn('[TMUX] Failed to reconcile detached window geometry', { windowId: createdWindow[1], stderr: sizing?.stderr });
        }
      } else if (result.returncode === 0) {
        logger.warn('[TMUX] Created window ID missing; detached geometry was not reconciled');
      }
    }
    return result;
  }

  /**
   * Execute command with subprocess and return result
   */
  private async executeCommand(cmd: string[], options?: Readonly<{ stdin?: string; timeoutMs?: number }>): Promise<TmuxCommandResult | null> {
    try {
      const result = await this.runCommand(cmd, {
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      return {
        returncode: result.exitCode,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        command: cmd,
        ...(result.timedOut ? { timedOut: true } : {}),
      };
    } catch (error) {
      logger.debug('[TMUX] Command execution failed:', error);
      return null;
    }
  }

  /**
   * Run command using Node.js child_process.spawn
   */
  private runCommand(
    args: string[],
    options: SpawnOptions & { stdin?: string; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }> {
    return new Promise((resolve, reject) => {
      const { stdin, timeoutMs, ...spawnOptions } = options;
      const mergedEnv = {
        ...process.env,
        ...(this.tmuxCommandEnv ?? {}),
        ...(spawnOptions.env ?? {}),
      };
      // If we are intentionally targeting a specific tmux server (via TMUX_TMPDIR or -S socket),
      // do not inherit an ambient tmux client context from the parent process.
      // Keeping TMUX/TMUX_PANE can cause tmux to connect to the wrong server, ignoring TMUX_TMPDIR.
      if (typeof mergedEnv.TMUX_TMPDIR === 'string' && mergedEnv.TMUX_TMPDIR.trim().length > 0) {
        delete (mergedEnv as Record<string, unknown>).TMUX;
        delete (mergedEnv as Record<string, unknown>).TMUX_PANE;
      } else if (typeof this.tmuxSocketPath === 'string' && this.tmuxSocketPath.trim().length > 0) {
        delete (mergedEnv as Record<string, unknown>).TMUX;
        delete (mergedEnv as Record<string, unknown>).TMUX_PANE;
      }

      const commandTimeoutMs = timeoutMs ?? resolveTmuxCommandTimeoutMs();
      logger.debug('[TMUX] Command starting', {
        operation: TmuxUtilities.operationName(args),
        timeoutMs: commandTimeoutMs,
        hasSocketPath: args.slice(0, TmuxUtilities.commandIndex(args)).includes('-S'),
      });
      const child = spawn(args[0], args.slice(1), {
        stdio: stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        shell: false,
        ...spawnOptions,
        env: mergedEnv,
      });

      if (stdin !== undefined) {
        child.stdin?.end(stdin);
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        resolve({
          exitCode: normalizeExitCode(code),
          stdout,
          stderr,
          ...(timedOut ? { timedOut: true } : {}),
        });
      };
      if (commandTimeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          // Do not wait for `close` after killing the child. Some tmux/client
          // processes can remain stuck in the OS even after kill(), which
          // would otherwise block readiness and recovery indefinitely.
          let killRequested = false;
          try {
            killRequested = child.kill();
          } catch {
            killRequested = false;
          } finally {
            const operationIndex = args[1] === '-S' ? 3 : 1;
            logger.warn('[TMUX] Command timed out', {
              operation: args[operationIndex] ?? 'unknown',
              timeoutMs: commandTimeoutMs,
              pid: child.pid ?? null,
              killRequested,
            });
            settle(null);
          }
        }, commandTimeoutMs);
      }

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        logger.debug('[TMUX] Command closed', {
          operation: TmuxUtilities.operationName(args),
          returncode: normalizeExitCode(code),
          timedOut,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });
        settle(code);
      });

      child.on('error', (error) => {
        if (settled) return;
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        settled = true;
        reject(error);
      });
    });
  }

  /**
   * Parse control sequences in text (^ for escape, ^^ for literal ^)
   */
  parseControlSequences(text: string): [string, TmuxControlState] {
    const result: string[] = [];
    let i = 0;
    let localState = this.controlState;

    while (i < text.length) {
      const char = text[i];

      if (localState === TmuxControlState.NORMAL) {
        if (char === '^') {
          if (i + 1 < text.length && text[i + 1] === '^') {
            // Literal ^
            result.push('^');
            i += 2;
          } else {
            // Escape to normal tmux
            localState = TmuxControlState.ESCAPE;
            i += 1;
          }
        } else {
          result.push(char);
          i += 1;
        }
      } else if (localState === TmuxControlState.ESCAPE) {
        // In escape mode - pass through to tmux directly
        result.push(char);
        i += 1;
        localState = TmuxControlState.NORMAL;
      } else {
        result.push(char);
        i += 1;
      }
    }

    this.controlState = localState;
    return [result.join(''), localState];
  }

  /**
   * Execute window operation using WIN_OPS dispatch with type safety
   */
  async executeWinOp(
    operation: TmuxWindowOperation,
    args: string[] = [],
    session?: string,
    window?: string,
    pane?: string,
  ): Promise<boolean> {
    const tmuxCmd = WIN_OPS[operation];
    if (!tmuxCmd) {
      logger.debug(`[TMUX] Unknown operation: ${operation}`);
      return false;
    }

    const cmdParts = tmuxCmd.split(' ');
    cmdParts.push(...args);

    const result = await this.executeTmuxCommand(cmdParts, session, window, pane);
    return result !== null && result.returncode === 0;
  }

  /**
   * Ensure session exists, create if needed
   */
  async ensureSessionExists(sessionName?: string): Promise<boolean> {
    const targetSession = sessionName || this.sessionName;

    // Check if session exists
    const result = await this.executeTmuxCommand(['has-session', '-t', targetSession]);
    if (result && result.returncode === 0) {
      return true;
    }

    // Create session if it doesn't exist
    const createResult = await this.executeTmuxCommand(['new-session', '-d', '-s', targetSession]);
    return createResult !== null && createResult.returncode === 0;
  }

  /**
   * Capture the FULL visible pane as raw screen text with SGR styling preserved (`-e`).
   *
   * R-E1: the in-flight steer evaluator and the readiness bridge parse this through the multi-line
   * `parseClaudeScreenState` owner (dialogs / spinner / permission prompt / user draft all sit ABOVE
   * the bottom composer line). Returning only the last line blinded every multi-line veto on tmux.
   * QA-B F6: the parser normalizes internally, but it needs the RAW styling to distinguish a DIM
   * empty-composer suggestion placeholder from a real typed draft, so this no longer pre-strips.
   */
  async captureCurrentInput(session?: string, window?: string, pane?: string): Promise<string> {
    const result = await this.executeTmuxCommand(['capture-pane', '-p', '-e'], session, window, pane);
    if (result && result.returncode === 0) {
      return result.stdout;
    }
    throw new Error('Failed to capture the current tmux pane');
  }

  async captureCursorPosition(session?: string, window?: string, pane?: string): Promise<TmuxCursorPosition | null> {
    const result = await this.executeTmuxCommand(
      ['display-message', '-p', '#{cursor_x}\t#{cursor_y}'],
      session,
      window,
      pane,
    );
    if (result && result.returncode === 0) {
      return parseTmuxCursorPosition(result.stdout);
    }
    return null;
  }

  /**
   * Send keys to tmux pane with proper control sequence handling and type safety
   */
  async sendKeys(keys: string | TmuxControlSequence, session?: string, window?: string, pane?: string): Promise<boolean> {
    // Validate input
    if (!keys || typeof keys !== 'string') {
      logger.debug('[TMUX] Invalid keys provided to sendKeys');
      return false;
    }

    // Handle control sequences that must be separate arguments
    if (CONTROL_SEQUENCES.has(keys as TmuxControlSequence)) {
      const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
      return result !== null && result.returncode === 0;
    }

    // Regular text
    const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
    return result !== null && result.returncode === 0;
  }

  /**
   * Send multiple keys to tmux pane with proper control sequence handling
   */
  async sendMultipleKeys(
    keys: Array<string | TmuxControlSequence>,
    session?: string,
    window?: string,
    pane?: string,
  ): Promise<boolean> {
    if (!Array.isArray(keys) || keys.length === 0) {
      logger.debug('[TMUX] Invalid keys array provided to sendMultipleKeys');
      return false;
    }

    for (const key of keys) {
      const success = await this.sendKeys(key, session, window, pane);
      if (!success) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get comprehensive session information
   */
  async getSessionInfo(sessionName?: string): Promise<TmuxSessionInfo> {
    const targetSession = sessionName || this.sessionName;
    const envInfo = this.detectTmuxEnvironment();

    const info: TmuxSessionInfo = {
      target_session: targetSession,
      session: targetSession,
      window: 'unknown',
      pane: 'unknown',
      socket_path: undefined,
      tmux_active: envInfo !== null,
      current_session: undefined,
      available_sessions: [],
    };

    if (envInfo) {
      info.socket_path = envInfo.socket_path;
      info.env_pane = envInfo.pane;
    }

    // Get available sessions
    const result = await this.executeTmuxCommand(['list-sessions']);
    if (result && result.returncode === 0) {
      info.available_sessions = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => line.split(':')[0]);
    }

    return info;
  }

  /**
   * Spawn process in tmux session with environment variables.
   *
   * IMPORTANT: Unlike Node.js spawn(), env is a separate parameter.
   * This is intentional because tmux sets window-scoped environment via `new-window -e KEY=VALUE`.
   * Callers may provide a fully merged environment (daemon env + profile overrides) so tmux and
   * non-tmux spawns behave consistently.
   *
   * @param args - Command and arguments to execute (as array, will be joined)
   * @param options - Spawn options (tmux-specific, excludes env)
   * @param env - Environment variables to set in window
   * @returns Result with success status and session identifier
   */
  async spawnInTmux(
    args: string[],
    options: TmuxSpawnOptions = {},
    env?: Record<string, string>,
  ): Promise<TmuxSpawnResult> {
    let spawnScriptPath: string | null = null;
    let launchDisposition: TerminalHostLaunchFailure['launchDisposition'] = 'not_started';
    try {
      const socketRoot = this.tmuxCommandEnv?.TMUX_TMPDIR;
      if (socketRoot) await mkdir(socketRoot, { recursive: true });

      // Check if tmux is available
      const tmuxCheck = await this.executeTmuxCommand(['list-sessions']);
      if (!tmuxCheck) {
        throw new Error('tmux not available');
      }

      // Handle session name resolution
      // - undefined: Use this instance's default session ("happy")
      // - empty string: Use current/most-recent session deterministically
      // - specific name: Use that session (create if doesn't exist)
      let sessionName = options.sessionName ?? this.sessionName;

      if (options.sessionName === '') {
        const listResult = await this.executeTmuxCommand([
          'list-sessions',
          '-F',
          '#{session_name}\t#{session_attached}\t#{session_last_attached}',
        ]);

        const candidates = (listResult?.stdout ?? '')
          .trim()
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            const [name, attachedRaw, lastAttachedRaw] = line.split('\t');
            const attached = Number.parseInt(attachedRaw ?? '0', 10);
            const lastAttached = Number.parseInt(lastAttachedRaw ?? '0', 10);
            return {
              name: (name ?? '').trim(),
              attached: Number.isFinite(attached) ? attached : 0,
              lastAttached: Number.isFinite(lastAttached) ? lastAttached : 0,
            };
          })
          .filter((row) => row.name.length > 0);

        candidates.sort((a, b) => {
          // Prefer attached sessions first, then most recently attached.
          if (a.attached !== b.attached) return b.attached - a.attached;
          return b.lastAttached - a.lastAttached;
        });

        sessionName = candidates[0]?.name ?? TmuxUtilities.DEFAULT_SESSION_NAME;
      }

      const windowName = options.windowName || `happy-${Date.now()}`;

      const requireNewSession = options.requireNewSession === true;
      if (!requireNewSession) {
        await this.ensureSessionExists(sessionName);
      }

      // Build command to execute in the new window
      const fullCommand = buildPosixShellCommand(args);

      // Create new window in session with command and environment variables
      // IMPORTANT: Don't manually add -t here - executeTmuxCommand handles it via parameters
      const baseCreateWindowArgs = requireNewSession
        ? ['new-session', '-d', '-P', '-F', '#{pane_pid}\t#{window_id}', '-s', sessionName, '-n', windowName]
        : ['new-window', '-d', '-P', '-F', '#{pane_pid}\t#{window_id}', '-n', windowName];

      // Add working directory if specified
      if (options.cwd) {
        const cwdPath = typeof options.cwd === 'string' ? options.cwd : options.cwd.pathname;
        baseCreateWindowArgs.push('-c', cwdPath);
      }

      if (!requireNewSession) {
        // Add target session explicitly so option ordering is correct.
        baseCreateWindowArgs.push('-t', sessionName);
      }

      // Add environment variables using -e flag (sets them in the window's environment)
      // Note: tmux windows inherit environment from tmux server, but we need to ensure
      // the daemon's environment variables (especially expanded auth variables) are available
      const envForWindow: Record<string, string> = {};
      const windowEnvArgs: string[] = [];
      if (env && Object.keys(env).length > 0) {
        for (const [key, value] of Object.entries(env)) {
          // Skip undefined/null values with warning
          if (value === undefined || value === null) {
            logger.warn(`[TMUX] Skipping undefined/null environment variable: ${key}`);
            continue;
          }

          // Validate variable name (tmux accepts standard env var names)
          if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
            logger.warn(`[TMUX] Skipping invalid environment variable name: ${key}`);
            continue;
          }

          // `new-window -e` takes KEY=VALUE literally (no shell parsing).
          // Do NOT quote or escape values intended for shell parsing.
          envForWindow[key] = value;
          windowEnvArgs.push('-e', `${key}=${value}`);
        }
        logger.debug(`[TMUX] Setting ${Object.keys(envForWindow).length} environment variables in tmux window`);
      }

      // Add the command to run in the window (runs immediately when window is created)
      const inlineCreateWindowArgs = [...baseCreateWindowArgs, ...windowEnvArgs, fullCommand];
      const inlineArgsLength = measureTmuxCommandArgsLength(inlineCreateWindowArgs);
      const inlineArgsLimit = resolveTmuxInlineSpawnMaxChars();
      let createWindowArgs = inlineCreateWindowArgs;
      if (inlineArgsLength > inlineArgsLimit) {
        logger.debug(`[TMUX] Externalizing oversized spawn command (${inlineArgsLength} bytes > ${inlineArgsLimit} bytes)`);
        spawnScriptPath = await writeTmuxSpawnScript(fullCommand, envForWindow);
        createWindowArgs = [...baseCreateWindowArgs, buildTmuxSpawnScriptCommand(spawnScriptPath)];
      }

      // Create window with command and get PID immediately.
      //
      // Note: tmux can fail with `create window failed: index N in use` when multiple
      // clients concurrently create windows in the same session (tmux does not always
      // auto-retry the window index allocation). Retry a few times to make concurrent
      // session starts robust. An exclusive new-session attempt is atomic and never retries
      // into an existing session: a duplicate name belongs to another live/recoverable owner.
      const maxAttempts = requireNewSession
        ? 1
        : readPositiveIntegerEnv('HAPPIER_CLI_TMUX_CREATE_WINDOW_MAX_ATTEMPTS', 3);
      const retryDelayMs = readNonNegativeIntegerEnv('HAPPIER_CLI_TMUX_CREATE_WINDOW_RETRY_DELAY_MS', 25);

      const withExplicitTargetWindowIndex = (args: string[], target: string): string[] => {
        const copy = [...args];
        const tIndex = copy.indexOf('-t');
        if (tIndex >= 0 && copy[tIndex + 1]) {
          copy[tIndex + 1] = target;
          return copy;
        }
        copy.push('-t', target);
        return copy;
      };

      const resolveNextWindowIndex = async (targetSessionName: string): Promise<number | null> => {
        const listResult = await this.executeTmuxCommand(['list-windows', '-t', targetSessionName, '-F', '#{window_index}']);
        if (!listResult || listResult.returncode !== 0) return null;

        const indices = listResult.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => Number.parseInt(line, 10))
          .filter((n) => Number.isFinite(n) && n >= 0);
        const maxIndex = indices.length > 0 ? Math.max(...indices) : 0;
        return maxIndex + 1;
      };

      const parseWindowIndexConflict = (stderr: string | undefined): number | null => {
        const match = /index\s+(\d+)\s+in\s+use/i.exec(stderr ?? '');
        if (!match) return null;
        const n = Number.parseInt(match[1] ?? '', 10);
        return Number.isFinite(n) && n >= 0 ? n : null;
      };

      let createResult: TmuxCommandResult | null = null;
      let createWindowArgsForAttempt = createWindowArgs;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // A lost or malformed reply cannot undo a command the server accepted.
        launchDisposition = 'unconfirmed';
        createResult = await this.executeTmuxCommand(createWindowArgsForAttempt);
        if (createResult && createResult.returncode === 0 && createResult.timedOut !== true) break;

        const stderr = createResult?.stderr;
        const explicitWindowConflict = !requireNewSession && createResult?.timedOut !== true && isTmuxWindowIndexConflict(stderr);
        const explicitSessionConflict = requireNewSession && createResult?.timedOut !== true
          && /(?:duplicate session|session .+ already exists)/i.test(stderr ?? '');
        if (explicitWindowConflict || explicitSessionConflict) launchDisposition = 'not_started';
        const shouldRetry = attempt < maxAttempts && explicitWindowConflict;
        if (!shouldRetry) break;

        // In high-concurrency starts, tmux may keep retrying the same conflicting index.
        // Allocate an explicit next index as a deterministic fallback.
        const conflictingIndex = parseWindowIndexConflict(stderr);
        const nextIndexFromList = await resolveNextWindowIndex(sessionName);
        const conflictPlusOne = conflictingIndex !== null ? conflictingIndex + 1 : null;
        const nextIndex =
          nextIndexFromList !== null && conflictPlusOne !== null
            ? Math.max(nextIndexFromList, conflictPlusOne)
            : (nextIndexFromList ?? conflictPlusOne);
        if (nextIndex !== null) {
          createWindowArgsForAttempt = withExplicitTargetWindowIndex(createWindowArgs, `${sessionName}:${nextIndex}`);
        }

        logger.debug(`[TMUX] new-window failed with window index conflict; retrying (attempt ${attempt}/${maxAttempts})`);
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }

      if (!createResult || createResult.returncode !== 0 || createResult.timedOut === true) {
        const tIndex = createWindowArgsForAttempt.indexOf('-t');
        const target = tIndex >= 0 ? createWindowArgsForAttempt[tIndex + 1] : sessionName;
        const resourceKind = requireNewSession ? 'session' : 'window';
        throw new Error(`Failed to create tmux ${resourceKind} (target=${target}): ${createResult?.stderr}`);
      }

      // Capture both the runner PID and tmux's immutable window identity. Window names
      // can be changed automatically by tmux, so they are display metadata, not ownership.
      const [panePidText = '', windowId = ''] = createResult.stdout.trim().split('\t');
      if (!/^\d+$/.test(panePidText)) {
        const output = createResult.stdout.trim();
        const preview = output.length > 200 ? `${output.slice(0, 200)}…` : output;
        throw new Error(`Failed to extract PID from tmux output: ${preview}`);
      }

      const panePid = Number.parseInt(panePidText, 10);
      if (!Number.isFinite(panePid) || panePid <= 0) {
        throw new Error(`Failed to extract PID from tmux output: ${panePidText}`);
      }
      if (!/^@\d+$/.test(windowId)) {
        throw new Error(`Failed to extract immutable window id from tmux output: ${windowId || '<empty>'}`);
      }

      logger.debug(`[TMUX] Spawned command in tmux session ${sessionName}, window ${windowName}, PID ${panePid}`);

      // Return tmux session info and PID
      const sessionIdentifier: TmuxSessionIdentifier = {
        session: sessionName,
        window: windowName,
      };

      return {
        success: true,
        sessionId: formatTmuxSessionIdentifier(sessionIdentifier),
        sessionName,
        windowName,
        windowId,
        pid: panePid,
      };
    } catch (error) {
      let cleanupIncomplete = false;
      // The pane may still need its launch handoff after the client reply is lost.
      // Without an immutable identity, do not guess which window to stop.
      if (spawnScriptPath && launchDisposition !== 'unconfirmed') {
        try {
          await removeTmuxSpawnScript(spawnScriptPath);
        } catch (cleanupError) {
          cleanupIncomplete = true;
          logger.debug('[TMUX] Launch handoff cleanup failed:', cleanupError);
        }
      }
      logger.debug('[TMUX] Failed to spawn in tmux:', error);
      logger.infoFile('[WARN] [TMUX] Runner creation failed', { launchDisposition, cleanupIncomplete });
      return {
        success: false,
        launchDisposition,
        cleanupIncomplete,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get session info for a given session identifier string
   */
  async getSessionInfoFromString(sessionIdentifier: string): Promise<TmuxSessionInfo | null> {
    try {
      const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
      const info = await this.getSessionInfo(parsed.session);
      return info;
    } catch (error) {
      if (error instanceof TmuxSessionIdentifierError) {
        logger.debug(`[TMUX] Invalid session identifier: ${error.message}`);
      } else {
        logger.debug('[TMUX] Error getting session info:', error);
      }
      return null;
    }
  }

  /**
   * Kill a tmux window safely with proper error handling
   */
  async killWindow(sessionIdentifier: string): Promise<boolean> {
    try {
      const immutableWindowId = sessionIdentifier.trim();
      if (/^@\d+$/.test(immutableWindowId)) {
        const result = await this.executeTmuxCommand(['kill-window', '-t', immutableWindowId]);
        return result !== null && result.returncode === 0;
      }
      const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
      if (!parsed.window) {
        throw new TmuxSessionIdentifierError(`Window identifier required: ${sessionIdentifier}`);
      }

      const result = await this.executeTmuxCommand([
        'kill-window', '-t', formatTmuxSessionIdentifier(parsed, { exactSession: true }),
      ]);
      return result !== null && result.returncode === 0;
    } catch (error) {
      if (error instanceof TmuxSessionIdentifierError) {
        logger.debug(`[TMUX] Invalid window identifier: ${error.message}`);
      } else {
        logger.debug('[TMUX] Error killing window:', error);
      }
      return false;
    }
  }

  /**
   * List windows in a session
   */
  async listWindows(sessionName?: string): Promise<string[]> {
    const targetSession = sessionName || this.sessionName;
    const result = await this.executeTmuxCommand(['list-windows', '-t', targetSession, '-F', '#W']);

    if (!result || result.returncode !== 0) {
      return [];
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
}
