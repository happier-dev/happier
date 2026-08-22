import {
  SESSION_MACHINE_WORKSPACE_PATH_ENV,
  SESSION_REQUESTED_DIRECTORY_ENV,
} from '@/agent/runtime/resolveRequestedSessionDirectory';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from '@/agent/runtime/sessionConnectedServicesBindingsEnv';
import { HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY } from '@/agent/runtime/sessionConnectedServiceMaterializationIdentityEnv';
import {
  HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import {
  HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY } from '@/plugins/runtime/providerBindings/handoff';

/** Daemon-issued, one-shot correlation for a terminal startup result. */
export const HAPPIER_SESSION_STARTUP_SPAWN_NONCE_ENV_KEY =
  'HAPPIER_SESSION_STARTUP_SPAWN_NONCE';

/**
 * Exact environment keys whose values are owned by Happier's session-launch
 * pipeline. Profile, provider, and plugin overlays must never write or unset
 * these keys. Keep this list exact: user-defined HAPPIER_* variables are not
 * implicitly privileged.
 */
export const SYSTEM_SESSION_CONTROL_ENV_KEYS = Object.freeze([
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_SERVER_URL',
  'HAPPIER_SESSION_PROFILE_ID',
  'HAPPIER_TRANSCRIPT_STORAGE',
  'HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY',
  'HAPPIER_SESSION_MCP_SELECTION_JSON',
  'HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON',
  HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY,
  HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY,
  HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
  SESSION_REQUESTED_DIRECTORY_ENV,
  SESSION_MACHINE_WORKSPACE_PATH_ENV,
  HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR,
  'HAPPIER_SESSION_ATTACH_FILE',
  'HAPPIER_STACK_PROCESS_KIND',
  HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY,
  HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  HAPPIER_SESSION_STARTUP_SPAWN_NONCE_ENV_KEY,
  'TMUX_SESSION_NAME',
  'TMUX_TMPDIR',
] as const);

export const CONNECTED_SERVICE_MATERIALIZER_CONTROL_ENV_KEYS = Object.freeze([
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
] as const);

export const SESSION_CONTROL_ENV_KEYS = Object.freeze([
  ...SYSTEM_SESSION_CONTROL_ENV_KEYS,
  ...CONNECTED_SERVICE_MATERIALIZER_CONTROL_ENV_KEYS,
] as const);

const SYSTEM_SESSION_CONTROL_ENV_KEY_SET = new Set<string>(SYSTEM_SESSION_CONTROL_ENV_KEYS);
const SESSION_CONTROL_ENV_KEY_SET = new Set<string>(SESSION_CONTROL_ENV_KEYS);
const FINAL_CHILD_TYPED_OR_FORCED_CONTROL_ENV_KEY_SET = new Set<string>([
  'HAPPIER_STACK_PROCESS_KIND',
  'TMUX_SESSION_NAME',
  'TMUX_TMPDIR',
]);

export function isSessionControlEnvKey(key: string): boolean {
  return SESSION_CONTROL_ENV_KEY_SET.has(key.toUpperCase());
}

export function isCanonicalSessionControlEnvKey(key: string): boolean {
  return SESSION_CONTROL_ENV_KEY_SET.has(key) && key === key.toUpperCase();
}

export function stripSessionControlEnvOverrides<T extends string | undefined>(
  input: Readonly<Record<string, T>>,
  options: Readonly<{ allowConnectedServiceMaterializerKeys?: boolean }> = {},
): Record<string, T> {
  const output: Record<string, T> = Object.create(null);
  const blockedKeys = options.allowConnectedServiceMaterializerKeys
    ? SYSTEM_SESSION_CONTROL_ENV_KEY_SET
    : SESSION_CONTROL_ENV_KEY_SET;
  for (const [key, value] of Object.entries(input) as Array<[string, T]>) {
    if (!blockedKeys.has(key.toUpperCase())) {
      output[key] = value;
    }
  }
  return output;
}

export function stripSessionControlUnsetEnvKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !isSessionControlEnvKey(key));
}

/**
 * Selects the exact session controls emitted by a trusted launch owner. Values
 * with dedicated typed finalizer inputs, and controls that must stay absent,
 * are deliberately excluded here.
 */
export function selectTrustedSessionControlEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = Object.create(null);
  for (const key of SESSION_CONTROL_ENV_KEYS) {
    if (FINAL_CHILD_TYPED_OR_FORCED_CONTROL_ENV_KEY_SET.has(key)) continue;
    const value = input[key];
    if (typeof value === 'string') {
      output[key] = value;
    }
  }
  return Object.freeze(output);
}

export function isFinalChildTypedOrForcedControlEnvKey(key: string): boolean {
  return FINAL_CHILD_TYPED_OR_FORCED_CONTROL_ENV_KEY_SET.has(key);
}

/**
 * Returns control keys which must be explicitly absent from a final launch.
 * This prevents inherited daemon/tmux-server state from supplying a value when
 * the canonical launch owner intentionally omitted that control.
 */
export function resolveAbsentSessionControlEnvKeys(
  explicitEnvironment: Readonly<Record<string, string | undefined>>,
): string[] {
  const explicitNames = new Set(
    Object.entries(explicitEnvironment)
      .filter(([, value]) => typeof value === 'string')
      .map(([key]) => key.toUpperCase()),
  );
  return SESSION_CONTROL_ENV_KEYS.filter((key) => !explicitNames.has(key));
}

/**
 * Returns the daemon-issued nonce accepted by the canonical spawn ingress.
 * Whitespace-only ambient values are absent, never an alternate attempt.
 */
export function readSessionStartupSpawnNonceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = typeof env[HAPPIER_SESSION_STARTUP_SPAWN_NONCE_ENV_KEY] === 'string'
    ? env[HAPPIER_SESSION_STARTUP_SPAWN_NONCE_ENV_KEY]!.trim()
    : '';
  return value || null;
}
