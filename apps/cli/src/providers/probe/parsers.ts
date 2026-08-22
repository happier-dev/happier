import {
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  ProviderCatalogParserV1Schema,
  ProviderCatalogProbeModelV1Schema,
  ProviderModelLoadStateV1Schema,
  readBundledProviderCatalogParserFactV1,
  type BundledProviderCatalogParserV1,
  type ProviderCatalogParserV1,
  type ProviderCatalogProbeModelV1,
  type ProviderModelLoadStateV1,
  ProviderModelDescriptorV1Schema,
} from '@happier-dev/protocol';
import {
  buildClaudeModelOptions,
  CLAUDE_EFFORT_LEVELS,
  type ClaudeEffortLevel,
} from '@happier-dev/agents/providers/claude-model-options';

export type ParsedProviderCatalogResponse = Readonly<{
  models: readonly ProviderCatalogProbeModelV1[];
  loadStates: readonly Readonly<{
    modelId: string;
    loadState: ProviderModelLoadStateV1;
  }>[];
}>;

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
  if (value.length > PROVIDER_ENDPOINT_SAFETY_LIMITS.maxModels) {
    throw new TypeError(`${label} exceeds the model limit`);
  }
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

function optionalOwnObject(value: unknown, key: string, label: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider model row must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)
    || typeof descriptor.value !== 'object' || descriptor.value === null || Array.isArray(descriptor.value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return descriptor.value as Record<string, unknown>;
}

function requiredOwnBoolean(value: unknown, key: string, label: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
    || typeof descriptor.value !== 'boolean') {
    throw new TypeError(`${label} ${key} must be a boolean`);
  }
  return descriptor.value;
}

function optionalOwnContextWindowTokens(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider model row must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'max_input_tokens');
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError('Provider model max_input_tokens must be a positive bounded integer');
  }
  try {
    return ProviderModelDescriptorV1Schema.shape.contextWindowTokens.parse(descriptor.value);
  } catch {
    throw new TypeError('Provider model max_input_tokens must be a positive bounded integer');
  }
}

function readAnthropicEffortCapability(value: unknown): Readonly<{
  supported: boolean;
  levels: readonly ClaudeEffortLevel[];
}> | undefined {
  const capabilities = optionalOwnObject(value, 'capabilities', 'Anthropic model capabilities');
  if (!capabilities) return undefined;
  const effort = optionalOwnObject(capabilities, 'effort', 'Anthropic model effort capability');
  if (!effort) return undefined;
  const supported = requiredOwnBoolean(effort, 'supported', 'Anthropic model effort capability');
  const levels: ClaudeEffortLevel[] = [];
  for (const level of CLAUDE_EFFORT_LEVELS) {
    const tier = optionalOwnObject(effort, level, `Anthropic model effort tier ${level}`);
    if (tier && requiredOwnBoolean(tier, 'supported', `Anthropic model effort tier ${level}`)) {
      levels.push(level);
    }
  }
  if (!supported && levels.length > 0) {
    throw new TypeError('Anthropic model effort capability cannot disable supported tiers');
  }
  if (supported && levels.length === 0) {
    throw new TypeError('Anthropic model effort capability requires a supported tier');
  }
  return { supported, levels };
}

function optionalOwnStringArray(
  value: unknown,
  key: string,
  options: Readonly<{ maxItems: number; maxItemLength: number }>,
): readonly string[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Provider model row must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor) || !Array.isArray(descriptor.value)
    || descriptor.value.length > options.maxItems) {
    throw new TypeError(`Provider model ${key} must be a bounded string array`);
  }
  return descriptor.value.map((_entry, index) => {
    const item = Object.getOwnPropertyDescriptor(descriptor.value, String(index));
    if (!item || !item.enumerable || !('value' in item)
      || typeof item.value !== 'string' || item.value.length > options.maxItemLength) {
      throw new TypeError(`Provider model ${key} must be a bounded string array`);
    }
    return item.value;
  });
}

function normalizeModels(models: readonly ProviderCatalogProbeModelV1[]): readonly ProviderCatalogProbeModelV1[] {
  const parsed = models.map((model) => ProviderCatalogProbeModelV1Schema.parse(model));
  const seen = new Set<string>();
  for (const model of parsed) {
    if (seen.has(model.id)) throw new TypeError('Duplicate provider model id');
    seen.add(model.id);
  }
  return parsed;
}

function parseOpenAiModels(input: unknown): ParsedProviderCatalogResponse {
  const rows = boundedArray(ownDataProperty(input, 'data'), 'OpenAI model list');
  return {
    models: normalizeModels(rows.map((row) => {
      const id = requiredOwnString(row, 'id');
      const name = optionalOwnString(row, 'name');
      return name === undefined ? { id } : { id, name };
    })),
    loadStates: [],
  };
}

function parseAnthropicModels(input: unknown): ParsedProviderCatalogResponse {
  const rows = boundedArray(ownDataProperty(input, 'data'), 'Anthropic model list');
  return {
    models: normalizeModels(rows.map((row) => {
      const id = requiredOwnString(row, 'id');
      const name = optionalOwnString(row, 'display_name');
      const contextWindowTokens = optionalOwnContextWindowTokens(row);
      const effort = readAnthropicEffortCapability(row);
      const modelOptions = effort?.supported
        ? buildClaudeModelOptions({ supportedLevels: effort.levels })
        : [];
      return {
        id,
        ...(name === undefined ? {} : { name }),
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        ...(effort ? {
          capabilities: {
            reasoningControls: effort.supported ? 'supported' as const : 'unsupported' as const,
          },
        } : {}),
        ...(modelOptions.length > 0 ? { modelOptions } : {}),
      };
    })),
    loadStates: [],
  };
}

