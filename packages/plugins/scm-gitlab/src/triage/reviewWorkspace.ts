/**
 * GitLab's provider-side admission for one selected merge-request workspace.
 *
 * This source owns exact configured-account reauthorization, rereading the
 * selected merge request, and deriving its editable source tip. The generic SCM
 * Action owns every local filesystem and Git decision after those facts hold.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  ActionsService,
  PluginActionInputById,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type {
  TriagePrepareReviewWorkspaceInputV1,
  TriagePrepareReviewWorkspaceResultV1,
  TriageSourceFailureV1,
  TriageVerifyReviewWorkspaceInputV1,
  TriageVerifyReviewWorkspaceResultV1,
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
function readObservedRoutingToken(input: Readonly<{
  lastKnownLocator: TriagePrepareReviewWorkspaceInputV1['lastKnownLocator'];
}>): string | null {
  const routingToken = input.lastKnownLocator.routingToken;
  return typeof routingToken === 'string'
    && routingToken !== ''
    && routingToken === routingToken.trim()
    ? routingToken
    : null;
}

type GitlabReviewWorkspaceRequest = Readonly<{
  instance: TriageVerifyReviewWorkspaceInputV1['instance'];
  entryRef: TriageVerifyReviewWorkspaceInputV1['entryRef'];
  lastKnownLocator: TriageVerifyReviewWorkspaceInputV1['lastKnownLocator'];
  observed: TriageVerifyReviewWorkspaceInputV1['observed'];
}>;

type GitlabAuthorizedReviewWorkspace =
  | Readonly<{
    kind: 'authorized';
    sourceTip: GitlabPreparedSourceTip;
    pullRequest: Readonly<{ number: number }>;
  }>
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'unavailable'; reason: 'account' }>
  | Readonly<{
    kind: 'refused';
    reason: 'instanceMoved' | 'pullRequestMoved' | 'observedHeadMoved';
  }>;

/**
 * One cancellation and transport-failure boundary for both SCM preparation
 * and verification. Action transport failures mean the canonical SCM owner is
 * unavailable; an abort remains cancellation and is never projected as a
 * retryable source result.
 */
async function executeGitlabReviewWorkspaceScmAction(input: Readonly<{
  actions: Pick<ActionsService, 'execute'>;
  request: PluginActionInputById['scm.reviewWorkspace.materializePrepared'];
  signal: AbortSignal;
}>): Promise<PluginActionResultById['scm.reviewWorkspace.materializePrepared'] | null> {
  try {
    const result = await input.actions.execute(
      'scm.reviewWorkspace.materializePrepared',
      input.request,
      { signal: input.signal },
    );
    input.signal.throwIfAborted();
    return result;
  } catch (error) {
    input.signal.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return null;
  }
}

function projectAdmissionFailure(
  failure: TriageSourceFailureV1,
): Exclude<GitlabAuthorizedReviewWorkspace, Readonly<{ kind: 'authorized' }>> {
  if (failure.code === 'gitlab-kind-unsupported') return { kind: 'unsupported' };
  if (failure.class === 'unsupportedContract') {
    return { kind: 'refused', reason: 'instanceMoved' };
  }
  return { kind: 'unavailable', reason: 'account' };
}

/** One provider authority path shared by initial preparation and final verification. */
async function authorizeGitlabReviewWorkspace(
  input: GitlabReviewWorkspaceRequest,
  context: PluginInvocationContext,
): Promise<GitlabAuthorizedReviewWorkspace> {
  context.signal.throwIfAborted();
  const admitted = await admitGitlabItemInvocation({
    instance: input.instance,
    localRef: input.entryRef,
    admissibleKinds: ['merge-request'],
  }, context);
  context.signal.throwIfAborted();
  if (!admitted.ok) return projectAdmissionFailure(admitted.failure);

  const reread = await requestGitlabJson({
    invocation: admitted.dependencies.invocation,
    url: buildGitlabItemUrl(admitted.route),
    fetcher: admitted.dependencies.fetcher,
    signal: admitted.dependencies.signal,
    nowMs: admitted.dependencies.nowMs,
  });
  context.signal.throwIfAborted();
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

  return Object.freeze({
    kind: 'authorized' as const,
    sourceTip,
    pullRequest: Object.freeze({ number: pullRequestNumber }),
  });
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
  if (input.workspace === undefined) return { kind: 'workspaceRequired' };
  const authorized = await authorizeGitlabReviewWorkspace(input, context);
  if (authorized.kind !== 'authorized') return authorized;
  const { sourceTip, pullRequest } = authorized;

  const materialized = await executeGitlabReviewWorkspaceScmAction({
    actions: context.services.actions,
    request: {
      cwd: input.workspace.rootPath,
      displayName: sourceTip.branch,
      sourceTip,
    },
    signal: context.signal,
  });
  if (materialized === null) {
    return { kind: 'unavailable', reason: 'scmResolver' };
  }
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
  if ('verification' in materialized) {
    return { kind: 'unavailable', reason: 'scmResolver' };
  }

  return {
    kind: 'prepared',
    repositoryPath: materialized.targetPath,
    branch: materialized.branchName,
    created: materialized.created,
    currentness: materialized.currentness,
    pullRequest,
  };
}

/**
 * Reauthorizes and rereads the selected merge request, then asks the canonical
 * SCM owner to compare the already prepared checkout's current local HEAD with
 * the same provider-authoritative source tip. No provider or Git command is
 * reconstructed in Triage or in this source boundary.
 */
export async function verifyGitlabReviewWorkspace(
  input: TriageVerifyReviewWorkspaceInputV1,
  context: PluginInvocationContext,
): Promise<TriageVerifyReviewWorkspaceResultV1> {
  const authorized = await authorizeGitlabReviewWorkspace(input, context);
  if (authorized.kind === 'unsupported') {
    return { kind: 'refused', reason: 'pullRequestMoved' };
  }
  if (authorized.kind !== 'authorized') return authorized;
  if (!pluginJsonValuesEqual(input.prepared.pullRequest, authorized.pullRequest)) {
    return { kind: 'refused', reason: 'pullRequestMoved' };
  }

  const verified = await executeGitlabReviewWorkspaceScmAction({
    actions: context.services.actions,
    request: {
      cwd: input.workspace.rootPath,
      displayName: authorized.sourceTip.branch,
      sourceTip: authorized.sourceTip,
      verification: { targetPath: input.prepared.repositoryPath },
    },
    signal: context.signal,
  });
  if (verified === null) {
    return { kind: 'unavailable', reason: 'scmResolver' };
  }
  if (!verified.success) {
    switch (verified.errorCode) {
      case 'NOT_REPOSITORY':
      case 'INVALID_PATH':
      case 'REMOTE_NOT_FOUND':
        return { kind: 'workspaceMismatch' };
      default:
        return { kind: 'unavailable', reason: 'scmResolver' };
    }
  }
  if (!('verification' in verified)) {
    return { kind: 'unavailable', reason: 'scmResolver' };
  }
  const verification = readRecord(verified.verification);
  if (verification === null
    || verification.targetPath !== input.prepared.repositoryPath) {
    return { kind: 'workspaceMismatch' };
  }
  if (typeof verification.sourceHeadSha !== 'string'
    || verification.sourceHeadSha.toLowerCase() !== authorized.sourceTip.sourceHeadSha.toLowerCase()) {
    return { kind: 'refused', reason: 'observedHeadMoved' };
  }
  return { kind: 'verified', pullRequest: authorized.pullRequest };
}
