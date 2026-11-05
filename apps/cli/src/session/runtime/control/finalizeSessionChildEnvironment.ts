import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';
import { stripDaemonServiceInstallRequestEnv } from '@/utils/processEnv/stripDaemonServiceInstallRequestEnv';
import {
  isFinalChildTypedOrForcedControlEnvKey,
  isCanonicalSessionControlEnvKey,
  stripSessionControlEnvOverrides,
} from './sessionControlEnvironment';

// Session behavior, rather than Stack command routing or daemon configuration.
// Tool tracing is documented in docs/tool-normalization.md; rescue sessions
// retain their priority adjustment through applyStackSessionPriority.
const SESSION_STACK_ENV_KEYS = new Set([
  'HAPPIER_STACK_RESCUE',
  'HAPPIER_STACK_TOOL_TRACE',
  'HAPPIER_STACK_TOOL_TRACE_DIR',
  'HAPPIER_STACK_TOOL_TRACE_FILE',
]);

/**
 * Canonical final sanitation for processes launched beneath a Happier session.
 * Callers provide the two launch-mode-specific controls explicitly so regular,
 * Windows, tmux, ACP, and plugin execution cannot independently re-derive them.
 */
export function finalizeSessionChildEnvironment(params: Readonly<{
  environment: NodeJS.ProcessEnv;
  explicitEnvironment?: Readonly<NodeJS.ProcessEnv>;
  canonicalSessionControlEnvironment?: Readonly<Record<string, string | undefined>>;
  enableCgroupSelfMigration: boolean;
  stackProcessKind: 'session' | null;
}>): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv(
    stripDaemonServiceInstallRequestEnv(stripSessionControlEnvOverrides(params.environment)),
    params.explicitEnvironment,
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

  // Agent tools must resolve their own checkout, not inherit the launching
  // daemon's Stack. Apply after overlays so all session launch paths agree.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('HAPPIER_STACK_') && !SESSION_STACK_ENV_KEYS.has(key)) {
      delete env[key];
    }
  }

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
