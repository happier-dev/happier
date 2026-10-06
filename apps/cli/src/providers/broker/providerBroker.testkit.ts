import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ProviderContributionRegistryView } from '@/providers/registry';

/** Declared gateway fixture: the real registry/projection owners are exercised. */
export function createBrokerProviderRegistry(): ProviderContributionRegistryView {
  const identity = { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' };
  const endpointTemplates = [
    { id: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
    { id: 'cliproxyapi-openai-chat', protocol: 'openai-chat' },
    { id: 'cliproxyapi-anthropic', protocol: 'anthropic' },
  ];
  const definition = ProviderContributionV1Schema.parse({
    v: 1, id: identity.localId, name: 'Managed gateway', kind: 'aggregator',
    endpointTemplates: endpointTemplates.map((endpoint) => ({
      ...endpoint, baseUrl: 'http://127.0.0.1:8317/v1',
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'supported' },
    })),
    catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    managedRuntime: {
      kind: 'managed', endpointTemplateIds: endpointTemplates.map((endpoint) => endpoint.id),
      connectedAccounts: [
        { purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          title: { key: 'managedPurpose.openai.title', fallback: 'Use OpenAI upstream account' }, required: false,
          materializationKinds: ['httpHeaders'], endpointTemplateIds: endpointTemplates.slice(0, 2).map((endpoint) => endpoint.id) },
        { purpose: 'anthropic-upstream', service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
          materializationKinds: ['httpHeaders'], endpointTemplateIds: ['cliproxyapi-anthropic'] },
      ],
    },
  });
  const provider: ResolvedProviderContribution = {
    identity, pluginId: identity.pluginId, definition, provenance: 'external', source: { kind: 'path' },
  };
  return { providersByContributionKey: new Map([[`${identity.pluginId}/${identity.localId}`, provider]]) };
}
