import type { ActionId } from './actionIds.js';
import {
  getActionSpec,
  isActionSpecSurfacedOn,
  listActionSpecs,
  type ActionInputFieldHint,
  type ActionInputOption,
  type ActionSpec,
  type ActionSurfaces,
} from './actionSpecs.js';
import {
  actionInputOptionValueSearchText,
  type ActionInputOptionValue,
} from './actionInputHints.js';
import {
  type ActionDefinitionSummaryV1,
  type ActionDefinitionV1,
} from './actionDefinitionV1.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';

export type SerializedActionSpec = ActionDefinitionSummaryV1;

export type ResolvedActionOption = Readonly<{
  value: ActionInputOptionValue;
  label: string;
  description?: string;
  disabled?: boolean;
}>;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function tokenize(value: unknown): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9_.-]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

type SearchableActionDefinition = Readonly<{
  id: string;
  title: string;
  description?: string | null;
  bindings?: ActionSpec['bindings'] | ActionDefinitionSummaryV1['bindings'];
  slash?: ActionSpec['slash'] | ActionDefinitionSummaryV1['slash'];
  inputHints?: ActionSpec['inputHints'] | ActionDefinitionSummaryV1['inputHints'];
}>;

function actionSearchText(spec: SearchableActionDefinition): string {
  const fieldText = Array.isArray(spec.inputHints?.fields)
    ? spec.inputHints.fields
        .flatMap((field) => [
          field.path,
          field.title,
          field.description ?? '',
          field.widget,
          ...(Array.isArray((field as any).options)
            ? ((field as any).options as readonly ActionInputOption[]).flatMap((option) => [
              actionInputOptionValueSearchText(option.value),
              option.label,
              option.description ?? '',
            ])
            : []),
        ])
        .join(' ')
    : '';

  return [
    spec.id,
    spec.title,
    spec.description ?? '',
    spec.inputHints?.title ?? '',
    spec.inputHints?.description ?? '',
    spec.bindings?.voiceClientToolName ?? '',
    spec.bindings?.mcpToolName ?? '',
    spec.bindings?.sdkMethod ?? '',
    spec.bindings?.rpcMethod ?? '',
    ...(Array.isArray(spec.bindings?.rpcMethodAliases)
      ? spec.bindings.rpcMethodAliases.filter((alias): alias is string => typeof alias === 'string')
      : []),
    ...(spec.slash?.tokens ?? []),
    fieldText,
  ]
    .join(' ')
    .toLowerCase();
}

function actionSearchScore(spec: SearchableActionDefinition, query: string): number {
  const haystack = actionSearchText(spec);
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 1;

  let score = 0;
  if (spec.id === normalizedQuery) score += 1000;
  if (normalizeText(spec.title) === normalizedQuery) score += 500;
  if (haystack.includes(normalizedQuery)) score += 100;

  const tokens = tokenize(query);
  for (const token of tokens) {
    if (spec.id.includes(token)) score += 50;
    if (normalizeText(spec.title).includes(token)) score += 25;
    if (haystack.includes(token)) score += 10;
  }

  return score;
}

type ActionCatalogSurfaceParams = Readonly<{
  surface?: keyof ActionSurfaces | null;
}>;

function resolveActionCatalogInputProjection(
  spec: ActionSpec,
  surface: keyof ActionSurfaces | null | undefined,
): Readonly<{
  inputSchema: ActionSpec['inputSchema'];
  inputHints: ActionSpec['inputHints'];
}> {
  const apiBinding = surface === 'api' ? spec.surfaceBindings?.api : undefined;
  return {
    inputSchema: apiBinding?.inputSchema ?? spec.inputSchema,
    inputHints: apiBinding?.inputHints ?? spec.inputHints,
  };
}

