import type { ProviderContribution as ProviderContributionV1, ProviderCatalogParser, ProviderCatalogParsedModelLoadState } from '@happier-dev/plugin-sdk/providers';

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
      { endpointTemplateId: 'lmstudio-openai-responses', path: '/api/v1/models', parser: 'lmstudio-native-models', reportsModelLoadState: true },
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
      reportsModelLoadState: true,
    },
    installedCheck: { lookupNames: ['lms'] },
    presenceCheck: {
      lookupNames: ['lms'],
      fixedArgs: ['daemon', 'status', '--json'],
      parser: 'lms-status-json',
    },
  },
} satisfies ProviderContributionV1;

function ownDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider catalog response must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`Provider catalog response is missing ${key}`);
  }
  return descriptor.value;
}

function boundedArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function optionalOwnString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider model row must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    throw new TypeError(`Provider model ${key} must be a string`);
  }
  return descriptor.value;
}

function requiredOwnString(value: unknown, key: string): string {
  const output = optionalOwnString(value, key);
  if (output === undefined) throw new TypeError(`Provider model is missing ${key}`);
  return output;
}

export const parseLmStudioModels: ProviderCatalogParser = (input) => {
  const rows = boundedArray(ownDataProperty(input, 'models'), 'LM Studio model list');
  const loadStates: Array<{ modelId: string; loadState: ProviderCatalogParsedModelLoadState['loadState'] }> = [];
  const models = rows.flatMap((row) => {
    const type = optionalOwnString(row, 'type');
    if (type !== undefined && type !== 'llm' && type !== 'embedding') {
      throw new TypeError('LM Studio model type must be llm or embedding');
    }
    // The native list includes embedding models, which cannot serve any coding
    // agent's chat/responses protocol. Preserve legacy rows that predate the
    // type field, but exclude rows explicitly identified as embeddings.
    if (type === 'embedding') return [];
    const id = requiredOwnString(row, 'key');
    const name = optionalOwnString(row, 'display_name');
    const loadedInstancesDescriptor = typeof row === 'object' && row !== null
      ? Object.getOwnPropertyDescriptor(row, 'loaded_instances')
      : undefined;
    if (loadedInstancesDescriptor) {
      if (!loadedInstancesDescriptor.enumerable || !('value' in loadedInstancesDescriptor)
        || !Array.isArray(loadedInstancesDescriptor.value)) {
        throw new TypeError('LM Studio loaded_instances must be an array');
      }
      loadStates.push({
        modelId: id,
        loadState: loadedInstancesDescriptor.value.length > 0 ? 'loaded' : 'unloaded',
      });
    }
    return [name === undefined ? { id } : { id, name }];
  });
  return { models, loadStates };
}
