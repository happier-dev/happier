import type { ProviderContributionV1 } from '@happier-dev/plugin-sdk/experimental/providers';

export const OPENROUTER_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'openrouter',
  name: 'OpenRouter',
  websiteUrl: 'https://openrouter.ai',
  kind: 'aggregator',
  endpointTemplates: [
    {
      id: 'openrouter-openai-chat',
      protocol: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unsupported',
        reasoningControls: 'supported',
      },
    },
    {
      id: 'openrouter-openai-responses',
      protocol: 'openai-responses',
      baseUrl: 'https://openrouter.ai/api/v1',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unsupported',
        reasoningControls: 'supported',
      },
    },
  ],
  credential: {
    kind: 'apiKey',
    slotId: 'apiKey',
    required: true,
    keyUrl: 'https://openrouter.ai/keys',
    transports: [{
      id: 'openrouter-http-bearer',
      protocols: ['openai-chat', 'openai-responses'],
      uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'probe',
    manualModelPolicy: 'allowed',
    probes: [{ endpointTemplateId: 'openrouter-openai-responses', path: '/api/v1/models', parser: 'openai-models' }],
  },
} satisfies ProviderContributionV1;