export function serializeActionSpec(
  spec: ActionSpec,
  params?: ActionCatalogSurfaceParams,
): SerializedActionSpec {
  const projection = resolveActionCatalogInputProjection(spec, params?.surface);
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description ?? null,
    safety: spec.safety,
    approval: spec.approval,
    requiredAuthority: spec.requiredAuthority,
    executionPlacement: spec.executionPlacement,
    placements: spec.placements ?? [],
    slash: spec.slash ?? null,
    bindings: spec.bindings ?? null,
    examples: spec.examples ?? null,
    surfaces: spec.surfaces,
    inputHints: projection.inputHints ?? null,
    ...(spec.toolExposure ? { toolExposure: spec.toolExposure } : {}),
    ...(spec.contextualDefaults ? { contextualDefaults: spec.contextualDefaults } : {}),
    ...(spec.outputSchema ? { outputSchema: zodSchemaToJsonSchemaObject(spec.outputSchema) } : {}),
    ...(spec.execution ? { execution: spec.execution } : {}),
    ...(spec.sideEffectClass ? { sideEffectClass: spec.sideEffectClass } : {}),
    ...(spec.operation ? { operation: spec.operation } : {}),
  };
}

export function actionSpecToActionDefinitionV1(
  spec: ActionSpec,
  params?: ActionCatalogSurfaceParams,
): ActionDefinitionV1 {
  const projection = resolveActionCatalogInputProjection(spec, params?.surface);
  return {
    kindVersion: 1,
    ...serializeActionSpec(spec, params),
    inputSchema: zodSchemaToJsonSchemaObject(projection.inputSchema),
  };
}

export function searchSerializedActionSpecs(
  specs: readonly ActionSpec[],
  params?: Readonly<{ query?: string | null; limit?: number | null }>,
): readonly SerializedActionSpec[] {
  const query = typeof params?.query === 'string' ? params.query.trim() : '';
  const limitRaw = typeof params?.limit === 'number' && Number.isFinite(params.limit) ? Math.floor(params.limit) : 20;
  const limit = Math.max(1, Math.min(100, limitRaw));

  const ranked = specs
    .map((spec) => ({ spec, score: actionSearchScore(spec, query) }))
    .filter((entry) => (query ? entry.score > 0 : true))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.spec.title.localeCompare(right.spec.title);
    })
    .slice(0, limit)
    .map((entry) => serializeActionSpec(entry.spec));

  return ranked;
}

function actionDefinitionToSummary(definition: ActionDefinitionV1): ActionDefinitionSummaryV1 {
  const { kindVersion: _kindVersion, inputSchema: _inputSchema, ...summary } = definition;
  return summary;
}

export function searchActionDefinitionSummaries(
  definitions: readonly ActionDefinitionSummaryV1[],
  params?: Readonly<{ query?: string | null; limit?: number | null }>,
): readonly ActionDefinitionSummaryV1[] {
  const query = typeof params?.query === 'string' ? params.query.trim() : '';
  const limitRaw = typeof params?.limit === 'number' && Number.isFinite(params.limit) ? Math.floor(params.limit) : 20;
  const limit = Math.max(1, Math.min(100, limitRaw));
  return definitions
    .map((definition) => ({ definition, score: actionSearchScore(definition, query) }))
    .filter((entry) => (query ? entry.score > 0 : true))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.definition.title.localeCompare(right.definition.title);
    })
    .slice(0, limit)
    .map((entry) => entry.definition);
}

export function listActionSpecsForCatalogSurface(params: Readonly<{
  surface?: keyof ActionSurfaces | null;
  isActionEnabled?: (id: ActionId) => boolean;
}>): readonly ActionSpec[] {
  const isActionEnabled = params.isActionEnabled ?? (() => true);
  return listActionSpecs().filter((spec) => (!params.surface || isActionSpecSurfacedOn(spec, params.surface)) && isActionEnabled(spec.id as ActionId));
}

