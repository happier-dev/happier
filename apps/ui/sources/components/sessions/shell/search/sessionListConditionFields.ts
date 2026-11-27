import {
  applyCollectionConditionEdit,
  conditionModelFromFilter,
  type CollectionConditionBindings,
  type CollectionConditionEdit,
  type CollectionConditionField,
  type CollectionConditionModel,
  type CollectionConditionValueCounts,
  type HappierCollectionConditionEditorLabels,
} from '@happier-dev/plugin-ui/components';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
  normalizeSessionListFilterV1,
  sessionWorkFilterFields,
  type SessionListFilterV1,
} from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SESSION_WORK_STATUS_FILTERS_V1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { SessionListScopeV1 } from '@happier-dev/protocol/sessions/listing/query';

import type { IconName } from '@/components/ui/icons/Icon';
import { readSessionListFilterAgentLabel } from './useSessionListFilterLocalOptions';

import {
  readSessionListFilterStatusLabel,
  type SessionListFilterEditorLabels,
  type SessionListFilterProjectOption,
  type SessionListFilterHomeOption,
  type SessionListFilterTagOption,
  type SessionListFilterAudienceOption,
  type SessionListFilterAgentOption,
  type SessionListFilterSectionOption,
} from './sessionListFilterEditorModel';
import {
  buildQualifiedAudienceSelectionKey,
  type SessionListViewFilters,
} from './sessionListViewFilters';

/**
 * The Sessions binding of the shared condition editor: words, value choices and marks for the Session
 * registry's fields (`sessionWorkFilterFields`), and the one route an edit takes back to the filter's
 * writers. The registry decides which fields exist and how a condition reads and writes; this file only
 * names them.
 */
export type SessionListConditionCopy = Omit<
  HappierCollectionConditionEditorLabels,
  'count'
> &
  Readonly<{
    waitingOnYou: string;
    onlyCoordinators: string;
    inactiveHidden: string;
    inactiveShown: string;
    groups: Readonly<{ work: string; people: string; kind: string }>;
    /** Field names by registry id. */
    fields: Readonly<Record<string, string>>;
    resultCount: (count: number) => string;
  }>;

/** Add filter's groups and order (lab `clfilter:add`). */
export const SESSION_LIST_CONDITION_GROUPS = Object.freeze({
  work: ['projects', 'agents', 'statuses', 'attention', 'sections', 'tagIds'],
  people: ['startedBy', 'audiences', 'homeServerIds'],
  kind: ['show', 'coordinator', 'includeInactive', 'source'],
} as const);

export const SESSION_LIST_CONDITION_FIELD_ICONS: Readonly<
  Record<string, IconName>
> = Object.freeze({
  projects: 'folder',
  agents: 'lightning',
  sections: 'folder',
  statuses: 'circle-half',
  attention: 'hand',
  tagIds: 'tag',
  startedBy: 'lightning',
  audiences: 'users',
  homeServerIds: 'house',
  show: 'tree-structure',
  coordinator: 'users',
  includeInactive: 'archive',
  source: 'cloud',
});

/** Whose is where the list starts: always drawn, never removed. */
export const SESSION_LIST_LOCKED_CONDITION_FIELDS: ReadonlySet<string> =
  new Set(['scope']);

const SCOPES: readonly SessionListScopeV1[] = [
  'my_work',
  'assigned_to_me',
  'following',
  'involving_me',
  'all_accessible',
];

export type SessionListConditionChoices = Readonly<{
  editorLabels: SessionListFilterEditorLabels;
  copy: SessionListConditionCopy;
  scopesAvailable: Readonly<Record<SessionListScopeV1, boolean>>;
  homes: readonly SessionListFilterHomeOption[];
  tags: readonly SessionListFilterTagOption[];
  projects: readonly SessionListFilterProjectOption[];
  agents?: readonly SessionListFilterAgentOption[];
  sections?: readonly SessionListFilterSectionOption[];
  audiences: readonly SessionListFilterAudienceOption[];
  fixedShow?: SessionListViewFilters['show'];
  attentionAvailable: boolean;
  inactiveVisibilityAvailable: boolean;
  sourceAvailable: boolean;
  /** Where the filter is evaluated; defaults to the list. */
  evaluator?: 'list' | 'daemonRule';
}>;

function scopeLabel(
  scope: SessionListScopeV1,
  labels: SessionListFilterEditorLabels,
): string {
  switch (scope) {
    case 'my_work':
      return labels.myWork;
    case 'assigned_to_me':
      return labels.assignedToMe;
    case 'following':
      return labels.following;
    case 'involving_me':
      return labels.involvingMe;
    case 'all_accessible':
      return labels.allAccessible;
  }
}

const key = (value: JsonValue) => JSON.stringify(value);

