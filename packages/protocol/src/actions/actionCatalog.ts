import type { ActionId } from './actionIds.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { pluginJsonValuesEqual } from '../plugins/contributions/jsonSchemaValues.js';
import {
  getActionSpec,
  isActionSpecSurfacedOn,
  listActionSpecs,
  type ActionInputFieldHint,
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
import { ActionJsonSchemaProjectionError, zodSchemaToJsonSchemaObject, type JsonSchemaObject } from './actionInputJsonSchema.js';
import { freezeActionCompletionContractV1, ActionCompletionContractV1Schema } from './actionCompletion.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import type { WorkflowMaterializedLeafV1 } from '../workflows/workflowDefinitionV1.js';

export { readCompleteActionSpecV1 } from './actionSpecSections.js';

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

type SearchableActionInputOption = NonNullable<ActionInputFieldHint['options']>[number];

function actionSearchText(spec: SearchableActionDefinition): string {
  const fieldText = Array.isArray(spec.inputHints?.fields)
    ? spec.inputHints.fields
        .flatMap((field) => [
          field.path,
          field.title,
          field.description ?? '',
          field.widget,
          ...(Array.isArray(field.options)
            ? field.options.flatMap((option: SearchableActionInputOption) => [
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
  includeOutputSchema?: boolean;
}>;

function resolveActionCatalogSurfaceProjection(
  spec: ActionSpec,
  surface: keyof ActionSurfaces | null | undefined,
): Readonly<{
  inputSchema: ActionSpec['inputSchema'];
  inputHints: ActionSpec['inputHints'];
  outputSchema: ActionSpec['outputSchema'];
}> {
  const apiBinding = surface === 'api' ? spec.surfaceBindings?.api : undefined;
  return {
    inputSchema: apiBinding?.inputSchema ?? spec.inputSchema,
    inputHints: apiBinding?.inputHints ?? spec.inputHints,
    outputSchema: apiBinding?.outputSchema ?? spec.outputSchema,
  };
}

/** Optional output metadata must not hide otherwise discoverable Actions. */
export function projectActionOutputJsonSchema(
  schema: Parameters<typeof zodSchemaToJsonSchemaObject>[0] | undefined,
  options?: Parameters<typeof zodSchemaToJsonSchemaObject>[1],
): JsonSchemaObject | undefined {
  if (!schema) return undefined;
  try {
    return zodSchemaToJsonSchemaObject(schema, options);
  } catch (error) {
    // Omit only an unsupported output claim; input projection remains strict.
    if (!(error instanceof ActionJsonSchemaProjectionError)) throw error;
    return undefined;
  }
}

export function serializeActionSpec(
  spec: ActionSpec,
  params?: ActionCatalogSurfaceParams,
): SerializedActionSpec {
  return projectSerializedActionOutput(serializeActionSpecMetadata(spec, params), spec, params);
}

function projectSerializedActionOutput(
  metadata: SerializedActionSpec,
  spec: ActionSpec,
  params?: ActionCatalogSurfaceParams,
): SerializedActionSpec {
  if (params?.includeOutputSchema === false) return metadata;
  const projection = resolveActionCatalogSurfaceProjection(spec, params?.surface);
  const outputSchema = projectActionOutputJsonSchema(projection.outputSchema, { target: 'draft-7', reused: 'ref' });
  return { ...metadata, ...(outputSchema ? { outputSchema } : {}) };
}

function serializeActionSpecMetadata(
  spec: ActionSpec,
  params?: ActionCatalogSurfaceParams,
): SerializedActionSpec {
  const projection = resolveActionCatalogSurfaceProjection(spec, params?.surface);
  return {
    id: spec.id,
    title: spec.title,
    ...(spec.confirmVerb === undefined ? {} : { confirmVerb: spec.confirmVerb }),
    ...(spec.irreversible === undefined ? {} : { irreversible: spec.irreversible }),
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
    ...(spec.prompting ? { prompting: spec.prompting } : {}),
    ...(spec.contextualDefaults ? { contextualDefaults: spec.contextualDefaults } : {}),
    ...(spec.sessionTarget ? { sessionTarget: spec.sessionTarget } : {}),
    ...(spec.execution ? { execution: spec.execution } : {}),
    ...(spec.sideEffectClass ? { sideEffectClass: spec.sideEffectClass } : {}),
    ...(spec.operation ? { operation: spec.operation } : {}),
  };
}

export function actionSpecToActionDefinitionV1(
  spec: ActionSpec,
  params?: ActionCatalogSurfaceParams,
): ActionDefinitionV1 {
  const projection = resolveActionCatalogSurfaceProjection(spec, params?.surface);
  return {
    kindVersion: 1,
    ...serializeActionSpec(spec, params),
    inputSchema: zodSchemaToJsonSchemaObject(projection.inputSchema, { target: 'draft-7', reused: 'ref' }),
    ...(spec.completion ? { completion: freezeActionCompletionContractV1(spec.completion) } : {}),
  };
}

/** One projection for native and contributed Workflow Action admission. */
export function freezeWorkflowActionContractV1(
  definition: Readonly<{ inputSchema?: unknown; outputSchema?: unknown; completion?: unknown }>,
): NonNullable<WorkflowMaterializedLeafV1['actionContract']> | null {
  const input = StrictJsonValueSchema.safeParse(definition.inputSchema ?? {});
  const completion = definition.completion === undefined ? undefined
    : ActionCompletionContractV1Schema.safeParse(definition.completion);
  if (!input.success || completion && !completion.success) return null;
  const output = StrictJsonValueSchema.safeParse(completion?.success
    ? completion.data.terminalOutputSchema : definition.outputSchema);
  if (!output.success) return null;
  return { inputSchema: input.data, outputSchema: output.data,
    ...(completion?.success ? { completion: StrictJsonValueSchema.parse(completion.data) } : {}) };
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
  return ActionDiscoveryDefinitionSummaryV1Schema.parse(projectActionDefinitionSummaryMetadata(definition));
}

function projectActionDefinitionSummaryMetadata(definition: ActionDefinitionSummaryV1, includeOutputSchema = true): ActionDiscoveryDefinitionSummaryV1 {
  return {
    id: definition.id,
    title: definition.title,
    ...(definition.confirmVerb === undefined ? {} : { confirmVerb: definition.confirmVerb }),
    ...(definition.irreversible === undefined ? {} : { irreversible: definition.irreversible }),
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
    ...(definition.prompting === undefined ? {} : { prompting: definition.prompting }),
    ...(definition.contextualDefaults === undefined ? {} : { contextualDefaults: definition.contextualDefaults }),
    ...(definition.sessionTarget === undefined ? {} : { sessionTarget: definition.sessionTarget }),
    inputHints: definition.inputHints,
    ...(!includeOutputSchema || definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    ...(definition.execution === undefined
      ? {}
      : { execution: projectActionDiscoveryExecution(definition.execution) }),
    ...(definition.sideEffectClass === undefined ? {} : { sideEffectClass: definition.sideEffectClass }),
    ...(definition.operation === undefined ? {} : { operation: definition.operation }),
  };
}

export function projectActionDefinitionForExternalDiscovery(
  definition: ActionDefinitionV1,
): ActionDiscoveryDefinitionV1 {
  return ActionDiscoveryDefinitionV1Schema.parse({
    ...projectActionDefinitionSummaryForExternalDiscovery(definition),
    kindVersion: definition.kindVersion,
    inputSchema: definition.inputSchema,
    ...(definition.completion === undefined ? {} : { completion: definition.completion }),
    ...(definition.compatibility === undefined ? {} : { compatibility: definition.compatibility }),
  });
}

export function searchSerializedActionSpecs(
  specs: readonly ActionSpec[],
  params?: Readonly<{ query?: string | null; limit?: number | null }>,
): readonly SerializedActionSpec[] {
  return searchActionDefinitionSummaryCandidates(specs.map(spec => {
    const definition = serializeActionSpecMetadata(spec);
    return { definition, project: () => projectSerializedActionOutput(definition, spec) };
  }), params);
}

function actionDefinitionToSummary(definition: ActionDefinitionSummaryV1, includeOutputSchema = true): ActionDefinitionSummaryV1 {
  return projectActionDefinitionSummaryMetadata(definition, includeOutputSchema);
}

type ActionDefinitionSearchCandidate = Readonly<{
  definition: ActionDefinitionSummaryV1;
  searchText?: string;
  project?: () => ActionDefinitionSummaryV1;
}>;

function searchActionDefinitionSummaryCandidates(
  candidates: readonly ActionDefinitionSearchCandidate[],
  params?: Readonly<{ query?: string | null; limit?: number | null; includeOutputSchema?: boolean }>,
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
    .map((entry) => params?.includeOutputSchema === false
      ? entry.candidate.definition
      : entry.candidate.project?.() ?? entry.candidate.definition);
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
  project: () => SerializedActionSpec;
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

  const definition = Object.freeze(serializeActionSpecMetadata(spec, params));
  let projected: SerializedActionSpec | undefined;
  const summary = { definition, searchText: actionSearchText(definition),
    // Output projection can be expensive. Ranking needs only metadata; retain
    // the existing immutable result cache once this row is actually selected.
    project: () => projected ??= Object.freeze(projectSerializedActionOutput(definition, spec, params)),
  };
  summaries.set(spec, summary);
  return summary;
}

export function searchSerializedActionSpecsForSurface(params: Readonly<{
  surface?: keyof ActionSurfaces | null;
  query?: string | null;
  limit?: number | null;
  /** Tool search discovers summaries; explicit detail reads retain the full contract. */
  includeOutputSchema?: boolean;
  isActionEnabled?: (id: ActionId) => boolean;
  additionalDefinitions?: readonly ActionDefinitionSummaryV1[];
}>): readonly SerializedActionSpec[] {
  const query = normalizeActionSearchQuery(params.query ?? '');
  const hostDefinitions = listActionSpecsForCatalogSurface(params)
    .map((spec) => getHostActionSearchSummary(spec, params))
    // Search the immutable cached summary so repeated request-current filters
    // do not rebuild the same host projection or its normalized search text.
    .filter((summary) => !query.text
      || actionSearchScore(summary.definition, query, summary.searchText) > 0);
  const hostIds = new Set(hostDefinitions.map((summary) => summary.definition.id));
  const additionalDefinitions = (params.additionalDefinitions ?? [])
    .filter((definition) => (
      !hostIds.has(definition.id)
      && (!params.surface || definition.surfaces[params.surface] === true)
    ))
    .map(definition => actionDefinitionToSummary(definition, params.includeOutputSchema));
  return searchActionDefinitionSummaryCandidates([
    ...hostDefinitions,
    ...additionalDefinitions.map((definition) => ({ definition })),
  ], {
    query: params.query,
    limit: params.limit,
    includeOutputSchema: params.includeOutputSchema,
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
  params?: Readonly<{ query?: string | null; limit?: number | null; values?: readonly JsonValue[] | null }>,
): readonly ResolvedActionOption[] {
  const query = typeof params?.query === 'string' ? params.query.trim().toLowerCase() : '';
  const limit = typeof params?.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.min(200, Math.floor(params.limit)))
    : null;

  const valued = params?.values ? options.filter(option => params.values!.some(value => pluginJsonValuesEqual(option.value, value))) : options;
  const filtered = query
    ? valued.filter((option) =>
        [actionInputOptionValueSearchText(option.value), option.label, option.description ?? '']
          .join(' ')
          .toLowerCase()
          .includes(query))
    : [...valued];

  return limit === null ? filtered : filtered.slice(0, limit);
}

export class ActionCatalogUnavailableError extends Error {
  readonly code = 'catalog_unavailable';
  constructor() { super('catalog_unavailable'); }
}
