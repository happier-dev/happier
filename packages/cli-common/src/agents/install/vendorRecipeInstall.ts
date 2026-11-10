import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import { commandExistsOnPath, execFileWithDeadline, ExecFileTerminationError, resolveWindowsCommandInvocation } from '../../process/index.js';
import { resolveAgentCliCommandForRuntime, type AgentCliRuntimeDescriptor } from '../resolution.js';
import type { AgentInstallProgressCallback } from '../installProgress.js';

type VendorRecipeInstallCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
}>;

type AppendCommandLogFn = (
  logPath: string,
  cmd: string,
  args: readonly string[],
  stdout: string,
  stderr: string,
  status: number | null,
  signal: NodeJS.Signals | null,
) => void;

type AppendLogLineFn = (logPath: string, line: string) => void;

function resolveVendorRecipeFailureMessage(params: Readonly<{
  cmd: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}>): string {
  const stderr = params.stderr.trim();
  if (params.status === 137 || params.signal === 'SIGKILL') {
    return [
      `Vendor install was killed while running ${params.cmd}; this often means the machine ran out of memory.`,
      'Please increase available memory or swap and retry.',
      stderr ? `Installer output: ${stderr}` : null,
    ].filter(Boolean).join(' ');
  }
  return stderr || `Command failed (${params.status ?? 'unknown'}): ${params.cmd}`;
}

export type VendorRecipeInstallResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode: 'command-not-found' | 'command-exec-failed' | 'command-timed-out' | 'command-failed' | 'termination-failed';
      errorMessage: string;
    }>;

function buildVendorRecipePath(runtimeSpec: AgentCliRuntimeDescriptor, env: NodeJS.ProcessEnv): string {
  const currentEntries = String(env.PATH ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const homeDir = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  if (!homeDir) {
    return currentEntries.join(delimiter);
  }

  const preferredEntries = [
    join(homeDir, '.local', 'bin'),
    ...((runtimeSpec.knownUserBinDirSuffixes ?? []).map((suffix) => join(homeDir, suffix))),
  ];

  const uniqueEntries = new Set<string>();
  for (const entry of [...preferredEntries, ...currentEntries]) {
    if (!entry) continue;
    uniqueEntries.add(entry);
  }
  return [...uniqueEntries].join(delimiter);
}

/** The budget for one agent install/update command: `HAPPIER_VENDOR_INSTALL_TIMEOUT_MS`, default 180 s, `0` disables it. */
export function resolveVendorInstallTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = typeof env.HAPPIER_VENDOR_INSTALL_TIMEOUT_MS === 'string'
    ? env.HAPPIER_VENDOR_INSTALL_TIMEOUT_MS.trim()
    : '';
  if (raw === '0') return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 250) return 180_000;
  return Math.min(parsed, 900_000);
}

type AgentCommandFailure = Readonly<{
  ok: false;
  errorCode: 'command-not-found' | 'command-exec-failed' | 'command-timed-out' | 'command-failed' | 'termination-failed';
  errorMessage: string;
}>;

/**
 * Runs one vendor-owned command (an install recipe step or a declared vendor updater) with the
 * vendor PATH and scratch env, the `HAPPIER_VENDOR_INSTALL_TIMEOUT_MS` budget and the install log,
 * without blocking the caller's event loop: the daemon keeps serving sessions and RPCs while a
 * vendor installer downloads. A non-zero exit after which the agent resolves counts as success.
 */
