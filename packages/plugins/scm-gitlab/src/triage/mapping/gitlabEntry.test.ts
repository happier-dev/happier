import { describe, expect, it } from 'vitest';

import issueList from '../__fixtures__/issueList.json' with { type: 'json' };
import mergeRequestList from '../__fixtures__/mergeRequestList.json' with { type: 'json' };
import mergeRequestVariants from '../__fixtures__/mergeRequestVariants.json' with { type: 'json' };
import { normalizeGitlabConfiguredBaseUrl } from '../origin.js';
import {
  MAX_TRIAGE_ROW_FACTS_V1,
  MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
} from '@happier-dev/triage-protocol/v1';

import { boundGitlabText, summarizeGitlabLabels } from './bounded.js';
import {
  decodeGitlabPage,
  decodeGitlabRow,
  projectGitlabIssueState,
  projectGitlabMergeRequestState,
  projectGitlabMergeStatusFact,
} from './gitlabEntry.js';

const origin = normalizeGitlabConfiguredBaseUrl('https://gitlab.com');
if (!origin) throw new Error('unusable fixture origin');
const GITLAB_COM = origin;

function rowOf(value: unknown): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

function mapMergeRequest(row: unknown) {
  const decoded = decodeGitlabRow({
    kindId: 'merge-request',
    origin: GITLAB_COM,
    row,
    laneInvolvement: 'author',
  });
  if (decoded.kind !== 'mapped') throw new Error(decoded.reason);
  return decoded.entry;
}

describe('merge-request mapping', () => {
  it('maps a published merge-request row into the plugin-local snapshot', () => {
    const entry = mapMergeRequest(mergeRequestList[0]);
    expect(entry.snapshot).toMatchObject({
      title: 'Fix login page CSS paddings',
      state: { presentation: 'active', nativeLabel: 'Open' },
      detailedMergeStatus: 'checking',
      branches: { source: 'fix-login-padding', target: 'main' },
      draft: false,
      commentCount: 3,
    });
    expect(entry.snapshot.author?.username).toBe('example-user');
    expect(entry.snapshot.reviewers.map((actor) => actor.username)).toEqual(['example-reviewer']);
    expect(entry.snapshot.sourceUpdatedAtMs).toBe(Date.parse('2026-08-09T08:46:00Z'));
    expect(entry.viewer.involvement).toEqual(['author']);
    // This row carries five projectable facts and the contract projects four, so the
    // entry says so. `projectionTruncated` is the contract's own signal that the
    // projection dropped something; suppressing it to keep it rare would make the four
    // facts look like the whole row.
    expect(entry.projectionTruncated).toBe(true);
  });

  it('reads the draft flag and never the title prefix', () => {
    expect(projectGitlabMergeRequestState(rowOf(mergeRequestVariants.draft)))
      .toEqual({ presentation: 'active', nativeLabel: 'Draft' });
    // The title begins with "Draft" but the flag is false: parsing the title would
    // mislabel a perfectly ordinary open merge request.
    expect(projectGitlabMergeRequestState(rowOf(mergeRequestVariants.titlePrefixedButNotDraft)))
      .toEqual({ presentation: 'active', nativeLabel: 'Open' });
  });

  it('keeps locked active, merged and closed closed, and an unseen state explicitly unknown', () => {
    expect(projectGitlabMergeRequestState(rowOf(mergeRequestVariants.locked)))
      .toEqual({ presentation: 'active', nativeLabel: 'Locked' });
    expect(projectGitlabMergeRequestState(rowOf(mergeRequestList[1])))
      .toEqual({ presentation: 'closed', nativeLabel: 'Merged' });
    expect(projectGitlabMergeRequestState(rowOf(mergeRequestVariants.closed)))
      .toEqual({ presentation: 'closed', nativeLabel: 'Closed' });
    // An unrecognized native state stays `unknown` with its own bounded label; it
    // must not be flattened into closed, which would hide a live merge request.
    expect(projectGitlabMergeRequestState(rowOf(mergeRequestVariants.unknownState)))
      .toEqual({ presentation: 'unknown', nativeLabel: 'quarantined' });
  });

  it('renders checking as ask-again rather than a hard block, and omits an unknown status', () => {
    expect(projectGitlabMergeStatusFact('checking')?.value)
      .toEqual({ kind: 'status', label: 'Computing', tone: 'info' });
    expect(projectGitlabMergeStatusFact('ci_still_running')?.value)
      .toEqual({ kind: 'status', label: 'Computing', tone: 'info' });
    expect(projectGitlabMergeStatusFact('conflict')?.value)
      .toEqual({ kind: 'status', label: 'Conflicts', tone: 'danger' });
    expect(projectGitlabMergeStatusFact('mergeable')?.value)
      .toEqual({ kind: 'status', label: 'Mergeable', tone: 'success' });
    expect(projectGitlabMergeStatusFact('a_status_shipped_after_this_client')).toBeNull();
    expect(projectGitlabMergeStatusFact(null)).toBeNull();
  });
});

