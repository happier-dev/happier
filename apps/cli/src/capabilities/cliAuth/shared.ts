import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  agentCliPathRequiresJavaScriptRuntime,
  resolveAgentCliJavaScriptRuntimeCommand,
} from '@happier-dev/cli-common/agents/resolution';
import { ExecFileTerminationError, execFileWithDeadline, resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';

export function resolveCliAuthHomeDir(): string {
  const envHome =
    process.platform === 'win32'
      ? (process.env.USERPROFILE || process.env.HOME)
      : process.env.HOME;
  const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
  return trimmed.length > 0 ? trimmed : homedir();
}

/**
 * Runs an agent CLI's auth probe. The command's OUTPUT is the answer, so the budget goes through
 * `execFileWithDeadline`: a `child_process` `timeout` reports a completed probe as `ok: true` with
 * empty stdout on a stalled loop, and every caller reads a silent CLI as "not signed in".
 */
export async function runCliCommandBestEffort(params: Readonly<{
  resolvedPath: string;
  args: string[];
  /** Null keeps the probe pending under caller cancellation instead of the auth diagnostic default. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  processEnv?: Readonly<Record<string, string | undefined>>;
}>): Promise<Readonly<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }>> {
  const timeoutMs = params.timeoutMs === null ? undefined : typeof params.timeoutMs === 'number' ? params.timeoutMs : 1_000;
  const isWindows = process.platform === 'win32';
  const isCmdScript = isWindows && /\.(cmd|bat)$/i.test(params.resolvedPath);
  const processEnv = params.processEnv ?? process.env;
  const execEnv = params.env ? { ...processEnv, ...params.env } : processEnv;
  const execOptions = {
    timeout: timeoutMs,
    signal: params.signal,
    terminateOnAbort: terminateProcessTree,
    // Native process environments can be sparse despite required ambient UI fields.
    env: execEnv as NodeJS.ProcessEnv,
    cwd: params.cwd,
    windowsHide: true,
  };
  const needsJavaScriptRuntime = agentCliPathRequiresJavaScriptRuntime(params.resolvedPath);
  const runtimeExecutable = resolveAgentCliJavaScriptRuntimeCommand(params.resolvedPath, execEnv, {
    isBunRuntime: typeof process.versions.bun === 'string',
    currentExecPath: process.execPath,
    cwd: params.cwd,
  });

  const asString = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return '';
  };

  try {
    if (needsJavaScriptRuntime && !runtimeExecutable) {
      return { ok: false, stdout: '', stderr: '', exitCode: null };
    }

    if (runtimeExecutable) {
      const { stdout, stderr } = await execFileWithDeadline(runtimeExecutable, [params.resolvedPath, ...params.args], execOptions);
      return { ok: true, stdout: asString(stdout), stderr: asString(stderr), exitCode: 0 };
    }

    if (isCmdScript) {
      const invocation = resolveWindowsCommandInvocation({
        command: params.resolvedPath,
        args: params.args,
        resolveCommandOnPath: false,
      });
      const { stdout, stderr } = await execFileWithDeadline(invocation.command, invocation.args, {
        ...execOptions,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      return { ok: true, stdout: asString(stdout), stderr: asString(stderr), exitCode: 0 };
    }

    const { stdout, stderr } = await execFileWithDeadline(params.resolvedPath, params.args, execOptions);
    return { ok: true, stdout: asString(stdout), stderr: asString(stderr), exitCode: 0 };
  } catch (error) {
    if (error instanceof ExecFileTerminationError) throw error;
    return {
      ok: false,
      stdout: asString((error as any)?.stdout),
      stderr: asString((error as any)?.stderr),
      exitCode:
        typeof (error as any)?.status === 'number'
          ? (error as any).status
          : typeof (error as any)?.exitCode === 'number'
            ? (error as any).exitCode
            : typeof (error as any)?.code === 'number'
              ? (error as any).code
            : null,
    };
  }
}

export function readJsonFileSafe(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveCommonApiKeyStatus(envKeys: readonly string[]): Readonly<{
  state: 'logged_in' | 'logged_out';
  method?: 'api_key_env';
  source?: 'env';
}> {
  const hasKey = envKeys.some((key) => {
    const raw = process.env[key];
    return typeof raw === 'string' && raw.trim().length > 0;
  });
  return hasKey
    ? { state: 'logged_in', method: 'api_key_env', source: 'env' }
    : { state: 'logged_out' };
}

export function decodeJwtEmail(token: string | null | undefined): string | null {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const email = parsed.email;
    return typeof email === 'string' && email.trim().length > 0 ? email.trim() : null;
  } catch {
    return null;
  }
}

export function joinHomePath(...parts: string[]): string {
  return join(resolveCliAuthHomeDir(), ...parts);
}
