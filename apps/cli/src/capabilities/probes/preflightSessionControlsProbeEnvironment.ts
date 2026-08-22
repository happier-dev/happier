import { legacyCustomAcpCompat } from '@happier-dev/agents';

import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { createAllowedEnvKeySet, isAllowedEnvKey } from '@/utils/env/envKeyAllowlist';

export type PreflightSessionControlsProbeEnvironment = Readonly<{
  env: NodeJS.ProcessEnv;
}>;

type ResolvePreflightSessionControlsProbeEnvironmentParams = Readonly<{
  agentId?: CatalogAgentLookupId;
  processEnv?: NodeJS.ProcessEnv;
  materializedEnv?: Readonly<Record<string, string>>;
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
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'HAPPIER_CLAUDE_CONFIG_DIR',
  'HAPPIER_HOME_DIR',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
  'HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON',
  'HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED',
] as const;

function resolveAgentCliPathOverrideEnvironmentKey(agentId: string | undefined): string | null {
  // Only the canonical Agent lookup set has an agent-specific CLI override contract.
  // Treat raw/unrecognized input as having no override rather than normalizing it into an env key.
  if (!legacyCustomAcpCompat.isAgentLookupId(agentId)) return null;
  const normalized = String(agentId ?? '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized ? `HAPPIER_${normalized}_PATH` : null;
}

function buildBaseEnvironment(params: ResolvePreflightSessionControlsProbeEnvironmentParams): PreflightSessionControlsProbeEnvironment {
  const agentCliPathOverrideEnvironmentKey = resolveAgentCliPathOverrideEnvironmentKey(params.agentId);
  const allowedKeys = createAllowedEnvKeySet([
    ...COLD_PROBE_PROCESS_ENV_KEYS,
    ...(agentCliPathOverrideEnvironmentKey ? [agentCliPathOverrideEnvironmentKey] : []),
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
  // Ambient values are always cold-probe sanitized. A caller may add only the explicit output of
  // the selected Agent plugin's connected-account materializer after that boundary.
  return buildBaseEnvironment(params);
}

export async function withPreflightSessionControlsProbeEnvironment<T>(
  params: ResolvePreflightSessionControlsProbeEnvironmentParams,
  run: (environment: Readonly<{ env: NodeJS.ProcessEnv }>) => Promise<T>,
): Promise<T> {
  const environment = await resolvePreflightSessionControlsProbeEnvironment(params);
  return await run({ env: environment.env });
}
