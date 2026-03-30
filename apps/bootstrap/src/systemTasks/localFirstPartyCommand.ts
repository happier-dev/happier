import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  installVersionedPayload,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveInstalledFirstPartyComponentPaths,
  type FirstPartyComponentId,
  type PreparedFirstPartyComponentPayload,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

export function resolveExplicitOrInstalledLocalFirstPartyCommand(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv?: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
}>): string | null {
  const processEnv = params.processEnv ?? process.env;

  for (const envVarName of params.envVarNames ?? []) {
    const explicit = String(processEnv[envVarName] ?? '').trim();
    if (explicit) {
      return explicit;
    }
  }

  try {
    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: params.componentId,
      processEnv,
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
    processEnv,
  });
  if (repoLocalPath) {
    return repoLocalPath;
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

function resolveRepoRootForFirstPartyComponent(processEnv: NodeJS.ProcessEnv): string | null {
  const explicitRepoRoot = String(processEnv.HAPPIER_STACK_REPO_DIR ?? processEnv.HAPPIER_STACK_CLI_ROOT_DIR ?? '').trim();
  const startDir = explicitRepoRoot || process.cwd();
  if (!startDir) {
    return null;
  }

  let cursor = resolve(startDir);
  while (true) {
    const stackBin = join(cursor, 'apps', 'stack', 'bin', 'hstack.mjs');
    const cliBin = join(cursor, 'apps', 'cli', 'bin', 'happier.mjs');
    if (existsSync(stackBin) || existsSync(cliBin)) {
      return cursor;
    }

    const parent = dirname(cursor);
    if (!parent || parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return null;
}

type PreparedPayload = Pick<PreparedFirstPartyComponentPayload, 'versionId' | 'payloadRoot' | 'cleanup'>;

type EnsureLocalFirstPartyCommandDeps = Readonly<{
  preparePayload: (params: Readonly<{
    componentId: FirstPartyComponentId;
    channel: PublicReleaseRingId;
  }>) => Promise<PreparedPayload>;
  installPayload: typeof installVersionedPayload;
}>;

export async function ensureLocalFirstPartyComponentCommand(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv?: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
}>, overrides: Partial<EnsureLocalFirstPartyCommandDeps> = {}): Promise<string> {
  const processEnv = params.processEnv ?? process.env;
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
      processEnv,
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

  const installedCommand = resolveExplicitOrInstalledLocalFirstPartyCommand({
    ...params,
    processEnv,
    releaseRing,
  });
  if (installedCommand) {
    return installedCommand;
  }

  throw new SystemTaskExecutionError(
    'first_party_component_install_failed',
    `Installed ${params.componentId}, but its local command path is still unavailable.`,
  );
}
