import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import {
  testkitLocator,
  testkitSnapshot,
  testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import { TRIAGE_LIST_NO_FILTERS_V1, triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriagePinnedEntryV1 } from '../marks/pinCommand.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';
import {
  planTriageListItemsV1,
  readTriageListGroupV1,
  readTriageSharedGroupReasonsV1,
  type TriageListItemV1,
} from './sections.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE = '11111111-1111-4111-8111-111111111111';

type RowFacts = Readonly<{
  state?: ReturnType<typeof testkitSnapshot>['state'];
  dueDate?: string;
  lane?: TriageListRowV1['lane'];
  attention?: 'required' | 'suggested' | null;
  reasonLabel?: string;
  involvement?: readonly ('reviewRequested' | 'assignee' | 'mentioned' | 'author' | 'participating' | 'subscribed')[];
  kindId?: string;
  facts?: ReturnType<typeof testkitSnapshot>['facts'];
}>;

function row(entryId: string, facts: RowFacts = {}): TriageListRowV1 {
  const kindId = facts.kindId ?? 'pull-request';
  const projected = {
    entryRef: { source: SOURCE, kindId, collisionScope: 'origin', entryId },
    content: {
      sourceInstanceId: INSTANCE,
      observedAtMs: 1_000,
      outcome: {
        kind: 'present',
        locator: testkitLocator(),
        snapshot: testkitSnapshot({ title: `Entry ${entryId}`, ...(facts.state === undefined ? {} : { state: facts.state }), ...(facts.dueDate === undefined ? {} : { dueDate: facts.dueDate }), ...(facts.facts === undefined ? {} : { facts: facts.facts }) }),
        viewer: testkitViewer({ involvement: [...(facts.involvement ?? [])] }),
      },
    },
    lane: facts.lane ?? CORPUS_LANE.open,
    sortAtMs: 0,
    presence: { kind: 'present', observedAtMs: 1_000 },
    attention: facts.attention == null ? null : {
      level: facts.attention,
      fromSourceInstanceId: INSTANCE,
      reasonId: 'involvement/review-requested',
      reasonLabel: facts.reasonLabel ?? 'Review requested',
    },
    selected: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
    observations: [],
  } as TriageListRowV1;
  return {
    ...projected,
    observations: [{ sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome: projected.content!.outcome }],
  };
}

function pin(entryId: string, title = `Pinned ${entryId}`): TriagePinnedEntryV1 {
  return {
    entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId },
    markedAtMs: 1_000,
    displayAtMark: { title, scopeLabel: 'origin' },
  };
}

const pullRequests = (ref: TriageListRowV1['entryRef']) => (ref.kindId === 'pull-request' ? 'pullRequest' as const : 'issue' as const);

function byGroup(items: readonly TriageListItemV1[]): Readonly<Record<string, readonly string[]>> {
  const groups: Record<string, string[]> = {};
  for (const item of items) (groups[item.group] ??= []).push(item.row.entryRef.entryId);
  return groups;
}

