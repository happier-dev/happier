import {
  PROVIDER_REASONING_EFFORT_LEVELS_V1,
  buildProviderReasoningModelOptions,
  type ProviderCatalogParser,
  type ProviderCatalogParsedModel,
} from '@happier-dev/plugin-sdk/providers';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Gateway catalog entries must be objects');
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new TypeError('Gateway catalog metadata must be an array of strings');
  }
  return value;
}

/** Gateway owns format decoding; the host owns descriptor admission, dedupe and catalog bounds. */
export const parseVercelModels: ProviderCatalogParser = (body) => {
  const { data } = record(body);
  if (!Array.isArray(data)) throw new TypeError('Gateway catalog must contain a data array');
  const models: ProviderCatalogParsedModel[] = [];
  for (const entry of data) {
    const row = record(entry);
    if (row.type !== 'language') continue;
    if (typeof row.id !== 'string' || !row.id.trim()) throw new TypeError('Gateway language model requires an id');
    if (row.name !== undefined && typeof row.name !== 'string') throw new TypeError('Gateway model name must be a string');
    const context = row.context_window;
    if (context !== undefined && (typeof context !== 'number' || !Number.isSafeInteger(context) || context <= 0)) {
      throw new TypeError('Gateway context window must be a positive integer');
    }
    const tags = row.tags === undefined ? [] : strings(row.tags);
    const advertisedEfforts = new Set<string>();
    let hasReasoningControl = false;
    if (row.reasoning_options !== undefined) {
      if (!Array.isArray(row.reasoning_options)) throw new TypeError('Gateway reasoning options must be an array');
      for (const value of row.reasoning_options) {
        const option = record(value);
        if (option.type === 'effort') {
          for (const effort of strings(option.values)) advertisedEfforts.add(effort);
          hasReasoningControl = true;
        } else if (option.type === 'budget_tokens' || option.type === 'toggle') {
          hasReasoningControl = true;
        }
      }
    }
    // No Gateway default is advertised. Use the shared Happier selection policy.
    const modelOptions = buildProviderReasoningModelOptions({
      supportedLevels: PROVIDER_REASONING_EFFORT_LEVELS_V1.filter(level => advertisedEfforts.has(level)),
    });
    models.push({
      id: row.id,
      ...(row.name === undefined ? {} : { name: row.name }),
      ...(context === undefined ? {} : { contextWindowTokens: context }),
      capabilities: {
        toolRoundTrips: tags.includes('tool-use') ? 'supported' : 'unknown',
        reasoningControls: hasReasoningControl ? 'supported' : 'unknown',
      },
      ...(modelOptions.length ? { modelOptions } : {}),
    });
  }
  return { models };
};