/** Field names and value choices for the Session registry, from the list's own option owners. */
export function buildSessionListConditionBindings(
  input: SessionListConditionChoices,
): Readonly<{
  bindings: CollectionConditionBindings;
  addableFieldIds: ReadonlySet<string>;
  formatValue: (field: CollectionConditionField, value: JsonValue) => string;
}> {
  const { copy, editorLabels: labels } = input;
  const label = (id: string) => copy.fields[id] ?? id;
  const statusOptions = SESSION_WORK_STATUS_FILTERS_V1.map((choice) => ({
    value: choice,
    label: readSessionListFilterStatusLabel(choice, labels),
  }));
  const audienceLabels = new Map(
    input.audiences.map(
      (audience) =>
        [buildQualifiedAudienceSelectionKey(audience), audience.label] as const,
    ),
  );
  const fields: Record<
    string,
    {
      label: string;
      valueOptions?: { value: JsonValue; label: string; disabled?: boolean }[];
    }
  > = {
    scope: {
      label: label('scope'),
      valueOptions: SCOPES.map((scope) => ({
        value: scope,
        label: scopeLabel(scope, labels),
        disabled: input.scopesAvailable[scope] !== true,
      })),
    },
    projects: {
      label: label('projects'),
      valueOptions: input.projects.map((project) => ({
        value: { serverId: project.serverId, projectKey: project.projectKey },
        label: project.label,
        disabled: project.disabled,
      })),
    },
    agents: {
      label: label('agents'),
      valueOptions: (input.agents ?? []).map(agent => ({ value: agent.agentTargetKey, label: agent.label, disabled: agent.disabled })),
    },
    sections: {
      label: label('sections'),
      valueOptions: (input.sections ?? []).map(section => ({
        value: { serverId: section.serverId, sectionId: section.sectionId }, label: section.label, disabled: section.disabled,
      })),
    },
    // Status is chosen by Work group; the registry gives each group its state vector, this its word.
    statuses: { label: label('statuses'), valueOptions: statusOptions },
    attention: {
      label: label('attention'),
      valueOptions: [{ value: 'needs_my_attention', label: copy.waitingOnYou }],
    },
    tagIds: {
      label: label('tagIds'),
      valueOptions: input.tags.map((tag) => ({
        value: { serverId: tag.serverId, tagId: tag.tagId },
        label: tag.label,
        disabled: tag.disabled,
      })),
    },
    startedBy: {
      label: label('startedBy'),
      valueOptions: [
        { value: 'you', label: labels.startedByYou },
        { value: 'triggers', label: labels.startedByTriggers },
        { value: 'agents', label: labels.startedByAgents },
      ],
    },
    audiences: { label: label('audiences') },
    homeServerIds: {
      label: label('homeServerIds'),
      valueOptions: input.homes.map((home) => ({
        value: home.serverId,
        label: home.label,
        disabled: home.disabled,
      })),
    },
    show: {
      label: label('show'),
      valueOptions: [
        { value: 'sessions', label: labels.sessions },
        { value: 'runs', label: labels.runs },
        { value: 'both', label: labels.both },
      ],
    },
    coordinator: {
      label: label('coordinator'),
      valueOptions: [{ value: 'coordinator', label: copy.onlyCoordinators }],
    },
    includeInactive: {
      label: label('includeInactive'),
      valueOptions: [{ value: false, label: copy.inactiveHidden }],
    },
    source: {
      label: label('source'),
      valueOptions: [
        { value: 'persisted', label: labels.persistedSource },
        { value: 'direct', label: labels.directSource },
      ],
    },
  };
  for (const id of [
    'underSessionId',
    'bot',
    'machines',
    'owners',
    'branches',
    'updated',
  ]) {
    fields[id] = { label: label(id) };
  }
  const addable = new Set<string>([
    ...SESSION_LIST_CONDITION_GROUPS.work,
    ...SESSION_LIST_CONDITION_GROUPS.people,
    ...SESSION_LIST_CONDITION_GROUPS.kind,
  ]);
  if (input.fixedShow) addable.delete('show');
  if (!input.attentionAvailable) {
    addable.delete('attention');
    addable.delete('coordinator');
  }
  if (!input.inactiveVisibilityAvailable) addable.delete('includeInactive');
  if (!input.sourceAvailable) addable.delete('source');
  // Choosing among Homes needs at least two; one Home is the whole corpus, not a choice.
  if (input.homes.length < 2) addable.delete('homeServerIds');
  return {
    bindings: { fields, ...(input.evaluator ? { evaluator: input.evaluator } : {}) },
    addableFieldIds: addable,
    formatValue: (field, value) => {
      if (field.id === 'agents' && typeof value === 'string') return readSessionListFilterAgentLabel(value);
      if (field.id === 'audiences')
        return (
          audienceLabels.get(
            buildQualifiedAudienceSelectionKey(value as never),
          ) ?? copy.operators.unavailable
        );
      if (field.id === 'includeInactive')
        return value === false ? copy.inactiveHidden : copy.inactiveShown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, JsonValue>;
        const name =
          record.projectKey ??
          record.tagId ??
          record.machineId ??
          record.sectionId ??
          record.accountId;
        if (typeof name === 'string') return name;
      }
      return typeof value === 'string' ? value : key(value);
    }
  };
}

