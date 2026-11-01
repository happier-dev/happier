import type { AgentModelConfig } from '@happier-dev/agents';
import type { AgentModelDescriptor, ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';

/** Project Provider membership into the native Agent's model catalog. */
export function projectNativeCatalogModels(
  models: readonly ProviderModelDescriptorV1[],
  modelConfig: AgentModelConfig | null,
): AgentModelDescriptor[] {
  const nativeWindows = new Map(modelConfig?.staticModels?.map(model => [model.id, model.contextWindowTokens]));
  return [{ id: 'default', name: 'Default' }, ...models.filter(model => model.id !== 'default').map(model => {
    const nativeWindow = nativeWindows.get(model.id);
    // Provider observations establish membership and API facts, not a larger
    // native Agent window. Unknown native sizes keep the observed fact unchanged.
    return nativeWindow === undefined ? model : { ...model,
      contextWindowTokens: Math.min(nativeWindow, model.contextWindowTokens ?? nativeWindow) };
  })];
}
