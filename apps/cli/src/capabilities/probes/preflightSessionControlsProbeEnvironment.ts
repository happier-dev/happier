import type { AccountSettings } from '@happier-dev/protocol';

import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { ApiClient, type ApiClient as ApiClientType } from '@/api/api';
import { configuration } from '@/configuration';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { resolveConnectedServicesMaterializationBaseDir } from '@/daemon/connectedServices/materialize/resolveConnectedServicesMaterializationBaseDir';
import type { Credentials } from '@/persistence';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';

import type { PreflightSessionControlsProbeKind } from './preflightSessionControlsProbeAdapterTypes';

type Cleanup = (() => void) | null;

export type PreflightSessionControlsProbeEnvironment = Readonly<{
  env: NodeJS.ProcessEnv;
  cleanupOnFailure: Cleanup;
  cleanupOnExit: Cleanup;
}>;

type ResolvePreflightSessionControlsProbeEnvironmentParams = Readonly<{
  agentId: CatalogAgentLookupId;
  probeKind: PreflightSessionControlsProbeKind;
  cwd: string;
  connectedServices?: unknown;
  credentials?: Credentials | null;
  api?: ApiClientType | null;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  activeServerDir?: string;
  baseDir?: string;
  processEnv?: NodeJS.ProcessEnv;
}>;

function buildBaseEnvironment(processEnv: NodeJS.ProcessEnv | undefined): PreflightSessionControlsProbeEnvironment {
  return {
    env: { ...(processEnv ?? process.env) },
    cleanupOnFailure: null,
    cleanupOnExit: null,
  };
}

function runCleanup(cleanup: Cleanup): void {
  if (!cleanup) return;
  try {
    cleanup();
  } catch {
    // Best effort: probe cleanup must not mask the provider probe result.
  }
}

export async function resolvePreflightSessionControlsProbeEnvironment(
  params: ResolvePreflightSessionControlsProbeEnvironmentParams,
): Promise<PreflightSessionControlsProbeEnvironment> {
  const base = buildBaseEnvironment(params.processEnv);
  if (params.connectedServices === undefined || params.connectedServices === null) return base;
  if (!params.credentials) return base;
  if (!isCatalogAgentId(params.agentId)) return base;

  const api = params.api ?? await ApiClient.create(params.credentials);
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const materialized = await resolveConnectedServiceAuthForSpawn({
    agentId: params.agentId,
    connectedServicesBindingsRaw: params.connectedServices,
    materializationKey: createStableSpawnNonce('preflight.session-controls-probe', {
      agentId: params.agentId,
      probeKind: params.probeKind,
      cwd,
      connectedServices: params.connectedServices,
    }),
    activeServerDir: params.activeServerDir ?? configuration.activeServerDir,
    baseDir: params.baseDir ?? resolveConnectedServicesMaterializationBaseDir(configuration.happyHomeDir),
    sessionDirectory: cwd,
    credentials: params.credentials,
    api,
    accountSettings: params.accountSettings ?? null,
    processEnv: base.env,
  });

  if (!materialized) return base;

  return {
    env: {
      ...base.env,
      ...materialized.env,
    },
    cleanupOnFailure: materialized.cleanupOnFailure,
    cleanupOnExit: materialized.cleanupOnExit,
  };
}

export async function withPreflightSessionControlsProbeEnvironment<T>(
  params: ResolvePreflightSessionControlsProbeEnvironmentParams,
  run: (environment: Readonly<{ env: NodeJS.ProcessEnv }>) => Promise<T>,
): Promise<T> {
  const environment = await resolvePreflightSessionControlsProbeEnvironment(params);
  let succeeded = false;
  try {
    const result = await run({ env: environment.env });
    succeeded = true;
    return result;
  } finally {
    runCleanup(succeeded ? environment.cleanupOnExit : (environment.cleanupOnFailure ?? environment.cleanupOnExit));
  }
}
