import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  installVersionedPayload,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveInstalledFirstPartyComponentPaths,
  type FirstPartyComponentId,
  type PreparedFirstPartyComponentPayload,
} from '../../firstPartyRuntime/index.js';
import { resolveWindowsCommandInvocation } from '../../process/index.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

export const DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES = [
  'HAPPIER_BOOTSTRAP_CLI_PATH',
  'HAPPIER_BOOTSTRAP_HAPPIER_PATH',
] as const;

export type HappierTextResult = Readonly<{
  status: number;
  stdout: string;
  stderr: string;
}>;

export type RunHappierOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export interface HappierJsonExecutor {
  runHappierText(args: readonly string[], opts?: RunHappierOptions): Promise<HappierTextResult>;
  runHappierJson(
    args: readonly string[],
    opts?: RunHappierOptions & Readonly<{ allowJsonFailure?: boolean }>,
  ): Promise<unknown>;
}

type CommandExecutionResult = Readonly<{
  status: number;
  stdout: string;
  stderr: string;
}>;

async function runCommandCapture(params: Readonly<{
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<CommandExecutionResult> {
  const invocation = resolveWindowsCommandInvocation({
    command: params.command,
    args: [...params.args],
    env: params.env,
  });

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(invocation.command, invocation.args, {
      env: params.env,
      cwd: params.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const cleanupAbortListener = () => {
      if (!params.signal) return;
      params.signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      cleanupAbortListener();
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      rejectPromise(new Error('Command aborted.'));
    };

    if (params.signal) {
      if (params.signal.aborted) {
        onAbort();
        return;
      }
      params.signal.addEventListener('abort', onAbort, { once: true });
    }

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupAbortListener();
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      rejectPromise(new Error(`Command timed out: ${params.command}`));
    }, Number.isFinite(params.timeoutMs) ? Math.max(1, Math.floor(params.timeoutMs as number)) : 60_000);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      cleanupAbortListener();
      rejectPromise(error);
    });

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      cleanupAbortListener();
      resolvePromise({
        status: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function parseFirstJsonObject(text: string): unknown {
  const lines = String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function isJsonFailureEnvelope(value: unknown): value is Readonly<{ ok: false }> {
  return Boolean(
    value
      && typeof value === 'object'
      && 'ok' in value
      && (value as { ok?: unknown }).ok === false,
  );
}

function resolveRepoRootForFirstPartyComponent(processEnv: NodeJS.ProcessEnv): string | null {
  const explicitRepoRoot = String(
    processEnv.HAPPIER_STACK_REPO_DIR ??
      processEnv.HAPPIER_STACK_CLI_ROOT_DIR ??
      '',
  ).trim();
  const startDir = explicitRepoRoot || process.cwd();
  if (!startDir) return null;

  let cursor = resolve(startDir);
  while (true) {
    const stackBin = join(cursor, 'apps', 'stack', 'bin', 'hstack.mjs');
    const cliBin = join(cursor, 'apps', 'cli', 'bin', 'happier.mjs');
    if (existsSync(stackBin) || existsSync(cliBin)) {
      return cursor;
    }

    const parent = dirname(cursor);
    if (!parent || parent === cursor) break;
    cursor = parent;
  }

  return null;
}

function resolveRepoLocalFirstPartyCommandPath(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv: NodeJS.ProcessEnv;
}>): string | null {
  const repoRoot = resolveRepoRootForFirstPartyComponent(params.processEnv);
  if (!repoRoot) {
    return null;
  }

  const candidates =
    params.componentId === 'hstack'
      ? [
          join(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs'),
          join(repoRoot, 'packages', 'stack', 'bin', 'hstack.mjs'),
        ]
      : params.componentId === 'happier-cli'
        ? [
            join(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs'),
            join(repoRoot, 'packages', 'cli', 'bin', 'happier.mjs'),
          ]
        : [];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveExplicitOrInstalledLocalFirstPartyCommand(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
}>): string | null {
  for (const envVarName of params.envVarNames ?? []) {
    const explicit = String(params.processEnv[envVarName] ?? '').trim();
    if (explicit) {
      return explicit;
    }
  }

  try {
    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: params.componentId,
      processEnv: params.processEnv,
      releaseRing: params.releaseRing,
    });
    if (existsSync(paths.binaryPath)) {
      return paths.binaryPath;
    }
  } catch {
    // ignore and continue to managed install acquisition
  }

  const repoLocalPath = resolveRepoLocalFirstPartyCommandPath({
    componentId: params.componentId,
    processEnv: params.processEnv,
  });
  if (repoLocalPath) {
    return repoLocalPath;
  }

  return null;
}

type PreparedPayload = Pick<PreparedFirstPartyComponentPayload, 'versionId' | 'payloadRoot' | 'cleanup'>;

type EnsureLocalFirstPartyCommandDeps = Readonly<{
  preparePayload: (params: Readonly<{ componentId: FirstPartyComponentId; channel: PublicReleaseRingId }>) => Promise<PreparedPayload>;
  installPayload: typeof installVersionedPayload;
}>;

export async function ensureLocalFirstPartyComponentCommand(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
}>, overrides: Partial<EnsureLocalFirstPartyCommandDeps> = {}): Promise<string> {
  const releaseRing = params.releaseRing ?? 'stable';
  const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand(params);
  if (resolved) {
    return resolved;
  }

  const deps: EnsureLocalFirstPartyCommandDeps = {
    preparePayload: async (innerParams) => await prepareFirstPartyComponentPayloadFromGitHubRelease(innerParams),
    installPayload: installVersionedPayload,
    ...overrides,
  };

  let prepared: PreparedPayload | null = null;
  try {
    prepared = await deps.preparePayload({
      componentId: params.componentId,
      channel: releaseRing,
    });

    await deps.installPayload({
      componentId: params.componentId,
      processEnv: params.processEnv,
      releaseRing,
      versionId: prepared.versionId,
      payloadRoot: prepared.payloadRoot,
    });
  } catch (error) {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : `Failed to acquire ${params.componentId}.`;
    throw new SystemTaskExecutionError('first_party_component_install_failed', message);
  } finally {
    if (prepared) {
      await prepared.cleanup().catch(() => undefined);
    }
  }

  const installed = resolveExplicitOrInstalledLocalFirstPartyCommand({
    componentId: params.componentId,
    processEnv: params.processEnv,
    envVarNames: params.envVarNames,
    releaseRing,
  });
  if (installed) {
    return installed;
  }

  throw new SystemTaskExecutionError(
    'first_party_component_install_failed',
    `Installed ${params.componentId} but could not resolve it.`,
  );
}

export function createLocalHappierJsonExecutor(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
}> = {}): HappierJsonExecutor {
  const defaultProcessEnv = params.processEnv ?? process.env;
  const envVarNames = params.envVarNames ?? DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES;
  const releaseRing = params.releaseRing;

  let installPromise: Promise<void> | null = null;
  const ensureCommand = async (processEnv: NodeJS.ProcessEnv): Promise<string> => {
    const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand({
      componentId: 'happier-cli',
      processEnv,
      envVarNames,
      releaseRing,
    });
    if (resolved) {
      return resolved;
    }

    if (!installPromise) {
      installPromise = ensureLocalFirstPartyComponentCommand({
        componentId: 'happier-cli',
        processEnv,
        envVarNames,
        releaseRing,
      }).then(() => undefined);
    }
    await installPromise;

    const installed = resolveExplicitOrInstalledLocalFirstPartyCommand({
      componentId: 'happier-cli',
      processEnv,
      envVarNames,
      releaseRing,
    });
    if (installed) {
      return installed;
    }

    throw new SystemTaskExecutionError(
      'first_party_component_install_failed',
      'Installed happier-cli but could not resolve it.',
    );
  };

  return {
    async runHappierText(args, opts) {
      const processEnv = opts?.env ?? defaultProcessEnv;
      const command = await ensureCommand(processEnv);
      const result = await runCommandCapture({
        command,
        args,
        env: processEnv,
        cwd: opts?.cwd,
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
      }).catch((error: unknown) => {
        const message = error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Failed to spawn Happier CLI.';
        throw new SystemTaskExecutionError('cli_spawn_failed', message);
      });

      return result;
    },

    async runHappierJson(args, opts) {
      const allowJsonFailure = opts?.allowJsonFailure;
      const result = await this.runHappierText(args, opts);
      const parsed = parseFirstJsonObject(result.stdout);

      if (result.status !== 0) {
        if (allowJsonFailure && parsed && typeof parsed === 'object') {
          return parsed;
        }
        throw new SystemTaskExecutionError(
          'cli_command_failed',
          result.stderr.trim() || result.stdout.trim() || 'Command failed.',
        );
      }

      if (!parsed || typeof parsed !== 'object') {
        throw new SystemTaskExecutionError(
          'invalid_cli_response',
          `Command did not return a JSON object: ${args.join(' ')}`,
        );
      }

      if (!allowJsonFailure && isJsonFailureEnvelope(parsed)) {
        const envelope = parsed as {
          error?: { code?: unknown; message?: unknown } | unknown;
          message?: unknown;
        };
        const message = typeof envelope.message === 'string' && envelope.message.trim()
          ? envelope.message.trim()
          : envelope.error && typeof envelope.error === 'object' && envelope.error !== null
              && typeof (envelope.error as { message?: unknown }).message === 'string'
            ? ((envelope.error as { message?: string }).message ?? '').trim()
            : `Command failed: ${args.join(' ')}`;
        throw new SystemTaskExecutionError('cli_command_failed', message);
      }

      return parsed;
    },
  };
}
