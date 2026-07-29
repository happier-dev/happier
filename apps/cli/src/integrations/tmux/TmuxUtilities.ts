import { spawn, type SpawnOptions } from 'child_process';
import { randomUUID } from 'node:crypto';

import {
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
import { parseTmuxCursorPosition } from './cursorPosition';
import { COMMANDS_SUPPORTING_TARGET, CONTROL_SEQUENCES, WIN_OPS } from './operations';
import { prepareTmuxWindowLaunch, type PreparedTmuxWindowLaunch } from './windowLaunchScript';
import {
  TmuxControlState,
  type TmuxCommandResult,
  type TmuxControlSequence,
  type TmuxEnvironment,
  type TmuxSessionIdentifier,
  type TmuxSessionInfo,
  type TmuxWindowOperation,
} from './types';
import { normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';

function logTmuxDebug(message: string, ...args: unknown[]): void {
  void import('@/ui/logger')
    .then(({ logger }) => {
      logger.debug(message, ...args);
    })
    .catch(() => undefined);
}

function logTmuxWarn(message: string, ...args: unknown[]): void {
  void import('@/ui/logger')
    .then(({ logger }) => {
      logger.warn(message, ...args);
    })
    .catch(() => undefined);
}

export interface TmuxSpawnOptions<TCommitRefusal = never> extends Omit<SpawnOptions, 'env'> {
  /** Target tmux session name */
  sessionName?: string;
  /** Custom tmux socket path */
  socketPath?: string;
  /** Create new window in existing session */
  createWindow?: boolean;
  /** Window name for new windows */
  windowName?: string;
  /** The caller guarantees that `windowName` uniquely identifies this launch. */
  windowNameIsUnique?: boolean;
  /** Create a new owned session whose initial window runs the command; fail if the name exists. */
  requireNewSession?: boolean;
  /** Environment names removed inside the new window before the command executes. */
  unsetEnvKeys?: readonly string[];
  /**
   * Final caller-owned authorization guard. A non-null value refuses the
   * current create-window attempt and is returned verbatim to the caller.
   */
  beforeCreateWindow?: () => Promise<TCommitRefusal | null>;
  // Note: env is intentionally excluded from this interface.
  // It is passed separately so spawnInTmux can keep values out of tmux
  // client arguments while installing the exact window environment.
}

export type TmuxWindowCreationDisposition = 'not_created' | 'created_and_absent' | 'created_or_uncertain';

export type TmuxSpawnResult<TCommitRefusal = never> =
  | Readonly<{
      success: true;
      creationDisposition: 'created_or_uncertain';
      sessionId: string;
      sessionName: string;
      windowName: string;
      pid: number;
      commitRefusal?: never;
    }>
  | Readonly<{
      success: false;
      creationDisposition: TmuxWindowCreationDisposition;
      error?: string;
      commitRefusal?: TCommitRefusal;
    }>;

export class TmuxUtilities {
  /** Default session name to prevent interference */
  public static readonly DEFAULT_SESSION_NAME = 'happy';

  private controlState: TmuxControlState = TmuxControlState.NORMAL;
  public readonly sessionName: string;
  private readonly tmuxCommandEnv?: Record<string, string>;
  private readonly tmuxSocketPath?: string;

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
      logTmuxDebug('[TMUX] Failed to parse TMUX environment variable:', error);
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

    // Build command array
    let baseCmd = ['tmux'];

    // Add socket specification if provided
    const resolvedSocketPath = socketPath ?? this.tmuxSocketPath;
    if (resolvedSocketPath) {
      baseCmd = ['tmux', '-S', resolvedSocketPath];
    }

    // Handle send-keys with proper target specification
    if (cmd.length > 0 && cmd[0] === 'send-keys') {
      const fullCmd = [...baseCmd, cmd[0]];
      const hasExplicitTarget = cmd.slice(1).includes('-t');

      // Add target specification immediately after send-keys
      if (!hasExplicitTarget) {
        let target = targetSession;
        if (window) target += `:${window}`;
        if (pane) target += `.${pane}`;
        fullCmd.push('-t', target);
      }

      // Add keys and control sequences
      fullCmd.push(...cmd.slice(1));

      return this.executeCommand(fullCmd, {
        ...(stdin !== undefined ? { stdin } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    }

    // Non-send-keys commands
    const fullCmd = [...baseCmd, ...cmd];

    // Add target specification for commands that support it
    const hasExplicitTarget = cmd.includes('-t');
    if (!hasExplicitTarget && cmd.length > 0 && COMMANDS_SUPPORTING_TARGET.has(cmd[0])) {
      let target = targetSession;
      if (window) target += `:${window}`;
      if (pane) target += `.${pane}`;
      fullCmd.push('-t', target);
    }

    return this.executeCommand(fullCmd, {
      ...(stdin !== undefined ? { stdin } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
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
      logTmuxDebug('[TMUX] Command execution failed:', error);
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
      const timeoutHandle = commandTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, commandTimeoutMs)
        : undefined;

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        resolve({
          exitCode: normalizeExitCode(code),
          stdout,
          stderr,
          ...(timedOut ? { timedOut: true } : {}),
        });
      });

      child.on('error', (error) => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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
      logTmuxDebug(`[TMUX] Unknown operation: ${operation}`);
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
   * Capture the FULL pane contents from tmux.
   *
   * Returns the whole captured screen (trailing blank rows trimmed), NOT just the bottom
   * line. The multi-line Claude screen parser (`parseClaudeScreenState` /
   * `resolveClaudeScreenInFlightSteerVeto`) inspects boxed composers, dialogs, permission
   * prompts, and spinner lines that sit ABOVE the bottom composer; returning only the last
   * line blinded every steer veto on tmux (a permission prompt above `│ > │` was invisible,
   * so a steer could be wrongly allowed into a dialog). zellij already returns the full
   * `dumpScreen`; this keeps tmux at parity.
   */
  async captureCurrentInput(session?: string, window?: string, pane?: string): Promise<string> {
    // `-e` preserves SGR styling (ported S-8): the dim-placeholder composer detection needs the
    // raw SGR codes; parseClaudeScreenState strips ANSI internally for all text matching.
    const result = await this.executeTmuxCommand(['capture-pane', '-p', '-e'], session, window, pane);
    if (result && result.returncode === 0) {
      return result.stdout.replace(/\s+$/, '');
    }
    return '';
  }

  async captureCursorPosition(session?: string, window?: string, pane?: string): Promise<Readonly<{ x: number; y: number }> | null> {
    const result = await this.executeTmuxCommand(['display-message', '-p', '#{cursor_x}\t#{cursor_y}'], session, window, pane);
    if (!result || result.returncode !== 0 || result.timedOut === true) return null;
    return parseTmuxCursorPosition(result.stdout);
  }

  /**
   * Send keys to tmux pane with proper control sequence handling and type safety
   */
  async sendKeys(keys: string | TmuxControlSequence, session?: string, window?: string, pane?: string): Promise<boolean> {
    // Validate input
    if (!keys || typeof keys !== 'string') {
      logTmuxDebug('[TMUX] Invalid keys provided to sendKeys');
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
      logTmuxDebug('[TMUX] Invalid keys array provided to sendMultipleKeys');
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
   * IMPORTANT: Unlike Node.js spawn(), env is a separate parameter. Values
   * travel through a private one-shot launcher rather than tmux client argv.
   * Callers may provide a fully merged environment (daemon env + profile
   * overrides) so tmux and non-tmux spawns behave consistently.
   *
   * @param args - Command and arguments to execute (as array, will be joined)
   * @param options - Spawn options (tmux-specific, excludes env)
   * @param env - Environment variables to set in window
   * @returns Result with success status and session identifier
   */
  async spawnInTmux<TCommitRefusal = never>(
    args: string[],
    options: TmuxSpawnOptions<TCommitRefusal> = {},
    env?: Record<string, string>,
  ): Promise<TmuxSpawnResult<TCommitRefusal>> {
    let preparedWindowLaunch: PreparedTmuxWindowLaunch | null = null;
    let creationDisposition: TmuxWindowCreationDisposition = 'not_created';
    try {
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

      const generatedWindowName = options.windowName === undefined;
      const windowName = options.windowName || `happy-${randomUUID()}`;
      const windowNameIsUnique = generatedWindowName || options.windowNameIsUnique === true;

      const requireNewSession = options.requireNewSession === true;
      if (!requireNewSession) {
        await this.ensureSessionExists(sessionName);
      }

      const unsetEnvKeys = normalizeUnsetEnvKeys(options.unsetEnvKeys);
      const windowEnv: Record<string, string> = {};

      // Create new window in session with command and environment variables
      // IMPORTANT: Don't manually add -t here - executeTmuxCommand handles it via parameters
      const createWindowArgs = requireNewSession
        ? ['new-session', '-d', '-P', '-F', '#{window_id}\t#{pane_pid}', '-s', sessionName, '-n', windowName]
        : ['new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_pid}', '-n', windowName];

      // Add working directory if specified
      if (options.cwd) {
        const cwdPath = typeof options.cwd === 'string' ? options.cwd : options.cwd.pathname;
        createWindowArgs.push('-c', cwdPath);
      }

      if (!requireNewSession) {
        // Add target session explicitly so option ordering is correct.
        createWindowArgs.push('-t', sessionName);
      }

      // Validate the exact environment that the one-shot window launcher will
      // export. Values must never be added to tmux client arguments.
      if (env && Object.keys(env).length > 0) {
        for (const [key, value] of Object.entries(env)) {
          // Skip undefined/null values with warning
          if (value === undefined || value === null) {
            logTmuxWarn(`[TMUX] Skipping undefined/null environment variable: ${key}`);
            continue;
          }

          // Validate variable name (tmux accepts standard env var names)
          if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
            logTmuxWarn(`[TMUX] Skipping invalid environment variable name: ${key}`);
            continue;
          }

          windowEnv[key] = value;
        }
        logTmuxDebug(`[TMUX] Setting ${Object.keys(env).length} environment variables in tmux window`);
      }

      // Create window with command and get PID immediately.
      //
      // Note: tmux can fail with `create window failed: index N in use` when multiple
      // clients concurrently create windows in the same session (tmux does not always
      // auto-retry the window index allocation). Retry a few times to make concurrent
      // session starts robust.
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
        const commitRefusal = await options.beforeCreateWindow?.() ?? null;
        if (commitRefusal !== null) {
          return { success: false, creationDisposition, commitRefusal };
        }
        if (!preparedWindowLaunch) {
          const readySignal = `happier-window-${randomUUID()}`;
          preparedWindowLaunch = await prepareTmuxWindowLaunch({
            args,
            env: windowEnv,
            unsetEnvKeys,
            readySignal,
          });
          createWindowArgs.push(
            preparedWindowLaunch.command,
            ';',
            'wait-for',
            readySignal,
          );
          createWindowArgsForAttempt = createWindowArgs;
        }
        creationDisposition = 'created_or_uncertain';
        createResult = await this.executeTmuxCommand(createWindowArgsForAttempt);
        if (createResult && createResult.returncode === 0 && createResult.timedOut !== true) break;

        const stderr = createResult?.stderr;
        const explicitSessionNameConflict = requireNewSession
          && createResult?.timedOut !== true
          && /(?:duplicate session|session .+ already exists)/i.test(stderr ?? '');
        const explicitWindowIndexConflict = !requireNewSession
          && createResult?.timedOut !== true
          && isTmuxWindowIndexConflict(stderr);
        if (explicitSessionNameConflict || explicitWindowIndexConflict) {
          creationDisposition = 'not_created';
        }
        const shouldRetry = attempt < maxAttempts && explicitWindowIndexConflict;
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

        logTmuxDebug(`[TMUX] new-window failed with window index conflict; retrying (attempt ${attempt}/${maxAttempts})`);
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }

      if (creationDisposition === 'not_created' && createResult?.returncode !== 0) {
        const tIndex = createWindowArgsForAttempt.indexOf('-t');
        const target = tIndex >= 0 ? createWindowArgsForAttempt[tIndex + 1] : sessionName;
        const resourceKind = requireNewSession ? 'session' : 'window';
        throw new Error(`Failed to create tmux ${resourceKind} (target=${target}): ${createResult?.stderr}`);
      }

      const parsePositivePid = (value: string | undefined): number | null => {
        const normalized = value?.trim() ?? '';
        if (!/^\d+$/.test(normalized)) return null;
        const parsed = Number.parseInt(normalized, 10);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      };
      const parseWindowId = (value: string | undefined): string | null => {
        const normalized = value?.trim() ?? '';
        return /^@\d+$/.test(normalized) ? normalized : null;
      };
      const createOutputParts = (createResult?.stdout ?? '').trim().split('\t');
      const createdWindowId = parseWindowId(createOutputParts[0]);
      const directlyReportedPid = createdWindowId
        ? parsePositivePid(createOutputParts[1])
        : parsePositivePid(createOutputParts[0]);
      const createCompletedNormally = createResult?.returncode === 0 && createResult.timedOut !== true;

      let panePid = createCompletedNormally ? directlyReportedPid : null;
      if (panePid === null) {
        type ListedWindow = Readonly<{ windowId: string; windowName: string; panePid: number | null }>;
        const listCreatedWindows = async (): Promise<readonly ListedWindow[] | null> => {
          const listed = await this.executeTmuxCommand([
            'list-windows',
            '-t',
            sessionName,
            '-F',
            '#{window_id}\t#{window_name}\t#{pane_pid}',
          ]);
          if (!listed || listed.returncode !== 0 || listed.timedOut === true) return null;
          return listed.stdout
            .split('\n')
            .map((line): ListedWindow | null => {
              const [windowIdRaw, listedWindowName = '', panePidRaw] = line.split('\t');
              const windowId = parseWindowId(windowIdRaw);
              if (!windowId) return null;
              return {
                windowId,
                windowName: listedWindowName,
                panePid: parsePositivePid(panePidRaw),
              };
            })
            .filter((entry): entry is ListedWindow => entry !== null);
        };

        const listedWindows = await listCreatedWindows();
        const exactIdMatch = createdWindowId
          ? listedWindows?.find((entry) => entry.windowId === createdWindowId) ?? null
          : null;
        const exactNameMatches = listedWindows?.filter((entry) => entry.windowName === windowName) ?? null;
        const recoveredWindow = createdWindowId
          ? exactIdMatch
          : (windowNameIsUnique && exactNameMatches?.length === 1 ? exactNameMatches[0]! : null);

        if (recoveredWindow?.panePid) {
          panePid = recoveredWindow.panePid;
        } else {
          const absenceWasAlreadyVerified = listedWindows !== null && (
            createdWindowId
              ? exactIdMatch === null
              : windowNameIsUnique && exactNameMatches?.length === 0
          );
          let absenceVerified = absenceWasAlreadyVerified;

          if (!absenceVerified) {
            const exactKillTarget = createdWindowId
              ?? (windowNameIsUnique
                ? recoveredWindow?.windowId ?? `${sessionName}:${windowName}`
                : null);
            if (exactKillTarget) {
              const killResult = await this.executeTmuxCommand(['kill-window', '-t', exactKillTarget]);
              if (killResult?.returncode === 0 && killResult.timedOut !== true) {
                absenceVerified = true;
              } else {
                const windowsAfterKill = await listCreatedWindows();
                const killedWindowId = parseWindowId(exactKillTarget);
                absenceVerified = windowsAfterKill !== null
                  && !windowsAfterKill.some((entry) => (
                    killedWindowId
                      ? entry.windowId === killedWindowId
                      : entry.windowName === windowName
                  ));
              }
            }
          }

          const tIndex = createWindowArgsForAttempt.indexOf('-t');
          const target = tIndex >= 0 ? createWindowArgsForAttempt[tIndex + 1] : sessionName;
          if (absenceVerified) {
            creationDisposition = 'created_and_absent';
            throw new Error(`Failed to create a live tmux window (target=${target}); exact absence was verified`);
          }
          creationDisposition = 'created_or_uncertain';
          throw new Error(`Failed to reconcile tmux window creation (target=${target}): ${createResult?.stderr}`);
        }
      }

      logTmuxDebug(`[TMUX] Spawned command in tmux session ${sessionName}, window ${windowName}, PID ${panePid}`);

      // Return tmux session info and PID
      const sessionIdentifier: TmuxSessionIdentifier = {
        session: sessionName,
        window: windowName,
      };

      return {
        success: true,
        creationDisposition: 'created_or_uncertain',
        sessionId: formatTmuxSessionIdentifier(sessionIdentifier),
        sessionName,
        windowName,
        pid: panePid,
      };
    } catch (error) {
      logTmuxDebug('[TMUX] Failed to spawn in tmux:', error);
      return {
        success: false,
        creationDisposition,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await preparedWindowLaunch?.cleanup();
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
        logTmuxDebug(`[TMUX] Invalid session identifier: ${error.message}`);
      } else {
        logTmuxDebug('[TMUX] Error getting session info:', error);
      }
      return null;
    }
  }

  /**
   * Kill a tmux window safely with proper error handling
   */
  async killWindow(sessionIdentifier: string): Promise<boolean> {
    try {
      const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
      if (!parsed.window) {
        throw new TmuxSessionIdentifierError(`Window identifier required: ${sessionIdentifier}`);
      }

      const result = await this.executeTmuxCommand(['kill-window'], parsed.session, parsed.window);
      if (!result || result.returncode !== 0 || result.timedOut === true) {
        return false;
      }
      const inventory = await this.executeTmuxCommand([
        'list-windows',
        '-t',
        parsed.session,
        '-F',
        '#{window_name}',
      ]);
      if (!inventory || inventory.timedOut === true) return false;
      if (inventory.returncode === 0) {
        return !inventory.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .includes(parsed.window);
      }
      return /(?:can't find session|no server running|failed to connect to server)/iu
        .test(inventory.stderr);
    } catch (error) {
      if (error instanceof TmuxSessionIdentifierError) {
        logTmuxDebug(`[TMUX] Invalid window identifier: ${error.message}`);
      } else {
        logTmuxDebug('[TMUX] Error killing window:', error);
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