function parseOllamaTags(input: unknown): ParsedProviderCatalogResponse {
  const rows = boundedArray(ownDataProperty(input, 'models'), 'Ollama model list');
  return {
    models: normalizeModels(rows.flatMap((row) => {
      const capabilities = optionalOwnStringArray(row, 'capabilities', {
        maxItems: 32,
        maxItemLength: 64,
      });
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
    })),
    loadStates: [],
  };
}

function parseLmStudioModels(input: unknown): ParsedProviderCatalogResponse {
  const rows = boundedArray(ownDataProperty(input, 'models'), 'LM Studio model list');
  const loadStates: Array<{ modelId: string; loadState: ProviderModelLoadStateV1 }> = [];
  const models = normalizeModels(rows.flatMap((row) => {
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
  }));
  return { models, loadStates };
}

/**
 * A catalog wire format implementation: maps one decoded response body onto
 * model rows. Bundled formats and plugin-contributed formats implement the
 * exact same contract.
 */
export type ProviderCatalogFormatParser = (input: unknown) => Readonly<{
  models: readonly ProviderCatalogProbeModelV1[];
  loadStates?: readonly Readonly<{
    modelId: string;
    loadState: ProviderModelLoadStateV1;
  }>[];
}>;

/**
 * The formats Happier bundles an implementation for. A Provider plugin
 * contributes any other format through the `providers` contribution family; the
 * bundled set never decides whether a declared format is valid.
 */
export const BUNDLED_PROVIDER_CATALOG_FORMAT_PARSERS: Readonly<
  Record<BundledProviderCatalogParserV1, ProviderCatalogFormatParser>
> = Object.freeze({
  'openai-models': parseOpenAiModels,
  'anthropic-models': parseAnthropicModels,
  'ollama-tags': parseOllamaTags,
  'lmstudio-native-models': parseLmStudioModels,
});

/**
 * Raised when a declared catalog format has no reachable implementation: no
 * bundled parser and no contributed parser from a currently active Provider
 * plugin. The response is never handed to another format's parser.
 */
export class ProviderCatalogFormatUnavailableError extends Error {
  readonly parser: ProviderCatalogParserV1;
  constructor(parser: ProviderCatalogParserV1) {
    super(`Provider catalog format '${parser}' has no available implementation`);
    this.name = 'ProviderCatalogFormatUnavailableError';
    this.parser = parser;
  }
}

/**
 * Resolves a declared format to its implementation. A contributed parser wins
 * only for a format the host does not bundle, so a plugin can never displace a
 * bundled format's meaning for another Provider.
 */
export function resolveProviderCatalogFormatParser(
  parser: ProviderCatalogParserV1,
  contributedParsers?: Readonly<Record<string, ProviderCatalogFormatParser>>,
): ProviderCatalogFormatParser | null {
  const bundled = readBundledProviderCatalogParserFactV1(
    BUNDLED_PROVIDER_CATALOG_FORMAT_PARSERS,
    parser,
  );
  if (bundled) return bundled;
  const contributed = contributedParsers
    ? Object.getOwnPropertyDescriptor(contributedParsers, parser)
    : undefined;
  return contributed && contributed.enumerable && typeof contributed.value === 'function'
    ? contributed.value as ProviderCatalogFormatParser
    : null;
}

/**
 * Host-owned normalization of any format's output. A contributed format decides
 * the model rows; the catalog's schema, dedupe, and size limits stay here so a
 * plugin cannot widen them.
 */
function normalizeLoadStates(
  loadStates: unknown,
  models: readonly ProviderCatalogProbeModelV1[],
): ParsedProviderCatalogResponse['loadStates'] {
  if (loadStates === undefined) return Object.freeze([]);
  const rows = boundedArray(loadStates, 'Provider model load state list');
  const modelIds = new Set(models.map((model) => model.id));
  const seen = new Set<string>();
  const normalized = rows.map((row) => {
    const modelId = requiredOwnString(row, 'modelId');
    if (!modelIds.has(modelId)) {
      throw new TypeError('Provider model load state names a model absent from the catalog');
    }
    if (seen.has(modelId)) throw new TypeError('Duplicate provider model load state');
    seen.add(modelId);
    return {
      modelId,
      loadState: ProviderModelLoadStateV1Schema.parse(
        (row as Readonly<Record<string, unknown>>).loadState,
      ),
    };
  });
  return Object.freeze(normalized);
}

function normalizeParsedCatalog(
  result: ReturnType<ProviderCatalogFormatParser>,
): ParsedProviderCatalogResponse {
  const models = boundedArray(result.models, 'Provider model list');
  const normalizedModels = normalizeModels(models as readonly ProviderCatalogProbeModelV1[]);
  return {
    models: normalizedModels,
    // Load states are contributed data exactly like the model rows: bound and
    // validate them here so an invalid contributed row is reported as an
    // invalid probe response instead of surfacing later as a storage failure.
    loadStates: normalizeLoadStates(result.loadStates, normalizedModels),
  };
}

export function parseProviderCatalogResponse(
  parser: ProviderCatalogParserV1,
  input: unknown,
  contributedParsers?: Readonly<Record<string, ProviderCatalogFormatParser>>,
): ParsedProviderCatalogResponse {
  const parserId = ProviderCatalogParserV1Schema.parse(parser);
  const parse = resolveProviderCatalogFormatParser(parserId, contributedParsers);
  if (!parse) throw new ProviderCatalogFormatUnavailableError(parserId);
  return normalizeParsedCatalog(parse(input));
}
