import { describe, expect, it } from 'vitest';
import type { TriageSourceDetailTabV1 } from '@happier-dev/triage-protocol/v1';

import { planTriageDetailTabsV1, readTriageDetailTabSummaryV1 } from './tabs.js';

const shared = (id: 'overview' | 'activity' | 'files' | 'checks'): TriageSourceDetailTabV1 => ({ kind: 'shared', id });
const PR_TABS: readonly TriageSourceDetailTabV1[] = [shared('checks'), shared('overview'), shared('files'), shared('activity')];
const ISSUE_TABS: readonly TriageSourceDetailTabV1[] = [shared('overview'), shared('activity')];

const summary = (plan: ReturnType<typeof planTriageDetailTabsV1>) => (plan.kind === 'whole'
  ? 'whole'
  : plan.tabs.map((tab) => `${tab.id}@${tab.from}`).join(' '));

describe('the detail tab plan (r0.42)', () => {
  it('keeps a source that declares no tabs as its whole detail', () => {
    expect(planTriageDetailTabsV1({ workflowSubject: 'pullRequest', entryTabs: undefined, fixPullRequest: null }))
      .toEqual({ kind: 'whole' });
  });

  it('orders a pull request by the shared vocabulary, whatever order it declared', () => {
    expect(summary(planTriageDetailTabsV1({ workflowSubject: 'pullRequest', entryTabs: PR_TABS, fixPullRequest: null })))
      .toBe('overview@entry activity@entry files@entry checks@entry');
  });

  it('shows an issue with no fix PR only the tabs it has: no empty Files or Checks', () => {
    expect(summary(planTriageDetailTabsV1({ workflowSubject: 'issue', entryTabs: ISSUE_TABS, fixPullRequest: null })))
      .toBe('overview@entry activity@entry');
  });

  it('sources an issue or error group\'s Files and Checks from its linked fix PR', () => {
    const fixPullRequest = { detailTabs: PR_TABS };
    expect(summary(planTriageDetailTabsV1({ workflowSubject: 'issue', entryTabs: ISSUE_TABS, fixPullRequest })))
      .toBe('overview@entry activity@entry files@fixPullRequest checks@fixPullRequest');
    expect(summary(planTriageDetailTabsV1({
      workflowSubject: 'errorIssue',
      entryTabs: [shared('overview'), { kind: 'source', id: 'stack-trace', title: 'Stack trace' }],
      fixPullRequest,
    }))).toBe('overview@entry files@fixPullRequest checks@fixPullRequest stack-trace@entry');
  });

  it('takes from the fix PR only what its source declares', () => {
    expect(summary(planTriageDetailTabsV1({
      workflowSubject: 'issue',
      entryTabs: ISSUE_TABS,
      fixPullRequest: { detailTabs: [shared('overview'), shared('files')] },
    }))).toBe('overview@entry activity@entry files@fixPullRequest');
  });

  it('puts source-only tabs after the shared ones, in declared order, with their own titles', () => {
    const plan = planTriageDetailTabsV1({
      workflowSubject: 'errorIssue',
      entryTabs: [
        { kind: 'source', id: 'occurrences', title: 'Occurrences', titleKey: 'plugins.source.tab.occurrences' },
        shared('activity'),
        { kind: 'source', id: 'stack-trace', title: 'Stack trace' },
        shared('overview'),
      ],
      fixPullRequest: null,
    });
    expect(summary(plan)).toBe('overview@entry activity@entry occurrences@entry stack-trace@entry');
    expect(plan.kind === 'tabs' && plan.tabs[2]).toMatchObject({
      kind: 'source', title: 'Occurrences', titleKey: 'plugins.source.tab.occurrences',
    });
  });

  it('always opens on Overview, which hosts the agent step even when the source has no overview panel', () => {
    const plan = planTriageDetailTabsV1({
      workflowSubject: 'pullRequest',
      entryTabs: [shared('files')],
      fixPullRequest: null,
    });
    expect(summary(plan)).toBe('overview@none files@entry');
  });
});

describe('the tab summaries (Files 17, Checks 2 failing)', () => {
  const failing = { id: 'example/checks', importance: 'primary', value: { kind: 'status', value: '2 failing', tone: 'danger' } } as const;
  const summaries = (plan: ReturnType<typeof planTriageDetailTabsV1>) => (plan.kind === 'whole'
    ? []
    : plan.tabs.map((tab) => [tab.id, tab.summary ?? null]));

  it('reads the fact each declaring source named, from that source\'s own entry', () => {
    const plan = planTriageDetailTabsV1({
      workflowSubject: 'issue',
      entryTabs: [shared('overview'), { kind: 'source', id: 'occurrences', title: 'Occurrences', summaryFact: 'example/events' }],
      entryFacts: [{ id: 'example/events', importance: 'secondary', value: { kind: 'number', value: 1234, format: 'compact' } }],
      fixPullRequest: {
        detailTabs: [shared('files'), { kind: 'shared', id: 'checks', summaryFact: 'example/checks' }],
        // The issue's own facts never stand in for the fix PR's.
        facts: [failing],
      },
    });
    expect(summaries(plan)).toEqual([
      ['overview', null],
      ['files', null],
      ['checks', failing.value],
      ['occurrences', { kind: 'number', value: 1234, format: 'compact' }],
    ]);
  });

  it('shows no count when the named fact is absent from this entry', () => {
    const plan = planTriageDetailTabsV1({
      workflowSubject: 'pullRequest',
      entryTabs: [shared('overview'), { kind: 'shared', id: 'checks', summaryFact: 'example/checks' }],
      entryFacts: [],
      fixPullRequest: null,
    });
    expect(summaries(plan)).toEqual([['overview', null], ['checks', null]]);
  });

  it('says a failure in its tone and keeps a plain count quiet', () => {
    expect(readTriageDetailTabSummaryV1(failing.value, 'en')).toEqual({ value: '2 failing', tone: 'danger' });
    expect(readTriageDetailTabSummaryV1({ kind: 'status', value: 'All passing', tone: 'success' }, 'en'))
      .toEqual({ value: 'All passing', tone: 'secondary' });
    expect(readTriageDetailTabSummaryV1({ kind: 'number', value: 17, format: 'plain' }, 'en'))
      .toEqual({ value: '17', tone: 'secondary' });
    // An approximate count stays approximate.
    expect(readTriageDetailTabSummaryV1({ kind: 'number', value: 1234, format: 'compact', approximate: true }, 'en'))
      .toEqual({ value: '~1.2K', tone: 'secondary' });
    expect(readTriageDetailTabSummaryV1({ kind: 'timestamp', atMs: 0, format: 'relative' }, 'en')).toBeNull();
    expect(readTriageDetailTabSummaryV1({ kind: 'detailOnly' }, 'en')).toBeNull();
  });
});
