import { getStackName, resolveStackBaseDir } from '../../utils/paths/paths.mjs';
import { resolveStackRuntimeMode } from '../shared/runtime_mode.mjs';
import { resolveActiveRuntimeSnapshot } from './resolveActiveRuntimeSnapshot.mjs';

export async function resolveStackRuntimeLaunchContext({ argv = [], env = process.env, activeRuntimeState = null } = {}) {
  const stackName = (env.HAPPIER_STACK_STACK ?? '').toString().trim() || getStackName(env);
  const { baseDir: stackBaseDir } = resolveStackBaseDir(stackName, env);
  const runtimeMode = resolveStackRuntimeMode({ argv, env, activeRuntimeState });
  const snapshot = await resolveActiveRuntimeSnapshot({ mode: runtimeMode.mode, stackBaseDir });

  return {
    stackName,
    stackBaseDir,
    runtimeMode,
    snapshot,
  };
}
