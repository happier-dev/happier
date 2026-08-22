import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';

import type { SurfaceFilterSelectionV1 } from '../../projection/listWindow.js';
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
 * **Type and Scope are not DISCOVERED here, and the reason is a producer rather
 * than a preference.** The only projected facts a mounted surface can see are
 * `TriageListWindowV1.rows`, and
 * `projection/listWindow.ts#foldTriageListWindow` applies the facet conjunction
 * *before* it publishes them. Discovering options from that set would trap the
 * reader inside their first choice: selecting one kind leaves only that kind's
 * rows, so the option that would widen the filter again no longer exists. The
 * honest producer is the window owner publishing the facet census it observed
 * before filtering — one owner, one coverage claim — which is
 * `U-CORPUS-QUERY-ORDERING`'s (`core/CORPUS.md` §6.1). A rail that offered a
 * control the reader could not undo would be worse than a rail that says which
 * facets it can honestly answer for.
 *
 * **They are still planned when they are ACTIVE**, which is a different fact
 * from discovery and needs no census. A route carries both facets
 * (`ui/navigation/location.ts` writes `ft,` and `fp,` segments) and the window
 * applies them, so a reader can arrive at a narrowed list whose only cause is a
 * constraint nothing on screen names. Planning exactly the reader's own live
 * values — never a wider set — makes the constraint visible and removable
 * without inventing an option the fold cannot honestly offer. It is the same
 * rule `planSourceFacet` already applies to a selected source the reader has
 * since unconfigured, so there is one reason here rather than two.
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
 * One Type or Scope facet, planned from the reader's own live constraints.
 *
 * There is no census to enumerate from, so the option set is exactly what is
 * selected: every option is `selected`, and deselecting one is the only move it
 * offers. That is honest in both directions — it never claims a value the fold
 * did not observe, and it never leaves an applied constraint without a control.
 * With nothing selected the option list is empty and the rail renders no
 * control at all, which is the same rule a facet with nothing to offer already
 * follows.
 *
 * The value's own name is the label. It is qualified by the source exactly when
 * the selected values span more than one, because two options reading `issue`
 * are two constraints a reader cannot tell apart — the same "one name or the
 * qualified one" rule `sourceLabel` applies a few lines above.
 */
function planActiveFacet<TFacet extends 'types' | 'scopes'>(
  facet: TFacet,
  facetLabelKey: string,
  facetLabelFallback: string,
  readValueName: (value: SurfaceFilterSelectionV1[TFacet][number]) => string,
  input: Readonly<{
    configuredSources: TriageListWindowSnapshotV1['configuredSources'];
    filters: SurfaceFilterSelectionV1;
  }>,
  text: TriageTextResolverV1,
): TriageFilterFacetPlanV1 {
  const values = input.filters[facet] as readonly SurfaceFilterSelectionV1[TFacet][number][];
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
        selected: true,
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
    filters: SurfaceFilterSelectionV1;
  }>,
  text: TriageTextResolverV1 = ENGLISH_TEXT,
): readonly TriageFilterFacetPlanV1[] {
  return Object.freeze([
    planSourceFacet(input, text),
    planActiveFacet(
      'types',
      'plugins.triage.surface.filters.type',
      'Type',
      (value) => value.kindId,
      input,
      text,
    ),
    planActiveFacet(
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
