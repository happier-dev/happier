import type { ProviderContributionV1 } from '@happier-dev/plugin-sdk/experimental/providers';

const CLIPROXYAPI_LOCAL_ORIGINS = [
  'http://127.0.0.1:8317',
  'http://localhost:8317',
] satisfies string[];

const CLIPROXYAPI_OPENAI_BASE_URLS = CLIPROXYAPI_LOCAL_ORIGINS.map((origin) => `${origin}/v1`);

export const CLIPROXYAPI_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'cliproxyapi',
  name: 'CLIProxyAPI',
  websiteUrl: 'https://github.com/router-for-me/CLIProxyAPI',
  kind: 'aggregator',
  endpointTemplates: [
    {
      id: 'cliproxyapi-openai-responses',
      protocol: 'openai-responses',
      localUrlCandidates: CLIPROXYAPI_OPENAI_BASE_URLS,
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'supported',
      },
    },
    {
      id: 'cliproxyapi-openai-chat',
      protocol: 'openai-chat',
      localUrlCandidates: CLIPROXYAPI_OPENAI_BASE_URLS,
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    },
    {
      id: 'cliproxyapi-anthropic',
      protocol: 'anthropic',
      localUrlCandidates: CLIPROXYAPI_LOCAL_ORIGINS,
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
    transports: [{
      id: 'cliproxyapi-http-bearer',
      protocols: ['openai-chat', 'openai-responses', 'anthropic'],
      uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'probe',
    manualModelPolicy: 'allowed',
    probes: [{
      endpointTemplateId: 'cliproxyapi-openai-responses',
      path: '/v1/models',
      parser: 'openai-models',
    }],
  },
  discovery: {
    v: 1,
    listener: {
      executableBasenames: ['CLIProxyAPI', 'CLIProxyAPI.exe', 'cli-proxy-api', 'cli-proxy-api.exe'],
      defaultPorts: [8317],
    },
    availabilityProbe: {
      endpointTemplateId: 'cliproxyapi-openai-responses',
      path: '/v1/models',
      parser: 'openai-models',
    },
  },
} satisfies ProviderContributionV1;
