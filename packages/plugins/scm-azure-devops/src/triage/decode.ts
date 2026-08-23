import {
  truncateTriageUtf8V1,
  type TriageBoundedTextV1,
} from '@happier-dev/triage-protocol/v1';

import { isAzureGuid } from './identity.js';
import type {
  AzureCompletionOptionsRow,
  AzureConnectionData,
  AzureIdentityRow,
  AzureProjectRow,
  AzurePullRequestMergeStatus,
  AzurePullRequestRow,
  AzurePullRequestStatus,
  AzureRepositoryRow,
  AzureReviewerRow,
} from './types.js';

const PULL_REQUEST_STATUSES: readonly AzurePullRequestStatus[] = [
  'active',
  'completed',
  'abandoned',
  'notSet',
  'all',
];

const MERGE_STATUSES: readonly AzurePullRequestMergeStatus[] = [
  'notSet',
  'queued',
  'conflicts',
  'succeeded',
  'rejectedByPolicy',
  'failure',
];

/**
 * The published UTF-8-safe truncation, under this source's own name.
 *
 * The rule belongs to `@happier-dev/triage-protocol` because every value it bounds is
 * measured against that package's own limits; a local reimplementation would be a second
 * decision-maker for one rule.
 */
export const truncateUtf8: (value: string, maxUtf8Bytes: number) => TriageBoundedTextV1 =
  truncateTriageUtf8V1;

export function readRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Readonly<Record<string, unknown>>;
}

export function readString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readBoolean(raw: unknown): boolean {
  return raw === true;
}

export function readPositiveInt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) return null;
  return raw;
}