describe('the PRs & Issues grouping axis', () => {
  it('applies the active query and facets to unread pins and exact reads outside the window', () => {
    const input = { rows: [], pins: [pin('unread', 'Repair login'), pin('read', 'Old name')],
      readRows: [row('read', { lane: CORPUS_LANE.done })], workflowSubjectOf: pullRequests,
      lens: { query: 'zzqxv-nothing', filters: TRIAGE_LIST_NO_FILTERS_V1 } };
    const ids = (next: typeof input) => planTriageListItemsV1(next).map(item => item.row.entryRef.entryId);
    expect(ids(input)).toEqual([]);
    expect(ids({ ...input, lens: { ...input.lens, query: 'LOGIN' } })).toEqual(['unread']);
    expect(ids({ ...input, lens: { ...input.lens, query: 'Entry read' } })).toEqual(['read']);
    expect(ids({ ...input, lens: { query: '', filters: { ...TRIAGE_LIST_NO_FILTERS_V1, states: ['open'] } } })).toEqual([]);
    expect(ids({ ...input, lens: { query: '', filters: { ...TRIAGE_LIST_NO_FILTERS_V1, states: ['done'] } } })).toEqual(['read']);
    expect(ids({ ...input, lens: { query: '', filters: { ...TRIAGE_LIST_NO_FILTERS_V1,
      types: [{ source: SOURCE, kindId: 'issue' }] } } })).toEqual([]);
    expect(ids({ ...input, lens: { query: 'login', filters: { ...TRIAGE_LIST_NO_FILTERS_V1,
      scopes: [{ source: SOURCE, collisionScope: 'origin' }] } } })).toEqual(['unread']);
    expect(ids({ ...input, lens: { query: '', filters: { ...TRIAGE_LIST_NO_FILTERS_V1,
      sources: [{ source: SOURCE, sourceInstanceId: INSTANCE }] } } })).toEqual(['read']);
    expect(ids({ ...input, lens: { query: '', filters: { ...TRIAGE_LIST_NO_FILTERS_V1,
      attention: ['none'] } } })).toEqual(['read']);
    expect(ids({ ...input, lens: { query: '', filters: TRIAGE_LIST_NO_FILTERS_V1 } })).toEqual(['unread', 'read']);
  });
  it('keeps personal tasks in Tasks rather than PRs & Issues, including pins and exact pin reads', () => {
    const personal = { ...row('personal', { kindId: 'task', involvement: ['assignee'] }),
      entryRef: { source: INTERNAL_TASK_SOURCE_V1, kindId: 'task', collisionScope: 'personal', entryId: 'personal' } };
    const personalPin = { ...pin('personal'), entryRef: personal.entryRef };
    const input = { rows: [row('pr'), row('issue', { kindId: 'issue' }), personal],
      pins: [personalPin], readRows: [personal], workflowSubjectOf: pullRequests };
    expect(planTriageListItemsV1(input).map(item => item.row.entryRef.entryId)).toEqual(['pr', 'issue']);
    expect(planTriageListItemsV1({ ...input, rows: [], readRows: [] })).toEqual([]);
    expect(planTriageListItemsV1({ ...input, tasks: { audience: 'everyone',
      isTask: ref => ref.kindId === 'task' || ref.kindId === 'issue', hasSessions: () => false } })
      .map(item => item.row.entryRef.entryId)).toEqual(['personal', 'issue']);
  });
  it('filters a 2000-pin retained projection to the matching entry without needing window rows', () => {
    const pins = Array.from({ length: 2000 }, (_, index) => pin(String(index)));
    const items = planTriageListItemsV1({ rows: [], pins, workflowSubjectOf: pullRequests,
      lens: { query: 'Pinned 1999', filters: TRIAGE_LIST_NO_FILTERS_V1 } });
    expect(items.map(item => item.row.entryRef.entryId)).toEqual(['1999']);
  });
  it('projects personal task order into only its existing slots, retaining external source order and status groups', () => {
    const personal = (id: string, state: 'unstarted' | 'started' = 'unstarted') => {
      const base = row(id, { kindId: 'task' });
      const entryRef = { source: { pluginId: 'happier.triage', localId: 'internal' }, kindId: 'task', collisionScope: 'personal', entryId: id };
      return { ...base, entryRef, content: { ...base.content!, outcome: { ...base.content!.outcome,
        snapshot: { ...base.content!.outcome.snapshot, state: { presentation: 'active' as const, stage: state } } } } };
    };
    const rows = [personal('a'), row('external-1'), personal('working', 'started'), personal('b'), row('external-2'), personal('c')];
    const tasks = { audience: 'everyone' as const, isTask: () => true, hasSessions: () => false, personalOrder: ['c', 'working', 'a', 'b'] };
    const items = planTriageListItemsV1({ rows, pins: [], workflowSubjectOf: pullRequests, tasks });
    expect(items.map(item => item.row.entryRef.entryId)).toEqual(['c', 'external-1', 'working', 'a', 'external-2', 'b']);
    expect(byGroup(items).started).toEqual(['working']);
    expect(byGroup(items).unstarted).toEqual(['c', 'external-1', 'a', 'external-2', 'b']);
    const fieldOrdered = planTriageListItemsV1({ rows, pins: [], workflowSubjectOf: pullRequests, tasks,
      lens: { query: '', filters: TRIAGE_LIST_NO_FILTERS_V1, sort: { field: 'created', direction: 'asc' } } });
    expect(fieldOrdered.map(item => item.row.entryRef.entryId)).toEqual(rows.map(row => row.entryRef.entryId));
  });
  it('never pulls a shared task with a colliding id into the viewer personal order', () => {
    const task = (id: string, collisionScope: string) => ({ ...row(id, { kindId: 'task' }),
      entryRef: { source: INTERNAL_TASK_SOURCE_V1, kindId: 'task', collisionScope, entryId: id } });
    const items = planTriageListItemsV1({ rows: [task('a', 'personal'), task('b', 'account:other'), task('b', 'account:account')],
      pins: [], workflowSubjectOf: pullRequests,
      tasks: { audience: 'everyone', isTask: () => true, hasSessions: () => false, personalOrder: ['b', 'a'], personalAccountId: 'account' } });
    expect(items.map(item => [item.row.entryRef.collisionScope, item.row.entryRef.entryId]))
      .toEqual([['account:account', 'b'], ['account:other', 'b'], ['personal', 'a']]);
  });
  it('takes the completing capability from the selected connection, with runtime capabilities replacing the kind defaults', () => {
    const capabilities = (id: string) => ({ completingTransitionId: id,
      transitions: [{ id, label: 'Done', state: { presentation: 'resolved' as const } }] });
    const base = row('selected');
    const projected = { ...base, content: { ...base.content!, outcome: { ...base.content!.outcome,
      snapshot: { ...base.content!.outcome.snapshot, taskCapabilities: capabilities('other-connection') } } },
      observations: [{ ...base.observations[0]!, outcome: { ...base.content!.outcome,
        snapshot: { ...base.content!.outcome.snapshot, taskCapabilities: capabilities('selected-connection') } } }] };
    const input = { rows: [projected], pins: [], workflowSubjectOf: pullRequests,
      tasks: { audience: 'everyone' as const, isTask: () => true, hasSessions: () => false, capabilitiesOf: () => capabilities('kind-default') } };
    expect(planTriageListItemsV1(input)[0]?.task?.completingTransitionId).toBe('selected-connection');
    const refined = { ...projected, observations: [{ ...projected.observations[0]!, outcome: { ...base.content!.outcome,
      snapshot: { ...base.content!.outcome.snapshot, taskCapabilities: { transitions: [] } } } }] };
    expect(planTriageListItemsV1({ ...input, rows: [refined] })[0]?.task).not.toHaveProperty('completingTransitionId');
  });
  it('limits Mine to assignment or source-declared authorship, while Everyone and Agents keep their meaning', () => {
    const rows = [row('assigned', { involvement: ['assignee'] }), row('authored', { involvement: ['author'] }),
      row('mentioned', { involvement: ['mentioned'] }), row('subscribed', { involvement: ['subscribed'] }),
      row('participating', { involvement: ['participating'] }), row('review', { involvement: ['reviewRequested'] })];
    const input = { rows, pins: [], workflowSubjectOf: pullRequests,
      tasks: { audience: 'mine' as const, isTask: () => true,
        hasSessions: (key: string) => key === triageEntryRowKey(rows[2]!.entryRef) } };
    expect(planTriageListItemsV1(input).map(item => item.row.entryRef.entryId)).toEqual(['assigned', 'authored']);
    expect(planTriageListItemsV1({ ...input, tasks: { ...input.tasks, audience: 'everyone' } })).toHaveLength(6);
    expect(planTriageListItemsV1({ ...input, tasks: { ...input.tasks, audience: 'agents' } })
      .map(item => item.row.entryRef.entryId)).toEqual(['mentioned']);
  });
  it('exposes due/completion facts and limits the completed band by source completion time, never update time', () => {
    const task = (id: string, completedAtMs?: number) => {
      const base = row(id, { involvement: ['assignee'] });
      return { ...base, content: { ...base.content!, outcome: { ...base.content!.outcome, snapshot: {
        ...base.content!.outcome.snapshot, dueDate: '2026-10-25', ...(completedAtMs === undefined ? {} : { completedAtMs }),
        state: { presentation: 'resolved' as const },
      } } } };
    };
    const rows = [task('recent', 100), task('old', 99), task('unknown'), row('open', { involvement: ['assignee'] })];
    const tasks = { audience: 'everyone' as const, isTask: () => true, hasSessions: () => false, completedSinceMs: 100 };
    const items = planTriageListItemsV1({ rows, pins: [], workflowSubjectOf: pullRequests, tasks });
    expect(items.map(item => item.row.entryRef.entryId)).toEqual(['recent', 'open']);
    expect(items[0]?.task).toMatchObject({ dueDate: '2026-10-25', completedAtMs: 100 });
    expect(planTriageListItemsV1({ rows, pins: [], workflowSubjectOf: pullRequests,
      tasks: { audience: 'everyone', isTask: () => true, hasSessions: () => false } })).toHaveLength(4);
  });
  it('uses declared task kinds, involvement and links for Tasks audiences, and the protocol category for groups', () => {
    const assigned = row('assigned', { kindId: 'issue', involvement: ['assignee'] });
    const authored = row('authored', { kindId: 'issue', involvement: ['author'] });
    const linked = row('linked', { kindId: 'issue' });
    const started = { ...linked, content: { ...linked.content!, outcome: { ...linked.content!.outcome,
      snapshot: { ...linked.content!.outcome.snapshot, state: { presentation: 'active' as const, stage: 'started' as const } } } } };
    const input = { rows: [row('pr'), assigned, authored, started], pins: [pin('pr')], workflowSubjectOf: pullRequests,
      tasks: { audience: 'everyone' as const, isTask: (ref: TriageListRowV1['entryRef']) => ref.kindId === 'issue',
        hasSessions: (key: string) => key === triageEntryRowKey(linked.entryRef) } };
    expect(planTriageListItemsV1(input).map((item) => [item.row.entryRef.entryId, item.group])).toEqual([
      ['assigned', 'unstarted'], ['authored', 'unstarted'], ['linked', 'started'],
    ]);
    expect(planTriageListItemsV1({ ...input, tasks: { ...input.tasks, audience: 'mine' } }).map((item) => item.row.entryRef.entryId)).toEqual(['assigned', 'authored']);
    // A linked Session is sufficient, even before its live work state answers.
    expect(planTriageListItemsV1({ ...input, tasks: { ...input.tasks, audience: 'agents' } }).map((item) => item.row.entryRef.entryId)).toEqual(['linked']);
  });
  it('applies Tasks kind membership to readable, exactly-read and unread pins, without excluding task-kind issues', () => {
    const issue = row('issue', { kindId: 'issue' });
    const issuePin = { ...pin('issue'), entryRef: issue.entryRef };
    const input = { rows: [row('pr'), issue], pins: [pin('pr'), issuePin], workflowSubjectOf: pullRequests,
      tasks: { audience: 'everyone' as const, isTask: (ref: TriageListRowV1['entryRef']) => ref.kindId === 'issue',
        hasSessions: () => false } };
    for (const rows of [input.rows, []]) {
      for (const readRows of [input.rows, []]) {
        expect(planTriageListItemsV1({ ...input, rows, readRows })
          .map(item => [item.row.entryRef.entryId, item.group])).toEqual([['issue', 'pinned']]);
      }
    }
  });
  it('carries the source\'s own status word and live relations on a task item, and none on a PRs & Issues item', () => {
    const base = row('relations', { kindId: 'issue', involvement: ['assignee'] });
    const task = { ...base, content: { ...base.content!, outcome: { ...base.content!.outcome, snapshot: {
      ...base.content!.outcome.snapshot,
      state: { presentation: 'active' as const, stage: 'started' as const, nativeLabel: 'In Review' },
      relations: { children: { total: 5, completed: 3 } },
    } } } };
    const capabilities = { completingTransitionId: 'done', transitions: [{ id: 'done', label: 'Done',
      state: { presentation: 'resolved' as const } }] };
    const tasks = { audience: 'mine' as const, isTask: () => true, hasSessions: () => false, capabilitiesOf: () => capabilities };
    const [item] = planTriageListItemsV1({ rows: [task], pins: [], workflowSubjectOf: pullRequests, tasks });
    // The row's status control offers the selected connection's workflow, each step with the category it moves to.
    expect(item!.task).toEqual({ category: 'started', statusLabel: 'In Review', completingTransitionId: 'done', assignedToViewer: true,
      transitions: [{ id: 'done', label: 'Done', category: 'completed', state: { presentation: 'resolved' } }],
      relations: { children: { total: 5, completed: 3 } } });
    const [plain] = planTriageListItemsV1({ rows: [task], pins: [], workflowSubjectOf: pullRequests });
    expect(plain!.task).toBeUndefined();
  });
  it('retains unchanged items in a 2000-row window when one linked Session changes work group', () => {
    const rows = Array.from({ length: 2000 }, (_, index) => row(String(index)));
    const working = {
      lifecycle: 'active', operational: 'working', workStatus: { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' },
    } as const;
    const changedKey = triageEntryRowKey(rows[0]!.entryRef);
    const input = { rows, pins: [], workflowSubjectOf: pullRequests };
    const initialStart = performance.now();
    const before = planTriageListItemsV1(input);
    const initialMs = performance.now() - initialStart;
    const changeStart = performance.now();
    const after = planTriageListItemsV1({
      ...input, agentStatesOf: (key) => key === changedKey ? [working] : [],
    }, before);
    const changeMs = performance.now() - changeStart;
    const changedItems = after.filter((item, index) => item !== before[index]).length;
    // Characterize the owner workload; this is not a browser frame budget.
    console.info('triage-list-locality-profile', { rows: rows.length, initialMs, changeMs, changedItems });
    expect(after[0]?.group).toBe('withAgent');
    expect(after.slice(1).filter((item, index) => item !== before[index + 1])).toHaveLength(0);
    expect(after[0]?.row).toBe(before[0]?.row);
    expect(planTriageListItemsV1(input, before)).toBe(before);
  });

  it('files an entry by who acts next: you, an agent, someone else, or nobody', () => {
    const subject = { workflowSubject: 'pullRequest' as const, agentActive: false };
    expect(readTriageListGroupV1({ row: row('1', { attention: 'required' }), ...subject, agentActive: true })).toBe('needsYou');
    expect(readTriageListGroupV1({ row: row('2', { involvement: ['author'], attention: 'suggested' }), ...subject })).toBe('inReview');
    expect(readTriageListGroupV1({ row: row('3', { attention: 'suggested', involvement: ['mentioned'] }), ...subject })).toBe('everythingElse');
    expect(readTriageListGroupV1({ row: row('4'), workflowSubject: 'pullRequest', agentActive: true })).toBe('withAgent');
  });

  it('never asks you about a finished entry, and never puts an issue you opened "in review"', () => {
    expect(readTriageListGroupV1({
      row: row('1', { attention: 'required', lane: CORPUS_LANE.done }), workflowSubject: 'pullRequest', agentActive: false,
    })).toBe('everythingElse');
    expect(readTriageListGroupV1({
      row: row('2', { involvement: ['author'], kindId: 'issue' }), workflowSubject: 'issue', agentActive: false,
    })).toBe('everythingElse');
  });

  it('keeps the window order inside each group, the group being a cut of that order', () => {
    const items = planTriageListItemsV1({
      rows: [row('a'), row('b', { attention: 'required' }), row('c'), row('d', { attention: 'required' })],
      pins: [],
      workflowSubjectOf: pullRequests,
    });
    expect(byGroup(items)).toEqual({ needsYou: ['b', 'd'], everythingElse: ['a', 'c'] });
    expect(items.map((item) => item.row.entryRef.entryId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lifts a pinned entry into Pinned instead of listing it twice, and keeps a pin the window never walked', () => {
    const items = planTriageListItemsV1({
      rows: [row('a', { attention: 'required' }), row('b')],
      pins: [pin('a'), pin('z', 'Not walked yet')],
      workflowSubjectOf: pullRequests,
      agentStatesOf: (key) => (key === triageEntryRowKey(row('b').entryRef) ? [] : [{
        sessionId: 'session-a', lifecycle: 'active', runtime: 'working', operational: 'working',
        workStatus: { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' }, pendingPermissions: [],
      }]),
    });
    expect(byGroup(items)).toEqual({ pinned: ['a', 'z'], everythingElse: ['b'] });
    const unwalked = items.find((item) => item.row.entryRef.entryId === 'z')!;
    expect(unwalked.row.materialized).toBe(false);
    expect(unwalked.row.title).toBe('Not walked yet');
  });

  it('keeps each pinned entry\'s own status for a view without a Pinned group (the board)', () => {
    // Owner ruling 2026-10-31: on the board a pin stays in its status column with a pin mark.
    const items = planTriageListItemsV1({
      rows: [row('a', { attention: 'required' }), row('b'), row('c', { involvement: ['author'] })],
      pins: [pin('a'), pin('c'), pin('z', 'Not walked yet')],
      workflowSubjectOf: pullRequests,
    });
    const statusOf = Object.fromEntries(items.map((item) => [item.row.entryRef.entryId, item.statusGroup]));
    expect(statusOf).toEqual({ a: 'needsYou', c: 'inReview', z: 'everythingElse', b: 'everythingElse' });
    expect(items.filter((item) => item.group === 'pinned').map((item) => item.row.entryRef.entryId)).toEqual(['a', 'c', 'z']);
  });

  it('lets an exact read answer a pin the window never walked, without listing the entry anywhere else', () => {
    // The reader opened the pinned entry: its detail read it exactly, so the pin no longer says it is unsynchronized.
    const items = planTriageListItemsV1({
      rows: [row('b')],
      pins: [pin('z', 'Title at pin time')],
      readRows: [row('z'), row('y')],
      workflowSubjectOf: pullRequests,
    });
    expect(byGroup(items)).toEqual({ pinned: ['z'], everythingElse: ['b'] });
    const pinned = items.find((item) => item.row.entryRef.entryId === 'z')!;
    expect(pinned.row.materialized).toBe(true);
    expect(pinned.row.title).toBe('Entry z');
  });

  it('carries the source summary for the peek and the primary status fact as the signal', () => {
    const [item] = planTriageListItemsV1({
      rows: [row('a', {
        facts: [
          ...Array.from({ length: 6 }, (_, index) => ({ id: `fact-${index}`, importance: 'secondary' as const,
            value: { kind: 'text' as const, value: `Value ${index}` } })),
          { id: 'checks', label: 'Checks', importance: 'primary', value: { kind: 'status', value: '2 failing', tone: 'danger' } },
        ],
      })],
      pins: [],
      workflowSubjectOf: pullRequests,
    });
    expect(item!.signal).toEqual({ label: '2 failing', tone: 'danger' });
  });

  it('keeps source labels and primary impact counts in Signal, with primary status taking precedence', () => {
    const items = planTriageListItemsV1({
      rows: [
        row('labels', { facts: [
          { id: 'number', label: 'Number', importance: 'primary', value: { kind: 'text', value: '#42' } },
          { id: 'comments', label: 'Comments', importance: 'supplementary', value: { kind: 'number', value: 5, format: 'compact' } },
          { id: 'labels', label: 'Labels', importance: 'supplementary', value: { kind: 'text', value: 'bug, android' } },
        ] }),
        row('impact', { facts: [
          { id: 'users', label: 'Affected users', importance: 'primary', value: { kind: 'number', value: 318, format: 'compact' } },
        ] }),
        row('checks', { facts: [
          { id: 'labels', label: 'Labels', importance: 'supplementary', value: { kind: 'text', value: 'bug' } },
          { id: 'checks', label: 'Checks', importance: 'primary', value: { kind: 'status', value: '2 failing', tone: 'danger' } },
        ] }),
      ],
      pins: [], workflowSubjectOf: pullRequests,
    });
    expect(items.map((item) => item.signal)).toEqual([
      { label: 'bug, android', tone: 'neutral' },
      { label: '318 Affected users', tone: 'neutral' },
      { label: '2 failing', tone: 'danger' },
    ]);
  });

  it('states the linked agent of every row, window and pinned alike, from the one Session join', () => {
    const working = {
      sessionId: 'session-a', lifecycle: 'active', runtime: 'working', operational: 'working',
      workStatus: { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' }, pendingPermissions: [],
    } as const;
    const items = planTriageListItemsV1({
      rows: [row('a'), row('b')],
      pins: [pin('p')],
      workflowSubjectOf: pullRequests,
      agentStatesOf: (key) => (key === triageEntryRowKey(row('a').entryRef) || key === triageEntryRowKey(pin('p').entryRef)
        ? [working] : []),
    });
    const agentOf = (id: string) => items.find((item) => item.row.entryRef.entryId === id)!.agent;
    expect(agentOf('a')).toMatchObject({ label: 'Working', live: true });
    expect(agentOf('p')).toMatchObject({ label: 'Working', live: true });
    expect(agentOf('b')).toBeNull();
  });

  it('keeps the source locator beside the qualified identity for a Session link drop', () => {
    const projected = row('31');
    const [item] = planTriageListItemsV1({
      rows: [projected], pins: [], workflowSubjectOf: pullRequests,
    });
    expect(item).toHaveProperty('locator', projected.content!.outcome.locator);
    const [unreadPin] = planTriageListItemsV1({
      rows: [], pins: [pin('31')], workflowSubjectOf: pullRequests,
    });
    expect(unreadPin).toHaveProperty('locator', null);
  });

  it('uses the selected connection locator rather than a different connection supplying display content', () => {
    const projected = row('31');
    const selectedLocator = testkitLocator({ routingToken: 'selected-connection', displayPath: 'selected/repository #31' });
    const [item] = planTriageListItemsV1({
      rows: [{ ...projected, observations: [{
        sourceInstanceId: INSTANCE, observedAtMs: 2_000,
        outcome: { ...projected.content!.outcome, locator: selectedLocator },
      }] }], pins: [], workflowSubjectOf: pullRequests,
    });
    expect(item).toHaveProperty('locator', selectedLocator);
  });

  it('says a suggestion once for a group whose every entry shares it, and leaves differing reasons on the rows', () => {
    const items = planTriageListItemsV1({
      rows: [
        row('a', { attention: 'suggested', reasonLabel: 'Mentioned' }),
        row('b', { attention: 'suggested', reasonLabel: 'Mentioned' }),
        row('c', { attention: 'required' }),
        row('d', { attention: 'required' }),
      ],
      pins: [],
      workflowSubjectOf: pullRequests,
    });
    const shared = readTriageSharedGroupReasonsV1(items);
    const suggested = items.find((item) => item.row.entryRef.entryId === 'a')!;
    expect(shared.get(suggested.group)).toBe(suggested.row.detail);
    // Required reasons are what tell needs-you entries apart: never folded into the header.
    expect(shared.has('needsYou')).toBe(false);

    const mixed = planTriageListItemsV1({
      rows: [
        row('a', { attention: 'suggested', reasonLabel: 'Mentioned' }),
        row('b', { attention: 'suggested', reasonLabel: 'Subscribed' }),
      ],
      pins: [],
      workflowSubjectOf: pullRequests,
    });
    expect(readTriageSharedGroupReasonsV1(mixed).size).toBe(0);
    // One entry is not a pattern: its own chip says it.
    expect(readTriageSharedGroupReasonsV1(mixed.slice(0, 1)).size).toBe(0);
  });
});

it('selects Home tasks by needs-you, overdue, today, started, preserving ties', () => {
  const nowMs = new Date(2026, 10, 14, 12).getTime();
  const rows = [
    row('ordinary', { involvement: ['assignee'] }),
    row('started', { involvement: ['assignee'], state: { presentation: 'active', stage: 'started' } }),
    row('today', { involvement: ['assignee'], dueDate: '2026-11-14' }),
    row('overdue', { involvement: ['assignee'], dueDate: '2026-11-13' }),
    row('attention', { involvement: ['assignee'] }),
    row('overdue-second', { involvement: ['assignee'], dueDate: '2026-11-12' }),
  ];
  const items = planTriageListItemsV1({ rows, pins: [], workflowSubjectOf: () => null,
    agentStatesOf: key => key === triageEntryRowKey(rows[4]!.entryRef) ? [{
      lifecycle: 'active', operational: 'permission_required', workStatus: { bucket: 'needs_you', tone: 'warning' },
    }] : [],
    tasks: { audience: 'mine', isTask: () => true, hasSessions: () => false,
      urgency: { nowMs, locale: 'en', text: (_key, fallback) => fallback ?? _key } },
  });
  expect(items.map(item => item.row.entryRef.entryId)).toEqual([
    'attention', 'overdue', 'overdue-second', 'today', 'started', 'ordinary',
  ]);
});
