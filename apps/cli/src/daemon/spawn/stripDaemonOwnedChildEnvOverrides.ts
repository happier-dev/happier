import { SESSION_MACHINE_WORKSPACE_PATH_ENV } from '@/agent/runtime/sessionWorkspaceLocation';
import { MACHINE_SESSION_FORWARD_ENV_KEY } from './selectMachineSessionEnvironment';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from './spawnExplicitEnvKeysMarker';

const DAEMON_OWNED_CHILD_ENV_KEYS = new Set<string>([
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_SERVER_URL',
  MACHINE_SESSION_FORWARD_ENV_KEY,
  HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR,
  SESSION_MACHINE_WORKSPACE_PATH_ENV,
]);

export function stripDaemonOwnedChildEnvOverrides(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (DAEMON_OWNED_CHILD_ENV_KEYS.has(key.toUpperCase())) continue;
    out[key] = value;
  }
  return out;
}
