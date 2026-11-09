import { definePlugin } from '@happier-dev/plugin-sdk';
import type { ProviderContribution } from '@happier-dev/plugin-sdk/providers';

// Public imports only: this is also the external-author example exercised by
// the Provider admission test. The host supplies the connection and secrets.
export const endpointPolicyProvider = {
  v: 1,
  id: 'gateway',
  name: 'Example Gateway',
  kind: 'aggregator',
  endpointTemplates: [{
    id: 'messages',
    protocol: 'anthropic',
    requiresEndpointOverride: true,
    addressConstraint: {
      origin: 'https://gateway.example',
      pathSegments: ['v1', null, null, 'anthropic'],
    },
    modelIdPattern: '^claude-[^/\\s]+$',
    publicHeaders: { 'x-collect-log': 'false' },
    requiredPublicHeaders: ['x-gateway-id'],
    publicHeaderHints: {
      'x-collect-log': { key: 'gateway.collectLog', fallback: 'Store request logs at the gateway.' },
      'x-gateway-id': 'Choose the gateway that receives this request.',
    },
    capabilities: {
      streaming: 'unknown', toolRoundTrips: 'unknown',
      statefulResponses: 'unknown', reasoningControls: 'unknown',
    },
  }],
  credential: {
    kind: 'apiKey', slotId: 'apiKey', required: true,
    authorityDescription: 'The gateway token can use every gateway in the selected vendor account.',
    transports: [{
      id: 'gateway-auth', protocols: ['anthropic'], uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'x-gateway-authorization', format: 'bearer' },
      additionalCredentials: [{
        slotId: 'anthropicApiKey', label: 'Anthropic API key',
        destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
      }],
    }],
  },
  catalog: { source: 'manual', manualModelPolicy: 'allowed' },
} satisfies ProviderContribution;

export const endpointPolicyPlugin = definePlugin({
  id: 'example.endpoint-policies',
  version: '0.1.0',
  entrypoints: { daemon: './daemon.js' },
  providers: { gateway: { declaration: endpointPolicyProvider } },
});
