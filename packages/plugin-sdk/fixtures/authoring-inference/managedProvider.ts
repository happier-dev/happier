import { definePlugin } from '../../src/definePlugin.js';
import type { ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';

export const managedProviderRuntime: ManagedProviderRuntime = Object.freeze({
  async start() {
    throw new Error('Fixture does not start the managed Provider');
  },
});

export const {
  manifest: managedProviderManifest,
  activate: managedProviderActivate,
} = definePlugin({
  id: 'example.inference.managed-provider',
  version: '0.1.0',
  providers: {
    gateway: {
      declaration: {
        v: 1,
        name: 'Managed Provider',
        kind: 'aggregator',
        endpointTemplates: [{
          id: 'responses',
          protocol: 'openai-responses',
          baseUrl: 'https://models.example.com/v1',
          capabilities: {
            streaming: 'supported',
            toolRoundTrips: 'unknown',
            statefulResponses: 'unknown',
            reasoningControls: 'unknown',
          },
        }],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        managedRuntime: {
          kind: 'managed',
          endpointTemplateIds: ['responses'],
        },
      },
      runtime: managedProviderRuntime,
    },
  },
});
