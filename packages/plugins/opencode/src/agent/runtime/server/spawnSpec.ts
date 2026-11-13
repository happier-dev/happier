import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import { OPEN_CODE_REQUEST_AUTH_PROVIDERS } from '../../auth/services/purposes.js';
import { resolveOpenCodeRequestAuthPluginPath, resolveOpenCodeRequestAuthV2PluginDir, resolveOpenCodeRequestAuthV2PluginSourcePath } from '../../auth/services/requestAuth/assets.js';

import { OPENCODE_SERVER_PASSWORD_ENV_KEY } from './endpoint.js';
import { buildOpenCodePermissionEnv, resolveOpenCodePermissionConfig } from '../../permissions/policy.js';
import {
  OPENCODE_PROVIDER_OWNED_ENV_KEYS,
} from '../../providerBinding/adapter.js';
import {
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '../../auth/services/requestAuth/env.js';
import type { OpenCodeSystemToolId } from '../../systemTool.js';
import { OPEN_CODE_MANAGED_SERVER_STARTUP_TIMEOUT_MS } from './timeoutPolicy.js';
import { openCodeServerHealthPath, type OpenCodeServerDialect } from './dialect.js';
import {
  mergeOpenCodeConfigContent,
  readOpenCodeConfigPart,
  type OpenCodeConfigPart,
} from './opencodeConfigContent.js';

/**
 * The complete ambient environment an owned `opencode serve` child may inherit.
 * The host replaces rather than merges the child environment, so this list is
 * the whole inheritance.
 *
 * `XDG_DATA_HOME` and `OPENCODE_DB` are deliberately absent and must stay
 * absent: OpenCode resolves its data root as
 * `(XDG_DATA_HOME ?? os.homedir() + '/.local/share') + '/opencode'` and its
 * database as `<data root>/opencode.db`. Forwarding or synthesizing either key
 * — for instance toward plugin storage, by analogy with the managed Provider
 * filesystem roots — repoints the server at an empty database, and every read
 * silently returns zero sessions instead of the user's corpus.
 */
export const OPENCODE_CHILD_LAUNCH_ENV_KEYS = Object.freeze([
  ...OPENCODE_PROVIDER_OWNED_ENV_KEYS,
  'XDG_CONFIG_HOME',
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
] as const);

/**
 * Environment keys that would repoint the owned server away from the user's
 * OpenCode data root. Exported so the negative requirement is assertable rather
 * than only documented.
 */
export const OPENCODE_DATA_ROOT_OVERRIDE_ENV_KEYS = Object.freeze([
  'XDG_DATA_HOME',
  'OPENCODE_DB',
  'HOME',
] as const);

export function buildOpenCodeConfigLaunchEnvironment(
  env: Readonly<Record<string, string>> | undefined,
  configParts: readonly OpenCodeConfigPart[] = [],
): Readonly<Record<string, string>> {
  const { OPENCODE_CONFIG_CONTENT: baseContent, ...values } = env ?? {};
  const parts = [
    ...(baseContent === undefined ? [] : [readOpenCodeConfigPart(baseContent)]),
    ...configParts,
  ];
  return Object.freeze({
    ...values,
    ...(parts.length === 0 ? {} : { OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfigContent(parts) }),
  });
}

export function buildOpenCodeManagedLaunchEnvironment(
  env: Readonly<Record<string, string>> | undefined,
  permissionMode: string | null | undefined,
  configParts: readonly OpenCodeConfigPart[] = [],
  additionalEnv?: Readonly<Record<string, string>>,
  workspaceWrites?: 'allow' | 'deny',
): Readonly<Record<string, string>> {
  const { OPENCODE_CONFIG_CONTENT: additionalContent, ...additionalValues } = additionalEnv ?? {};
  const permissionEnv = buildOpenCodePermissionEnv(permissionMode, workspaceWrites);
  return buildOpenCodeConfigLaunchEnvironment({
    ...Object.fromEntries(OPENCODE_CHILD_LAUNCH_ENV_KEYS.flatMap((key) => (
      typeof env?.[key] === 'string' ? [[key, env[key]]] : []
    ))),
    ...permissionEnv,
    ...additionalValues,
    ...(workspaceWrites === 'deny' ? permissionEnv : {}),
  }, [
    ...configParts,
    ...(additionalContent === undefined ? [] : [readOpenCodeConfigPart(additionalContent)]),
    ...(workspaceWrites === 'deny' ? [{ permission: resolveOpenCodePermissionConfig(permissionMode, workspaceWrites) }] : []),
  ]);
}

/**
 * The one owned-`opencode serve` specification. It carries no Session identity
 * and no open request: a spawned server is a data-root-scoped process, so the
 * Session runtime and the External Sessions browse surface describe the same
 * process the same way and cannot drift apart.
 *
 * `dialect` and `healthPath` come from the same resolved executable decision.
 * Preview `opencode2` uses `/api/health`; released `opencode` 2.x uses
 * `/api/info`. Every caller — Session runtime and External Sessions browse —
 * uses the provider-owned `resolveOpenCodeManagedServerDialect` result.
 */
export function buildOpenCodeManagedServerSpawnSpec(params: Readonly<{
  id: string;
  dialect: OpenCodeServerDialect;
  healthPath?: string;
  systemToolId: OpenCodeSystemToolId;
  env?: Readonly<Record<string, string>>;
  permissionMode?: string | null;
  workspaceWrites?: 'allow' | 'deny';
  configParts?: readonly OpenCodeConfigPart[];
  additionalEnv?: Readonly<Record<string, string>>;
  durableLog?: boolean;
}>): ManagedServiceSpec {
  const env = buildOpenCodeManagedLaunchEnvironment(params.env, params.permissionMode,
    params.configParts, params.additionalEnv, params.workspaceWrites);
  const configHome = env.XDG_CONFIG_HOME;
  const plugins = env.OPENCODE_CONFIG_CONTENT === undefined ? undefined
    : readOpenCodeConfigPart(env.OPENCODE_CONFIG_CONTENT).plugins;
  // Materialization owns these generated plugin paths. Declare the source file
  // used by the selected native dialect; the native file owner alone admits it.
  const requiredFiles = configHome && Array.isArray(plugins)
    ? OPEN_CODE_REQUEST_AUTH_PROVIDERS.filter(provider => plugins.includes(resolveOpenCodeRequestAuthV2PluginDir(configHome, provider)))
      .map(provider => params.dialect === 'v1' ? resolveOpenCodeRequestAuthPluginPath(configHome, provider)
        : resolveOpenCodeRequestAuthV2PluginSourcePath(configHome, provider))
    : [];
  return {
    id: params.id,
    mode: {
      kind: 'spawn',
      launch: {
        executable: {
          kind: 'systemTool',
          id: params.systemToolId,
        },
        args: [
          'serve',
          '--hostname',
          '127.0.0.1',
        ],
        cwd: { root: 'workspace', relativePath: '' },
        env,
        requiredFiles,
      },
      endpoint: {
        kind: 'assignAndInject',
        host: '127.0.0.1',
        port: { kind: 'allocated' },
        inject: { argument: '--port' },
      },
    },
    healthCheck: {
      kind: 'http',
      target: {
        kind: 'servicePath',
        path: params.healthPath ?? openCodeServerHealthPath(params.dialect),
      },
      timeoutMs: 5_000,
    },
    clientAccess: {
      kind: 'hostBasic',
      // OpenCode's Basic-auth middleware defaults the username to `opencode`
      // and is enabled solely by the password environment variable, so the host
      // injects only the password and must not send a username variable.
      username: 'opencode',
      injectPasswordEnvironmentKey: OPENCODE_SERVER_PASSWORD_ENV_KEY,
    },
    healthPolicy: {
      intervalMs: 10_000,
      consecutiveFailures: 3,
    },
    startupTimeoutMs: OPEN_CODE_MANAGED_SERVER_STARTUP_TIMEOUT_MS,
    // Durable per-server log: tee post-spawn stdout/stderr to a secret-redacted log file for later
    // incident diagnosis. Handled generically by the host (shared with other managed-server
    // providers); the OpenCode plugin only opts in.
    ...(params.durableLog === false ? {} : { durableLog: { enabled: true } }),
  };
}
