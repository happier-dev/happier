/**
 * GitLab's provider-side admission for one selected merge-request workspace.
 *
 * This source owns exact configured-account reauthorization, rereading the
 * selected merge request, and deriving its editable source tip. The generic SCM
 * Action owns every local filesystem and Git decision after those facts hold.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  TriagePrepareReviewWorkspaceInputV1,
  TriagePrepareReviewWorkspaceResultV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { admitGitlabItemInvocation } from './admission.js';
import { buildGitlabItemUrl } from './detail/routes.js';
import { requestGitlabJson } from './http/gitlabClient.js';
import { buildGitlabEntryIdentity } from './identity.js';
import { readGitlabMergeRequestReviewRevision } from './mapping/mergeRequestHead.js';
import type { GitlabConfiguredOrigin } from './origin.js';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readGitlabSourceCloneUrl(
  sourceProject: Readonly<Record<string, unknown>>,
  origin: GitlabConfiguredOrigin,
): string | null {
  const cloneUrl = readNonEmptyString(sourceProject.http_url_to_repo);
  if (cloneUrl === null) return null;

  try {
    if (new URL(cloneUrl).origin !== new URL(origin.normalized).origin) return null;
  } catch {
    return null;
  }
  return cloneUrl;
}

type GitlabPreparedSourceTip = Readonly<{
  repository: Readonly<{
    kind: 'gitlab';
    deployment: string;
    repository: string;
  }>;
  cloneUrl: string;
  branch: string;
  sourceHeadSha: string;
  fetchRef: string;
}>;

function readGitlabPreparedSourceTip(
  row: Readonly<Record<string, unknown>>,
  origin: GitlabConfiguredOrigin,
  sourceHeadSha: string,
): GitlabPreparedSourceTip | null {
  const sourceProject = readRecord(row.source_project);
  const branch = readNonEmptyString(row.source_branch);
  if (sourceProject === null || branch === null) return null;

  const repository = readNonEmptyString(sourceProject.path_with_namespace);
  const cloneUrl = readGitlabSourceCloneUrl(sourceProject, origin);
  if (repository === null || cloneUrl === null) return null;

  return Object.freeze({
    repository: Object.freeze({
      kind: 'gitlab',
      deployment: origin.normalized,
      repository,
    }),
    cloneUrl,
    branch,
    sourceHeadSha,
    // A source branch is the only editable fetch authority. GitLab's
    // merge-request ref is a review ref and is never substituted here.
    fetchRef: `refs/heads/${branch}`,
  });
}

/**
 * This source mints the routing token from its canonical provider path reader.
 * It is carried by Triage unchanged, so preparation checks that the fresh row
 * still names that exact route without turning the locator into a second
 * identity or a replacement endpoint router.
 */
function readObservedRoutingToken(
  input: TriagePrepareReviewWorkspaceInputV1,
): string | null {
  const routingToken = input.lastKnownLocator.routingToken;
  return typeof routingToken === 'string'
    && routingToken !== ''
    && routingToken === routingToken.trim()
    ? routingToken
    : null;
}

function projectAdmissionFailure(
  failure: TriageSourceFailureV1,
): TriagePrepareReviewWorkspaceResultV1 {
  if (failure.code === 'gitlab-kind-unsupported') return { kind: 'unsupported' };
  if (failure.class === 'unsupportedContract') {
    return { kind: 'refused', reason: 'instanceMoved' };
  }
  return { kind: 'unavailable', reason: 'account' };
}

/**
 * Rereads the selected merge request before it sends exactly one generic local
 * materialization Action. The provider response remains the authority for the
 * source project, branch and head; neither a target project nor a GitLab merge
 * ref can reach the SCM owner.
 */
export async function prepareGitlabReviewWorkspace(
  input: TriagePrepareReviewWorkspaceInputV1,
  context: PluginInvocationContext,
): Promise<TriagePrepareReviewWorkspaceResultV1> {
  if (input.workspace === null) return { kind: 'workspaceRequired' };

  const admitted = await admitGitlabItemInvocation({
    instance: input.instance,
    localRef: input.entryRef,
    admissibleKinds: ['merge-request'],
  }, context);
  if (!admitted.ok) return projectAdmissionFailure(admitted.failure);

  const reread = await requestGitlabJson({
    invocation: admitted.dependencies.invocation,
    url: buildGitlabItemUrl(admitted.route),
    fetcher: admitted.dependencies.fetcher,
    signal: admitted.dependencies.signal,
    nowMs: admitted.dependencies.nowMs,
  });
  if (reread.kind === 'failed') {
    return reread.failure.code === 'not-found'
      ? { kind: 'refused', reason: 'pullRequestMoved' }
      : { kind: 'unavailable', reason: 'account' };
  }

  const row = readRecord(reread.response.body);
  if (row === null) return { kind: 'refused', reason: 'pullRequestMoved' };
  const routingToken = readObservedRoutingToken(input);
  const identity = buildGitlabEntryIdentity({
    kindId: 'merge-request',
    origin: admitted.route.origin,
    row,
  });
  if (routingToken === null
    || identity.kind !== 'built'
    || identity.identity.collisionScope !== input.entryRef.collisionScope
    || identity.identity.entryId !== input.entryRef.entryId
    || identity.locator.routingToken !== routingToken) {
    return { kind: 'refused', reason: 'pullRequestMoved' };
  }

  const pullRequestNumber = Number(identity.identity.entryId);
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    return { kind: 'refused', reason: 'pullRequestMoved' };
  }

  const revision = readGitlabMergeRequestReviewRevision(row);
  const sourceTip = revision === null
    ? null
    : readGitlabPreparedSourceTip(row, admitted.route.origin, revision.headSha);
  if (revision === null || sourceTip === null) {
    return { kind: 'refused', reason: 'pullRequestMoved' };
  }
  if (revision.baseSha !== input.observed.baseSha
    || revision.headSha !== input.observed.headSha
    || revision.nativeRevision !== input.observed.nativeRevision) {
    return { kind: 'refused', reason: 'observedHeadMoved' };
  }

  const materialized = await context.services.actions.execute(
    'scm.reviewWorkspace.materializePrepared',
    {
      cwd: input.workspace.rootPath,
      displayName: sourceTip.branch,
      sourceTip,
    },
    { signal: context.signal },
  );
  if (!materialized.success) {
    switch (materialized.errorCode) {
      case 'NOT_REPOSITORY':
      case 'INVALID_PATH':
      case 'REMOTE_NOT_FOUND':
        return { kind: 'workspaceMismatch' };
      default:
        return { kind: 'unavailable', reason: 'scmResolver' };
    }
  }

  return {
    kind: 'prepared',
    repositoryPath: materialized.targetPath,
    branch: materialized.branchName,
    created: materialized.created,
    currentness: materialized.currentness,
    pullRequest: { number: pullRequestNumber },
  };
}
