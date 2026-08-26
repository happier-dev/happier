import { describe, expect, it } from 'vitest';

import pageOne from './fixtures/pullRequestsPageOne.json' with { type: 'json' };
import pageTwo from './fixtures/pullRequestsPageTwo.json' with { type: 'json' };
import pullRequestSelf from './fixtures/pullRequestSelf.json' with { type: 'json' };
import workspacesPage from './fixtures/userWorkspacesPage.json' with { type: 'json' };
import repositoriesPage from './fixtures/workspaceRepositoriesPage.json' with { type: 'json' };
import {
  MAX_BITBUCKET_TEXT_UTF8_BYTES,
  decodeBitbucketPullRequestRow,
  decodeBitbucketRepositoryRow,
  decodeBitbucketWorkspaceAccessRow,
} from './entries.js';

const [openRow, declinedRow] = pageOne.values;

describe('Bitbucket pull-request row mapping', () => {
  it('keys identity on the destination repository UUID with braces and on the provider integer id', () => {
    const decoded = decodeBitbucketPullRequestRow(openRow);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.entry.collisionScope).toBe('bitbucket:{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}');
    expect(decoded.entry.entryId).toBe('42');
    expect(decoded.entry.kindId).toBe('pull-request');
    expect(decoded.entry.repository.repositoryKey).toBe('example-workspace/deploy-tools');
    expect(decoded.entry.webUrl).toBe('https://bitbucket.org/example-workspace/deploy-tools/pull-requests/42');
  });

  it('omits an identity-invalid row rather than fabricating an id, and keeps its siblings', () => {
    const [validRow, identityInvalidRow] = pageTwo.values;

    expect(decodeBitbucketPullRequestRow(validRow).ok).toBe(true);

    const rejected = decodeBitbucketPullRequestRow(identityInvalidRow);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe('identity-invalid');

    expect(decodeBitbucketPullRequestRow(null).ok).toBe(false);
  });

  it('maps all four native states without collapsing a declined pull request into absence', () => {
    const declined = decodeBitbucketPullRequestRow(declinedRow);
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    expect(declined.entry.state).toEqual({
      native: 'DECLINED',
      presentation: 'declined',
      nativeLabel: 'Declined',
    });
    expect(declined.entry.declineReason).toBe('Replaced by the workspace-wide notifier rollout.');
    expect(declined.entry.closedBy?.nickname).toBe('example-maintainer');

    const merged = decodeBitbucketPullRequestRow(pageTwo.values[0]);
    expect(merged.ok && merged.entry.state.presentation).toBe('merged');
    expect(merged.ok && merged.entry.mergeCommitHash).toBe('b71c3d9e2f08');

    const superseded = decodeBitbucketPullRequestRow({ ...openRow, state: 'SUPERSEDED' });
    expect(superseded.ok && superseded.entry.state.presentation).toBe('superseded');

    const unknownState = decodeBitbucketPullRequestRow({ ...openRow, state: 'ARCHIVED' });
    expect(unknownState.ok && unknownState.entry.state.presentation).toBe('unknown');
    expect(unknownState.ok && unknownState.entry.state.nativeLabel).toBe('ARCHIVED');
  });

  it('distinguishes a reviewer list the endpoint omits from a reviewer list that is empty', () => {
    const fromList = decodeBitbucketPullRequestRow(openRow);
    const fromSelf = decodeBitbucketPullRequestRow(pullRequestSelf);
    expect(fromList.ok && fromSelf.ok).toBe(true);
    if (!fromList.ok || !fromSelf.ok) return;

    expect(fromList.entry.reviewers).toBeNull();
    expect(fromList.entry.participants).toBeNull();

    expect(fromSelf.entry.reviewers).toHaveLength(2);
    expect(fromSelf.entry.participants).toHaveLength(3);
    expect(fromSelf.entry.participants?.[0]).toMatchObject({
      role: 'REVIEWER',
      approved: true,
      state: 'approved',
    });
    expect(fromSelf.entry.participants?.[2]).toMatchObject({ role: 'PARTICIPANT', state: null });

    const emptyReviewers = decodeBitbucketPullRequestRow({ ...pullRequestSelf, reviewers: [] });
    expect(emptyReviewers.ok && emptyReviewers.entry.reviewers).toEqual([]);
  });

  it('drops only malformed nested review items and records incomplete review evidence', () => {
    const decoded = decodeBitbucketPullRequestRow({
      ...pullRequestSelf,
      reviewers: [
        pullRequestSelf.reviewers[0],
        { ...pullRequestSelf.reviewers[1], uuid: 'not-a-bitbucket-uuid' },
      ],
      participants: [
        pullRequestSelf.participants[0],
        { ...pullRequestSelf.participants[1], state: 'maybe' },
        {
          ...pullRequestSelf.participants[2],
          user: { ...pullRequestSelf.participants[2].user, uuid: null },
        },
      ],
    });

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.entry.reviewers).toHaveLength(1);
    expect(decoded.entry.participants).toHaveLength(1);
    expect(decoded.entry.participants?.[0]?.state).toBe('approved');
    expect(decoded.entry.reviewEvidenceIncomplete).toBe(true);
  });

  it('carries draft and queued as read facts and never as a transition', () => {
    const draft = decodeBitbucketPullRequestRow(pullRequestSelf);
    expect(draft.ok && draft.entry.draft).toBe(true);
    expect(draft.ok && draft.entry.queued).toBe(false);

    const withoutQueued = decodeBitbucketPullRequestRow({ ...openRow, queued: undefined });
    expect(withoutQueued.ok && withoutQueued.entry.queued).toBeNull();
    expect(withoutQueued.ok && withoutQueued.entry.draft).toBe(false);
  });

  it('parses the ISO8601 timestamps through the provider strings, not through a local clock', () => {
    const decoded = decodeBitbucketPullRequestRow(openRow);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.entry.createdAtMs).toBe(Date.parse('2026-08-10T09:14:22.113940+00:00'));
    expect(decoded.entry.updatedAtMs).toBe(Date.parse('2026-08-12T16:02:41.884210+00:00'));

    const malformedDate = decodeBitbucketPullRequestRow({ ...openRow, updated_on: 'not-a-date' });
    expect(malformedDate.ok && malformedDate.entry.updatedAtMs).toBeNull();
  });

  it('keeps an oversize but identity-valid entry visible, truncated on a UTF-8 boundary, and flagged', () => {
    const decoded = decodeBitbucketPullRequestRow({ ...openRow, title: '☂'.repeat(4_000) });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const titleBytes = new TextEncoder().encode(decoded.entry.title).byteLength;
    expect(titleBytes).toBeLessThanOrEqual(MAX_BITBUCKET_TEXT_UTF8_BYTES);
    expect(decoded.entry.title.endsWith('�')).toBe(false);
    expect(decoded.entry.projectionTruncated).toBe(true);
    expect(decoded.entry.entryId).toBe('42');
  });

  it('records the source and destination tips a checkout needs without inventing one', () => {
    const decoded = decodeBitbucketPullRequestRow(openRow);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.entry.source).toMatchObject({
      branchName: 'fix/poller-deadline',
      commitHash: '3f6c1a8e9b24',
    });
    expect(decoded.entry.destination).toMatchObject({ branchName: 'main', commitHash: 'c07d5b21f4ae' });

    const noTips = decodeBitbucketPullRequestRow({ ...openRow, source: { branch: { name: 'x' } } });
    expect(noTips.ok && noTips.entry.source?.commitHash).toBeNull();
  });
});

