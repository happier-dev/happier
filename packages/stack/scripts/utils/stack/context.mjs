import { getStackName, resolveStackEnvPath } from '../paths/paths.mjs';
import { getStackRuntimeStatePath } from './runtime_state.mjs';

export function resolveStackContext({ env = process.env, autostart = null } = {}) {
  const explicitStack = (env.HAPPY_STACKS_STACK ?? '').toString().trim();
  const stackName = explicitStack || (autostart?.stackName ?? '') || getStackName(env);
  const stackMode = Boolean(explicitStack);

  const envPath =
    (env.HAPPY_STACKS_ENV_FILE ?? '').toString().trim() || resolveStackEnvPath(stackName, env).envPath;

  const runtimeStatePath =
    (env.HAPPY_STACKS_RUNTIME_STATE_PATH ?? '').toString().trim() || getStackRuntimeStatePath(stackName);

  const explicitEphemeral = (env.HAPPY_STACKS_EPHEMERAL_PORTS ?? '').toString().trim() === '1';
  const ephemeral = explicitEphemeral || (stackMode && stackName !== 'main');

  return { stackMode, stackName, envPath, runtimeStatePath, ephemeral };
}
