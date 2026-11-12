import type { PreflightSessionControlsProbeParams } from './preflightSessionControlsProbeAdapterTypes';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import type { AgentModelConfig } from '@happier-dev/agents';

import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { createAllowedEnvKeySet, isAllowedEnvKey } from '@/utils/env/envKeyAllowlist';

export type PreflightSessionControlsProbeEnvironment = Readonly<{
  env: NodeJS.ProcessEnv;
}>;

type ResolvePreflightSessionControlsProbeEnvironmentParams = Readonly<{
  agentId?: CatalogAgentLookupId;
  registrySnapshot?: Readonly<{
    agentDefinitionsById: ReadonlyMap<string, Pick<ResolvedAgentContribution, 'runtimeSpec' | 'richDefinition' | 'catalogEntry'>>;
  }>;
  catalogEntry?: Pick<AgentCatalogEntry, 'connectedAccountNativeHome'> | null;
  modelConfig?: Pick<AgentModelConfig, 'nativeCatalogObservation'> | null;
  processEnv?: NodeJS.ProcessEnv;
  materializedEnv?: Readonly<Record<string, string>>;
  acquireEnvironment?: PreflightSessionControlsProbeParams['acquireEnvironment'];
}>;

const COLD_PROBE_PROCESS_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'USER',
  'LOGNAME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'NODE_ENV',
  'TSX_TSCONFIG_PATH',
  'HAPPIER_HOME_DIR',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
  'HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON',
] as const;

function buildBaseEnvironment(params: ResolvePreflightSessionControlsProbeEnvironmentParams): PreflightSessionControlsProbeEnvironment {
  const agent = params.agentId ? params.registrySnapshot?.agentDefinitionsById.get(params.agentId) : undefined;
  const runtime = agent?.runtimeSpec;
  const nativeHome = (params.catalogEntry === undefined ? agent?.catalogEntry : params.catalogEntry)?.connectedAccountNativeHome;
  const declaredEnvironment = agent?.richDefinition?.definition.ui?.behavior?.payload?.environmentVariables;
  const nativeEndpointEnvironmentKey = params.modelConfig?.nativeCatalogObservation?.nativeTarget?.endpointEnvironmentVariable;
  const allowedKeys = createAllowedEnvKeySet([
    ...COLD_PROBE_PROCESS_ENV_KEYS,
    ...(runtime ? [resolveAgentCliOverrideEnvKey(runtime.id)] : []),
    ...(runtime?.knownEnvironmentBinDirs?.map((directory) => directory.envVar) ?? []),
    ...(runtime?.alternativeBinaryFallbackEnabledEnvVar ? [runtime.alternativeBinaryFallbackEnabledEnvVar] : []),
    ...(nativeEndpointEnvironmentKey ? [nativeEndpointEnvironmentKey] : []),
    ...(nativeHome ? [nativeHome.environmentKey, ...(nativeHome.fallbackEnvironmentKeys ?? []),
      ...(nativeHome.sourceEnvironmentKey ? [nativeHome.sourceEnvironmentKey] : [])] : []),
    ...(declaredEnvironment ? [declaredEnvironment.backendMode.envKey,
      ...(declaredEnvironment.serverBaseUrl
        ? [declaredEnvironment.serverBaseUrl.envKey, declaredEnvironment.serverBaseUrl.explicitEnvKey] : [])] : []),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(params.processEnv ?? process.env)) {
    if (typeof value === 'string' && isAllowedEnvKey(key, allowedKeys)) {
      env[key] = value;
    }
  }
  return {
    env: {
      ...env,
      ...(params.materializedEnv ?? {}),
    },
  };
}

export async function resolvePreflightSessionControlsProbeEnvironment(
  params: ResolvePreflightSessionControlsProbeEnvironmentParams,
): Promise<PreflightSessionControlsProbeEnvironment> {
  // Ambient values are always cold-probe sanitized. The capability owner may add only explicit
  // output selected for this launch: the chosen profile/Saved Secrets and connected-account
  // materialization. Arbitrary ambient credentials never cross this boundary.
  return buildBaseEnvironment(params);
}

export async function withPreflightSessionControlsProbeEnvironment<T>(
  params: ResolvePreflightSessionControlsProbeEnvironmentParams,
  run: (environment: Readonly<{ env: NodeJS.ProcessEnv }> & Pick<PreflightSessionControlsProbeParams, 'acquireEnvironment'>) => Promise<T>,
): Promise<T> {
  const environment = await resolvePreflightSessionControlsProbeEnvironment(params);
  let requestedAcquisition: Promise<NodeJS.ProcessEnv> | undefined;
  const acquire = params.acquireEnvironment;
  const acquireEnvironment = acquire
    ? (signal?: AbortSignal) => requestedAcquisition = acquire(signal)
    : undefined;
  const result = await run({ env: environment.env, acquireEnvironment });
  // A plugin may recover from a native unavailable result. Requested Profile
  // preparation must settle before this can become a successful cache entry.
  if (requestedAcquisition) await requestedAcquisition;
  return result;
}
