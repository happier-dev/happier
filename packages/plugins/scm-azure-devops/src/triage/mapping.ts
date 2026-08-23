import { truncateUtf8 } from './decode.js';
import { buildAzureCollisionScope, buildAzureEntryId, foldAzureIdentityId } from './identity.js';
import { buildAzureRepositoryKey } from './origin.js';
import type {
  AzureDevOpsOrigin,
  AzureInvolvement,
  AzureInvolvementLaneId,
  AzurePresentationState,
  AzureProjectRow,
  AzurePullRequestEntry,
  AzurePullRequestMergeStatus,
  AzurePullRequestRow,
  AzurePullRequestStatus,
  AzureRepositoryRow,
  AzureReviewerRow,
  AzureRowFact,
} from './types.js';

/** Semantic display bound. Oversize text is shortened, never a reason to drop a valid entry. */
export const MAX_AZURE_TEXT_UTF8_BYTES = 4 * 1024;
/** Bounded projected fact count. Excess facts set `projectionTruncated`. */
export const MAX_AZURE_ROW_FACTS = 12;

const STATE_PRESENTATION: Readonly<Record<AzurePullRequestStatus, AzurePresentationState>> = {
  active: 'active',
  completed: 'closed',
  abandoned: 'closed',
  notSet: 'active',
  all: 'active',
};

/**
 * Azure's own word for an abandoned pull request, and the one fact that separates it from a
 * completed one once both project to the `closed` presentation.
 *
 * It is exported because the detail surface decides whether to offer *Reactivate* from exactly
 * this label. Spelling it twice is how the control would keep appearing on completed pull
 * requests after somebody reworded the table below.
 */
export const AZURE_ABANDONED_NATIVE_STATE_LABEL = 'Abandoned';

const STATE_NATIVE_LABEL: Readonly<Record<AzurePullRequestStatus, string>> = {
  active: 'Active',
  completed: 'Completed',
  abandoned: AZURE_ABANDONED_NATIVE_STATE_LABEL,
  notSet: 'Not set',
  all: 'All',
};

const MERGE_STATUS_NATIVE_LABEL: Readonly<Record<AzurePullRequestMergeStatus, string>> = {
  notSet: 'Not set',
  queued: 'Queued',
  conflicts: 'Conflicts',
  succeeded: 'Succeeded',
  rejectedByPolicy: 'Rejected by policy',
  failure: 'Failure',
};

/** Azure's documented reviewer vote values, kept as native facts rather than ABI vocabulary. */
const VOTE_NATIVE_LABEL: Readonly<Record<string, string>> = {
  '10': 'Approved',
  '5': 'Approved with suggestions',
  '0': 'No vote',
  '-5': 'Waiting for author',
  '-10': 'Rejected',
};

export function readAzureVoteNativeLabel(vote: number): string {
  return VOTE_NATIVE_LABEL[String(vote)] ?? `Vote ${vote}`;
}

/**
 * Resolve one native scan lane into the canonical involvement vocabulary.
 *
 * The `reviewer` lane is the *requested* lane; only a non-zero returned vote proves the viewer
 * actually participated. No third "reviewed" query is sent to discover that — Azure already
 * returned the vote on the row.
 */
export function resolveAzureInvolvement(input: Readonly<{
  lane: AzureInvolvementLaneId;
  viewerId: string;
  reviewers: readonly AzureReviewerRow[];
}>): AzureInvolvement {
  if (input.lane === 'authored') return 'author';
  const vote = readViewerReviewer(input.reviewers, input.viewerId)?.vote ?? 0;
  return vote === 0 ? 'reviewRequested' : 'participating';
}

