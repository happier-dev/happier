// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import { planTriageListItemsV1, type TriageListItemV1 } from './sections.js';
import { testkitEntryRef, testkitObservation, testkitPresentOutcome } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
// A mounted plugin renderer loads after its real declaration/registration entry.
import '../../manifest.js';
import { TRIAGE_ROW_REASON_TEST_ID_V1, readTriageDataColumnsV1, useTriageListAnatomyV1 } from './rows.js';
import { readTriageTaskDueV1 } from './taskColumns.js';
import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

async function readAnatomy(input: Parameters<typeof useTriageListAnatomyV1>[0]) {
  let anatomy: CollectionAnatomy<TriageListItemV1> | null = null;
  const surface = defineUiSurface(function Probe() {
    anatomy = useTriageListAnatomyV1(input);
    return <Text value="probe" />;
  });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'triage-columns-test', mountNonce: 'triage-columns-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface, surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
    });
  });
  mounted.push(fixture);
  await expect(fixture.getByText('probe')).resolves.toBeDefined();
  return anatomy as unknown as CollectionAnatomy<TriageListItemV1>;
}

describe('PRs & Issues table columns', () => {
  it('renders the source’s Owner value and distinguishes unassigned from unknown', async () => {
    const base = testkitObservation();
    const present = testkitPresentOutcome();
    const observations = ['Mara', null, undefined].map((assigneeLabel, index) => ({ ...base,
      entryRef: testkitEntryRef({ kindId: 'issue', entryId: String(index) }),
      outcome: { ...present, snapshot: { ...present.snapshot, authorLabel: 'A different author',
        ...(assigneeLabel === undefined ? {} : { assigneeLabel }) } },
    }));
    const window = foldTriageListWindow({ observations, lanes: [], configuredSourcesStatus: 'complete',
      activeSourceInstanceIds: [base.sourceInstanceId], lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: base.observedAtMs });
    const items = planTriageListItemsV1({ rows: window.rows, pins: [], workflowSubjectOf: () => 'issue',
      tasks: { audience: 'everyone', isTask: () => true, hasSessions: () => false } });
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({ identity: { instanceId: 'owner-column', mountNonce: 'owner-column' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(() => {
          const anatomy = useTriageListAnatomyV1({ withSignal: false, tasks: true, taskAudience: 'everyone' });
          const owner = anatomy.fields?.find(field => field.key === 'owner');
          return <>{items.map(item => <React.Fragment key={item.key}>{owner?.render(item)}</React.Fragment>)}</>;
        }),
        surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
      });
    });
    mounted.push(fixture);
    for (const label of ['Mara', 'Nobody', '—']) await expect(fixture.getByText(label)).resolves.toBeDefined();
    await expect(fixture.queryByText('A different author')).resolves.toBeUndefined();
    // A person is drawn with their mark (lab `tasks-everyone`); nobody, or an unknown owner, has none.
    await expect(fixture.getByRole('image', { name: 'Mara' })).resolves.toBeDefined();
    await expect(fixture.queryByRole('image', { name: 'Nobody' })).resolves.toBeUndefined();
  });
  it("gives a task's list row its one loudest fact: an agent asking, then an urgent due date, Blocked, then a working agent", async () => {
    const base = testkitObservation();
    const present = testkitPresentOutcome();
    const observations = [{ ...base, entryRef: testkitEntryRef({ kindId: 'issue', entryId: 'task' }),
      outcome: present }];
    const window = foldTriageListWindow({ observations, lanes: [], configuredSourcesStatus: 'complete',
      activeSourceInstanceIds: [base.sourceInstanceId], lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: base.observedAtMs });
    const [planned] = planTriageListItemsV1({ rows: window.rows, pins: [], workflowSubjectOf: () => 'issue',
      tasks: { audience: 'everyone', isTask: () => true, hasSessions: () => false } });
    const task = { ...planned!.task!, category: 'unstarted' as const };
    const asking = { kind: 'permission' as const, labelKey: 'x.asking', label: 'Codex needs you', tone: 'attention' as const, live: false };
    const working = { kind: 'working' as const, labelKey: 'x.working', label: 'Working', tone: 'neutral' as const, live: true };
    const blocked = { ...task, relations: { blockedBy: [planned!.row.entryRef] },
      readiness: { ready: false, reason: 'blocker_not_terminal' } as const };
    const overdue = { ...task, dueDate: '2020-01-01' };
    const cases: ReadonlyArray<readonly [string, TriageListItemV1]> = [
      ['asking', { ...planned!, key: 'asking', agent: asking, task: { ...overdue, relations: blocked.relations } }],
      ['overdue', { ...planned!, key: 'overdue', agent: working, task: { ...overdue, relations: blocked.relations } }],
      ['blocked', { ...planned!, key: 'blocked', agent: working, task: blocked }],
      ['working', { ...planned!, key: 'working', agent: working, task }],
      ['quiet', { ...planned!, key: 'quiet', agent: null, task }],
    ];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-fact', mountNonce: 'task-fact' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(() => {
          const anatomy = useTriageListAnatomyV1({ withSignal: false, tasks: true, taskAudience: 'everyone' });
          return <>{cases.map(([id, item]) => <React.Fragment key={id}>{anatomy.listFact?.(item)}</React.Fragment>)}</>;
        }),
        surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
      });
    });
    mounted.push(fixture);
    await expect(fixture.getByText('Codex needs you')).resolves.toBeDefined();
    const overdueLabel = readTriageTaskDueV1('2020-01-01', task.category, createSurfaceContextFixture().locale, Date.now(), (_key, fallback = '', params) =>
      Object.entries(params ?? {}).reduce((value, [name, part]) => value.replace(`{${name}}`, String(part)), fallback))!.label;
    await expect(fixture.getByText(overdueLabel)).resolves.toBeDefined();
    await expect(fixture.getByText('Blocked')).resolves.toBeDefined();
    await expect(fixture.getByText('Working')).resolves.toBeDefined();
  });
  it('says a task row\'s agent at the end of its line (lab tasks-list), and keeps the glyph badge to PRs & Issues (lab merged-detail)', async () => {
    const base = testkitObservation();
    const window = foldTriageListWindow({ observations: [{ ...base, entryRef: testkitEntryRef({ kindId: 'issue', entryId: 'task' }), outcome: testkitPresentOutcome() }],
      lanes: [], configuredSourcesStatus: 'complete', activeSourceInstanceIds: [base.sourceInstanceId], lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: base.observedAtMs });
    const [planned] = planTriageListItemsV1({ rows: window.rows, pins: [], workflowSubjectOf: () => 'issue',
      tasks: { audience: 'everyone', isTask: () => true, hasSessions: () => false } });
    const ready = { kind: 'ready' as const, labelKey: 'x.ready', label: 'Ready', tone: 'neutral' as const, live: false };
    const item: TriageListItemV1 = { ...planned!, agent: ready };
    const seen: { taskBadge?: unknown; prBadge?: unknown } = {};
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-agent', mountNonce: 'task-agent' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(() => {
          const tasks = useTriageListAnatomyV1({ withSignal: false, tasks: true, taskAudience: 'mine' });
          const prs = useTriageListAnatomyV1({ withSignal: true });
          seen.taskBadge = tasks.glyphBadge?.(item) ?? null;
          seen.prBadge = prs.glyphBadge?.(item) ?? null;
          return <>{tasks.listFact?.(item)}</>;
        }),
        surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
      });
    });
    mounted.push(fixture);
    await expect(fixture.getByText('Ready')).resolves.toBeDefined();
    expect(seen.taskBadge).toBeNull();
    expect(seen.prBadge).not.toBeNull();
  });

  it('names the reader as You when the source says the reader is the assignee', async () => {
    const base = testkitObservation();
    const present = testkitPresentOutcome();
    const observations = [{ ...base, entryRef: testkitEntryRef({ kindId: 'issue', entryId: 'mine' }),
      outcome: { ...present, viewer: { ...present.viewer, involvement: ['assignee' as const] },
        snapshot: { ...present.snapshot, assigneeLabel: 'qa-usage-visuals-owner' } } }];
    const window = foldTriageListWindow({ observations, lanes: [], configuredSourcesStatus: 'complete',
      activeSourceInstanceIds: [base.sourceInstanceId], lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: base.observedAtMs });
    const items = planTriageListItemsV1({ rows: window.rows, pins: [], workflowSubjectOf: () => 'issue',
      tasks: { audience: 'everyone', isTask: () => true, hasSessions: () => false } });
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({ identity: { instanceId: 'owner-you', mountNonce: 'owner-you' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(() => {
          const anatomy = useTriageListAnatomyV1({ withSignal: false, tasks: true, taskAudience: 'everyone' });
          const owner = anatomy.fields?.find(field => field.key === 'owner');
          return <>{items.map(item => <React.Fragment key={item.key}>{owner?.render(item)}</React.Fragment>)}</>;
        }),
        surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
      });
    });
    mounted.push(fixture);
    await expect(fixture.getByText('You')).resolves.toBeDefined();
    await expect(fixture.queryByText('qa-usage-visuals-owner')).resolves.toBeUndefined();
  });
  it('keeps the entry columns from the first paint, so a fact arriving late never moves Where or the titles', () => {
    const late = readTriageDataColumnsV1({ tasks: false, items: [], sharedGroupReasons: new Map() });
    expect(late).toEqual({ withSignal: true, withAgent: true, withReason: true });
    expect(readTriageDataColumnsV1({ tasks: true, items: [], sharedGroupReasons: new Map() }))
      .toEqual({ withSignal: false, withAgent: false, withReason: false });
  });
  it('gives Everyone its Owner field and Agents its declared Agent field', async () => {
    const mine = await readAnatomy({ withSignal: false, tasks: true, taskAudience: 'mine' });
    const everyone = await readAnatomy({ withSignal: false, tasks: true, taskAudience: 'everyone' });
    const agents = await readAnatomy({ withSignal: false, tasks: true, taskAudience: 'agents' });
    expect(mine.fields?.some(field => field.key === 'owner')).toBe(false);
    expect(everyone.fields?.some(field => field.key === 'owner')).toBe(true);
    expect(agents.fields?.some(field => field.key === 'agent')).toBe(true);
    expect(agents.agent).toBeUndefined();
  });
  it('gives each lens the lab’s column set: Agents leads with the agent before Where and drops Progress and Due', async () => {
    const keys = async (audience: 'mine' | 'agents' | 'everyone') =>
      (await readAnatomy({ withSignal: false, tasks: true, taskAudience: audience })).fields?.map(field =>
        `${field.key}${field.leading === true ? ':lead' : ''}`);
    expect(await keys('mine')).toEqual(['status:lead', 'progress', 'due']);
    expect(await keys('agents')).toEqual(['status:lead', 'agent:lead']);
    expect(await keys('everyone')).toEqual(['status:lead', 'owner:lead', 'due']);
  });
  it('widens the Agents lens’ agent to what its Session is about', async () => {
    const base = testkitObservation();
    const window = foldTriageListWindow({ observations: [{ ...base, entryRef: testkitEntryRef({ kindId: 'issue', entryId: 'a' }) }],
      lanes: [], configuredSourcesStatus: 'complete', activeSourceInstanceIds: [base.sourceInstanceId],
      lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: base.observedAtMs });
    const [planned] = planTriageListItemsV1({ rows: window.rows, pins: [], workflowSubjectOf: () => 'issue',
      tasks: { audience: 'agents', isTask: () => true, hasSessions: () => true } });
    const item: TriageListItemV1 = { ...planned!, agent: { kind: 'working', labelKey: 'x.working', label: 'Working', tone: 'neutral',
      live: true, sessionTitle: 'Writing a regression test' } };
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({ identity: { instanceId: 'agents-wide', mountNonce: 'agents-wide' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(() => {
          const anatomy = useTriageListAnatomyV1({ withSignal: false, tasks: true, taskAudience: 'agents' });
          return <>{anatomy.fields?.find(field => field.key === 'agent')?.render(item)}</>;
        }),
        surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
      });
    });
    mounted.push(fixture);
    await expect(fixture.getByText('Working')).resolves.toBeDefined();
    await expect(fixture.getByText('· Writing a regression test')).resolves.toBeDefined();
  });
  it('draws the Agent column only when some listed entry has a linked agent, like Signal', async () => {
    const without = await readAnatomy({ withSignal: false, withAgent: false });
    expect(without.agent).toBeUndefined();
    expect(without.signal).toBeUndefined();
    const withBoth = await readAnatomy({ withSignal: true, withAgent: true });
    expect(withBoth.agent).toBeDefined();
    expect(withBoth.signal).toBeDefined();
    // Why it's here, too: when every reason is already said by its group's line, the column is not a wall of dashes.
    expect(withBoth.reason).toBeDefined();
    expect((await readAnatomy({ withSignal: true, withAgent: true, withReason: false })).reason).toBeUndefined();
  });

  it('draws a suggested reason as the same quiet chip with its mark that the detail header shows, not bare words', async () => {
    const row = {
      key: 'happier.forge/items|pull-request|origin|31',
      entryRef: { source: { pluginId: 'happier.forge', sourceId: 'items' }, kindId: 'pull-request', collisionScope: 'origin', entryId: '31' },
      title: 'Replace the duplicated normalizer', scopeLabel: 'example/repository',
      detail: 'Mentioned', tone: 'neutral', detailKind: 'suggestion', detailIcon: 'mention',
      authorLabel: null, designation: '#31', lifecyclePresentation: 'active', activityAtMs: null,
      pinned: false, materialized: true, sourceInstanceId: null, kindId: 'pull-request', lifecycleLabel: 'Open',
      observedAtMs: 1_000, stale: false,
    } as unknown as TriageListDisplayRowV1;
    const item: TriageListItemV1 = { key: row.key, row, group: 'everythingElse', statusGroup: 'everythingElse', summary: null, signal: null, agent: null };
    const surface = defineUiSurface(function Probe() {
      const anatomy = useTriageListAnatomyV1({ withSignal: false, withAgent: false });
      return <>{anatomy.reason?.(item)}</>;
    });
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'triage-reason-test', mountNonce: 'triage-reason-mount' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface, surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
      });
    });
    mounted.push(fixture);
    await expect(fixture.getByText('Mentioned')).resolves.toBeDefined();
    expect(document.querySelector(`[data-testid="${TRIAGE_ROW_REASON_TEST_ID_V1}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-testid="${TRIAGE_ROW_REASON_TEST_ID_V1}:icon"]`)).not.toBeNull();
  });
});
