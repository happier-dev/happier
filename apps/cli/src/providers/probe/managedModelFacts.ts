import type { ProviderCatalogProbeModelV1, ProviderModelDescriptorV1 } from '@happier-dev/protocol';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { ProviderManagedCatalogSource } from './catalog';

/** Model-list membership is observed; missing model facts belong to the declared upstream family. */
export function projectManagedProviderModelFacts(
  source: ProviderManagedCatalogSource,
  models: readonly ProviderCatalogProbeModelV1[],
): readonly ProviderCatalogProbeModelV1[] {
  const families = new Map(source.managedRuntime.connectedAccounts.map(family => [
    qualifiedPurposeKey({ consumer: source.implementationIdentity, purpose: family.purpose }),
    new Map((family.staticModels ?? []).map(model => [model.id, model])),
  ]));
  return models.map(model => {
    let declared: ProviderModelDescriptorV1 | undefined;
    for (const purpose of model.connectedAccountPurposes ?? []) {
      declared = families.get(qualifiedPurposeKey(purpose))?.get(model.id);
      if (declared) break;
    }
    if (!declared) return model;
    const options = new Map(declared.modelOptions?.map(option => [option.id, option]));
    for (const option of model.modelOptions ?? []) options.set(option.id, option);
    return {
      ...model,
      ...(model.contextWindowTokens === undefined && declared.contextWindowTokens !== undefined
        ? { contextWindowTokens: declared.contextWindowTokens } : {}),
      ...(declared.capabilities ? { capabilities: { ...declared.capabilities, ...model.capabilities } } : {}),
      ...(options.size ? { modelOptions: [...options.values()] } : {}),
    };
  });
}
