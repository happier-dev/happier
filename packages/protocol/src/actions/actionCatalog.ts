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

export type SerializedActionSpec = Readonly<{
  id: string;
  title: string;
  description: string | null;
  safety: ActionSpec['safety'];
  placements: readonly string[];
  slash: ActionSpec['slash'] | null;
  bindings: ActionSpec['bindings'] | null;
  examples: ActionSpec['examples'] | null;
  surfaces: ActionSpec['surfaces'];
  inputHints: ActionSpec['inputHints'] | null;
}>;

export type ResolvedActionOption = Readonly<{
  value: string;
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

function actionSearchText(spec: ActionSpec): string {
  const fieldText = Array.isArray(spec.inputHints?.fields)
    ? spec.inputHints.fields
        .flatMap((field) => [
          field.path,
          field.title,
          field.description ?? '',
          field.widget,
          ...(Array.isArray((field as any).options)
            ? ((field as any).options as readonly ActionInputOption[]).flatMap((option) => [option.value, option.label, option.description ?? ''])
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
    ...(spec.slash?.tokens ?? []),
    fieldText,
  ]
    .join(' ')
    .toLowerCase();
}

function actionSearchScore(spec: ActionSpec, query: string): number {
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

export function serializeActionSpec(spec: ActionSpec): SerializedActionSpec {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description ?? null,
    safety: spec.safety,
    placements: spec.placements ?? [],
    slash: spec.slash ?? null,
    bindings: spec.bindings ?? null,
    examples: spec.examples ?? null,
    surfaces: spec.surfaces,
    inputHints: spec.inputHints ?? null,
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
}>): readonly SerializedActionSpec[] {
  return searchSerializedActionSpecs(listActionSpecsForCatalogSurface(params), {
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
  return spec ? serializeActionSpec(spec) : null;
}

export function findActionInputFieldHint(spec: ActionSpec, fieldPath: string): ActionInputFieldHint | null {
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
        .filter((option) => option.value.trim().length > 0)
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
        [option.value, option.label, option.description ?? '']
          .join(' ')
          .toLowerCase()
          .includes(query))
    : [...options];

  return limit === null ? filtered : filtered.slice(0, limit);
}