export function searchSerializedActionSpecsForSurface(params: Readonly<{
  surface?: keyof ActionSurfaces | null;
  query?: string | null;
  limit?: number | null;
  isActionEnabled?: (id: ActionId) => boolean;
  additionalDefinitions?: readonly ActionDefinitionV1[];
}>): readonly SerializedActionSpec[] {
  const hostDefinitions = listActionSpecsForCatalogSurface(params)
    .map((spec) => serializeActionSpec(spec, params));
  const hostIds = new Set(hostDefinitions.map((definition) => definition.id));
  const additionalDefinitions = (params.additionalDefinitions ?? [])
    .filter((definition) => (
      !hostIds.has(definition.id)
      && (!params.surface || definition.surfaces[params.surface] === true)
    ))
    .map(actionDefinitionToSummary);
  return searchActionDefinitionSummaries([...hostDefinitions, ...additionalDefinitions], {
    query: params.query,
    limit: params.limit,
  });
}

export function getActionSpecForCatalogSurface(params: Readonly<{
  id: ActionId;
  surface?: keyof ActionSurfaces | null;
  isActionEnabled?: (id: ActionId) => boolean;
}>): ActionSpec | null {
  const spec = getActionSpec(params.id);
  const isActionEnabled = params.isActionEnabled ?? (() => true);
  if ((params.surface && !isActionSpecSurfacedOn(spec, params.surface)) || !isActionEnabled(spec.id as ActionId)) {
    return null;
  }
  return spec;
}

export function getSerializedActionSpecForSurface(params: Readonly<{
  id: ActionId;
  surface?: keyof ActionSurfaces | null;
  isActionEnabled?: (id: ActionId) => boolean;
}>): SerializedActionSpec | null {
  const spec = getActionSpecForCatalogSurface(params);
  return spec ? serializeActionSpec(spec, params) : null;
}

export function listActionDefinitionsForCatalogSurface(params: Readonly<{
  surface?: keyof ActionSurfaces | null;
  isActionEnabled?: (id: ActionId) => boolean;
}>): readonly ActionDefinitionV1[] {
  return listActionSpecsForCatalogSurface(params)
    .map((spec) => actionSpecToActionDefinitionV1(spec, params));
}

export function getActionDefinitionForCatalogSurface(params: Readonly<{
  id: ActionId;
  surface?: keyof ActionSurfaces | null;
  isActionEnabled?: (id: ActionId) => boolean;
}>): ActionDefinitionV1 | null {
  const spec = getActionSpecForCatalogSurface(params);
  return spec ? actionSpecToActionDefinitionV1(spec, params) : null;
}

export function findActionInputFieldHint(
  spec: Readonly<{
    inputHints?: ActionSpec['inputHints'] | ActionDefinitionSummaryV1['inputHints'];
  }>,
  fieldPath: string,
): ActionInputFieldHint | null {
  const normalizedFieldPath = typeof fieldPath === 'string' ? fieldPath.trim() : '';
  if (!normalizedFieldPath) return null;
  const fields = Array.isArray(spec.inputHints?.fields) ? spec.inputHints.fields : [];
  return fields.find((field) => field.path === normalizedFieldPath) ?? null;
}

export function serializeActionFieldOptions(field: ActionInputFieldHint): readonly ResolvedActionOption[] {
  return Array.isArray(field.options)
    ? field.options
        .map((option) => ({
          value: option.value,
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
          ...(option.disabled === true ? { disabled: true as const } : {}),
        }))
        .filter((option) => (
          typeof option.value !== 'string' || option.value.trim().length > 0
        ))
    : [];
}

export function filterResolvedActionOptions(
  options: readonly ResolvedActionOption[],
  params?: Readonly<{ query?: string | null; limit?: number | null }>,
): readonly ResolvedActionOption[] {
  const query = typeof params?.query === 'string' ? params.query.trim().toLowerCase() : '';
  const limit = typeof params?.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.min(200, Math.floor(params.limit)))
    : null;

  const filtered = query
    ? options.filter((option) =>
        [actionInputOptionValueSearchText(option.value), option.label, option.description ?? '']
          .join(' ')
          .toLowerCase()
          .includes(query))
    : [...options];

  return limit === null ? filtered : filtered.slice(0, limit);
}
