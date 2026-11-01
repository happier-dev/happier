import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';
import type { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';

import { resolveNativeCatalogObservationContext } from './resolveNativeCatalogObservationContext';

describe('resolveNativeCatalogObservationContext', () => {
  it('qualifies the native request-auth use from the same Agent catalog declaration', () => {
    const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' } as const;
    const provider = ProviderContributionV1Schema.parse({
      v: 1,
      id: 'anthropic',
      name: 'Anthropic',
      kind: 'frontier',
      endpointTemplates: [{
        id: 'anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'supported',
          statefulResponses: 'unknown',
          reasoningControls: 'supported',
        },
      }],
      credential: {
        kind: 'apiKey',
        slotId: 'apiKey',
        required: true,
        transports: [{
          id: 'anthropic-x-api-key',
          protocols: ['anthropic'],
          uses: ['probe'],
          destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
        }],
      },
      catalog: {
        source: 'static',
        manualModelPolicy: 'allowed',
        staticModels: [{ id: 'claude-static', name: 'Claude static' }],
      },
    });
    const catalogEntry = {
      connectedAccountRequestAuthUses: [{
        purpose: 'model_upstream',
        materialization: {
          kind: 'httpHeaders' as const,
          origin: 'https://api.anthropic.com',
          headerNames: ['authorization'],
        },
      }],
    };
    const registry = {
      agentDefinitionsById: new Map([['claude', { identity: consumer, catalogEntry }]]),
      providersByContributionKey: new Map([[
        'happier.agent.claude/anthropic',
        { definition: provider },
      ]]),
    } as unknown as ReturnType<typeof getResolvedContributionRegistry>;

    expect(resolveNativeCatalogObservationContext({
      agentId: 'claude',
      observation: {
        providerLocalId: 'anthropic',
        purpose: 'model_upstream',
        connectedServiceId: 'claude-subscription',
      },
      registry,
    })).toMatchObject({
      consumer,
      purpose: { consumer, purpose: 'model_upstream' },
      requestAuthUse: {
        purpose: { consumer, purpose: 'model_upstream' },
        materialization: { origin: 'https://api.anthropic.com', headerNames: ['authorization'] },
      },
      provider,
      catalogEntry,
    });
  });
});