export function mapAzurePullRequestEntry(input: Readonly<{
  origin: AzureDevOpsOrigin;
  project: AzureProjectRow;
  repository: AzureRepositoryRow;
  row: AzurePullRequestRow;
  lane: AzureInvolvementLaneId;
  viewerId: string;
}>): AzurePullRequestEntry | null {
  const { origin, project, repository, row, lane, viewerId } = input;

  // A row that names another repository is a routing error, not a mappable entry.
  if (row.repositoryId !== repository.id) return null;

  const collisionScope = buildAzureCollisionScope({ origin, repositoryId: repository.id });
  const entryId = buildAzureEntryId(row.pullRequestId);
  if (collisionScope === null || entryId === null) return null;

  const title = truncateUtf8(row.title, MAX_AZURE_TEXT_UTF8_BYTES);
  const facts = buildRowFacts({ row, viewerId });

  return {
    kindId: 'pull-request',
    collisionScope,
    entryId,
    locator: {
      forgeHostId: origin.forgeHostId,
      repositoryKey: buildAzureRepositoryKey({
        organizationOrCollection: origin.organizationOrCollection,
        forgeHostId: origin.forgeHostId,
        projectName: project.name,
        repositoryName: repository.name,
      }),
      organizationOrCollection: origin.organizationOrCollection,
      projectId: project.id,
      projectName: project.name,
      repositoryId: repository.id,
      repositoryName: repository.name,
      webUrl: repository.webUrl,
    },
    title: title.value,
    state: row.status,
    presentation: STATE_PRESENTATION[row.status],
    nativeLabel: STATE_NATIVE_LABEL[row.status],
    isDraft: row.isDraft,
    authorId: row.createdBy?.id ?? null,
    authorDisplayName: row.createdBy?.displayName ?? null,
    createdAt: row.creationDate,
    closedAt: row.closedDate,
    sourceRefName: row.sourceRefName,
    targetRefName: row.targetRefName,
    headCommitId: row.lastMergeSourceCommitId,
    baseCommitId: row.lastMergeTargetCommitId,
    mergeStatus: row.mergeStatus,
    involvement: resolveAzureInvolvement({ lane, viewerId, reviewers: row.reviewers }),
    facts: facts.facts,
    projectionTruncated: title.truncated || facts.truncated,
  };
}

function buildRowFacts(input: Readonly<{
  row: AzurePullRequestRow;
  viewerId: string;
}>): Readonly<{ facts: readonly AzureRowFact[]; truncated: boolean }> {
  const { row, viewerId } = input;
  const candidates: AzureRowFact[] = [];

  const viewerReviewer = readViewerReviewer(row.reviewers, viewerId);
  if (viewerReviewer !== undefined && viewerReviewer.vote !== 0) {
    candidates.push({
      kind: 'reviewerVote',
      reviewerId: viewerReviewer.id,
      vote: viewerReviewer.vote,
      nativeLabel: readAzureVoteNativeLabel(viewerReviewer.vote),
    });
  }
  if (row.mergeStatus !== null) {
    candidates.push({
      kind: 'mergeStatus',
      value: row.mergeStatus,
      nativeLabel: MERGE_STATUS_NATIVE_LABEL[row.mergeStatus],
    });
  }
  if (row.isDraft) candidates.push({ kind: 'draft' });
  if (row.autoCompleteSetBy !== null) {
    // Auto-complete means completion can fire later on policy satisfaction, entirely outside
    // any request we make. Surfacing it is disclosure, not normalization.
    candidates.push({ kind: 'autoCompleteEnabled', enabledById: row.autoCompleteSetBy.id });
  }
  for (const label of row.labels) candidates.push({ kind: 'label', value: label });

  if (candidates.length <= MAX_AZURE_ROW_FACTS) {
    return { facts: candidates, truncated: false };
  }
  return { facts: candidates.slice(0, MAX_AZURE_ROW_FACTS), truncated: true };
}

function readViewerReviewer(
  reviewers: readonly AzureReviewerRow[],
  viewerId: string,
): AzureReviewerRow | undefined {
  const wanted = foldAzureIdentityId(viewerId);
  return reviewers.find((reviewer) => foldAzureIdentityId(reviewer.id) === wanted);
}
