import { describe, expect, it } from 'vitest';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '@happier-dev/plugins-cliproxyapi';
import { ProviderContributionV1Schema, resolveProviderManagedRuntimeFromContributionV1 } from '@happier-dev/protocol';
import { projectManagedProviderModelFacts } from './managedModelFacts';
import type { ProviderManagedCatalogSource } from './catalog';

// Exercise the real saved-gateway projection with its published family facts.
// /v1/models supplies membership and purpose, not capability declarations.
function gatewaySource(): ProviderManagedCatalogSource {
  const definition = ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION);
  if (!definition.managedRuntime) throw new Error('Expected managed gateway');
  const implementationIdentity = { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' };
  return {
    implementationIdentity,
    managedRuntime: resolveProviderManagedRuntimeFromContributionV1({ implementationIdentity, definition: { ...definition, managedRuntime: definition.managedRuntime } }),
    purposeBindings: { v: 1, bindings: [] }, endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses',
    sourceRegistryVersion: definition.catalog && 'sourceRegistryVersion' in definition.catalog
      ? definition.catalog.sourceRegistryVersion ?? '' : '', publicHeaders: {},
  };
}

describe('saved managed gateway model facts', () => {
  it('publishes verified Muse structured output with the offered reasoning controls', () => {
    const [model] = projectManagedProviderModelFacts(gatewaySource(), [{
      id: 'muse-spark-1.3-contributor', name: 'Muse contributor',
      connectedAccountPurposes: [{ consumer: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, purpose: 'meta-upstream' }],
    }]);
    expect(model?.capabilities).toEqual({
      structuredOutput: 'supported', toolRoundTrips: 'unknown', reasoningControls: 'supported',
    });
    const effort = model?.modelOptions?.find(option => option.id === 'reasoning_effort');
    expect(effort?.type === 'select' ? effort.options : undefined)
      .toEqual(expect.arrayContaining([expect.objectContaining({ value: 'minimal' })]));
  });

  it('leaves uncharacterized models and other upstream families without Muse schema support', () => {
    const purpose = (purpose: string) => [{ consumer: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, purpose }];
    const models = projectManagedProviderModelFacts(gatewaySource(), [
      { id: 'muse-spark-1.2', name: 'Other Muse model', connectedAccountPurposes: purpose('meta-upstream') },
      { id: 'uncharacterized-model', name: 'Unknown', connectedAccountPurposes: purpose('meta-upstream') },
      { id: 'muse-spark-1.3-contributor', name: 'Other upstream', connectedAccountPurposes: purpose('openai-upstream') },
    ]);
    expect(models.map(model => model.capabilities?.structuredOutput)).toEqual([undefined, undefined, undefined]);
  });
});
