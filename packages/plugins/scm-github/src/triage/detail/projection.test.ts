import { describe, expect, it } from 'vitest';

import {
  githubChangedFile,
  githubTimelineCommitEvent,
  githubTimelineEvent,
  githubTimelineReviewEvent,
} from '../__fixtures__/githubResponses.js';

import {
  GithubChangedFilesResultV1Schema,
  GithubChecksResultV1Schema,
  GithubReviewsResultV1Schema,
  GithubTimelineResultV1Schema,
} from './contracts.js';
import {
  GITHUB_DETAIL_BOUNDS_V1,
  GITHUB_MAX_CHANGED_FILE_ROWS_V1,
  GITHUB_MAX_TIMELINE_ROWS_V1,
  GITHUB_TIMELINE_KINDS_V1,
  projectGithubChangedFileRows,
  projectGithubCheckRows,
  projectGithubCommentBody,
  projectGithubReviewPeople,
  projectGithubTimelineRows,
} from './projection.js';

const BOUNDS = GITHUB_DETAIL_BOUNDS_V1;

/** A string of exactly `count` ASCII code points, which is `count` UTF-8 bytes. */
function filler(count: number): string {
  return 'x'.repeat(count);
}

describe('GitHub detail timeline projection', () => {
  it('keeps forcePushed and baseChanged as their own arms', () => {
    const projected = projectGithubTimelineRows([
      githubTimelineEvent({ id: 1, event: 'head_ref_force_pushed', createdAt: '2026-08-01T00:00:00Z' }),
      githubTimelineEvent({ id: 2, event: 'base_ref_changed', createdAt: '2026-08-02T00:00:00Z' }),
    ], BOUNDS);

    // Folding either into `committed` is silent in both directions: a force push
    // may have destroyed the old head, and a base change usually does not move
    // the head SHA at all.
    expect(projected.rows.map((row) => row.kind)).toEqual(['forcePushed', 'baseChanged']);
    expect(projected.rows.map((row) => row.rawKind))
      .toEqual(['head_ref_force_pushed', 'base_ref_changed']);
  });

  it('keeps an unrecognized event as an unsupported row carrying its own raw kind', () => {
    const projected = projectGithubTimelineRows([
      githubTimelineEvent({ id: 9, event: 'connected', createdAt: '2026-08-03T00:00:00Z' }),
    ], BOUNDS);

    // Dropping it makes the timeline quietly incomplete; guessing it into a
    // neighbouring arm makes it quietly wrong.
    expect(projected.rows).toHaveLength(1);
    expect(projected.rows[0]?.kind).toBe('unsupported');
    expect(projected.rows[0]?.rawKind).toBe('connected');
    expect(projected.omittedRowCount).toBe(0);
  });

  it('reads a commit event, which carries no id, no created_at and no actor', () => {
    const projected = projectGithubTimelineRows([
      githubTimelineCommitEvent({
        sha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
        message: 'Stream terminal frames',
        committedAt: '2026-08-04T12:00:00Z',
        authorName: 'Mona Lisa',
      }),
    ], BOUNDS);

    const row = projected.rows[0];
    expect(row?.id).toBe('github-timeline-commit:9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29');
    expect(row?.kind).toBe('committed');
    expect(row?.actor).toBe('Mona Lisa');
    expect(row?.summary).toBe('Stream terminal frames');
    expect(row?.atMs).toBe(Date.parse('2026-08-04T12:00:00Z'));
  });

  it('reads a reviewed event, which names its author on user and its instant on submitted_at', () => {
    const projected = projectGithubTimelineRows([
      githubTimelineReviewEvent({
        id: 44,
        state: 'approved',
        submittedAt: '2026-08-07T09:30:00Z',
        login: 'mona',
      }),
    ], BOUNDS);

    const row = projected.rows[0];
    // A review is the one timeline event whose author and instant decide a
    // product question — has anybody signed off — so dropping them renders an
    // anonymous, undated approval that also sorts to the end of the history.
    expect(row?.kind).toBe('reviewed');
    expect(row?.actor).toBe('mona');
    expect(row?.atMs).toBe(Date.parse('2026-08-07T09:30:00Z'));
    expect(row?.summary).toBe('approved');
  });

  it('orders by event time and then by native event id', () => {
    const projected = projectGithubTimelineRows([
      githubTimelineEvent({ id: 30, event: 'labeled', createdAt: '2026-08-05T00:00:00Z', label: 'b' }),
      githubTimelineEvent({ id: 10, event: 'labeled', createdAt: '2026-08-05T00:00:00Z', label: 'a' }),
      githubTimelineEvent({ id: 20, event: 'closed', createdAt: '2026-08-04T00:00:00Z' }),
    ], BOUNDS);

    expect(projected.rows.map((row) => row.id)).toEqual([
      'github-timeline-event:20',
      'github-timeline-event:10',
      'github-timeline-event:30',
    ]);
  });

  it('omits a row it cannot identify and counts it against the page it read', () => {
    const projected = projectGithubTimelineRows([
      { event: 'labeled', created_at: '2026-08-05T00:00:00Z' },
      'not an object',
      githubTimelineEvent({ id: 7, event: 'closed', createdAt: '2026-08-06T00:00:00Z' }),
    ], BOUNDS);

    expect(projected.rows).toHaveLength(1);
    expect(projected.omittedRowCount).toBe(2);
  });

  it('normalizes a control-bearing summary into one bounded line', () => {
    const projected = projectGithubTimelineRows([
      githubTimelineEvent({
        id: 5,
        event: 'labeled',
        createdAt: '2026-08-05T00:00:00Z',
        label: `needs\ntriage${filler(BOUNDS.textUtf8Bytes)}`,
      }),
    ], BOUNDS);

    const row = projected.rows[0];
    expect(row?.summary?.startsWith('needs triage')).toBe(true);
    expect(row?.summary).not.toContain('\n');
    expect(new TextEncoder().encode(row?.summary ?? '').length)
      .toBeLessThanOrEqual(BOUNDS.textUtf8Bytes);
    expect(row?.truncated).toBe(true);
    expect(projected.projectionTruncated).toBe(true);
  });

  it('states the same kind vocabulary the published contract admits', () => {
    for (const kind of GITHUB_TIMELINE_KINDS_V1) {
      const parsed = GithubTimelineResultV1Schema.parse({
        kind: 'timeline',
        rows: [{ id: 'github-timeline-event:1', kind, rawKind: 'anything' }],
        omittedRowCount: 0,
        projectionTruncated: false,
      });
      expect(parsed.kind).toBe('timeline');
    }
    expect(() => GithubTimelineResultV1Schema.parse({
      kind: 'timeline',
      rows: [{ id: 'github-timeline-event:1', kind: 'invented', rawKind: 'anything' }],
      omittedRowCount: 0,
      projectionTruncated: false,
    })).toThrow();
  });
});

