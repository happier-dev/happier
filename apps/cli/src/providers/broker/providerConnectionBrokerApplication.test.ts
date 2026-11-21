import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/plugin-sdk/providers';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/cliproxyapi/src/provider/contribution';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { projectProviderConnectionBrokerApplication, readProviderConnectionBrokerImplementation } from './providerConnectionBrokerApplication';

function declaredBroker(pluginId: string, transport: boolean, localId = 'gateway'): ResolvedProviderContribution {
  const definition = ProviderContributionV1Schema.parse({
    ...CLIPROXYAPI_PROVIDER_CONTRIBUTION,
    id: localId,
    managedRuntime: {
      ...CLIPROXYAPI_PROVIDER_CONTRIBUTION.managedRuntime,
      ...(transport ? { sourceEnvelopeTransport: 'cpx-v1' } : { sourceEnvelopeTransport: undefined }),
    },
  });
  return { identity: { pluginId, localId: definition.id }, pluginId, definition,
    provenance: 'external', source: { kind: 'path' } };
}

const application = {
  agentTargetKey: 'agent:happier.agent.codex/codex',
  implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
  endpointTemplateId: 'cliproxyapi-openai-responses',
  protocol: 'openai-responses' as const,
};
describe('Provider Connection broker application', () => {
  it('admits the bundled producer through its declared private source transport', () => {
    const definition = ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION);
    const provider: ResolvedProviderContribution = {
      identity: application.implementationIdentity, pluginId: application.implementationIdentity.pluginId,
      definition, provenance: 'first_party', source: { kind: 'bundled' },
    };
    const registry = { providersByContributionKey: new Map([
      [`${provider.pluginId}/${provider.identity.localId}`, provider],
    ]) };
    expect(readProviderConnectionBrokerImplementation(registry)?.definition.managedRuntime?.sourceEnvelopeTransport).toBe('cpx-v1');
    expect(projectProviderConnectionBrokerApplication({ registry, agentTargetKey: application.agentTargetKey,
      protocol: application.protocol, expectedApplication: application })).toEqual(application);
  });

  it('admits an exact declared implementation without scanning unrelated Providers per request', () => {
    let enumerations = 0;
    class ProviderMap extends Map<string, ResolvedProviderContribution> {
      override values() {
        enumerations += 1;
        return super.values();
      }
    }
    const providers = new ProviderMap();
    for (let index = 0; index < 100; index += 1) {
      const provider = declaredBroker(`acme.broker-${index}`, true);
      providers.set(`${provider.pluginId}/${provider.identity.localId}`, provider);
    }
    const selected = providers.get('acme.broker-42/gateway')!;
    const registry = { providersByContributionKey: providers };
    const expectedApplication = { ...application, implementationIdentity: selected.identity };
    for (let request = 0; request < 100; request += 1) {
      expect(projectProviderConnectionBrokerApplication({ registry, agentTargetKey: application.agentTargetKey,
        protocol: application.protocol, expectedApplication })).toEqual(expectedApplication);
    }
    expect(enumerations).toBe(0);
    const undeclared = declaredBroker('acme.no-transport', false);
    providers.set(`${undeclared.pluginId}/${undeclared.identity.localId}`, undeclared);
    expect(projectProviderConnectionBrokerApplication({ registry, agentTargetKey: application.agentTargetKey,
      protocol: application.protocol, expectedApplication: { ...application, implementationIdentity: undeclared.identity } })).toBeNull();
  });

  it('selects an external declaration of the private source transport and refuses absent or ambiguous implementations', () => {
    const external = declaredBroker('acme.source-broker', true);
    const ordinary = declaredBroker('happier.provider.cliproxyapi', false, 'cliproxyapi');
    const registry = { providersByContributionKey: new Map([
      [`${ordinary.pluginId}/${ordinary.identity.localId}`, ordinary],
      [`${external.pluginId}/${external.identity.localId}`, external],
    ]) };
    expect(readProviderConnectionBrokerImplementation(registry)).toBe(external);
    expect(projectProviderConnectionBrokerApplication({ registry,
      agentTargetKey: application.agentTargetKey, protocol: application.protocol }))
      .toMatchObject({ implementationIdentity: external.identity });
    expect(readProviderConnectionBrokerImplementation({ providersByContributionKey: new Map([
      [`${ordinary.pluginId}/${ordinary.identity.localId}`, ordinary],
    ]) })).toBeNull();
    const second = declaredBroker('acme.other-broker', true);
    registry.providersByContributionKey.set(`${second.pluginId}/${second.identity.localId}`, second);
    expect(readProviderConnectionBrokerImplementation(registry)).toBeNull();
    expect(projectProviderConnectionBrokerApplication({ registry,
      agentTargetKey: application.agentTargetKey, protocol: application.protocol })).toBeNull();
  });
});