export async function runLoggedAgentCommand(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  command: VendorRecipeInstallCommand;
  env: NodeJS.ProcessEnv;
  logPath: string;
  vendorScratchDir: string | null;
  runCommand: typeof execFileWithDeadline;
  appendCommandLog: AppendCommandLogFn;
  appendLogLine: AppendLogLineFn;
  /**
   * An install recipe may exit non-zero after it already placed the CLI, so by default a resolvable
   * agent counts as success. A vendor updater runs against an agent that already resolves, so it
   * passes `false` and a failed exit stays a failure.
   */
  acceptResolvedAfterFailure?: boolean;
  signal?: AbortSignal;
  onProgress?: AgentInstallProgressCallback;
}>): Promise<Readonly<{ ok: true }> | AgentCommandFailure> {
  const { runtimeSpec, command: c, env, logPath, vendorScratchDir, appendCommandLog, appendLogLine } = params;
  params.signal?.throwIfAborted();
  // An absolute command is the executable detect resolved; `command -v`/`where` answer PATH names.
  const exists = isAbsolute(c.cmd) ? existsSync(c.cmd) : commandExistsOnPath(c.cmd, { env });
  if (!exists) {
    return { ok: false, errorCode: 'command-not-found', errorMessage: `Command not found: ${c.cmd}` };
  }
  const timeoutMs = resolveVendorInstallTimeoutMs(env);
  const childEnv = {
    ...process.env,
    ...env,
    // Only POSIX recipes add user install directories. Preserve Windows Path
    // instead of shadowing the case-insensitive key with an empty PATH.
    ...(process.platform === 'win32' ? {} : { PATH: buildVendorRecipePath(runtimeSpec, {
      ...process.env,
      ...env,
    }) }),
    ...(vendorScratchDir ? { TMPDIR: vendorScratchDir, TMP: vendorScratchDir, TEMP: vendorScratchDir } : {}),
  };
  const invocation = resolveWindowsCommandInvocation({
    command: c.cmd,
    args: c.args,
    env: childEnv,
    resolveCommandOnPath: true,
  });
  let status: number | null = 0;
  let signal: NodeJS.Signals | null = null;
  let stdout = '';
  let stderr = '';
  params.onProgress?.({ t: 'log', line: `Running ${c.cmd}` });
  try {
    const result = await params.runCommand(invocation.command, invocation.args, {
      encoding: 'utf8',
      env: childEnv,
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      signal: params.signal,
    });
    stdout = String(result.stdout ?? '');
    stderr = String(result.stderr ?? '');
  } catch (error) {
    if (error instanceof ExecFileTerminationError) {
      appendLogLine(logPath, error.message);
      return { ok: false, errorCode: 'termination-failed', errorMessage: error.message };
    }
    params.signal?.throwIfAborted();
    // `execFile`'s rejection contract: numeric `code` is the exit status, a string `code` is a
    // spawn errno, `killed` means this boundary's deadline ended the command.
    const failure = error as NodeJS.ErrnoException & {
      code?: string | number;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      stdout?: unknown;
      stderr?: unknown;
    };
    stdout = String(failure.stdout ?? '');
    stderr = String(failure.stderr ?? '');
    signal = failure.signal ?? null;
    status = typeof failure.code === 'number' ? failure.code : null;
    if (failure.killed === true && timeoutMs > 0) {
      appendCommandLog(logPath, c.cmd, c.args, stdout, stderr, status, signal);
      appendLogLine(logPath, `# vendor command timed out after ${timeoutMs}ms`);
      return {
        ok: false,
        errorCode: 'command-timed-out',
        errorMessage: `Vendor command timed out after ${timeoutMs}ms: ${c.cmd}`,
      };
    }
    if (typeof failure.code === 'string') {
      appendCommandLog(logPath, c.cmd, c.args, stdout, failure.message, null, signal);
      return { ok: false, errorCode: 'command-exec-failed', errorMessage: failure.message };
    }
  }
  params.signal?.throwIfAborted();
  appendCommandLog(logPath, c.cmd, c.args, stdout, stderr, status, signal);
  if (status === 0 && signal === null) return { ok: true };

  const resolvedAfterFailure = params.acceptResolvedAfterFailure === false
    ? null
    : resolveAgentCliCommandForRuntime(runtimeSpec, { processEnv: childEnv });
  if (resolvedAfterFailure) {
    appendLogLine(
      logPath,
      `# vendor command exited ${status ?? 'unknown'} but ${runtimeSpec.id} became available at ${resolvedAfterFailure.command}`,
    );
    return { ok: true };
  }
  return {
    ok: false,
    errorCode: 'command-failed',
    errorMessage: resolveVendorRecipeFailureMessage({ cmd: c.cmd, status, signal, stderr }),
  };
}

export async function runVendorRecipeInstall(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  commands: ReadonlyArray<VendorRecipeInstallCommand>;
  env: NodeJS.ProcessEnv;
  logPath: string;
  vendorScratchDir: string | null;
  runCommand: typeof execFileWithDeadline;
  appendCommandLog: AppendCommandLogFn;
  appendLogLine: AppendLogLineFn;
  /** Native updates must succeed independently of any already-installed executable. */
  acceptResolvedAfterFailure?: boolean;
  signal?: AbortSignal;
  onProgress?: AgentInstallProgressCallback;
}>): Promise<VendorRecipeInstallResult> {
  for (const command of params.commands) {
    const result = await runLoggedAgentCommand({ ...params, command });
    if (!result.ok) return result;
  }
  return { ok: true };
}

