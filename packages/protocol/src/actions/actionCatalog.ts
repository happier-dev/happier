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
  ActionDiscoveryDefinitionSummaryV1Schema,
  ActionDiscoveryDefinitionV1Schema,
  type ActionDiscoveryDefinitionSummaryV1,
  type ActionDiscoveryDefinitionV1,
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

type NormalizedActionSearchQuery = Readonly<{
  text: string;
  tokens: readonly string[];
}>;

function normalizeActionSearchQuery(query: string): NormalizedActionSearchQuery {
  return {
    text: normalizeText(query),
    tokens: tokenize(query),
  };
}

function actionSearchScore(
  spec: SearchableActionDefinition,
  query: NormalizedActionSearchQuery,
  searchText?: string,
): number {
  const haystack = searchText ?? actionSearchText(spec);
  if (!query.text) return 1;

  let score = 0;
  if (spec.id === query.text) score += 1000;
  if (normalizeText(spec.title) === query.text) score += 500;
  if (haystack.includes(query.text)) score += 100;

  for (const token of query.tokens) {
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

function projectActionDiscoveryExamples(examples: ActionDefinitionSummaryV1['examples']) {
  if (examples === null) return null;
  return {
    ...(examples.voice === undefined
      ? {}
      : {
          voice: examples.voice === null
            ? null
            : { ...(examples.voice.argsExample === undefined ? {} : { argsExample: examples.voice.argsExample }) },
        }),
    ...(examples.mcp === undefined
      ? {}
      : {
          mcp: examples.mcp === null
            ? null
            : { ...(examples.mcp.argsExample === undefined ? {} : { argsExample: examples.mcp.argsExample }) },
        }),
    ...(examples.sdk === undefined
      ? {}
      : {
          sdk: examples.sdk === null
            ? null
            : { ...(examples.sdk.codeExample === undefined ? {} : { codeExample: examples.sdk.codeExample }) },
        }),
  };
}

function projectActionDiscoveryExecution(execution: NonNullable<ActionDefinitionSummaryV1['execution']>) {
  const handler = execution.handler;
  return {
    ...(handler === undefined
      ? {}
      : {
          handler: typeof handler === 'string'
            ? handler
            : {
                target: handler.target,
                ...(handler.exportName === undefined ? {} : { exportName: handler.exportName }),
                ...(handler.registrationId === undefined ? {} : { registrationId: handler.registrationId }),
              },
        }),
    ...(execution.transport === undefined ? {} : { transport: execution.transport }),
    ...(execution.routing === undefined ? {} : { routing: execution.routing }),
    ...(execution.approvalPolicy === undefined ? {} : { approvalPolicy: execution.approvalPolicy }),
    ...(execution.resultSchema === undefined ? {} : { resultSchema: execution.resultSchema }),
  };
}

/**
 * External Action discovery is a closed current-version DTO. The serialized
 * Action-definition readers remain compatibility-open and are normalized here
 * so their extension fields cannot leak into the external SDK contract.
 */
export function projectActionDefinitionSummaryForExternalDiscovery(
  definition: ActionDefinitionSummaryV1,
): ActionDiscoveryDefinitionSummaryV1 {
  return ActionDiscoveryDefinitionSummaryV1Schema.parse({
    id: definition.id,
    title: definition.title,
    description: definition.description,
    safety: definition.safety,
    ...(definition.approval === undefined ? {} : { approval: definition.approval }),
    ...(definition.requiredAuthority === undefined
      ? {}
      : { requiredAuthority: definition.requiredAuthority }),
    ...(definition.executionPlacement === undefined
      ? {}
      : { executionPlacement: definition.executionPlacement }),
    placements: definition.placements,
    slash: definition.slash === null ? null : { tokens: definition.slash.tokens },
    bindings: definition.bindings === null
      ? null
      : {
          ...(definition.bindings.voiceClientToolName === undefined
            ? {}
            : { voiceClientToolName: definition.bindings.voiceClientToolName }),
          ...(definition.bindings.mcpToolName === undefined
            ? {}
            : { mcpToolName: definition.bindings.mcpToolName }),
          ...(definition.bindings.sdkMethod === undefined
            ? {}
            : { sdkMethod: definition.bindings.sdkMethod }),
          ...(definition.bindings.rpcMethod === undefined
            ? {}
            : { rpcMethod: definition.bindings.rpcMethod }),
          ...(definition.bindings.rpcMethodAliases === undefined
            ? {}
            : { rpcMethodAliases: definition.bindings.rpcMethodAliases }),
        },
    examples: projectActionDiscoveryExamples(definition.examples),
    surfaces: definition.surfaces,
    ...(definition.toolExposure === undefined ? {} : { toolExposure: definition.toolExposure }),
    ...(definition.contextualDefaults === undefined ? {} : { contextualDefaults: definition.contextualDefaults }),
    inputHints: definition.inputHints,
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    ...(definition.execution === undefined
      ? {}
      : { execution: projectActionDiscoveryExecution(definition.execution) }),
    ...(definition.sideEffectClass === undefined ? {} : { sideEffectClass: definition.sideEffectClass }),
    ...(definition.operation === undefined ? {} : { operation: definition.operation }),
  });
}

export function projectActionDefinitionForExternalDiscovery(
  definition: ActionDefinitionV1,
): ActionDiscoveryDefinitionV1 {
  return ActionDiscoveryDefinitionV1Schema.parse({
    ...projectActionDefinitionSummaryForExternalDiscovery(definition),
    kindVersion: definition.kindVersion,
    inputSchema: definition.inputSchema,
    ...(definition.compatibility === undefined ? {} : { compatibility: definition.compatibility }),
  });
}

export function searchSerializedActionSpecs(
  specs: readonly ActionSpec[],
  params?: Readonly<{ query?: string | null; limit?: number | null }>,
): readonly SerializedActionSpec[] {
  const query = typeof params?.query === 'string' ? params.query.trim() : '';
  const normalizedQuery = normalizeActionSearchQuery(query);
  const limitRaw = typeof params?.limit === 'number' && Number.isFinite(params.limit) ? Math.floor(params.limit) : 20;
  const limit = Math.max(1, Math.min(100, limitRaw));

  const ranked = specs
    .map((spec) => ({ spec, score: actionSearchScore(spec, normalizedQuery) }))
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
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    safety: definition.safety,
    placements: definition.placements,
    slash: definition.slash,
    bindings: definition.bindings,
    examples: definition.examples,
    surfaces: definition.surfaces,
    inputHints: definition.inputHints,
    ...(definition.approval === undefined ? {} : { approval: definition.approval }),
    ...(definition.requiredAuthority === undefined
      ? {}
      : { requiredAuthority: definition.requiredAuthority }),
    ...(definition.executionPlacement === undefined
      ? {}
      : { executionPlacement: definition.executionPlacement }),
    ...(definition.toolExposure === undefined ? {} : { toolExposure: definition.toolExposure }),
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    ...(definition.execution === undefined ? {} : { execution: definition.execution }),
    ...(definition.sideEffectClass === undefined
      ? {}
      : { sideEffectClass: definition.sideEffectClass }),
    ...(definition.operation === undefined ? {} : { operation: definition.operation }),
  };
}

type ActionDefinitionSearchCandidate = Readonly<{
  definition: ActionDefinitionSummaryV1;
  searchText?: string;
}>;

function searchActionDefinitionSummaryCandidates(
  candidates: readonly ActionDefinitionSearchCandidate[],
  params?: Readonly<{ query?: string | null; limit?: number | null }>,
): readonly ActionDefinitionSummaryV1[] {
  const query = typeof params?.query === 'string' ? params.query.trim() : '';
  const normalizedQuery = normalizeActionSearchQuery(query);
  const limitRaw = typeof params?.limit === 'number' && Number.isFinite(params.limit) ? Math.floor(params.limit) : 20;
  const limit = Math.max(1, Math.min(100, limitRaw));
  return candidates
    .map((candidate) => ({
      candidate,
      score: actionSearchScore(candidate.definition, normalizedQuery, candidate.searchText),
    }))
    .filter((entry) => (query ? entry.score > 0 : true))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.candidate.definition.title.localeCompare(right.candidate.definition.title);
    })
    .slice(0, limit)
    .map((entry) => entry.candidate.definition);
}

