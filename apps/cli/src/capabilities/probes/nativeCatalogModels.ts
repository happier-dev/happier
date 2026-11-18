import type { AgentModelConfig } from '@happier-dev/agents';
import type { AgentModelDescriptor, ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import { resolveModelStructuredOutputSupport } from '@happier-dev/protocol/models/descriptor';

/** Native catalog membership can use the Agent's publication contract; explicit model evidence wins. */
export function projectNativeModelStructuredOutputCapabilities<Model extends Pick<AgentModelDescriptor, 'id' | 'capabilities'>>(
  models: readonly Model[],
  agentFormats?: readonly string[] | null,
): Model[] {
  return models.map(model => {
    const support = resolveModelStructuredOutputSupport({ model, catalogModel: true, agentFormats });
    return support === 'unknown' && model.capabilities?.structuredOutput === undefined && model.id !== 'default'
      ? model
      : { ...model, capabilities: { ...model.capabilities, structuredOutput: support } };
  });
}

/** Project Provider membership into the native Agent's model catalog. */
export function projectNativeCatalogModels(
  models: readonly ProviderModelDescriptorV1[],
  modelConfig: AgentModelConfig | null,
  agentFormats?: readonly string[] | null,
): AgentModelDescriptor[] {
  const nativeWindows = new Map(modelConfig?.staticModels?.map(model => [model.id, model.contextWindowTokens]));
  return projectNativeModelStructuredOutputCapabilities([{ id: 'default', name: 'Default' }, ...models.filter(model => model.id !== 'default').map(model => {
    const nativeWindow = nativeWindows.get(model.id);
    // Provider observations establish membership and API facts, not a larger
    // native Agent window. Unknown native sizes keep the observed fact unchanged.
    return nativeWindow === undefined ? model : { ...model,
      contextWindowTokens: Math.min(nativeWindow, model.contextWindowTokens ?? nativeWindow) };
  })], agentFormats);
}
