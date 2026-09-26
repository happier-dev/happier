import { STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS } from '@happier-dev/cli-common/firstPartyRuntime';

import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';
import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import {
  HAPPIER_RUNTIME_CONTEXT_ENV_KEYS,
  resolveHappierRuntimeContextEnv,
  type HappierRuntimeServerContext,
} from '@/utils/env/resolveHappierRuntimeContextEnv';
import { shouldUseSystemdUserSessionResourceGovernor } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { resolveStackProcessKindOverrideForSessionSpawn } from './resolveStackProcessKindOverrideForSessionSpawn';

type ChildServerSelectionEnv = HappierRuntimeServerContext;

const DAEMON_ONLY_ENV_KEYS = [
  'HAPPIER_DAEMON_EXECUTION_GENERATION_V1',
  'HAPPIER_SESSION_AUTOSTART_DAEMON',
  'HAPPIER_DAEMON_RUNTIME_ID',
  'HAPPIER_DAEMON_STARTUP_SOURCE',
  'HAPPIER_DAEMON_TAKEOVER',
] as const;

/** Keys the daemon decides for its children; launchers that inherit another env must pin them. */
export const DAEMON_DECIDED_CHILD_ENV_KEYS = [
  ...HAPPIER_RUNTIME_CONTEXT_ENV_KEYS,
  ...STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
  ...DAEMON_ONLY_ENV_KEYS,
] as const;

export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
  serverSelectionEnv?: ChildServerSelectionEnv;
}): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv({ ...params.processEnv, ...params.extraEnv });
  for (const key of DAEMON_ONLY_ENV_KEYS) delete env[key];
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
