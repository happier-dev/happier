import { describe, expect, it } from 'vitest';

import { TRIAGE_LIST_NO_FILTERS_V1, triageFacetScopeKeyV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { planTriageFilterFacetsV1, readTriageRefineCountV1 } from './plan.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';
import { planTriageTaskViewInventoryV1 } from '../list/viewInventory.js';
import { TriageSourceDescriptorV1Schema } from '@happier-dev/triage-protocol/v1';

const GITHUB = { pluginId: 'happier.scm-github', localId: 'github' } as const;
const SENTRY = { pluginId: 'happier.sentry', localId: 'sentry' } as const;

function configured(
  source: Readonly<{ pluginId: string; localId: string }>,
  sourceInstanceId: string,
  displayLabel?: string,
): TriageListWindowSnapshotV1['configuredSources'][number] {
  return {
    sourceInstanceId, configurationRowId: sourceInstanceId,
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
  it('offers the census labels as a Label facet and keeps an active label removable after it leaves the census (G8′)', () => {
    const census = { types: [], scopes: [], scopeNames: {}, labels: ['agent-ok', 'payments'], coverage: 'complete' as const };
    const plan = planTriageFilterFacetsV1({
      configuredSources: [configured(INTERNAL_TASK_SOURCE_V1, 'tasks', 'Happier tasks')],
      facetCensus: census,
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, tasks: 'everyone', labels: ['agent-ok', 'infra'] },
    });
    expect(facetOf(plan, 'labels').options.map(option => [option.label, option.selected]))
      .toEqual([['agent-ok', true], ['payments', false], ['infra', true]]);
    expect(readTriageRefineCountV1(plan)).toBe(2);
  });

  it('offers Ready on Tasks only, as one claimable choice that reads as selected from the lens', () => {
    const configuredSources = [configured(INTERNAL_TASK_SOURCE_V1, 'tasks', 'Happier tasks')];
    expect(planTriageFilterFacetsV1({ configuredSources, filters: TRIAGE_LIST_NO_FILTERS_V1 })
      .some(facet => facet.facet === 'ready')).toBe(false);
    const off = facetOf(planTriageFilterFacetsV1({ configuredSources,
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, tasks: 'everyone' } }), 'ready');
    expect(off.options.map(option => [option.label, option.selected])).toEqual([['Ready to take', false]]);
    const on = planTriageFilterFacetsV1({ configuredSources,
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, tasks: 'everyone', ready: true } });
    expect(facetOf(on, 'ready').options[0]?.selected).toBe(true);
    expect(readTriageRefineCountV1(on)).toBe(1);
  });

  it('names retained task ownership scopes without relabeling another source unit', () => {
    const scopes = [
      { source: INTERNAL_TASK_SOURCE_V1, sourceInstanceId: 'tasks', unitId: 'shared' },
      { source: INTERNAL_TASK_SOURCE_V1, sourceInstanceId: 'tasks', unitId: 'mine' },
      { source: GITHUB, sourceInstanceId: 'github', unitId: 'shared' },
    ];
    const plan = planTriageFilterFacetsV1({
      configuredSources: [configured(INTERNAL_TASK_SOURCE_V1, 'tasks', 'Happier tasks'), configured(GITHUB, 'github', 'GitHub')],
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, scopes },
    });
    expect(facetOf(plan, 'scopes').options.map(option => [option.label, option.selected]))
      .toEqual([['Shared with you — Happier tasks', true], ['Owned by you — Happier tasks', true],
        ['shared — GitHub', true]]);
  });
  it('uses source names for ambiguous types and avoids repeating a scope name as its connection', () => {
    const sourceName = (source: Readonly<{ pluginId: string; localId: string }>) => source.pluginId === GITHUB.pluginId ? 'GitHub' : 'Sentry';
    const plan = planTriageFilterFacetsV1({
      configuredSources: [configured(GITHUB, 'github', 'leeroybrun'), configured(SENTRY, 'sentry', 'Happier errors')],
      facetCensus: { types: [{ source: GITHUB, kindId: 'issue' }, { source: SENTRY, kindId: 'issue' }],
        scopes: [{ source: GITHUB, collisionScope: 'repo' }, { source: SENTRY, collisionScope: 'project' }],
        scopeNames: { [triageFacetScopeKeyV1(GITHUB, 'repo')]: 'acme/widgets',
          [triageFacetScopeKeyV1(SENTRY, 'project')]: 'Happier errors' }, coverage: 'complete' },
      filters: TRIAGE_LIST_NO_FILTERS_V1,
      readSourceName: sourceName,
      readKindName: () => 'Issue',
    });
    expect(facetOf(plan, 'types').options.map(option => option.label)).toEqual(['Issue — GitHub', 'Issue — Sentry']);
    expect(facetOf(plan, 'scopes').options.map(option => option.label))
      .toEqual(['acme/widgets — GitHub', 'Happier errors']);
  });

  it('offers only the PR view inventory, while retaining selected personal constraints for removal', () => {
    const personalType = { source: INTERNAL_TASK_SOURCE_V1, kindId: 'task' };
    const personalScope = { source: INTERNAL_TASK_SOURCE_V1, collisionScope: 'personal' };
    const input = {
      configuredSources: [configured(GITHUB, 'github', 'GitHub'),
        configured(INTERNAL_TASK_SOURCE_V1, 'personal', 'Happier tasks')],
      facetCensus: { types: [{ source: GITHUB, kindId: 'issue' }, personalType],
        scopes: [{ source: GITHUB, collisionScope: 'repo' }, personalScope], scopeNames: {}, coverage: 'partial' as const },
      filters: TRIAGE_LIST_NO_FILTERS_V1,
    };
    const plan = planTriageFilterFacetsV1(input);
    expect(facetOf(plan, 'sources').options.map(option => option.selection.value))
      .toEqual([{ source: GITHUB, sourceInstanceId: 'github' }]);
    expect(facetOf(plan, 'types').options.map(option => option.selection.value))
      .toEqual([{ source: GITHUB, kindId: 'issue' }]);
    expect(facetOf(plan, 'scopes').options.map(option => option.selection.value))
      .toEqual([{ source: GITHUB, collisionScope: 'repo' }]);
    const constrained = planTriageFilterFacetsV1({ ...input, filters: { ...input.filters,
      sources: [{ source: INTERNAL_TASK_SOURCE_V1, sourceInstanceId: 'personal' }],
      types: [personalType], scopes: [personalScope] } });
    for (const facet of ['sources', 'types', 'scopes']) {
      expect(facetOf(constrained, facet).options.filter(option => option.selected)).toHaveLength(1);
    }
    expect(facetOf(constrained, 'sources').options.find(option => option.selected)?.label).toBe('Happier tasks');
    const kinds = TriageSourceDescriptorV1Schema.parse({ v: 1, purpose: 'tracker', displayName: 'Tracker', kinds: [
      { id: 'issue', displayName: 'Issue', pluralDisplayName: 'Issues', workflowSubject: 'issue', task: true },
      { id: 'pull-request', displayName: 'Pull request', pluralDisplayName: 'Pull requests', workflowSubject: 'pullRequest' },
    ] }).kinds;
    const personalKinds = TriageSourceDescriptorV1Schema.parse({ v: 1, purpose: 'tasks', displayName: 'Personal', kinds: [
      { id: 'task', displayName: 'Task', pluralDisplayName: 'Tasks', workflowSubject: 'issue', task: true },
    ] }).kinds;
    const taskPlan = planTriageFilterFacetsV1({ ...input,
      inventory: planTriageTaskViewInventoryV1(source => source.pluginId === GITHUB.pluginId ? kinds : personalKinds),
      facetCensus: { ...input.facetCensus, types: [...input.facetCensus.types, { source: GITHUB, kindId: 'pull-request' }] },
    });
    expect(facetOf(taskPlan, 'sources').options.map(option => option.selection.value))
      .toEqual(input.configuredSources.map(summary => ({ source: summary.source, sourceInstanceId: summary.sourceInstanceId })));
    expect(facetOf(taskPlan, 'types').options.map(option => option.selection.value))
      .toEqual([{ source: GITHUB, kindId: 'issue' }, personalType]);
  });
  it('retains seen alternatives and discloses failed configured scope projection', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [{ ...configured(GITHUB, 'instance-1', 'Work account'), scope: {
        unit: { singularLabel: 'Repository', pluralLabel: 'repositories' },
        projection: { kind: 'failed', failure: { class: 'unknown', code: 'scope_read_failed' } },
      } }],
      facetCensus: { types: [], scopes: [{ source: GITHUB, collisionScope: 'github:1' }],
        scopeNames: { [triageFacetScopeKeyV1(GITHUB, 'github:1')]: 'acme/widgets' }, coverage: 'partial' },
      filters: TRIAGE_LIST_NO_FILTERS_V1,
    });
    expect(facetOf(plan, 'scopes').options.map((option) => option.label)).toEqual(['acme/widgets']);
    expect(facetOf(plan, 'scopes').notices).toEqual(['Work account: Configured scopes could not be read. Refresh to try again.']);
  });

  it('distinguishes identically named instances and keeps retired exact constraints removable', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [configured(GITHUB, 'instance-1', 'GitHub'), configured(GITHUB, 'instance-2', 'GitHub')],
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, sources: [{ source: GITHUB, sourceInstanceId: 'retired' }] },
    });
    const options = facetOf(plan, 'sources').options;
    expect(new Set(options.map((option) => option.label)).size).toBe(3);
    expect(options.find((option) => option.selected)?.selection.value).toEqual({ source: GITHUB, sourceInstanceId: 'retired' });
  });

  it('offers configured units and an all placeholder before any source items load', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [
        { ...configured(GITHUB, 'instance-1', 'Work account'), scope: {
          unit: { singularLabel: 'Repository', pluralLabel: 'repositories' },
          projection: { kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['repo-1', 'repo-2'] },
            units: [{ id: 'repo-1', label: 'acme/widgets', collisionScope: 'github:1' }, { id: 'repo-2', label: 'acme/api' }] },
        } },
        { ...configured(GITHUB, 'instance-2', 'Personal account'), scope: {
          unit: { singularLabel: 'Repository', pluralLabel: 'repositories' },
          projection: { kind: 'page', status: 'complete', selection: { kind: 'all' }, units: [] },
        } },
      ],
      filters: TRIAGE_LIST_NO_FILTERS_V1,
    });
    const options = facetOf(plan, 'scopes').options;
    expect(options.map((option) => option.label)).toEqual([
      'acme/widgets — Work account', 'acme/api — Work account', 'All repositories — Personal account',
    ]);
    expect(options.map((option) => option.selection.value)).toEqual([
      { source: GITHUB, sourceInstanceId: 'instance-1', unitId: 'repo-1', collisionScope: 'github:1' },
      { source: GITHUB, sourceInstanceId: 'instance-1', unitId: 'repo-2' },
      { source: GITHUB, sourceInstanceId: 'instance-2' },
    ]);
  });

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
      .toEqual([{ source: GITHUB, sourceInstanceId: 'instance-1' }, { source: SENTRY, sourceInstanceId: 'instance-2' }]);
  });

  it('offers distinct named options for two configured instances of the same source', () => {
    const plan = planTriageFilterFacetsV1({
      configuredSources: [
        configured(GITHUB, 'instance-1', 'acme/widgets'),
        configured(GITHUB, 'instance-2', 'acme/api'),
      ],
      filters: TRIAGE_LIST_NO_FILTERS_V1,
    });

    expect(facetOf(plan, 'sources').options.map((option) => option.label)).toEqual(['acme/widgets', 'acme/api']);
    expect(new Set(facetOf(plan, 'sources').options.map((option) => option.key)).size).toBe(2);
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
        scopeNames: {},
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

  it('names Type and Scope the way the rows do, never by their ids', () => {
    const census = {
      types: [{ source: GITHUB, kindId: 'pull-request' }],
      scopes: [{ source: GITHUB, collisionScope: 'github:1117388084' }],
      scopeNames: { [triageFacetScopeKeyV1(GITHUB, 'github:1117388084')]: 'happier' },
      coverage: 'complete',
    } as const;
    const named = planTriageFilterFacetsV1({
      configuredSources: [configured(GITHUB, 'instance-1', 'acme/widgets')],
      facetCensus: census,
      filters: TRIAGE_LIST_NO_FILTERS_V1,
      readKindName: (_source, kindId) => (kindId === 'pull-request' ? 'Pull request' : undefined),
    });
    expect(facetOf(named, 'types').options.map((option) => option.label)).toEqual(['Pull request']);
    expect(facetOf(named, 'scopes').options.map((option) => option.label)).toEqual(['happier']);

    // The label is presentation only: the value a press toggles, and the key it is looked up
    // by, stay the protocol identity, so a saved view or a route carrying it still matches.
    expect(facetOf(named, 'types').options[0]?.selection)
      .toEqual({ facet: 'types', value: { source: GITHUB, kindId: 'pull-request' } });
    const ids = planTriageFilterFacetsV1({
      configuredSources: [configured(GITHUB, 'instance-1', 'acme/widgets')],
      facetCensus: census,
      filters: TRIAGE_LIST_NO_FILTERS_V1,
    });
    expect(facetOf(ids, 'types').options[0]?.key).toBe(facetOf(named, 'types').options[0]?.key);
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

describe('readTriageRefineCountV1', () => {
  const option = (facet: 'attention' | 'states' | 'types', key: string, label: string, selected = false) => ({
    key, label, selected, selection: { facet, value: key } as never,
  });

  it('counts every value in force, the same set the token line says (no chip holds any back)', () => {
    const facets = [
      { facet: 'types' as const, label: 'Type', options: [option('types', 't1', 'Pull requests'), option('types', 't3', 'Tasks', true)] },
      { facet: 'states' as const, label: 'State', options: [option('states', 'open', 'Open', true)] },
      { facet: 'attention' as const, label: 'Attention', options: [option('attention', 'required', 'Needs you', true), option('attention', 'none', 'Nothing for you')] },
    ];
    expect(readTriageRefineCountV1(facets)).toBe(3);
    expect(readTriageRefineCountV1([{ ...facets[0]!, options: [option('types', 't1', 'Pull requests')] }])).toBe(0);
  });
});
