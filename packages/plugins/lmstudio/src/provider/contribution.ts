import type { ProviderContributionV1 } from '@happier-dev/plugin-sdk/experimental/providers';

const LMSTUDIO_LOCAL_ORIGINS = [
  'http://127.0.0.1:1234',
  'http://localhost:1234',
] satisfies string[];

const LMSTUDIO_OPENAI_BASE_URLS = LMSTUDIO_LOCAL_ORIGINS.map((origin) => `${origin}/v1`);

export const LMSTUDIO_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'lmstudio',
  name: 'LM Studio',
  websiteUrl: 'https://lmstudio.ai',
  kind: 'local',
  endpointTemplates: [
    {
      id: 'lmstudio-openai-responses',
      protocol: 'openai-responses',
      localUrlCandidates: LMSTUDIO_OPENAI_BASE_URLS,
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'supported',
        reasoningControls: 'supported',
      },
    },
    {
      id: 'lmstudio-openai-chat',
      protocol: 'openai-chat',
      localUrlCandidates: LMSTUDIO_OPENAI_BASE_URLS,
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    },
    {
      id: 'lmstudio-anthropic',
      protocol: 'anthropic',
      localUrlCandidates: LMSTUDIO_LOCAL_ORIGINS,
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'supported',
      },
    },
  ],
  credential: {
    kind: 'apiKey',
    slotId: 'apiKey',
    required: false,
    keyUrl: 'https://lmstudio.ai/docs/app/api/tools/auth',
    transports: [{
      id: 'lmstudio-http-bearer',
      protocols: ['openai-chat', 'openai-responses', 'anthropic'],
      uses: ['probe', 'runtime', 'management'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'probe',
    manualModelPolicy: 'allowed',
    probes: [
      { endpointTemplateId: 'lmstudio-openai-responses', path: '/api/v1/models', parser: 'lmstudio-native-models' },
      { endpointTemplateId: 'lmstudio-openai-responses', path: '/v1/models', parser: 'openai-models' },
    ],
  },
  modelLoad: {
    endpointTemplateId: 'lmstudio-openai-responses',
    path: '/api/v1/models/load',
    request: 'json-model-id-v1',
    confirmation: 'refresh-catalog-load-state',
    preflightPolicy: 'advisory',
  },
  discovery: {
    v: 1,
    listener: { executableBasenames: ['llmster'], defaultPorts: [1234] },
    availabilityProbe: {
      endpointTemplateId: 'lmstudio-openai-responses',
      path: '/api/v1/models',
      parser: 'lmstudio-native-models',
    },
    installedCheck: { lookupNames: ['lms'] },
    presenceCheck: {
      lookupNames: ['lms'],
      fixedArgs: ['daemon', 'status', '--json'],
      parser: 'lms-status-json',
    },
  },
} satisfies ProviderContributionV1;