export function searchActionDefinitionSummaries(
  definitions: readonly ActionDefinitionSummaryV1[],
  params?: Readonly<{ query?: string | null; limit?: number | null }>,
): readonly ActionDefinitionSummaryV1[] {
  return searchActionDefinitionSummaryCandidates(
    definitions.map((definition) => ({ definition })),
    params,
  );
}

export function listActionSpecsForCatalogSurface(params: Readonly<{
  surface?: keyof ActionSurfaces | null;
  isActionEnabled?: (id: ActionId) => boolean;
}>): readonly ActionSpec[] {
  const isActionEnabled = params.isActionEnabled ?? (() => true);
  return listActionSpecs().filter((spec) => (!params.surface || isActionSpecSurfacedOn(spec, params.surface)) && isActionEnabled(spec.id as ActionId));
}

type HostActionSearchSummary = Readonly<{
  definition: SerializedActionSpec;
  searchText: string;
}>;

const defaultHostActionSearchSummaries = new WeakMap<ActionSpec, HostActionSearchSummary>();
const apiHostActionSearchSummaries = new WeakMap<ActionSpec, HostActionSearchSummary>();

function getHostActionSearchSummary(
  spec: ActionSpec,
  params: ActionCatalogSurfaceParams,
): HostActionSearchSummary {
  const summaries = params.surface === 'api'
    ? apiHostActionSearchSummaries
    : defaultHostActionSearchSummaries;
  const cached = summaries.get(spec);
  if (cached) return cached;

  const definition = Object.freeze(serializeActionSpec(spec, params));
  const summary = { definition, searchText: actionSearchText(definition) };
  summaries.set(spec, summary);
  return summary;
}

export function searchSerializedActionSpecsForSurface(params: Readonly<{
  surface?: keyof ActionSurfaces | null;
  query?: string | null;
  limit?: number | null;
  isActionEnabled?: (id: ActionId) => boolean;
  additionalDefinitions?: readonly ActionDefinitionV1[];
}>): readonly SerializedActionSpec[] {
  const hostDefinitions = listActionSpecsForCatalogSurface(params)
    .map((spec) => getHostActionSearchSummary(spec, params));
  const hostIds = new Set(hostDefinitions.map((summary) => summary.definition.id));
  const additionalDefinitions = (params.additionalDefinitions ?? [])
    .filter((definition) => (
      !hostIds.has(definition.id)
      && (!params.surface || definition.surfaces[params.surface] === true)
    ))
    .map(actionDefinitionToSummary);
  return searchActionDefinitionSummaryCandidates([
    ...hostDefinitions,
    ...additionalDefinitions.map((definition) => ({ definition })),
  ], {
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
