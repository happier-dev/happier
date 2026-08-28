import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';

import type { SurfaceFilterSelectionV1, TriageListFacetCensusV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { sameTriageFilterValueV1, type TriageFilterFacetValueV1 } from '../state/surface.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';

/**
 * What the filter rail may offer, discovered from facts this mount already has.
 *
 * `core/SURFACE.md` §6 requires the Source, Type and Scope options to be
 * discovered "only from projected facts under their disclosed coverage" — never
 * from a global census or a provider branch. Two of those five facets are
 * closed source-neutral vocabularies and need no discovery at all; the Source
 * facet is enumerated from the configured set the window snapshot already
 * carries, which is the same unfiltered fact the health strip names connections
 * from.
 *
 * Type and Scope come only from the window owner's pre-filter census, under the
 * census's disclosed coverage. The shell never rediscovers them from filtered
 * rows. Active route values are retained beside that census so a constraint
 * remains removable after its source disappears, exactly like Source below.
 *
 * The plan carries both halves of each option: the opaque `key` the public
 * option control takes as its value, and the exact facet value the reducer
 * toggles. That is why nothing here or in the rail ever parses a key back into
 * a value — a second decoder is a second identity, and it would eventually
 * toggle a constraint the reader did not press.
 */

export type TriageFilterFacetIdV1 = 'sources' | 'types' | 'scopes' | 'states' | 'attention';

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
}>;

const ENGLISH_TEXT: TriageTextResolverV1 = (_key, fallback = '') => fallback;

/** The four canonical lifecycle facts a reader can filter by. */
const STATE_COPY: readonly (readonly [SurfaceFilterSelectionV1['states'][number], string, string])[] = [
  ['open', 'plugins.triage.surface.filters.state.open', 'Open'],
  ['done', 'plugins.triage.surface.filters.state.done', 'Done'],
  ['absent', 'plugins.triage.surface.filters.state.absent', 'No longer at the source'],
  ['unresolved', 'plugins.triage.surface.filters.state.unresolved', 'Could not be read'],
];

/** The one displayed-attention result, as its three canonical levels. */
const ATTENTION_COPY: readonly (readonly [SurfaceFilterSelectionV1['attention'][number], string, string])[] = [
  ['required', 'plugins.triage.surface.filters.attention.required', 'Needs you'],
  ['suggested', 'plugins.triage.surface.filters.attention.suggested', 'Might need you'],
  ['none', 'plugins.triage.surface.filters.attention.none', 'Nothing for you'],
];

function sameSource(left: PluginContributionIdentity, right: PluginContributionIdentity): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

/** Injective over the ordered components, like every other Triage identity key. */
function sourceOptionKey(source: PluginContributionIdentity): string {
  return `sources:${JSON.stringify([source.pluginId, source.localId])}`;
}

/**
 * The name to show for one source facet value.
 *
 * A facet value names a source **contribution**, while a `displayLabel` names one
 * configured **connection**. Borrowing a label when several connections share the
 * source would tell the reader this option filters to that one connection, so the
 * qualified contribution id answers instead — the same fallback the health strip
 * already uses. The source's own declared display name is not available to this
 * plan: it lives in the contributor's descriptor, which the detail read carries
 * per *entry* because thirty-two descriptors do not fit under the aggregate list
 * Action's byte gate (`actions/entryDetailProtocol.ts`).
 */
function sourceLabel(
  source: PluginContributionIdentity,
  configuredSources: TriageListWindowSnapshotV1['configuredSources'],
): string {
  const labels = new Set(configuredSources
    .filter((summary) => sameSource(summary.source, source))
    .map((summary) => summary.displayLabel)
    .filter((label): label is string => label !== undefined && label.length > 0));
  const only = labels.size === 1 ? [...labels][0] : undefined;
  return only ?? `${source.pluginId}/${source.localId}`;
}

function selectedIn(
  filters: SurfaceFilterSelectionV1,
  selection: TriageFilterFacetValueV1,
): boolean {
  const current = filters[selection.facet] as readonly TriageFilterFacetValueV1['value'][];
  return current.some((candidate) => sameTriageFilterValueV1(
    { facet: selection.facet, value: candidate } as TriageFilterFacetValueV1,
    selection,
  ));
}

function planSourceFacet(
  input: Readonly<{
    configuredSources: TriageListWindowSnapshotV1['configuredSources'];
    filters: SurfaceFilterSelectionV1;
  }>,
  text: TriageTextResolverV1,
): TriageFilterFacetPlanV1 {
  const sources: PluginContributionIdentity[] = [];
  for (const summary of input.configuredSources) {
    if (sources.some((seen) => sameSource(seen, summary.source))) continue;
    sources.push(summary.source);
  }
  // A selected source the reader has since unconfigured keeps its option: the
  // constraint is still applied, so removing the only control that clears it
  // would leave a filter with no visible cause (`settings/effectiveView.ts`
  // records the same degradation for a saved view).
  for (const value of input.filters.sources) {
    if (sources.some((seen) => sameSource(seen, value.source))) continue;
    sources.push(value.source);
  }
  return Object.freeze({
    facet: 'sources',
    label: text('plugins.triage.surface.filters.source', 'Source'),
    options: Object.freeze(sources.map((source) => {
      const selection = { facet: 'sources', value: { source } } as const;
      return Object.freeze({
        key: sourceOptionKey(source),
        label: sourceLabel(source, input.configuredSources),
        selected: selectedIn(input.filters, selection),
        selection,
      });
    })),
  });
}

/**
 * One Type or Scope facet, planned from the window owner's pre-filter census.
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
  input: Readonly<{
    configuredSources: TriageListWindowSnapshotV1['configuredSources'];
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
      const name = readValueName(value);
      return Object.freeze({
        key: `${facet}:${JSON.stringify([value.source.pluginId, value.source.localId, name])}`,
        label: qualify ? `${name} — ${sourceLabel(value.source, input.configuredSources)}` : name,
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

export function planTriageFilterFacetsV1(
  input: Readonly<{
    configuredSources: TriageListWindowSnapshotV1['configuredSources'];
    facetCensus?: TriageListFacetCensusV1;
    filters: SurfaceFilterSelectionV1;
  }>,
  text: TriageTextResolverV1 = ENGLISH_TEXT,
): readonly TriageFilterFacetPlanV1[] {
  return Object.freeze([
    planSourceFacet(input, text),
    planCensusFacet(
      'types',
      'plugins.triage.surface.filters.type',
      'Type',
      (value) => value.kindId,
      input,
      text,
    ),
    planCensusFacet(
      'scopes',
      'plugins.triage.surface.filters.scope',
      'Scope',
      (value) => value.collisionScope,
      input,
      text,
    ),
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
