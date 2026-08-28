import { describe, expect, it } from 'vitest';

import { TRIAGE_LIST_NO_FILTERS_V1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { planTriageFilterFacetsV1 } from './plan.js';

const GITHUB = { pluginId: 'happier.scm-github', localId: 'github' } as const;
const SENTRY = { pluginId: 'happier.sentry', localId: 'sentry' } as const;

function configured(
  source: Readonly<{ pluginId: string; localId: string }>,
  sourceInstanceId: string,
  displayLabel?: string,
): TriageListWindowSnapshotV1['configuredSources'][number] {
  return {
    sourceInstanceId,
    source,
    ...(displayLabel === undefined ? {} : { displayLabel }),
    available: true,
  } as TriageListWindowSnapshotV1['configuredSources'][number];
}

function facetOf(
  plan: readonly ReturnType<typeof planTriageFilterFacetsV1>[number][],
  facet: string,
) {
  const found = plan.find((candidate) => candidate.facet === facet);
  if (found === undefined) throw new Error(`No ${facet} facet was planned.`);
  return found;
}

describe('the filter rail facet plan', () => {
  it('offers one option per configured connection under the reader own name for it', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [
        configured(GITHUB, 'instance-1', 'acme/widgets'),
        configured(SENTRY, 'instance-2', 'acme errors'),
      ],
      filters: TRIAGE_LIST_NO_FILTERS_V1,
    });

    expect(facetOf(plan, 'sources').options.map((option) => option.label))
      .toEqual(['acme/widgets', 'acme errors']);
    expect(facetOf(plan, 'sources').options.map((option) => option.selection.value))
      .toEqual([{ source: GITHUB }, { source: SENTRY }]);
  });

  it('names a source by its qualified contribution id when one name cannot answer for it', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [
        configured(GITHUB, 'instance-1', 'acme/widgets'),
        configured(GITHUB, 'instance-2', 'acme/api'),
      ],
      filters: TRIAGE_LIST_NO_FILTERS_V1,
    });

    // One facet value covers both connections, so borrowing either label would
    // tell the reader this option filters to that one connection.
    expect(facetOf(plan, 'sources').options).toHaveLength(1);
    expect(facetOf(plan, 'sources').options[0]?.label).toBe('happier.scm-github/github');
  });

  it('keeps offering a selected source the reader has since unconfigured', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [configured(SENTRY, 'instance-2', 'acme errors')],
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, sources: [{ source: GITHUB }] },
    });

    const options = facetOf(plan, 'sources').options;
    // Without this the constraint is still applied and the control that would
    // remove it is gone, so the reader is trapped inside a filter they cannot
    // see the source of.
    expect(options.map((option) => option.label))
      .toEqual(['acme errors', 'happier.scm-github/github']);
    expect(options.find((option) => option.label === 'happier.scm-github/github')?.selected)
      .toBe(true);
  });

  it('enumerates the two closed facets whole so a value stays reachable at any filter', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [],
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, states: ['done'], attention: ['none'] },
    });

    expect(facetOf(plan, 'states').options.map((option) => option.selection.value))
      .toEqual(['open', 'done', 'absent', 'unresolved']);
    expect(facetOf(plan, 'attention').options.map((option) => option.selection.value))
      .toEqual(['required', 'suggested', 'none']);
    expect(facetOf(plan, 'states').options.filter((option) => option.selected)
      .map((option) => option.selection.value)).toEqual(['done']);
    expect(facetOf(plan, 'attention').options.filter((option) => option.selected)
      .map((option) => option.selection.value)).toEqual(['none']);
  });

  it('shows an active Type or Scope constraint so the reader can still remove it', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [configured(GITHUB, 'instance-1', 'acme/widgets')],
      filters: {
        ...TRIAGE_LIST_NO_FILTERS_V1,
        types: [{ source: GITHUB, kindId: 'pull-request' }],
        scopes: [{ source: GITHUB, collisionScope: 'acme/widgets' }],
      },
    });

    // A route can carry either facet, and the window applies it. Without a
    // control the reader sees a narrowed list, no cause for it, and no way out.
    expect(facetOf(plan, 'types').options.map((option) => [option.label, option.selected]))
      .toEqual([['pull-request', true]]);
    expect(facetOf(plan, 'types').options[0]?.selection)
      .toEqual({ facet: 'types', value: { source: GITHUB, kindId: 'pull-request' } });
    expect(facetOf(plan, 'scopes').options.map((option) => [option.label, option.selected]))
      .toEqual([['acme/widgets', true]]);
    expect(facetOf(plan, 'scopes').options[0]?.selection)
      .toEqual({ facet: 'scopes', value: { source: GITHUB, collisionScope: 'acme/widgets' } });
  });

  it('offers no Type or Scope control while neither facet constrains the window', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [configured(GITHUB, 'instance-1', 'acme/widgets')],
      filters: TRIAGE_LIST_NO_FILTERS_V1,
    });

    // Nothing is discovered for these two: the only honest options are the
    // reader's own live constraints, and with none the rail offers no control.
    expect(facetOf(plan, 'types').options).toEqual([]);
    expect(facetOf(plan, 'scopes').options).toEqual([]);
  });

  it('offers the pre-filter Type and Scope census even after the active lens excludes its rows', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [configured(GITHUB, 'instance-1', 'acme/widgets')],
      facetCensus: {
        types: [
          { source: GITHUB, kindId: 'issue' },
          { source: GITHUB, kindId: 'pull-request' },
        ],
        scopes: [
          { source: GITHUB, collisionScope: 'acme/api' },
          { source: GITHUB, collisionScope: 'acme/widgets' },
        ],
        coverage: 'partial',
      },
      filters: {
        ...TRIAGE_LIST_NO_FILTERS_V1,
        types: [{ source: GITHUB, kindId: 'pull-request' }],
        scopes: [{ source: GITHUB, collisionScope: 'acme/widgets' }],
      },
    });

    expect(facetOf(plan, 'types').options.map((option) => [option.label, option.selected]))
      .toEqual([['issue', false], ['pull-request', true]]);
    expect(facetOf(plan, 'scopes').options.map((option) => [option.label, option.selected]))
      .toEqual([['acme/api', false], ['acme/widgets', true]]);
  });

  it('names the source of an active Type when two sources constrain the same kind', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [
        configured(GITHUB, 'instance-1', 'acme/widgets'),
        configured(SENTRY, 'instance-2', 'acme errors'),
      ],
      filters: {
        ...TRIAGE_LIST_NO_FILTERS_V1,
        types: [
          { source: GITHUB, kindId: 'issue' },
          { source: SENTRY, kindId: 'issue' },
        ],
      },
    });

    // Two identically labelled options are two constraints the reader cannot
    // tell apart, so the source qualifies the name exactly when it has to.
    expect(facetOf(plan, 'types').options.map((option) => option.label))
      .toEqual(['issue — acme/widgets', 'issue — acme errors']);
  });

  it('gives every option a key unique across the whole rail', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [configured(GITHUB, 'instance-1', 'acme/widgets')],
      filters: TRIAGE_LIST_NO_FILTERS_V1,
    });
    const keys = plan.flatMap((facet) => facet.options.map((option) => option.key));

    // The rail passes these to one option control per facet and looks the
    // selection back up by key; a collision would toggle the wrong constraint.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves every label through the host catalog rather than shipping English', () => {
    const plan = planTriageFilterFacetsV1(
      { configuredSources: [], filters: TRIAGE_LIST_NO_FILTERS_V1 },
      (key) => `translated:${key}`,
    );

    expect(facetOf(plan, 'states').label).toBe('translated:plugins.triage.surface.filters.state');
    expect(facetOf(plan, 'states').options[0]?.label)
      .toBe('translated:plugins.triage.surface.filters.state.open');
  });
});
