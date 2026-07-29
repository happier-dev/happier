import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { resolveStackProcessKindOverrideForSessionSpawn } from './resolveStackProcessKindOverrideForSessionSpawn';
import {
  selectTrustedSessionControlEnvironment,
  stripSessionControlEnvOverrides,
} from '@/session/runtime/control/sessionControlEnvironment';
import { finalizeSessionChildEnvironment } from '@/session/runtime/control/finalizeSessionChildEnvironment';
export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
  unsetEnvKeys?: readonly string[];
}): NodeJS.ProcessEnv {
  const env = buildScopedProcessEnv({
    baseEnv: stripSessionControlEnvOverrides(params.processEnv),
    explicitEnv: params.extraEnv,
    unsetEnvKeys: params.unsetEnvKeys,
  });
  // Older daemons stamped children with their process incarnation. A surviving
  // runner is authorized by current session/account truth, never by its launcher.
  delete env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1;

  const stackProcessKindOverride = resolveStackProcessKindOverrideForSessionSpawn(params.processEnv);
  return finalizeSessionChildEnvironment({
    environment: env,
    canonicalSessionControlEnvironment: selectTrustedSessionControlEnvironment(params.extraEnv),
    enableCgroupSelfMigration:
      String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() === 'background-service',
    stackProcessKind:
      stackProcessKindOverride.HAPPIER_STACK_PROCESS_KIND === 'session' ? 'session' : null,
  });
}
