import type { ReviewCommentV1 } from '@happier-dev/plugin-sdk/reviews';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_PLUGIN_ID,
} from '../../triage/contribution.js';
import {
  buildGitlabIssueCommentPublicationInputV1,
  buildGitlabMergeRequestReviewCommentCreateInputV1,
  buildGitlabMergeRequestReviewPublicationInputV1,
  buildGitlabMergeRequestThreadReplyInputV1,
} from './reviewPublicationControls.js';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);

const INPUT = {
  v: 1,
  instance: {
    v: 1,
    instance: {
      source: { pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-forge' },
      sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
    },
    binding: {
      purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
      account: {
        service: { pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-account' },
        accountId: 'account-1',
      },
    },
    localInstanceKey: 'gitlab-com',
    configuration: { v: 1, token: 'configuration-token' },
  },
  observation: {
    entryRef: {
      source: { pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-forge' },
      kindId: 'merge-request',
      collisionScope: 'gitlab.com:group/project',
      entryId: '42',
    },
    observedAtMs: 1,
    locator: {
      v: 1,
      webUrl: 'https://gitlab.com/group/project/-/merge_requests/42',
      displayPath: 'group/project !42',
      routingToken: 'group/project',
    },
    snapshot: {
      v: 1,
      title: 'Keep publication exact',
      scopeLabel: 'group/project',
      state: { presentation: 'active', nativeLabel: 'opened' },
      facts: [],
      reviewRevision: { baseSha: BASE, headSha: HEAD, nativeRevision: HEAD },
    },
    viewer: { involvement: ['reviewRequested'] },
    nativeRevision: HEAD,
  },
  linkedSessions: [],
} as unknown as TriageDetailSurfaceInputV1;

const PROPOSAL = {
  id: 'review-comment-1',
  body: 'Keep this normalization at the canonical owner.',
  serverRevision: 3,
  anchor: { kind: 'line', filePath: 'src/index.ts', line: 12, side: 'after' },
  snapshot: {
    kind: 'text',
    selectedLines: ['return canonical;'],
    beforeContext: [],
    afterContext: [],
    selectedLinesHash: 'selected-hash',
    contextWindowHash: 'context-hash',
    capturedAt: 1,
    fileLength: 20,
    source: 'committed',
    commitSha: HEAD,
    isUncommitted: false,
    isUntracked: false,
    truncated: false,
    hasBidiControls: false,
    likelyMinified: false,
    diffContext: { side: 'after', baseSha: BASE, headSha: HEAD, startSha: BASE },
  },
} as unknown as ReviewCommentV1 & Readonly<{ body: string }>;

describe('GitLab mounted review publication input builders', () => {
  it('freezes submit-review around the mounted base/head and canonical proposal', () => {
    expect(buildGitlabMergeRequestReviewPublicationInputV1(
      INPUT,
      [PROPOSAL],
      { kind: 'approve', body: 'This is ready.' },
    )).toMatchObject({
      publicationPlan: {
        target: {
          providerId: 'gitlab',
          configuredAccountId: 'account-1',
          subtarget: null,
          entryRef: {
            sourceId: `${GITLAB_PLUGIN_ID}/gitlab-forge`,
            kindId: 'merge-request',
            collisionScope: 'gitlab.com:group/project',
            entryId: '42',
          },
        },
        baseRevision: BASE,
        headRevision: HEAD,
        entries: [{ happierCommentId: 'review-comment-1', expectedServerRevision: 3 }],
        verdict: { kind: 'approve', body: 'This is ready.' },
      },
    });
  });

  it('uses one revision-pinned entry for the standalone MR comment', () => {
    expect(buildGitlabMergeRequestReviewCommentCreateInputV1(INPUT, PROPOSAL))
      .toMatchObject({ publicationPlan: { baseRevision: BASE, headRevision: HEAD, entries: [{ happierCommentId: PROPOSAL.id }], verdict: null } });
  });

  it('binds a discussion reply to the canonical review-thread subtarget', () => {
    expect(buildGitlabMergeRequestThreadReplyInputV1(INPUT, PROPOSAL, 'discussion-7'))
      .toMatchObject({
        discussionId: 'discussion-7',
        publicationPlan: {
          target: { subtarget: { kindId: 'review-thread', targetId: 'discussion-7' } },
          baseRevision: null,
          headRevision: null,
          entries: [{ happierCommentId: PROPOSAL.id }],
          verdict: null,
        },
      });
  });

  it('keeps an issue comment unversioned and top-level', () => {
    const issueInput = {
      ...INPUT,
      observation: {
        ...INPUT.observation,
        entryRef: { ...INPUT.observation.entryRef, kindId: 'issue' },
      },
    } as TriageDetailSurfaceInputV1;
    expect(buildGitlabIssueCommentPublicationInputV1(issueInput, PROPOSAL))
      .toMatchObject({
        publicationPlan: {
          target: { subtarget: null, entryRef: { kindId: 'issue' } },
          baseRevision: null,
          headRevision: null,
          entries: [{ happierCommentId: PROPOSAL.id }],
          verdict: null,
        },
      });
  });
});
