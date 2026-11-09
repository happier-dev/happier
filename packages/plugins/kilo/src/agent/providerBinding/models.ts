import type { AgentAcpModelControls, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

export function kiloProviderModelControls(
  request: Pick<AgentSessionOpenRequest, 'providerBinding' | 'launchEnvironment'>,
): AgentAcpModelControls | undefined {
  const binding = request.providerBinding;
  if (!binding) return undefined;
  if (binding.materialization.kind !== 'spawnEnv') throw new Error('Kilo requires its Provider launch environment');
  const content = request.launchEnvironment?.values.KILO_CONFIG_CONTENT;
  const config: unknown = content ? JSON.parse(content) : null;
  if (!config || typeof config !== 'object' || !('model' in config)
    || typeof config.model !== 'string' || !config.model.endsWith(`/${binding.model.id}`)) {
    throw new Error('Kilo Provider launch configuration is missing its selected model');
  }
  const nativeModelId = config.model;
  const projectId = (modelId: string) => modelId === nativeModelId ? binding.model.id : modelId;
  return {
    // ACP's legacy models and configOptions paths meet at projectModelState;
    // translate that complete state once rather than depending on either parser.
    projectModel: (_raw, model) => model,
    projectModelState: ({ normalizedModelState }) => ({
      ...normalizedModelState, currentModelId: projectId(normalizedModelState.currentModelId),
      availableModels: normalizedModelState.availableModels.map(model => model.id === nativeModelId
        ? { ...model, id: binding.model.id } : model),
    }),
    projectModelId: ({ modelId }) => projectId(modelId),
    resolveModelUpdate: ({ modelId }) => {
      if (modelId !== binding.model.id && modelId !== nativeModelId) {
        throw new Error('Kilo model selection does not match the Session Provider binding');
      }
      return { modelId: nativeModelId };
    },
  };
}
