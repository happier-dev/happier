import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';

import { triageFacetScopeKeyV1, triageScopeFilterKeyV1, triageSourceFilterKeyV1,
  TRIAGE_STATE_FILTER_VALUES_V1, TRIAGE_ATTENTION_FILTER_VALUES_V1,
  type CorpusScopeFilterValueV1, type CorpusSourceFilterValueV1,
  type SurfaceFilterSelectionV1, type TriageListFacetCensusV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { sameTriageFilterValueV1, type TriageFilterFacetValueV1 } from '../state/surface.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';
import { TRIAGE_PR_VIEW_INVENTORY_V1, type TriageListViewInventoryV1 } from '../list/viewInventory.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';
import { sameTriageSourceIdentity as sameSource } from '../../corpus/identity/components.js';

/** Source membership of the active view, before state, attention or text matches individual rows. */
export function planTriageViewSourceSelectionV1(
  filters: SurfaceFilterSelectionV1,
  inventory: TriageListViewInventoryV1,
): (instance: Readonly<{ source: PluginContributionIdentity; sourceInstanceId: string }>) => boolean {
  const matchesConnection = (value: CorpusSourceFilterValueV1,
    instance: Readonly<{ source: PluginContributionIdentity; sourceInstanceId: string }>) =>
    sameSource(value.source, instance.source)
      && (value.sourceInstanceId === undefined || value.sourceInstanceId === instance.sourceInstanceId);
  return instance => inventory.includesSource(instance.source)
    && (filters.sources.length === 0 || filters.sources.some(value => matchesConnection(value, instance)))
    && (filters.types.length === 0 || filters.types.some(value => inventory.includesKind(value)
      && sameSource(value.source, instance.source)))
    && (filters.scopes.length === 0 || filters.scopes.some(value => matchesConnection(value, instance)));
}

/**
 * What the filter rail may offer, discovered from facts this mount already has.
 *
 * `core/SURFACE.md` §6 requires the Source, Type and Scope options to be
 * discovered "only from projected facts under their disclosed coverage" — never
 * from a global census or a provider branch. Two of those five facets are
 * closed source-neutral vocabularies and need no discovery at all; the Source
 * facet is enumerated from the configured set the window snapshot already
 * carries, restricted by the Collection's view inventory. The health strip
 * still names the whole scan's connections.
 *
 * Type comes from the window owner's pre-filter census. Scope combines the
 * source-owned configured selection with that census. The shell never rediscovers them from filtered
 * rows. Active route values are retained beside that census so a constraint
 * remains removable after its source disappears, exactly like Source below.
 *
 * The plan carries both halves of each option: the opaque `key` the public
 * option control takes as its value, and the exact facet value the reducer
 * toggles. That is why nothing here or in the rail ever parses a key back into
 * a value — a second decoder is a second identity, and it would eventually
 * toggle a constraint the reader did not press.
 */

export type TriageFilterFacetIdV1 = TriageFilterFacetValueV1['facet'];

export type TriageFilterOptionV1 = Readonly<{
  /** Opaque, stable, unique across the whole rail. Never parsed back. */
  key: string;
  label: string;
  selected: boolean;
  selection: TriageFilterFacetValueV1;
}>;

export type TriageFilterFacetPlanV1 = Readonly<{
  facet: TriageFilterFacetIdV1;
  label: string;
  options: readonly TriageFilterOptionV1[];
  notices?: readonly string[];
}>;

const ENGLISH_TEXT: TriageTextResolverV1 = (_key, fallback = '') => fallback;
type ReadSourceNameV1 = (source: PluginContributionIdentity) => string | undefined;

/** The four canonical lifecycle facts a reader can filter by. */
const STATE_LABELS = {
  open: ['plugins.triage.surface.filters.state.open', 'Open'],
  done: ['plugins.triage.surface.filters.state.done', 'Done'],
  absent: ['plugins.triage.surface.filters.state.absent', 'No longer at the source'],
  unresolved: ['plugins.triage.surface.filters.state.unresolved', 'Could not be read'],
} satisfies Record<SurfaceFilterSelectionV1['states'][number], readonly [string, string]>;
const STATE_COPY = TRIAGE_STATE_FILTER_VALUES_V1.map(value => [value, ...STATE_LABELS[value]] as const);

/** The one displayed-attention result, as its three canonical levels. */
const ATTENTION_LABELS = {
  required: ['plugins.triage.surface.filters.attention.required', 'Needs you'],
  suggested: ['plugins.triage.surface.filters.attention.suggested', 'Might need you'],
  none: ['plugins.triage.surface.filters.attention.none', 'Nothing for you'],
} satisfies Record<SurfaceFilterSelectionV1['attention'][number], readonly [string, string]>;
const ATTENTION_COPY = TRIAGE_ATTENTION_FILTER_VALUES_V1.map(value => [value, ...ATTENTION_LABELS[value]] as const);

/** Injective over the ordered components, like every other Triage identity key. */
function sourceOptionKey(value: CorpusSourceFilterValueV1): string {
  return `sources:${triageSourceFilterKeyV1(value)}`;
}

/** Contribution-wide Type and retained older filters have no one connection label. */
function sourceLabel(
  source: PluginContributionIdentity,
  configuredSources: TriageListWindowSnapshotV1['configuredSources'],
  readSourceName?: ReadSourceNameV1,
): string {
  const declaredName = readSourceName?.(source);
  if (declaredName) return declaredName;
  const labels = new Set(configuredSources
    .filter((summary) => sameSource(summary.source, source))
    .map((summary) => summary.displayLabel)
    .filter((label): label is string => label !== undefined && label.length > 0));
  const only = labels.size === 1 ? [...labels][0] : undefined;
  return only ?? `${source.pluginId}/${source.localId}`;
}

function instanceLabel(value: CorpusSourceFilterValueV1, configuredSources: TriageListWindowSnapshotV1['configuredSources'],
  readSourceName?: ReadSourceNameV1): string {
  if (value.sourceInstanceId === undefined) return sourceLabel(value.source, configuredSources, readSourceName);
  const summary = configuredSources.find((summary) => summary.sourceInstanceId === value.sourceInstanceId
    && sameSource(summary.source, value.source));
  const label = summary?.displayLabel || `${value.source.pluginId}/${value.source.localId}`;
  const ambiguous = configuredSources.some((candidate) => candidate.sourceInstanceId !== value.sourceInstanceId
    && (candidate.displayLabel || `${candidate.source.pluginId}/${candidate.source.localId}`) === label);
  return summary === undefined || ambiguous ? `${label} · ${value.sourceInstanceId}` : label;
}

function selectedIn(
  filters: SurfaceFilterSelectionV1,
  selection: TriageFilterFacetValueV1,
): boolean {
  if (selection.facet === 'ready') return filters.ready === true;
  const current = (filters[selection.facet] ?? []) as readonly TriageFilterFacetValueV1['value'][];
  return current.some((candidate) => sameTriageFilterValueV1(
    { facet: selection.facet, value: candidate } as TriageFilterFacetValueV1,
    selection,
  ));
}

function planSourceFacet(
  input: Readonly<{
    configuredSources: TriageListWindowSnapshotV1['configuredSources'];
    readSourceName?: ReadSourceNameV1;
    filters: SurfaceFilterSelectionV1;
    inventory: TriageListViewInventoryV1;
  }>,
  text: TriageTextResolverV1,
): TriageFilterFacetPlanV1 {
  const sources: CorpusSourceFilterValueV1[] = [];
  for (const summary of input.configuredSources) {
    if (!input.inventory.includesSource(summary.source)) continue;
    const value = { source: summary.source, sourceInstanceId: summary.sourceInstanceId };
    if (sources.some((seen) => triageSourceFilterKeyV1(seen) === triageSourceFilterKeyV1(value))) continue;
    sources.push(value);
  }
  // A selected source the reader has since unconfigured keeps its option: the
  // constraint is still applied, so removing the only control that clears it
  // would leave a filter with no visible cause (`settings/effectiveView.ts`
  // records the same degradation for a saved view).
  for (const value of input.filters.sources) {
    if (sources.some((seen) => triageSourceFilterKeyV1(seen) === triageSourceFilterKeyV1(value))) continue;
    sources.push(value);
  }
  return Object.freeze({
    facet: 'sources',
    label: text('plugins.triage.surface.filters.source', 'Source'),
    options: Object.freeze(sources.map((value) => {
      const selection = { facet: 'sources', value } as const;
      return Object.freeze({
        key: sourceOptionKey(value),
        label: instanceLabel(value, input.configuredSources, input.readSourceName),
        selected: selectedIn(input.filters, selection),
        selection,
      });
    })),
  });
}

/** Configuration is available before rows; seen facts widen All without another directory read. */
function planScopeFacet(input: Readonly<{
  configuredSources: TriageListWindowSnapshotV1['configuredSources'];
  readSourceName?: ReadSourceNameV1;
  facetCensus?: TriageListFacetCensusV1;
  filters: SurfaceFilterSelectionV1;
  inventory: TriageListViewInventoryV1;
}>, text: TriageTextResolverV1): TriageFilterFacetPlanV1 {
  const values = new Map<string, Readonly<{ value: CorpusScopeFilterValueV1; label: string }>>();
  const notices: string[] = [];
  const add = (value: CorpusScopeFilterValueV1, label: string) => {
    const key = triageScopeFilterKeyV1(value);
    // Task ownership is projected by the source, independently of assignment or edit access.
    const taskLabel = sameSource(value.source, INTERNAL_TASK_SOURCE_V1)
      ? value.unitId === 'shared' ? text('plugins.triage.internal.sharedWithYou', 'Shared with you')
        : value.unitId === 'mine' ? text('plugins.triage.internal.ownedByYou', 'Owned by you') : undefined
      : undefined;
    if (!values.has(key)) values.set(key, { value, label: taskLabel ?? label });
  };
  for (const summary of input.configuredSources) {
    if (!input.inventory.includesSource(summary.source)) continue;
    const projection = summary.scope?.projection;
    const base = { source: summary.source, sourceInstanceId: summary.sourceInstanceId };
    if (projection?.kind === 'failed') {
      notices.push(`${instanceLabel(base, input.configuredSources)}: ${text('plugins.triage.surface.filters.scopesUnavailable',
        'Configured scopes could not be read. Refresh to try again.')}`);
    } else if (projection?.kind === 'page' && projection.status === 'partial') {
      notices.push(`${instanceLabel(base, input.configuredSources)}: ${text('plugins.triage.surface.filters.scopesPartial',
        'Some configured scopes could not be read. Refresh to try again.')}`);
    }
    if (projection?.kind !== 'page') continue;
    if (projection.selection.kind === 'all') {
      add(base, text('plugins.triage.surface.filters.allUnits', 'All {units}')
        .replace('{units}', summary.scope?.unit.pluralLabel ?? ''));
    } else {
      const unitsById = new Map(projection.units.map((unit) => [unit.id, unit]));
      for (const unitId of projection.selection.unitIds) {
        const unit = unitsById.get(unitId);
        add({ ...base, unitId, ...(unit?.collisionScope === undefined ? {} : { collisionScope: unit.collisionScope }) },
          unit?.label ?? unitId);
      }
    }
  }
  for (const seen of input.facetCensus?.scopes ?? []) {
    // An older source may emit only entry collision identity. A configured
    // source-authored join already offers that same scope under its unit name.
    if (seen.unitId === undefined && seen.collisionScope !== undefined && [...values.values()].some(({ value }) =>
      sameSource(value.source, seen.source) && value.collisionScope === seen.collisionScope
      && (seen.sourceInstanceId === undefined || value.sourceInstanceId === seen.sourceInstanceId))) continue;
    add(seen, input.facetCensus?.scopeNames[triageScopeFilterKeyV1(seen)]
      ?? (seen.collisionScope === undefined ? undefined
        : input.facetCensus?.scopeNames[triageFacetScopeKeyV1(seen.source, seen.collisionScope)])
      ?? seen.unitId ?? seen.collisionScope ?? instanceLabel(seen, input.configuredSources));
  }
  for (const active of input.filters.scopes) {
    add(active, active.unitId ?? active.collisionScope ?? instanceLabel(active, input.configuredSources));
  }
  const qualify = new Set([...values.values()].map(({ value }) => triageSourceFilterKeyV1(value))).size > 1;
  return Object.freeze({ facet: 'scopes', label: text('plugins.triage.surface.filters.scope', 'Scope'),
    ...(notices.length === 0 ? {} : { notices: Object.freeze(notices) }),
    options: Object.freeze([...values.entries()].map(([key, { value, label }]) => {
      const selection = { facet: 'scopes', value } as const;
      const connection = instanceLabel(value, input.configuredSources);
      const qualifier = value.sourceInstanceId === undefined
        ? sourceLabel(value.source, input.configuredSources, input.readSourceName) : connection;
      return Object.freeze({ key: `scopes:${key}`,
        label: qualify && label !== connection && label !== qualifier ? `${label} — ${qualifier}` : label,
        selected: selectedIn(input.filters, selection), selection });
    })),
  });
}

/**
 * Type choices from the window owner's pre-filter census.
 *
 * The census supplies every value observed under its disclosed coverage, so a
 * selected value cannot erase the alternatives that would widen the lens. A
 * selected route value absent from the current census is retained as well: the
 * reader can remove a stale constraint after a source disappears instead of
 * being trapped by an invisible filter.
 *
 * The value's own name is the label. It is qualified by the source exactly when
 * the selected values span more than one, because two options reading `issue`
 * are two constraints a reader cannot tell apart — the same "one name or the
 * qualified one" rule `sourceLabel` applies a few lines above.
 */
function planCensusFacet<TFacet extends 'types' | 'scopes'>(
  facet: TFacet,
  facetLabelKey: string,
  facetLabelFallback: string,
  readValueName: (value: SurfaceFilterSelectionV1[TFacet][number]) => string,
  readValueLabel: (value: SurfaceFilterSelectionV1[TFacet][number]) => string,
  input: Readonly<{
    configuredSources: TriageListWindowSnapshotV1['configuredSources'];
    readSourceName?: ReadSourceNameV1;
    facetCensus?: TriageListFacetCensusV1;
    filters: SurfaceFilterSelectionV1;
  }>,
  text: TriageTextResolverV1,
): TriageFilterFacetPlanV1 {
  const values: SurfaceFilterSelectionV1[TFacet][number][] = [
    ...((input.facetCensus?.[facet] ?? []) as readonly SurfaceFilterSelectionV1[TFacet][number][]),
  ];
  for (const active of input.filters[facet] as readonly SurfaceFilterSelectionV1[TFacet][number][]) {
    const selection = { facet, value: active } as TriageFilterFacetValueV1;
    if (values.some((value) => sameTriageFilterValueV1(
      { facet, value } as TriageFilterFacetValueV1,
      selection,
    ))) continue;
    values.push(active);
  }
  const sources: PluginContributionIdentity[] = [];
  for (const value of values) {
    if (sources.some((seen) => sameSource(seen, value.source))) continue;
    sources.push(value.source);
  }
  const qualify = sources.length > 1;
  return Object.freeze({
    facet,
    label: text(facetLabelKey, facetLabelFallback),
    options: Object.freeze(values.map((value) => {
      // The key names the protocol identity; only the label is for reading.
      const label = readValueLabel(value);
      return Object.freeze({
        key: `${facet}:${JSON.stringify([value.source.pluginId, value.source.localId, readValueName(value)])}`,
        label: qualify ? `${label} — ${sourceLabel(value.source, input.configuredSources, input.readSourceName)}` : label,
        selected: selectedIn(input.filters, { facet, value } as TriageFilterFacetValueV1),
        selection: { facet, value } as TriageFilterFacetValueV1,
      });
    })),
  });
}

function planClosedFacet<TFacet extends 'states' | 'attention'>(
  facet: TFacet,
  facetLabelKey: string,
  facetLabelFallback: string,
  copy: readonly (readonly [SurfaceFilterSelectionV1[TFacet][number], string, string])[],
  filters: SurfaceFilterSelectionV1,
  text: TriageTextResolverV1,
): TriageFilterFacetPlanV1 {
  return Object.freeze({
    facet,
    label: text(facetLabelKey, facetLabelFallback),
    options: Object.freeze(copy.map(([value, key, fallback]) => {
      const selection = { facet, value } as TriageFilterFacetValueV1;
      return Object.freeze({
        key: `${facet}:${value}`,
        label: text(key, fallback),
        selected: selectedIn(filters, selection),
        selection,
      });
    })),
  });
}

/**
 * Ready on Tasks (work-loop R3 `ready:F`): one choice, decided by the protocol's task readiness fact through the window
 * matcher, never re-derived here. Other pages list sources that have no claim, so they are not offered it.
 */
function planReadyFacet(filters: SurfaceFilterSelectionV1, text: TriageTextResolverV1): TriageFilterFacetPlanV1 | null {
  if (filters.tasks === undefined && filters.ready === undefined) return null;
  const selection = { facet: 'ready', value: true } as const;
  return Object.freeze({
    facet: 'ready',
    label: text('plugins.triage.surface.filters.ready', 'Ready'),
    options: Object.freeze([Object.freeze({
      key: 'ready:true',
      label: text('plugins.triage.surface.filters.ready.claimable', 'Ready to take'),
      selected: selectedIn(filters, selection),
      selection,
    })]),
  });
}

/** Labels the window's census saw (`G8′`), then any selected label it no longer sees, so the constraint stays removable. */
function planLabelFacet(
  input: Readonly<{ facetCensus?: TriageListFacetCensusV1; filters: SurfaceFilterSelectionV1 }>,
  text: TriageTextResolverV1,
): TriageFilterFacetPlanV1 {
  const labels = [...(input.facetCensus?.labels ?? [])];
  for (const active of input.filters.labels ?? []) if (!labels.includes(active)) labels.push(active);
  return Object.freeze({
    facet: 'labels',
    label: text('plugins.triage.surface.filters.label', 'Label'),
    options: Object.freeze(labels.map((value) => {
      const selection = { facet: 'labels', value } as const;
      return Object.freeze({ key: `labels:${JSON.stringify(value)}`, label: value,
        selected: selectedIn(input.filters, selection), selection });
    })),
  });
}

export function planTriageFilterFacetsV1(
  input: Readonly<{
    configuredSources: TriageListWindowSnapshotV1['configuredSources'];
    facetCensus?: TriageListFacetCensusV1;
    filters: SurfaceFilterSelectionV1;
    /** Source descriptor already held by the mounted list; never a directory read. */
    readSourceName?: ReadSourceNameV1;
    /** A kind's declared display name, from its source's descriptor; the kind id when the source declares none. */
    readKindName?: (source: PluginContributionIdentity, kindId: string) => string | undefined;
    /** The Collection's view inventory, not the rows left after a facet or audience narrows it. */
    inventory?: TriageListViewInventoryV1;
  }>,
  text: TriageTextResolverV1 = ENGLISH_TEXT,
): readonly TriageFilterFacetPlanV1[] {
  const inventory = input.inventory ?? TRIAGE_PR_VIEW_INVENTORY_V1;
  const discovered = { ...input, inventory,
    ...(input.facetCensus === undefined ? {} : { facetCensus: { ...input.facetCensus,
      types: input.facetCensus.types.filter(inventory.includesKind),
      scopes: input.facetCensus.scopes.filter(scope => inventory.includesSource(scope.source)),
    } }),
  };
  // Selected constraints remain removable even when outside this view or no longer configured.
  // Discovery is view-scoped; the existing facet owners retain only those explicit active values.
  const ready = planReadyFacet(input.filters, text);
  return Object.freeze([
    ...(ready === null ? [] : [ready]),
    planLabelFacet(input, text),
    planSourceFacet(discovered, text),
    planCensusFacet(
      'types',
      'plugins.triage.surface.filters.type',
      'Type',
      (value) => value.kindId,
      (value) => input.readKindName?.(value.source, value.kindId) ?? value.kindId,
      discovered,
      text,
    ),
    planScopeFacet(discovered, text),
    planClosedFacet(
      'states',
      'plugins.triage.surface.filters.state',
      'State',
      STATE_COPY,
      input.filters,
      text,
    ),
    planClosedFacet(
      'attention',
      'plugins.triage.surface.filters.attention',
      'Attention',
      ATTENTION_COPY,
      input.filters,
      text,
    ),
  ]);
}

/** How many values are in force: the funnel's name says it, and the token line under the field says each one. */
export function readTriageRefineCountV1(facets: readonly TriageFilterFacetPlanV1[]): number {
  return facets.reduce((count, facet) => count + facet.options.filter((option) => option.selected).length, 0);
}
