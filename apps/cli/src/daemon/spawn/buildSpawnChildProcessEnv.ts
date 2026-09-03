import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';
import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import {
  resolveHappierRuntimeContextEnv,
  type HappierRuntimeServerContext,
} from '@/utils/env/resolveHappierRuntimeContextEnv';
import { shouldUseSystemdUserSessionResourceGovernor } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { resolveStackProcessKindOverrideForSessionSpawn } from './resolveStackProcessKindOverrideForSessionSpawn';

type ChildServerSelectionEnv = HappierRuntimeServerContext;

export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
  serverSelectionEnv?: ChildServerSelectionEnv;
}): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv({ ...params.processEnv, ...params.extraEnv });
  delete env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1;
  delete env.HAPPIER_SESSION_AUTOSTART_DAEMON;
  const stackProcessKindOverride = resolveStackProcessKindOverrideForSessionSpawn(env);

  // Stack-spawned session runners are headless: their file log is the ONLY forensic artifact
  // (session-exit records reference it and crashed-log retention preserves it). Product session
  // processes retain the logger's default 'info' level; stack context keeps runner forensics.
  // Explicit operator overrides always win.
  if (
    String(env.HAPPIER_LOG_LEVEL ?? '').trim().length === 0 &&
    stackProcessKindOverride.HAPPIER_STACK_PROCESS_KIND === 'session'
  ) {
    env.HAPPIER_LOG_LEVEL = 'debug';
  }

  if (shouldUseSystemdUserSessionResourceGovernor({
    platform: process.platform,
    startupSource: String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim(),
  })) {
    env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY] = '1';
  } else {
    delete env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY];
  }
  delete env.HAPPIER_DAEMON_RUNTIME_ID;
  delete env.HAPPIER_DAEMON_STARTUP_SOURCE;
  delete env.HAPPIER_DAEMON_TAKEOVER;

  delete env.HAPPIER_STACK_PROCESS_KIND;
  Object.assign(env, stackProcessKindOverride);

  if (params.serverSelectionEnv) {
    // Clear any stale inherited split URLs, then apply the authoritative selection
    // via the shared runtime-context resolver (single source of truth shared with
    // the coding-agent spawn seam). For a non-split stack the resolver omits the
    // local/public URLs, so they must be cleared here first.
    delete env.HAPPIER_PUBLIC_SERVER_URL;
    delete env.HAPPIER_LOCAL_SERVER_URL;
    Object.assign(env, resolveHappierRuntimeContextEnv({
      // Older stack daemons used the stable active-server id for both credentials and daemon
      // lifecycle. Promote that already-resolved daemon selection for children when the explicit
      // lifecycle variable is absent; current daemons keep the two scopes independent.
      daemonLifecycleScopeId:
        String(params.processEnv.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? '').trim()
        || params.serverSelectionEnv.activeServerId,
      server: params.serverSelectionEnv,
    }));
  }

  return env;
}