/** The registry's view of the editor's filter: the stored selection, with the effective inactive choice. */
export function toSessionListConditionFilter(
  filters: SessionListViewFilters,
  includeInactive: boolean,
): SessionListFilterV1 {
  const { searchQuery: _searchQuery, ...stored } = filters;
  return { ...stored, includeInactive };
}

export function buildSessionListConditionModel(
  filters: SessionListViewFilters,
  includeInactive: boolean,
  bindings: CollectionConditionBindings,
  valueCounts?: CollectionConditionValueCounts,
): CollectionConditionModel {
  return conditionModelFromFilter(
    sessionWorkFilterFields,
    toSessionListConditionFilter(filters, includeInactive),
    valueCounts ? { ...bindings, valueCounts } : bindings,
  );
}

/**
 * Conditions equal to where the list starts are not drawn (its space, or the context default); Whose
 * always is. Adding such a field edits its row.
 */
export function resolveSessionListBaseConditionFields(
  input: Readonly<{
    filters: SessionListViewFilters;
    base: SessionListViewFilters;
    includeInactive: boolean;
    baseIncludeInactive: boolean;
  }>,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  const filter = toSessionListConditionFilter(
    input.filters,
    input.includeInactive,
  ) as Record<string, unknown>;
  const base = toSessionListConditionFilter(
    input.base,
    input.baseIncludeInactive,
  ) as Record<string, unknown>;
  for (const field of sessionWorkFilterFields) {
    if (SESSION_LIST_LOCKED_CONDITION_FIELDS.has(field.id)) continue;
    if (
      JSON.stringify(filter[field.id] ?? null) ===
      JSON.stringify(base[field.id] ?? null)
    )
      hidden.add(field.id);
  }
  return hidden;
}

/**
 * Applies one editor edit through the Session registry and hands the result to the facet's own writer:
 * Source and inactive visibility have theirs; Clear restores the list's base.
 */
export function applySessionListConditionEdit(
  edit: CollectionConditionEdit,
  input: Readonly<{
    filters: SessionListViewFilters;
    includeInactive: boolean;
    updateFilters(filters: SessionListViewFilters): void;
    setSource(source: SessionListViewFilters['source']): void;
    setIncludeInactive(includeInactive: boolean): void;
    resetFilters(): void;
  }>,
): boolean {
  if (edit.type === 'clear') {
    input.resetFilters();
    return true;
  }
  let next: SessionListFilterV1;
  try {
    next = applyCollectionConditionEdit(
      sessionWorkFilterFields,
      toSessionListConditionFilter(input.filters, input.includeInactive),
      edit,
    );
  } catch {
    return false;
  }
  const nextIncludeInactive = next.includeInactive ?? true;
  // Compare like with like: the registry writes the canonical (normalized) shape.
  const before = normalizeSessionListFilterV1(toSessionListConditionFilter(input.filters, input.includeInactive));
  if (next.source !== before.source) input.setSource(next.source);
  else if (nextIncludeInactive !== input.includeInactive)
    input.setIncludeInactive(nextIncludeInactive);
  else {
    const { includeInactive: _includeInactive, ...rest } = next;
    input.updateFilters({
      ...rest,
      ...(input.filters.includeInactive === undefined
        ? {}
        : { includeInactive: input.filters.includeInactive }),
      searchQuery: input.filters.searchQuery,
    });
  }
  return true;
}

/** A token's ×: that one condition goes back to what the space itself says, through the facet's writer. */
export function restoreSessionListConditionToBase(fieldId: string, input: Readonly<{
  filters: SessionListViewFilters;
  base: SessionListViewFilters;
  baseIncludeInactive: boolean;
  updateFilters(filters: SessionListViewFilters): void;
  setSource(source: SessionListViewFilters['source']): void;
  setIncludeInactive(includeInactive: boolean): void;
}>): void {
  if (fieldId === 'includeInactive') {
    input.setIncludeInactive(input.baseIncludeInactive);
    return;
  }
  if (fieldId === 'source') {
    input.setSource(input.base.source);
    return;
  }
  const facet = fieldId as keyof SessionListViewFilters;
  const next: Record<string, unknown> = { ...input.filters, [facet]: input.base[facet] };
  if (next[facet] === undefined) delete next[facet];
  input.updateFilters(next as SessionListViewFilters);
}