/** A relative provider URL yields `null` rather than a string a consumer could resolve wrongly. */
export function readAbsoluteUrl(raw: unknown): string | null {
  const value = readString(raw);
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Decode one provider page.
 *
 * The envelope is strict — a response without a `value` array is not a page. Each raw row is
 * then decoded independently, so one malformed row cannot invalidate the valid rows beside
 * it. `rawCardinality` is the provider's own count *before* decoding, and is the only legal
 * amount by which an offset walk may advance.
 */
export function decodeAzureRowPage<TRow>(
  raw: unknown,
  decodeRow: (row: unknown) => TRow | null,
): Readonly<{ rows: readonly TRow[]; rawCardinality: number; undecodable: number }> | null {
  const record = readRecord(raw);
  if (record === null) return null;
  const value = record.value;
  if (!Array.isArray(value)) return null;

  const rows: TRow[] = [];
  for (const entry of value) {
    const decoded = decodeRow(entry);
    if (decoded !== null) rows.push(decoded);
  }
  return { rows, rawCardinality: value.length, undecodable: value.length - rows.length };
}

export function decodeAzureProjectRow(raw: unknown): AzureProjectRow | null {
  const record = readRecord(raw);
  if (record === null) return null;
  const id = readString(record.id);
  const name = readString(record.name);
  if (id === null || !isAzureGuid(id) || name === null) return null;
  return { id: id.toLowerCase(), name, state: readString(record.state) };
}

export function decodeAzureRepositoryRow(raw: unknown): AzureRepositoryRow | null {
  const record = readRecord(raw);
  if (record === null) return null;
  const id = readString(record.id);
  const name = readString(record.name);
  const project = readRecord(record.project);
  const projectId = project === null ? null : readString(project.id);
  const projectName = project === null ? null : readString(project.name);
  if (id === null || !isAzureGuid(id) || name === null) return null;
  if (projectId === null || !isAzureGuid(projectId) || projectName === null) return null;
  return {
    id: id.toLowerCase(),
    name,
    projectId: projectId.toLowerCase(),
    projectName,
    defaultBranch: readString(record.defaultBranch),
    isDisabled: readBoolean(record.isDisabled),
    webUrl: readAbsoluteUrl(record.webUrl),
  };
}

export function decodeAzureIdentityRow(raw: unknown): AzureIdentityRow | null {
  const record = readRecord(raw);
  if (record === null) return null;
  const id = readString(record.id);
  if (id === null) return null;
  return {
    id,
    displayName: readString(record.displayName) ?? readString(record.providerDisplayName),
    uniqueName: readString(record.uniqueName),
  };
}

export function decodeAzureReviewerRow(raw: unknown): AzureReviewerRow | null {
  const identity = decodeAzureIdentityRow(raw);
  if (identity === null) return null;
  const record = readRecord(raw);
  if (record === null) return null;
  const vote = typeof record.vote === 'number' && Number.isFinite(record.vote) ? record.vote : 0;
  return {
    ...identity,
    vote,
    isRequired: readBoolean(record.isRequired),
    hasDeclined: readBoolean(record.hasDeclined),
  };
}

export function decodeAzurePullRequestRow(raw: unknown): AzurePullRequestRow | null {
  const record = readRecord(raw);
  if (record === null) return null;

  const pullRequestId = readPositiveInt(record.pullRequestId);
  if (pullRequestId === null) return null;

  const repository = readRecord(record.repository);
  const repositoryId = repository === null ? null : readString(repository.id);
  if (repositoryId === null || !isAzureGuid(repositoryId)) return null;

  const status = readString(record.status);
  const mergeStatus = readString(record.mergeStatus);

  return {
    pullRequestId,
    repositoryId: repositoryId.toLowerCase(),
    // A missing title is a presentation gap, not an identity failure: the row stays visible.
    title: readString(record.title) ?? '',
    description: readString(record.description),
    status: status !== null && (PULL_REQUEST_STATUSES as readonly string[]).includes(status)
      ? status as AzurePullRequestStatus
      : 'notSet',
    isDraft: readBoolean(record.isDraft),
    createdBy: decodeAzureIdentityRow(record.createdBy),
    creationDate: readString(record.creationDate),
    closedDate: readString(record.closedDate),
    sourceRefName: readString(record.sourceRefName),
    targetRefName: readString(record.targetRefName),
    mergeStatus: mergeStatus !== null && (MERGE_STATUSES as readonly string[]).includes(mergeStatus)
      ? mergeStatus as AzurePullRequestMergeStatus
      : null,
    mergeFailureType: readString(record.mergeFailureType),
    mergeFailureMessage: readString(record.mergeFailureMessage),
    lastMergeSourceCommitId: readCommitId(record.lastMergeSourceCommit),
    lastMergeTargetCommitId: readCommitId(record.lastMergeTargetCommit),
    lastMergeCommitId: readCommitId(record.lastMergeCommit),
    reviewers: decodeReviewers(record.reviewers),
    labels: decodeLabels(record.labels),
    supportsIterations: readBoolean(record.supportsIterations),
    autoCompleteSetBy: decodeAzureIdentityRow(record.autoCompleteSetBy),
    // Stored completion options can carry `transitionWorkItems: true` set elsewhere, so their
    // VALUES are a fact a later completion path must disclose, overwrite explicitly, and compare
    // against after the write — a `PATCH` Azure silently ignored is otherwise a reported success.
    completionOptions: decodeCompletionOptions(record.completionOptions),
    url: readAbsoluteUrl(record.url),
  };
}

/**
 * Azure omits a completion option it holds no value for, and `undefined` is not `false`: reporting
 * an absent `bypassPolicy` as `false` would claim this pull request is policy-gated when nothing
 * said so.
 */
function decodeCompletionOptions(raw: unknown): AzureCompletionOptionsRow | null {
  const record = readRecord(raw);
  if (record === null) return null;
  const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
  return {
    deleteSourceBranch: flag(record.deleteSourceBranch),
    transitionWorkItems: flag(record.transitionWorkItems),
    bypassPolicy: flag(record.bypassPolicy),
  };
}

export function decodeAzureConnectionData(raw: unknown): AzureConnectionData | null {
  const record = readRecord(raw);
  if (record === null) return null;
  const authenticatedUser = readRecord(record.authenticatedUser);
  const id = authenticatedUser === null ? null : readString(authenticatedUser.id);
  if (id === null || !isAzureGuid(id)) return null;
  return {
    authenticatedUserId: id.toLowerCase(),
    authenticatedUserDisplayName: authenticatedUser === null
      ? null
      : readString(authenticatedUser.providerDisplayName) ?? readString(authenticatedUser.displayName),
    deploymentType: readString(record.deploymentType),
    instanceId: readString(record.instanceId),
  };
}

function readCommitId(raw: unknown): string | null {
  const record = readRecord(raw);
  if (record === null) return null;
  return readString(record.commitId);
}

function decodeReviewers(raw: unknown): readonly AzureReviewerRow[] {
  if (!Array.isArray(raw)) return [];
  const reviewers: AzureReviewerRow[] = [];
  for (const entry of raw) {
    const decoded = decodeAzureReviewerRow(entry);
    if (decoded !== null) reviewers.push(decoded);
  }
  return reviewers;
}

function decodeLabels(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const labels: string[] = [];
  for (const entry of raw) {
    const record = readRecord(entry);
    if (record === null) continue;
    if (record.active === false) continue;
    const name = readString(record.name);
    if (name !== null) labels.push(name);
  }
  return labels;
}
