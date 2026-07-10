import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';
import {
  isFinalChildTypedOrForcedControlEnvKey,
  isCanonicalSessionControlEnvKey,
  stripSessionControlEnvOverrides,
} from './sessionControlEnvironment';

/**
 * Canonical final sanitation for processes launched beneath a Happier session.
 * Callers provide the two launch-mode-specific controls explicitly so regular,
 * Windows, tmux, ACP, and plugin execution cannot independently re-derive them.
 */
export function finalizeSessionChildEnvironment(params: Readonly<{
  environment: NodeJS.ProcessEnv;
  canonicalSessionControlEnvironment?: Readonly<Record<string, string | undefined>>;
  enableCgroupSelfMigration: boolean;
  stackProcessKind: 'session' | null;
}>): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv(
    stripSessionControlEnvOverrides(params.environment),
  );
  for (const [key, value] of Object.entries(params.canonicalSessionControlEnvironment ?? {})) {
    if (!isCanonicalSessionControlEnvKey(key) || isFinalChildTypedOrForcedControlEnvKey(key)) {
      throw new Error(`Invalid canonical session-control environment key: ${JSON.stringify(key)}`);
    }
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  delete env.HAPPIER_SESSION_AUTOSTART_DAEMON;
  if (params.enableCgroupSelfMigration) {
    env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP = '1';
  } else {
    delete env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP;
  }
  delete env.HAPPIER_DAEMON_RUNTIME_ID;
  delete env.HAPPIER_DAEMON_STARTUP_SOURCE;
  delete env.HAPPIER_DAEMON_TAKEOVER;

  if (params.stackProcessKind) {
    env.HAPPIER_STACK_PROCESS_KIND = params.stackProcessKind;
    if (String(env.HAPPIER_LOG_LEVEL ?? '').trim().length === 0) {
      env.HAPPIER_LOG_LEVEL = 'debug';
    }
  } else {
    delete env.HAPPIER_STACK_PROCESS_KIND;
  }
  return env;
}
