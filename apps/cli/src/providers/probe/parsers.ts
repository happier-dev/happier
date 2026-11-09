import { ProviderCatalogParserV1Schema, readBundledProviderCatalogParserFactV1 } from '@happier-dev/protocol/providers/catalog/descriptorV1';
import { ProviderCatalogProbeModelV1Schema } from '@happier-dev/protocol/providers/catalog/merge';
import { ProviderModelLoadStateV1Schema } from '@happier-dev/protocol/providers/runtimeState/v1';
import type { BundledProviderCatalogParserV1, ProviderCatalogParserV1, ProviderCatalogProbeModelV1, ProviderModelLoadStateV1 } from '@happier-dev/protocol';
import { parseAnthropicModelCatalog } from '@happier-dev/protocol/providers/anthropic-models';

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
      const purposeProperty = Object.getOwnPropertyDescriptor(row, 'happier_connected_account_purposes');
      if (purposeProperty && (!purposeProperty.enumerable || !('value' in purposeProperty))) {
        throw new TypeError('Provider model purposes must be data');
      }
      const connectedAccountPurposes = purposeProperty
        ? ProviderCatalogProbeModelV1Schema.shape.connectedAccountPurposes.parse(purposeProperty.value)
        : undefined;
      return { id, ...(name === undefined ? {} : { name }),
        ...(connectedAccountPurposes === undefined ? {} : { connectedAccountPurposes }) };
    })),
    loadStates: [],
  };
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
  'anthropic-models': parseAnthropicModelCatalog,
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

/** A Provider implementation owns its declared format; shared wire codecs serve custom templates. */
export function resolveProviderCatalogFormatParser(
  parser: ProviderCatalogParserV1,
  contributedParsers?: Readonly<Record<string, ProviderCatalogFormatParser>>,
): ProviderCatalogFormatParser | null {
  const contributed = contributedParsers
    ? Object.getOwnPropertyDescriptor(contributedParsers, parser)
    : undefined;
  return contributed && contributed.enumerable && typeof contributed.value === 'function'
    ? contributed.value as ProviderCatalogFormatParser
    : readBundledProviderCatalogParserFactV1(BUNDLED_PROVIDER_CATALOG_FORMAT_PARSERS, parser);
}

/**
 * Host-owned normalization of any format's output. A contributed format decides
 * the model rows; the catalog's schema and dedupe stay here.
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
