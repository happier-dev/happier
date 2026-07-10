import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

import { commandExistsOnPath, resolveWindowsCommandInvocation } from '../../process/index.js';
import { resolveAgentCliCommandForRuntime, type AgentCliRuntimeDescriptor } from '../resolution.js';

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
      errorCode: 'command-not-found' | 'command-exec-failed' | 'command-timed-out' | 'command-failed';
      errorMessage: string;
    }>;

function buildVendorRecipePath(runtimeSpec: AgentCliRuntimeDescriptor, env: NodeJS.ProcessEnv): string {
  const currentEntries = String(env.PATH ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  if (process.platform === 'win32') {
    return currentEntries.join(delimiter);
  }

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

function resolveVendorInstallTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = typeof env.HAPPIER_VENDOR_INSTALL_TIMEOUT_MS === 'string'
    ? env.HAPPIER_VENDOR_INSTALL_TIMEOUT_MS.trim()
    : '';
  if (raw === '0') return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 250) return 180_000;
  return Math.min(parsed, 900_000);
}

export async function runVendorRecipeInstall(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  commands: ReadonlyArray<VendorRecipeInstallCommand>;
  env: NodeJS.ProcessEnv;
  logPath: string;
  vendorScratchDir: string | null;
  spawn: typeof spawnSync;
  appendCommandLog: AppendCommandLogFn;
  appendLogLine: AppendLogLineFn;
}>): Promise<VendorRecipeInstallResult> {
  const {
    runtimeSpec,
    commands,
    env,
    logPath,
    vendorScratchDir,
    spawn,
    appendCommandLog,
    appendLogLine,
  } = params;

  for (const c of commands) {
    if (!commandExistsOnPath(c.cmd, { env })) {
      return { ok: false, errorCode: 'command-not-found', errorMessage: `Command not found: ${c.cmd}` };
    }
    const timeoutMs = resolveVendorInstallTimeoutMs(env);
    const childEnv = {
      ...process.env,
      ...env,
      PATH: buildVendorRecipePath(runtimeSpec, {
        ...process.env,
        ...env,
      }),
      ...(vendorScratchDir ? { TMPDIR: vendorScratchDir, TMP: vendorScratchDir, TEMP: vendorScratchDir } : {}),
    };
    const invocation = resolveWindowsCommandInvocation({
      command: c.cmd,
      args: c.args,
      env: childEnv,
      resolveCommandOnPath: true,
    });
    const res = spawn(invocation.command, invocation.args, {
      encoding: 'utf8',
      env: childEnv,
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (res.error) {
      appendCommandLog(logPath, c.cmd, c.args, '', res.error.message, res.status ?? null, res.signal ?? null);
      if ((res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        appendLogLine(logPath, `# vendor recipe timed out after ${timeoutMs}ms`);
        return {
          ok: false,
          errorCode: 'command-timed-out',
          errorMessage: `Vendor install timed out after ${timeoutMs}ms: ${c.cmd}`,
        };
      }
      return { ok: false, errorCode: 'command-exec-failed', errorMessage: res.error.message };
    }
    const status = typeof res.status === 'number' ? res.status : null;
    const signal = res.signal ?? null;
    appendCommandLog(logPath, c.cmd, c.args, String(res.stdout ?? ''), String(res.stderr ?? ''), status, signal);
    if (status !== 0) {
      const resolvedAfterFailure = resolveAgentCliCommandForRuntime(runtimeSpec, { processEnv: childEnv });
      if (resolvedAfterFailure) {
        appendLogLine(
          logPath,
          `# vendor recipe exited ${status ?? 'unknown'} but ${runtimeSpec.id} became available at ${resolvedAfterFailure.command}`,
        );
        return { ok: true };
      }
      return {
        ok: false,
        errorCode: 'command-failed',
        errorMessage: resolveVendorRecipeFailureMessage({
          cmd: c.cmd,
          status,
          signal,
          stderr: String(res.stderr ?? ''),
        }),
      };
    }
  }

  return { ok: true };
}