describe('GitHub detail changed-file projection', () => {
  it('publishes whether a patch exists without publishing the patch', () => {
    const projected = projectGithubChangedFileRows([
      githubChangedFile({ filename: 'src/a.ts' }),
      githubChangedFile({ filename: 'src/huge.bin', withPatch: false }),
    ], BOUNDS);

    expect(projected.rows.map((row) => row.diffAvailable)).toEqual([true, false]);
    // The rich diff body is held under B6, and shipping diff bytes to a surface
    // that has no renderer for them would pay for a feature that does not exist.
    expect(JSON.stringify(projected)).not.toContain('@@');
  });

  it('keeps the previous path of a rename and derives an absent change count', () => {
    const projected = projectGithubChangedFileRows([
      Object.freeze({
        ...githubChangedFile({
          filename: 'src/renamed.ts',
          status: 'renamed',
          previousFilename: 'src/old.ts',
          additions: 4,
          deletions: 2,
        }),
        changes: undefined,
      }),
    ], BOUNDS);

    const row = projected.rows[0];
    expect(row?.previousPath).toBe('src/old.ts');
    expect(row?.status).toBe('renamed');
    expect(row?.changes).toBe(6);
  });

  it('omits a row with no path or status rather than inventing one', () => {
    const projected = projectGithubChangedFileRows([
      { status: 'modified', additions: 1, deletions: 0 },
      { filename: 'src/a.ts', additions: 1, deletions: 0 },
      githubChangedFile({ filename: 'src/b.ts' }),
    ], BOUNDS);

    expect(projected.rows.map((row) => row.path)).toEqual(['src/b.ts']);
    expect(projected.omittedRowCount).toBe(2);
  });
});

describe('GitHub detail comment projection', () => {
  it('keeps the line structure a comment body IS', () => {
    const body = projectGithubCommentBody(
      'First line\r\n\r\n\r\n\r\nSecond line\0with a control',
    );
    expect(body.value).toBe('First line\n\nSecond line with a control');
    expect(body.truncated).toBe(false);
  });

  it('preserves provider document bytes when no real boundary requires truncation', () => {
    const value = `${filler(9_000)}\u{1F600}`;
    const body = projectGithubCommentBody(value);
    expect(body.value).toBe(value);
    expect(body.truncated).toBe(false);
  });

});

describe('GitHub detail check projection', () => {
  it('keeps every valid listed row when the result fits the canonical Action envelope', () => {
    const observations = Array.from({ length: 205 }, (_, index) => ({
      key: `github-check-run:${index + 1}`,
      resourceKind: 'check-run' as const,
      name: `job-${index + 1}`,
      status: 'completed',
      conclusion: 'success',
      detailsUrl: null,
      startedAtMs: null,
      completedAtMs: null,
    }));

    const projected = projectGithubCheckRows(observations, BOUNDS);
    expect(projected.rows).toHaveLength(observations.length);
    expect(projected.omittedRowCount).toBe(0);
    expect(projected.projectionTruncated).toBe(false);
  });
});