describe('issue mapping', () => {
  it('never synthesizes merge-request-only content on an issue', () => {
    const decoded = decodeGitlabRow({
      kindId: 'issue',
      origin: GITLAB_COM,
      row: issueList[0],
      laneInvolvement: 'assignee',
    });
    if (decoded.kind !== 'mapped') throw new Error(decoded.reason);
    expect(decoded.entry.snapshot).toMatchObject({
      state: { presentation: 'active', nativeLabel: 'Open' },
      draft: null,
      branches: null,
      detailedMergeStatus: null,
    });
    expect(decoded.entry.snapshot.reviewers).toEqual([]);
    expect(decoded.entry.rowFacts.map((fact) => fact.id)).not.toContain('gitlab/merge-status');
    expect(decoded.entry.rowFacts.find((fact) => fact.id === 'gitlab/iid')?.value)
      .toEqual({ kind: 'text', text: '#7' });
  });

  it('maps the item-level subscription only when GitLab actually returned it', () => {
    const withoutFlag = decodeGitlabRow({
      kindId: 'issue', origin: GITLAB_COM, row: issueList[0], laneInvolvement: 'author',
    });
    const withFlag = decodeGitlabRow({
      kindId: 'issue', origin: GITLAB_COM, row: issueList[1], laneInvolvement: 'author',
    });
    if (withoutFlag.kind !== 'mapped' || withFlag.kind !== 'mapped') throw new Error('expected both');
    // A missing key is a permission-scoped omission, not "not subscribed".
    expect(withoutFlag.entry.viewer.involvement).toEqual(['author']);
    expect(withFlag.entry.viewer.involvement).toEqual(['author', 'subscribed']);
  });

  it('keeps an unrecognized issue state explicitly unknown', () => {
    expect(projectGitlabIssueState(rowOf(issueList[2])))
      .toEqual({ presentation: 'unknown', nativeLabel: 'escalated' });
  });
});

describe('semantic bounds', () => {
  it('keeps an oversize valid entry visible, bounded, and flagged rather than dropping it', () => {
    const entry = mapMergeRequest({
      ...rowOf(mergeRequestList[0]),
      title: '\u{1F680}'.repeat(4_000),
      labels: Array.from({ length: 300 }, (_, index) => `label-${index}`),
    });
    // Identity and locator survive intact.
    expect(entry.identity.entryId).toBe('7');
    expect(entry.locator.repositoryKey).toBe('example-group/example-subgroup/example-project');
    // The ceiling is the published symbol, never a number this package remembers: the
    // contract owner tightens it independently, and an over-bound row is rejected
    // atomically, taking every sibling row in the page with it.
    expect(new TextEncoder().encode(entry.snapshot.title).length)
      .toBeLessThanOrEqual(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
    // Truncation lands on a code-point boundary, never mid-surrogate.
    expect(entry.snapshot.title).not.toContain('�');
    expect([...entry.snapshot.title].every((c) => c === '\u{1F680}' || c === '…')).toBe(true);
    expect(entry.rowFacts.length).toBeLessThanOrEqual(MAX_TRIAGE_ROW_FACTS_V1);
    for (const fact of entry.rowFacts) {
      const text = fact.value.kind === 'text'
        ? fact.value.text
        : fact.value.kind === 'actor' ? fact.value.actor : '';
      expect(new TextEncoder().encode(text).length)
        .toBeLessThanOrEqual(MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
    }
    // Every decoded label survives on the entry: only the projection is summarized.
    expect(entry.snapshot.labels).toHaveLength(300);
    expect(summarizeGitlabLabels(entry.snapshot.labels).text)
      .toBe('label-0, label-1, label-2 +297');
    expect(entry.projectionTruncated).toBe(true);
  });

  it('keeps the provider-native state a reader acts on when the fact bound drops one', () => {
    // Four projected facts is the whole budget, so which four survive is a decision, not
    // a side effect of push order. A merge request's conflict status outranks its
    // supplementary counts.
    const entry = mapMergeRequest({
      ...rowOf(mergeRequestList[0]),
      detailed_merge_status: 'conflict',
      user_notes_count: 12,
      labels: ['a', 'b'],
    });

    expect(entry.rowFacts.map((fact) => fact.id)).toEqual([
      'gitlab/iid',
      'gitlab/merge-status',
      'gitlab/author',
      'gitlab/comments',
    ]);
    expect(entry.projectionTruncated).toBe(true);
  });

  it('collapses a control character rather than emitting a string the target rejects', () => {
    // Every V1 display string is a single line. A provider title carrying a newline is
    // not repaired downstream — the strict target rejects the whole result.
    const entry = mapMergeRequest({
      ...rowOf(mergeRequestList[0]),
      title: 'Fix the parser\n\tand its caller',
    });

    expect(entry.snapshot.title).toBe('Fix the parser and its caller');
    // The collapse itself loses nothing, so it is not what raises the truncation flag.
    expect(boundGitlabText('Fix the parser\n\tand its caller').truncated).toBe(false);
  });

  it('truncates on a UTF-8 byte budget without splitting a code point', () => {
    const bounded = boundGitlabText('é'.repeat(100), 20);
    expect(new TextEncoder().encode(bounded.text).length).toBeLessThanOrEqual(20);
    expect(bounded.text).not.toContain('�');
    expect(bounded.truncated).toBe(true);
  });
});

describe('decodeGitlabPage', () => {
  it('skips a malformed row while keeping its valid siblings and the raw cardinality', () => {
    const decoded = decodeGitlabPage({
      kindId: 'merge-request',
      origin: GITLAB_COM,
      body: [mergeRequestList[0], mergeRequestVariants.missingIid, 'not-an-object', mergeRequestList[1]],
      laneInvolvement: 'author',
    });
    expect(decoded).toMatchObject({ undecodableCount: 2, rawItemCount: 4 });
    expect(decoded?.entries.map((entry) => entry.identity.entryId)).toEqual(['7', '8']);
  });

  it('returns null for a body that is not a collection rather than an empty page', () => {
    expect(decodeGitlabPage({
      kindId: 'issue', origin: GITLAB_COM, body: { message: '403 Forbidden' }, laneInvolvement: 'author',
    })).toBeNull();
  });
});
