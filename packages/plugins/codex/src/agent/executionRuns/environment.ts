import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import { CODEX_ACP_TIMEOUT_ENV_KEYS } from '../acp/env.js';
import { CODEX_ACP_MANAGED_DEPENDENCY } from '../installables/definition.js';
import { CODEX_MCP_CONFIG_ENV_KEYS } from '../mcp/configServers.js';
import { CODEX_PROVIDER_OWNED_ENV_KEYS } from '../providerBinding/adapter.js';
import { CODEX_NATIVE_UPSTREAM_CONFIG_ENV } from '../providerBinding/runtimeConfig.js';
import { CODEX_APP_SERVER_MAX_JSON_LINE_CHARS_ENV_KEY } from '../runtime/appServer/client/framing.js';
import { CODEX_APP_SERVER_TIMEOUT_ENV_KEYS } from '../runtime/appServer/client/timeout.js';

export const CODEX_EXECUTION_RUN_PROCESS_ENV_KEYS = [
  'HAPPIER_CODEX_APP_SERVER_BIN',
  'HAPPIER_CODEX_TUI_BIN',
  'HAPPY_CODEX_TUI_BIN',
  'HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT',
  CODEX_APP_SERVER_TIMEOUT_ENV_KEYS.rpc,
  CODEX_APP_SERVER_TIMEOUT_ENV_KEYS.startup,
] as const;

// Without a launch overlay the native adapters still select auth, configuration
// and transport options. Child Exec owns the rest of the inherited environment.
const CODEX_NATIVE_INHERITED_ENV_KEYS = [
  ...CODEX_EXECUTION_RUN_PROCESS_ENV_KEYS,
  ...CODEX_MCP_CONFIG_ENV_KEYS,
  CODEX_APP_SERVER_TIMEOUT_ENV_KEYS.resumeRecovery,
  CODEX_APP_SERVER_MAX_JSON_LINE_CHARS_ENV_KEY,
  ...CODEX_PROVIDER_OWNED_ENV_KEYS,
  ...Object.values(CODEX_ACP_TIMEOUT_ENV_KEYS),
  CODEX_NATIVE_UPSTREAM_CONFIG_ENV,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV,
  CODEX_ACP_MANAGED_DEPENDENCY.sources[0].launch.overrideEnvironmentKey,
  CODEX_ACP_MANAGED_DEPENDENCY.sources[0].launch.configOverridesEnvironmentKey,
  'CODEX_SQLITE_HOME',
  'PATH',
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

export function buildCodexExecutionRunBaseEnv(args: Readonly<{
  processEnv?: Environment;
  exec?: Pick<ExecService, 'readEnvironment'>;
  isolationEnv?: Environment;
  unset?: readonly string[];
}>): Record<string, string | undefined> | undefined {
  if (args.processEnv === undefined && args.exec && !args.exec.readEnvironment) {
    throw new PluginError({ code: 'plugin_service_unavailable', message: 'Inherited Session environment is unavailable.' });
  }
  const processEnv = args.processEnv ?? args.exec?.readEnvironment?.(
    args.isolationEnv === undefined ? CODEX_NATIVE_INHERITED_ENV_KEYS : CODEX_EXECUTION_RUN_PROCESS_ENV_KEYS,
  ) ?? process.env;
  const inheritedEnv: Record<string, string | undefined> = args.isolationEnv === undefined ? { ...processEnv } : {};
  for (const key of CODEX_EXECUTION_RUN_PROCESS_ENV_KEYS) {
    const value = processEnv[key];
    if (typeof value === 'string' && value.length > 0) {
      inheritedEnv[key] = value;
    }
  }

  const environment = Object.keys(inheritedEnv).length === 0
    ? args.isolationEnv ?? {}
    : { ...inheritedEnv, ...args.isolationEnv };
  if (!args.unset?.length) return environment;
  const unset = new Set(args.unset.map(key => key.toUpperCase()));
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !unset.has(key.toUpperCase())));
}