describe('GitHub detail projection schema admission', () => {
  it('admits a fully saturated timeline page', () => {
    const raw = Array.from({ length: GITHUB_MAX_TIMELINE_ROWS_V1 }, (_, index) => ({
      id: index + 1,
      node_id: filler(BOUNDS.identifierUtf8Bytes * 2),
      event: filler(256),
      created_at: '2026-08-05T00:00:00Z',
      actor: { login: filler(256) },
      label: { name: filler(BOUNDS.textUtf8Bytes * 2) },
      html_url: `https://github.com/${filler(BOUNDS.locationUtf8Bytes - 20)}`,
    }));

    const projected = projectGithubTimelineRows(raw, BOUNDS);
    expect(projected.rows).toHaveLength(GITHUB_MAX_TIMELINE_ROWS_V1);
    const result = GithubTimelineResultV1Schema.parse({
      kind: 'timeline',
      rows: projected.rows,
      omittedRowCount: 0,
      projectionTruncated: true,
      continuation: JSON.stringify({ v: 1, page: 2, perPage: 50 }),
    });
    if (result.kind !== 'timeline') throw new Error(`expected timeline, got ${result.kind}`);
    expect(result.rows).toHaveLength(GITHUB_MAX_TIMELINE_ROWS_V1);
  });

  it('admits a fully saturated changed-file page', () => {
    const raw = Array.from({ length: GITHUB_MAX_CHANGED_FILE_ROWS_V1 }, (_, index) => ({
      filename: `${filler(1_024)}${index}`,
      previous_filename: filler(1_024),
      status: filler(256),
      additions: Number.MAX_SAFE_INTEGER,
      deletions: Number.MAX_SAFE_INTEGER,
      changes: Number.MAX_SAFE_INTEGER,
      sha: filler(BOUNDS.identifierUtf8Bytes * 2),
      blob_url: `https://github.com/${filler(BOUNDS.locationUtf8Bytes - 20)}`,
      patch: filler(50_000),
    }));

    const projected = projectGithubChangedFileRows(raw, BOUNDS);
    expect(projected.rows).toHaveLength(GITHUB_MAX_CHANGED_FILE_ROWS_V1);
    expect(projected.rows[0]?.path).toBe(`${filler(1_024)}0`);
    expect(projected.rows[0]?.status).toBe(filler(256));
    const result = GithubChangedFilesResultV1Schema.parse({
      kind: 'changedFiles',
      rows: projected.rows,
      omittedRowCount: 0,
      projectionTruncated: true,
      incomplete: 'ceiling',
      continuation: JSON.stringify({ v: 1, page: 2, perPage: 100 }),
    });
    if (result.kind !== 'changedFiles') throw new Error(`expected changedFiles, got ${result.kind}`);
    expect(result.rows).toHaveLength(GITHUB_MAX_CHANGED_FILE_ROWS_V1);
  });

  it('admits a fully saturated checks result', () => {
    const observations = Array.from({ length: 205 }, (_, index) => ({
      key: `${filler(BOUNDS.identifierUtf8Bytes * 2)}${index}`,
      resourceKind: 'check-run' as const,
      name: filler(256),
      status: filler(256),
      conclusion: filler(256),
      detailsUrl: `https://ci.example.com/${filler(BOUNDS.locationUtf8Bytes - 25)}`,
      startedAtMs: 1_700_000_000_000,
      completedAtMs: 1_700_000_100_000,
    }));

    const projected = projectGithubCheckRows(observations, BOUNDS);
    const result = GithubChecksResultV1Schema.parse({
      kind: 'checks',
      headRevision: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      state: 'knownIncomplete',
      rows: projected.rows,
      failingCount: 1,
      runningCount: 2,
      passingCount: 3,
      omittedRowCount: 0,
      projectionTruncated: true,
    });
    if (result.kind !== 'checks') throw new Error(`expected checks, got ${result.kind}`);
    expect(result.rows).toHaveLength(observations.length);
  });

  it('admits review people beyond the retired source-local count ceiling', () => {
    const historical = Array.from({ length: 205 }, (_, index) => ({
      login: `reviewer-${index}`,
      state: 'APPROVED',
      submittedAtMs: index,
    }));
    const outstanding = Array.from({ length: 205 }, (_, index) => ({
      kind: 'user' as const,
      login: `requested-${index}`,
    }));
    const projected = projectGithubReviewPeople({ historical, outstanding }, BOUNDS);
    const result = GithubReviewsResultV1Schema.parse({
      kind: 'reviews',
      reviewed: projected.reviewed,
      requested: projected.requested,
      omittedRowCount: projected.omittedRowCount,
      projectionTruncated: projected.projectionTruncated,
    });
    if (result.kind !== 'reviews') throw new Error(`expected reviews, got ${result.kind}`);
    expect(result.reviewed).toHaveLength(historical.length);
    expect(result.requested).toHaveLength(outstanding.length);
    expect(result.omittedRowCount).toBe(0);
  });
});
