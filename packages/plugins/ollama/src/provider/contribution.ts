import type { ProviderContribution as ProviderContributionV1 } from '@happier-dev/plugin-sdk/providers';

const OLLAMA_LOCAL_ORIGINS = [
  'http://127.0.0.1:11434',
  'http://localhost:11434',
] satisfies string[];

const OLLAMA_OPENAI_BASE_URLS = OLLAMA_LOCAL_ORIGINS.map((origin) => `${origin}/v1`);

// The managed catalog projects Ollama's `/api/tags` response through the
// bundled `ollama-tags` parser. Change this semantic identity only when that
// source/projection contract can produce different model rows.
const OLLAMA_CATALOG_SOURCE_REGISTRY_VERSION = 'ollama-tags/v1';

export const OLLAMA_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'ollama',
  name: 'Ollama',
  websiteUrl: 'https://ollama.com',
  kind: 'local',
  endpointTemplates: [
    {
      id: 'ollama-native',
      protocol: 'ollama-native',
      localUrlCandidates: OLLAMA_LOCAL_ORIGINS,
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unsupported',
        reasoningControls: 'supported',
      },
    },
    {
      id: 'ollama-openai-chat',
      protocol: 'openai-chat',
      localUrlCandidates: OLLAMA_OPENAI_BASE_URLS,
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unsupported',
        reasoningControls: 'supported',
      },
    },
    {
      id: 'ollama-openai-responses',
      protocol: 'openai-responses',
      localUrlCandidates: OLLAMA_OPENAI_BASE_URLS,
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unsupported',
        reasoningControls: 'supported',
      },
    },
  ],
  catalog: {
    source: 'probe',
    manualModelPolicy: 'allowed',
    sourceRegistryVersion: OLLAMA_CATALOG_SOURCE_REGISTRY_VERSION,
    probes: [{ endpointTemplateId: 'ollama-native', path: '/api/tags', parser: 'ollama-tags' }],
  },
  managedRuntime: {
    kind: 'managed',
    endpointTemplateIds: [
      'ollama-native',
      'ollama-openai-chat',
      'ollama-openai-responses',
    ],
  },
  discovery: {
    v: 1,
    listener: {
      executableBasenames: ['ollama', 'ollama.exe'],
      argvMatch: { mode: 'containsAll', tokens: ['serve'] },
      defaultPorts: [11434],
    },
    availabilityProbe: { endpointTemplateId: 'ollama-native', path: '/api/tags', parser: 'ollama-tags' },
    installedCheck: { lookupNames: ['ollama'] },
    catalogFallback: {
      endpointTemplateId: 'ollama-native',
      lookupNames: ['ollama'],
      fixedArgs: ['list'],
      parser: 'ollama-list-table',
      endpointEnvName: 'OLLAMA_HOST',
    },
  },
} satisfies ProviderContributionV1;
