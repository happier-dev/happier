import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { systemTasks } from '@happier-dev/cli-common';

import {
  ensureLocalFirstPartyComponentCommand,
  resolveExplicitOrInstalledLocalFirstPartyCommand,
} from './localFirstPartyCommand.js';
import { parseFirstJsonObject, runCommandCapture } from './taskRuntime.js';

const DEFAULT_ENV_VAR_NAMES = [
  'HAPPIER_BOOTSTRAP_CLI_PATH',
  'HAPPIER_BOOTSTRAP_HAPPIER_PATH',
] as const;

function resolveRepoLocalHappierCommand(processEnv: NodeJS.ProcessEnv): string | null {
  const explicitRepoRoot = String(
    processEnv.HAPPIER_STACK_REPO_DIR ??
      processEnv.HAPPIER_STACK_CLI_ROOT_DIR ??
      ''
  ).trim();
  const startDir = explicitRepoRoot || process.cwd();
  if (!startDir) {
    return null;
  }

  let cursor = resolve(startDir);
  while (cursor) {
    const candidates = [
      join(cursor, 'apps', 'cli', 'bin', 'happier.mjs'),
      join(cursor, 'packages', 'cli', 'bin', 'happier.mjs'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = dirname(cursor);
    if (!parent || parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return null;
}

export function resolveLocalHappierCommand(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
}> = {}): string {
  const processEnv = params.processEnv ?? process.env;
  const explicitOrInstalled = resolveExplicitOrInstalledLocalFirstPartyCommand({
    componentId: 'happier-cli',
    processEnv,
    envVarNames: params.envVarNames ?? DEFAULT_ENV_VAR_NAMES,
  });
  if (explicitOrInstalled) {
    return explicitOrInstalled;
  }

  const repoLocal = resolveRepoLocalHappierCommand(processEnv);
  if (repoLocal) {
    return repoLocal;
  }

  return 'happier';
}

export async function runLocalHappierJsonCommand(params: Readonly<{
  args: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
  allowJsonFailure?: boolean;
}>): Promise<unknown> {
  const processEnv = params.processEnv ?? process.env;
  const command = await ensureLocalFirstPartyComponentCommand({
    componentId: 'happier-cli',
    processEnv,
    envVarNames: DEFAULT_ENV_VAR_NAMES,
  });

  const result = await runCommandCapture({
    command,
    args: params.args,
    env: processEnv,
  }).catch((error: unknown) => {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Failed to spawn Happier CLI.';
    throw new systemTasks.SystemTaskExecutionError('cli_spawn_failed', message);
  });

  const parsed = parseFirstJsonObject(result.stdout);

  if (result.status !== 0) {
    if (params.allowJsonFailure && parsed && typeof parsed === 'object') {
      return parsed;
    }
    throw new systemTasks.SystemTaskExecutionError(
      'cli_command_failed',
      result.stderr.trim() || result.stdout.trim() || `Command failed: ${command}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      `Command did not return a JSON object: ${params.args.join(' ')}`,
    );
  }

  if (!params.allowJsonFailure && isJsonFailureEnvelope(parsed)) {
    const envelope = parsed as {
      error?: { code?: unknown; message?: unknown } | unknown;
      message?: unknown;
    };
    const message = typeof envelope.message === 'string' && envelope.message.trim()
      ? envelope.message.trim()
      : envelope.error && typeof envelope.error === 'object' && envelope.error !== null
          && typeof (envelope.error as { message?: unknown }).message === 'string'
        ? ((envelope.error as { message?: string }).message ?? '').trim()
        : `Command failed: ${params.args.join(' ')}`;
    throw new systemTasks.SystemTaskExecutionError('cli_command_failed', message);
  }

  return parsed;
}

function isJsonFailureEnvelope(value: unknown): value is Readonly<{ ok: false }> {
  return Boolean(
    value
      && typeof value === 'object'
      && 'ok' in value
      && (value as { ok?: unknown }).ok === false,
  );
}
