/**
 * Bitbucket's provider-side admission for one selected pull-request review
 * workspace. This source owns configured-account authorization, the exact
 * provider reread, and source-tip facts; the generic SCM Action owns all local
 * repository, remote, Git, and currentness decisions.
 */

import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type {
  TriagePrepareReviewWorkspaceInputV1,
  TriagePrepareReviewWorkspaceResultV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import type { BitbucketPullRequestEntry } from '../entries.js';
import { BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1 } from '../identity.js';
import { getBitbucketPullRequest } from '../pullRequests.js';
import type { BitbucketSourceRuntime } from './authorization.js';
import { admitBitbucketEntryInvocation } from './invocationAdmission.js';
import { matchesBitbucketEntryLocator } from './observations.js';

export type BitbucketReviewWorkspaceRuntime = BitbucketSourceRuntime & Readonly<{
  actions: ActionsService;
}>;

type BitbucketPreparedSourceTip = Readonly<{
  repository: Readonly<{
    kind: 'bitbucket';
    deployment: string;
    repository: string;
  }>;
  cloneUrl: string;
  branch: string;
  sourceHeadSha: string;
  fetchRef: string;
}>;

type BitbucketPreparedReview = Readonly<{
  baseSha: string;
  sourceTip: BitbucketPreparedSourceTip;
  pullRequest: Readonly<{ number: number }>;
}>;

function projectAdmissionFailure(
  failure: TriageSourceFailureV1,
): TriagePrepareReviewWorkspaceResultV1 {
  if (failure.code === 'kind-not-declared') return { kind: 'unsupported' };
  if (failure.class === 'unsupportedContract') {
    return { kind: 'refused', reason: 'instanceMoved' };
  }
  return { kind: 'unavailable', reason: 'account' };
}

/**
 * Uses provider source fields exclusively. A destination repository, merge
 * ref, or derived clone URL cannot substitute for a missing editable source.
 */
function readBitbucketPreparedReview(
  entry: BitbucketPullRequestEntry,
): BitbucketPreparedReview | null {
  const baseSha = entry.destination?.commitHash;
  const source = entry.source;
  const repository = source?.repository?.repositoryKey;
  const cloneUrl = source?.cloneUrl;
  const branch = source?.branchName;
  const sourceHeadSha = source?.commitHash;
  if (
    baseSha === null || baseSha === undefined
    || repository === null || repository === undefined
    || cloneUrl === undefined
    || branch === null || branch === undefined
    || sourceHeadSha === null || sourceHeadSha === undefined
  ) {
    return null;
  }

  return {
    baseSha,
    sourceTip: {
      repository: {
        kind: 'bitbucket',
        deployment: BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1,
        repository,
      },
      cloneUrl,
      branch,
      sourceHeadSha,
      // Bitbucket's source branch is the editable fetch authority. A PR/merge
      // ref is a review projection and must never reach the generic Git owner.
      fetchRef: `refs/heads/${branch}`,
    },
    // `entryId` reaches this reader only through Bitbucket's native positive
    // safe-integer decoder; this remains an opaque SCM reference for Triage.
    pullRequest: { number: Number(entry.entryId) },
  };
}

/**
 * Reauthorizes and rereads exactly the selected Bitbucket PR before one generic
 * local materialization. No source-local filesystem/Git fallback exists.
 */
export async function prepareBitbucketReviewWorkspace(
  input: TriagePrepareReviewWorkspaceInputV1,
  runtime: BitbucketReviewWorkspaceRuntime,
): Promise<TriagePrepareReviewWorkspaceResultV1> {
  if (input.workspace === null) return { kind: 'workspaceRequired' };

  const admitted = await admitBitbucketEntryInvocation({
    instance: input.instance,
    localRef: {
      kindId: input.entryRef.kindId,
      collisionScope: input.entryRef.collisionScope,
      entryId: input.entryRef.entryId,
    },
  }, runtime);
  if (!admitted.ok) return projectAdmissionFailure(admitted.failure);

  const reread = await getBitbucketPullRequest({
    client: admitted.client,
    workspaceUuid: admitted.route.workspaceUuid,
    repositoryUuid: admitted.route.repositoryUuid,
    entryId: admitted.route.entryId,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (reread.kind === 'unresolved') {
    return reread.failure.code === 'route-not-found'
      ? { kind: 'refused', reason: 'pullRequestMoved' }
      : { kind: 'unavailable', reason: 'account' };
  }

  if (!matchesBitbucketEntryLocator(reread.entry, input.lastKnownLocator)) {
    return { kind: 'refused', reason: 'pullRequestMoved' };
  }

  const prepared = readBitbucketPreparedReview(reread.entry);
  if (prepared === null) return { kind: 'refused', reason: 'pullRequestMoved' };
  if (
    prepared.baseSha !== input.observed.baseSha
    || prepared.sourceTip.sourceHeadSha !== input.observed.headSha
    || prepared.sourceTip.sourceHeadSha !== input.observed.nativeRevision
  ) {
    return { kind: 'refused', reason: 'observedHeadMoved' };
  }

  const materialized = await runtime.actions.execute(
    'scm.reviewWorkspace.materializePrepared',
    {
      cwd: input.workspace.rootPath,
      displayName: prepared.sourceTip.branch,
      sourceTip: prepared.sourceTip,
    },
    { signal: runtime.signal },
  );
  if (!materialized.success) {
    if (
      materialized.errorCode === 'NOT_REPOSITORY'
      || materialized.errorCode === 'INVALID_PATH'
      || materialized.errorCode === 'REMOTE_NOT_FOUND'
    ) {
      return { kind: 'workspaceMismatch' };
    }
    return { kind: 'unavailable', reason: 'scmResolver' };
  }

  return {
    kind: 'prepared',
    repositoryPath: materialized.targetPath,
    branch: materialized.branchName,
    created: materialized.created,
    currentness: materialized.currentness,
    pullRequest: prepared.pullRequest,
  };
}
