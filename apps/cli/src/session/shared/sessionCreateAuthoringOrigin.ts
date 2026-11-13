import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { PluginUiNewSessionSeedOriginV1Schema, type PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import { HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerEnvironment';
export { HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerEnvironment';

export function readSessionCreateAuthoringOriginFromEnv(env: NodeJS.ProcessEnv = sessionProcessEnvironment()): PluginUiNewSessionSeedOriginV1 | undefined {
  const raw = env[HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_ENV_KEY];
  delete env[HAPPIER_SESSION_CREATE_AUTHORING_ORIGIN_ENV_KEY];
  return raw === undefined ? undefined : PluginUiNewSessionSeedOriginV1Schema.parse(JSON.parse(raw));
}
