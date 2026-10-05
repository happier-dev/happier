import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import {
  testkitLocator,
  testkitSnapshot,
  testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriagePinnedEntryV1 } from '../marks/pinCommand.js';
import {
  planTriageListItemsV1,
  readTriageListGroupV1,
  type TriageListItemV1,
} from './sections.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE = '11111111-1111-4111-8111-111111111111';

type RowFacts = Readonly<{
  lane?: TriageListRowV1['lane'];
  attention?: 'required' | 'suggested' | null;
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
        snapshot: testkitSnapshot({ title: `Entry ${entryId}`, ...(facts.facts === undefined ? {} : { facts: facts.facts }) }),
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
      reasonLabel: 'Your review was requested',
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
      agentActive: (key) => key !== triageEntryRowKey(row('b').entryRef),
    });
    expect(byGroup(items)).toEqual({ pinned: ['a', 'z'], everythingElse: ['b'] });
    const unwalked = items.find((item) => item.row.entryRef.entryId === 'z')!;
    expect(unwalked.row.materialized).toBe(false);
    expect(unwalked.row.title).toBe('Not walked yet');
  });

  it('carries the source summary for the peek and the primary status fact as the signal', () => {
    const [item] = planTriageListItemsV1({
      rows: [row('a', {
        facts: [{ id: 'checks', label: 'Checks', importance: 'primary', value: { kind: 'status', value: '2 failing', tone: 'danger' } }],
      })],
      pins: [],
      workflowSubjectOf: pullRequests,
    });
    expect(item!.signal).toEqual({ label: '2 failing', tone: 'danger' });
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
});
