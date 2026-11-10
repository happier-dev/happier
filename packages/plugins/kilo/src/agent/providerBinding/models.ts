import type { AgentAcpModelControls, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

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
  return kiloNativeUpstreamModelControls(binding.model.id, nativeModelId);
}

export function kiloNativeUpstreamModelControls(modelId: string, nativeModelId: string, restartRequired = false): AgentAcpModelControls {
  const projectId = (value: string) => value === nativeModelId ? modelId : value;
  return {
    // ACP's legacy models and configOptions paths meet at projectModelState;
    // translate that complete state once rather than depending on either parser.
    projectModel: (_raw, model) => model,
    projectModelState: ({ normalizedModelState }) => ({
      ...normalizedModelState, currentModelId: projectId(normalizedModelState.currentModelId),
      availableModels: normalizedModelState.availableModels.map(model => model.id === nativeModelId
        ? { ...model, id: modelId } : model),
    }),
    projectModelId: ({ modelId }) => projectId(modelId),
    resolveModelUpdate: ({ modelId: selectedModelId }) => {
      if (selectedModelId !== modelId && selectedModelId !== nativeModelId) {
        if (restartRequired) throw new PluginError({ code: 'plugin_kilo_connected_account_model_restart_required',
          message: 'Restart the Kilo session to use the selected Connected Account model.', details: { status: 'requires_restart' } });
        throw new Error('Kilo model selection does not match the Session Provider binding');
      }
      return { modelId: nativeModelId };
    },
  };
}