describe('Bitbucket workspace and repository row mapping', () => {
  it('unwraps the workspace-permission envelope that /user/workspaces actually returns', () => {
    const rows = workspacesPage.values.map(decodeBitbucketWorkspaceAccessRow);

    expect(rows[0]).toEqual({
      ok: true,
      workspace: {
        uuid: '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}',
        slug: 'example-workspace',
        name: 'Example Workspace',
        administrator: true,
      },
    });
    expect(rows[1]).toMatchObject({ ok: true, workspace: { administrator: false } });

    expect(decodeBitbucketWorkspaceAccessRow({ administrator: true })).toMatchObject({ ok: false });
    expect(decodeBitbucketWorkspaceAccessRow({
      administrator: true,
      workspace: { uuid: 'no-braces', slug: 'x' },
    })).toMatchObject({ ok: false });
  });

  it('keeps the immutable repository id as identity and the slug as a replaceable locator', () => {
    const rows = repositoriesPage.values.map(decodeBitbucketRepositoryRow);

    expect(rows[0]).toMatchObject({
      ok: true,
      repository: {
        uuid: '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}',
        repositoryKey: 'example-workspace/deploy-tools',
        name: 'deploy-tools',
      },
    });
    expect(rows[2]).toMatchObject({ ok: false, reason: 'identity-invalid' });
  });
});
