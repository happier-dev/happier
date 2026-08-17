import {
  MAX_TRIAGE_ROW_FACTS_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
  TriageSourceEntrySnapshotV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  GITHUB_FIXTURE_OTHER_REPOSITORY_ID,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_ISSUE_RESPONSE,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_SEARCH_ISSUE_ITEM,
  GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY,
  GITHUB_SEARCH_PULL_REQUEST_ITEM,
  GITHUB_SEARCH_UNDECODABLE_ITEM,
} from '../__fixtures__/githubResponses.js';

import {
  decodeGithubIssueBody,
  decodeGithubPullRequestBody,
  decodeGithubSearchItem,
  projectGithubEntry,
} from './entry.js';
import { buildGithubRowFacts, formatGithubLabelSummary } from './facts.js';
import { toTriageSnapshot } from './protocol.js';

const SINGLE_LINE_V1 = new RegExp(TRIAGE_SINGLE_LINE_STRING_PATTERN_V1, 'u');

function requireProjection(value: ReturnType<typeof projectGithubEntry>) {
  if (value === null) throw new Error('expected the fixture entry to project');
  return value;
}

describe('GitHub triage entry mapping', () => {
  it('keys a pull request on the repository id and the number, never on the item id', () => {
    const view = decodeGithubSearchItem(GITHUB_SEARCH_PULL_REQUEST_ITEM);
    expect(view).not.toBeNull();
    const projection = requireProjection(
      projectGithubEntry(view!, GITHUB_FIXTURE_REPOSITORY_ID, { additionsDeletions: 'detailOnly' }),
    );

    expect(projection.localRef).toEqual({
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    });
    expect(projection.localRef.entryId).not.toBe(String(GITHUB_SEARCH_PULL_REQUEST_ITEM.id));
  });

  it('never persists or compares node_id', () => {
    const view = decodeGithubSearchItem(GITHUB_SEARCH_PULL_REQUEST_ITEM);
    const projection = requireProjection(
      projectGithubEntry(view!, GITHUB_FIXTURE_REPOSITORY_ID),
    );
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain('node_id');
    expect(serialized).not.toContain(String(GITHUB_SEARCH_PULL_REQUEST_ITEM.node_id));
  });

  it('maps a merged pull request to Merged and a closed one to Closed', () => {
    const merged = decodeGithubPullRequestBody({
      ...GITHUB_PULL_REQUEST_RESPONSE,
      state: 'closed',
      merged: true,
      merged_at: '2026-08-13T09:00:00Z',
    });
    const closed = decodeGithubPullRequestBody({
      ...GITHUB_PULL_REQUEST_RESPONSE,
      state: 'closed',
      merged_at: null,
    });

    expect(
      requireProjection(projectGithubEntry(merged!, GITHUB_FIXTURE_REPOSITORY_ID)).snapshot.state,
    ).toEqual({ presentation: 'closed', nativeLabel: 'Merged' });
    expect(
      requireProjection(projectGithubEntry(closed!, GITHUB_FIXTURE_REPOSITORY_ID)).snapshot.state,
    ).toEqual({ presentation: 'closed', nativeLabel: 'Closed' });
  });

  it('separates an issue closed as completed from one closed as not planned', () => {
    const route = { owner: 'octo-org', name: 'example-tools' } as const;
    const completed = decodeGithubIssueBody(
      { ...GITHUB_ISSUE_RESPONSE, state: 'closed', state_reason: 'completed' },
      route,
    );
    const notPlanned = decodeGithubIssueBody(
      { ...GITHUB_ISSUE_RESPONSE, state: 'closed', state_reason: 'not_planned' },
      route,
    );
    const bare = decodeGithubIssueBody({ ...GITHUB_ISSUE_RESPONSE, state: 'closed' }, route);

    expect(
      requireProjection(projectGithubEntry(completed!, GITHUB_FIXTURE_OTHER_REPOSITORY_ID))
        .snapshot.state,
    ).toEqual({ presentation: 'resolved', nativeLabel: 'Closed as completed' });
    expect(
      requireProjection(projectGithubEntry(notPlanned!, GITHUB_FIXTURE_OTHER_REPOSITORY_ID))
        .snapshot.state,
    ).toEqual({ presentation: 'closed', nativeLabel: 'Closed as not planned' });
    expect(
      requireProjection(projectGithubEntry(bare!, GITHUB_FIXTURE_OTHER_REPOSITORY_ID))
        .snapshot.state,
    ).toEqual({ presentation: 'closed', nativeLabel: 'Closed' });
  });

  it('keeps an unknown provider state as unknown with the raw label, never as absence', () => {
    const view = decodeGithubPullRequestBody({
      ...GITHUB_PULL_REQUEST_RESPONSE,
      state: 'archived_by_provider',
    });
    expect(
      requireProjection(projectGithubEntry(view!, GITHUB_FIXTURE_REPOSITORY_ID)).snapshot.state,
    ).toEqual({ presentation: 'unknown', nativeLabel: 'archived_by_provider' });
  });

  it('maps a search item carrying pull_request as a pull request, never as an issue', () => {
    expect(decodeGithubSearchItem(GITHUB_SEARCH_PULL_REQUEST_ITEM)?.kindId).toBe('pull-request');
    expect(decodeGithubSearchItem(GITHUB_SEARCH_ISSUE_ITEM)?.kindId).toBe('issue');
  });

  it('omits a row without a usable number instead of fabricating a key', () => {
    expect(decodeGithubSearchItem(GITHUB_SEARCH_UNDECODABLE_ITEM)).toBeNull();
    expect(decodeGithubSearchItem({ ...GITHUB_SEARCH_PULL_REQUEST_ITEM, number: 0 })).toBeNull();
    expect(decodeGithubSearchItem({ ...GITHUB_SEARCH_PULL_REQUEST_ITEM, number: null })).toBeNull();
  });

  it('renders a detail-only fact differently from an omitted one', () => {
    const view = decodeGithubSearchItem(GITHUB_SEARCH_PULL_REQUEST_ITEM)!;
    const scanRow = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID, { additionsDeletions: 'detailOnly' }),
    );
    const detailRow = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID, {
        additionsDeletions: { additions: 214, deletions: 88 },
      }),
    );
    const omittedRow = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID, { additionsDeletions: null }),
    );

    // Read the fact TABLE, not the bounded row: the published fact count is small
    // enough that a supplementary fact may not reach the row at all, and the contract
    // under test here is that answered-elsewhere and cannot-report stay distinct.
    const readFact = (row: typeof scanRow) => buildGithubRowFacts({
      kindId: 'pull-request',
      number: row.localRef.entryId,
      repositoryLabel: row.snapshot.scopeLabel,
      authorLogin: null,
      updatedAtMs: row.snapshot.sourceUpdatedAtMs,
      commentCount: null,
      labelNames: [],
      reviewDecision: null,
      checks: null,
      mergeability: null,
      additionsDeletions: row === scanRow
        ? 'detailOnly'
        : row === detailRow ? { additions: 214, deletions: 88 } : null,
    }).rowFacts.find((fact) => fact.id === 'github/additions-deletions');

    expect(readFact(scanRow)?.value).toEqual({ kind: 'detailOnly' });
    expect(readFact(detailRow)?.value).toEqual({ kind: 'text', text: '+214 −88' });
    expect(readFact(omittedRow)).toBeUndefined();
  });

  it('keeps a valid entry with 300 labels and a 20KB title visible, bounded, and projectionTruncated', () => {
    const view = decodeGithubSearchItem({
      ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
      title: 'ß'.repeat(20_000),
      labels: Array.from({ length: 300 }, (_unused, index) => ({ name: `label-${index}` })),
    })!;
    const projection = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID),
    );

    expect(projection.localRef.entryId).toBe('1284');
    // Bounded by the PUBLISHED text bound, not a second local number: an oversized
    // string is rejected atomically at the target, taking the whole page with it.
    expect(new TextEncoder().encode(projection.snapshot.title).byteLength)
      .toBeLessThanOrEqual(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
    expect(projection.snapshot.projectionTruncated).toBe(true);
    expect(projection.snapshot.rowFacts.length).toBeLessThanOrEqual(MAX_TRIAGE_ROW_FACTS_V1);
    // 300 labels become one bounded summary, never a complete label set on a list row.
    expect(formatGithubLabelSummary(view.labelNames))
      .toBe('label-0, label-1, label-2 +297');
  });

  it('keeps the highest-importance facts when the published fact count cannot hold the table', () => {
    const view = decodeGithubSearchItem(GITHUB_SEARCH_PULL_REQUEST_ITEM)!;
    const projection = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID, {
        reviewDecision: 'changes-requested',
        checks: { kind: 'failing', failingCount: 2 },
        mergeability: 'conflicts',
        additionsDeletions: 'detailOnly',
      }),
    );

    // Emission order is the table's reading order, so a positional bound would keep
    // the comment count and drop the review decision a reviewer triages on.
    expect(projection.snapshot.rowFacts.map((fact) => fact.id)).toEqual([
      'github/number',
      'github/repository',
      'github/review-decision',
      'github/checks',
    ]);
    expect(projection.snapshot.projectionTruncated).toBe(true);
  });

  it('never carries a body excerpt onto a list row', () => {
    const view = decodeGithubSearchItem({
      ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
      body: 'A long provider description that belongs to the live detail materialization.',
    })!;
    const projection = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID),
    );

    // Body, comments, activity and diffs are fetched live in the detail surface. A
    // list row that carried an excerpt of them would make the scan result the place
    // provider content lives, which is exactly what the list projection is not.
    expect(JSON.stringify(projection)).not.toContain('live detail materialization');
    expect(Object.keys(projection.snapshot)).not.toContain('summary');
  });

  it('derives the repository route from repository_url when the search item omits repository', () => {
    const view = decodeGithubSearchItem(GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY);
    expect(view?.owner).toBe('octo-org');
    expect(view?.name).toBe('example-app');
    // Identity is NOT guessable from the mutable path: the caller must read the id.
    expect(view?.repositoryId).toBeNull();
  });

  it('builds a lowercased routing token and an owner/name#number display path', () => {
    const view = decodeGithubSearchItem({
      ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
      repository_url: 'https://api.github.com/repos/Octo-Org/Example-App',
    })!;
    const projection = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID),
    );

    expect(projection.locator.routingToken).toBe('octo-org/example-app');
    expect(projection.locator.displayPath).toBe('octo-org/example-app#1284');
    expect(projection.locator.webUrl).toBe(
      'https://github.com/octo-org/example-app/pull/1284',
    );
  });

  it('yields a null web url for a relative provider link rather than a host-relative string', () => {
    const view = decodeGithubSearchItem({
      ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
      html_url: '/octo-org/example-app/pull/1284',
    })!;
    const projection = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID),
    );

    expect(projection.locator.webUrl).toBeNull();
    expect(projection.snapshot.webUrl).toBeNull();
  });
  it('publishes a newline-bearing provider title as one line instead of rejecting its page', () => {
    const view = decodeGithubSearchItem({
      ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
      title: 'Stream terminal frames\r\n\twithout a full re-render',
    })!;
    const projection = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID),
    );
    const published = toTriageSnapshot(
      projection.snapshot,
      projection.locator,
      projection.localRef.entryId,
    );

    // The strict target rejects a control-bearing result ATOMICALLY, so one such
    // title would discard every other row on the same scan page.
    expect(() => TriageSourceEntrySnapshotV1Schema.parse(published)).not.toThrow();
    expect(published.title).toBe('Stream terminal frames without a full re-render');

    // Collapsing a control run loses no content, so it must not be charged as
    // truncation: this row's flag is whatever the unmodified fixture already produced.
    const baseline = requireProjection(
      projectGithubEntry(
        decodeGithubSearchItem(GITHUB_SEARCH_PULL_REQUEST_ITEM)!,
        GITHUB_FIXTURE_REPOSITORY_ID,
      ),
    );
    expect(published.projectionTruncated)
      .toBe(baseline.snapshot.projectionTruncated || undefined);
  });

  it('publishes a newline-bearing repository label as one line', () => {
    const view = decodeGithubSearchItem({
      ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
      repository: {
        ...(GITHUB_SEARCH_PULL_REQUEST_ITEM.repository as Record<string, unknown>),
        full_name: 'octo-org/example\napp',
      },
    })!;
    const projection = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID),
    );

    expect(SINGLE_LINE_V1.test(projection.snapshot.scopeLabel)).toBe(true);
  });
  it('publishes an unrecognized provider state as one bounded line', () => {
    // GitHub's `state` is a bare provider string and this mapper documents an
    // unrecognized value as expected. It reaches `state.nativeLabel`, a single-line
    // byte-bounded V1 string, so an unnormalized one rejects the whole page.
    const view = decodeGithubSearchItem({
      ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
      state: 'under\nreview',
      pull_request: undefined,
    })!;
    const projection = requireProjection(
      projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID),
    );
    const published = toTriageSnapshot(
      projection.snapshot,
      projection.locator,
      projection.localRef.entryId,
    );

    expect(published.state).toEqual({ presentation: 'unknown', nativeLabel: 'under review' });
    expect(() => TriageSourceEntrySnapshotV1Schema.parse(published)).not.toThrow();
  });
});
