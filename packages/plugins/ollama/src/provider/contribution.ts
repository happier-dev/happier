import type { ProviderContribution as ProviderContributionV1, ProviderCatalogParser } from '@happier-dev/plugin-sdk/providers';

const OLLAMA_LOCAL_ORIGINS = [
  'http://127.0.0.1:11434',
  'http://localhost:11434',
] satisfies string[];

const OLLAMA_OPENAI_BASE_URLS = OLLAMA_LOCAL_ORIGINS.map((origin) => `${origin}/v1`);

// The managed catalog projects Ollama's `/api/tags` response through the
// plugin's declared `ollama-tags` parser. Change this semantic identity only when that
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
    source: 'static+probe',
    manualModelPolicy: 'allowed',
    // Exact base checkpoint and byte-level BPE: Qwen/Qwen2.5-Coder-1.5B
    // tokenizer.json; Ollama's base template uses the three FIM markers.
    staticModels: [{ id: 'qwen2.5-coder:1.5b-base', name: 'Qwen2.5 Coder 1.5B Base', contextWindowTokens: 32768,
      inlineCompletion: { operationId: 'native-fim', tokenAccounting: 'utf8-bytes', promptOverheadTokens: 3 } },
      { id: 'hf.co/sweepai/sweep-next-edit-1.5B:latest', name: 'Sweep Next Edit 1.5B', contextWindowTokens: 8192,
        nextEdit: { operationId: 'next-edit', tokenAccounting: 'utf8-bytes', promptOverheadTokens: 0 } }],
    sourceRegistryVersion: OLLAMA_CATALOG_SOURCE_REGISTRY_VERSION,
    probes: [{ endpointTemplateId: 'ollama-native', path: '/api/tags', parser: 'ollama-tags' }],
  },
  inlineCompletion: [{ id: 'native-fim', mode: 'native-fim', endpointTemplateId: 'ollama-native', path: '/api/generate', wireFormat: 'ollama-generate' },
    { id: 'next-edit', mode: 'next-edit-codec', codec: 'rewrite-window-v1', endpointTemplateId: 'ollama-native', path: '/api/generate', wireFormat: 'ollama-generate' }],
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

function optionalOwnStringArray(
  value: unknown,
  key: string,
): readonly string[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider model row must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor) || !Array.isArray(descriptor.value)) {
    throw new TypeError(`Provider model ${key} must be a string array`);
  }
  return descriptor.value.map((_entry, index) => {
    const item = Object.getOwnPropertyDescriptor(descriptor.value, String(index));
    if (!item || !item.enumerable || !('value' in item)
      || typeof item.value !== 'string') {
      throw new TypeError(`Provider model ${key} must be a string array`);
    }
    return item.value;
  });
}

export const parseOllamaTags: ProviderCatalogParser = (input) => {
  const rows = boundedArray(ownDataProperty(input, 'models'), 'Ollama model list');
  return {
    models: rows.flatMap((row) => {
      const capabilities = optionalOwnStringArray(row, 'capabilities');
      // Newer Ollama versions expose exact model capabilities on /api/tags.
      // A row explicitly lacking completion support cannot serve a coding-agent
      // session. Older versions omit this field, so absence remains unknown and
      // the model stays visible rather than being guessed incompatible.
      if (capabilities !== undefined && !capabilities.includes('completion')) return [];
      return [{
        id: optionalOwnString(row, 'model') ?? requiredOwnString(row, 'name'),
        ...(capabilities === undefined
          ? {}
          : {
              capabilities: {
                toolRoundTrips: capabilities.includes('tools') ? 'supported' as const : 'unsupported' as const,
                reasoningControls: capabilities.includes('thinking') ? 'supported' as const : 'unsupported' as const,
              },
            }),
      }];
    }),
    loadStates: [],
  };
}

export const parseOllamaListTable: ProviderCatalogParser = (input) => {
  if (typeof input !== 'string') throw new TypeError('Provider command catalog output must be text');
  const lines = input.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new TypeError('Ollama model table is empty');
  const header = lines[0]!.split(/\s+/u).map((part) => part.toUpperCase());
  if (header.length !== 4 || header.join('\0') !== 'NAME\0ID\0SIZE\0MODIFIED') {
    throw new TypeError('Ollama model table header is unrecognized');
  }
  return {
    models: lines.slice(1).map((line) => {
      const columns = line.split(/\s+/u);
      if (columns.length < 4) throw new TypeError('Ollama model table row is malformed');
      return { id: columns[0]! };
    }),
  };
};
