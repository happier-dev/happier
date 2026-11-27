import type { JsonValue } from '../../json/strictJsonValue.js';

export const GITHUB_POST_SUMMARY_PLUGIN_ID_V1 = 'happier.scm.github' as const;
export const GITHUB_POST_SUMMARY_COMMENT_ACTION_LOCAL_ID_V1 = 'github/comment/create' as const;

/**
 * GitHub issue and pull-request event local IDs that carry an authorized connected
 * source identity and target entry number for Q11 summary posting.
 */
export const GITHUB_POST_SUMMARY_EVENT_LOCAL_IDS_V1 = Object.freeze([
  'automation/issue-opened-v1',
  'automation/issue-labeled-v1',
  'automation/pull-request-opened-v1',
  'automation/pull-request-lifecycle-v1',
  'automation/pull-request-merged-v1',
  'automation/pull-request-checks-completed-v1',
  'automation/pull-request-checks-failed-v1',
  'automation/pull-request-checks-passed-v1',
] as const);

const GITHUB_POST_SUMMARY_EVENT_LOCAL_ID_SET = new Set<string>(GITHUB_POST_SUMMARY_EVENT_LOCAL_IDS_V1);

export type WorkflowTriggerPostSummaryCandidateV1 = Readonly<{
  kind: string;
  eventRef?: Readonly<{ pluginId: string; localId: string }>;
}>;

/**
 * Canonical owner predicate for Q11 (`Post a summary`): true only when the trigger
 * originates from an authorized connected source (GitHub issue/PR event).
 * Pure internal Task triggers, schedules, and session triggers return false.
 */
export function isAuthorizedPostSummaryTriggerV1(trigger: WorkflowTriggerPostSummaryCandidateV1): boolean {
  return trigger.kind === 'pluginEvent'
    && trigger.eventRef !== undefined
    && trigger.eventRef.pluginId === GITHUB_POST_SUMMARY_PLUGIN_ID_V1
    && GITHUB_POST_SUMMARY_EVENT_LOCAL_ID_SET.has(trigger.eventRef.localId);
}

/** True when at least one trigger in the set originates from an authorized connected source. */
export function supportsWorkflowTriggerPostSummaryV1(
  triggers: readonly WorkflowTriggerPostSummaryCandidateV1[],
): boolean {
  return triggers.some(isAuthorizedPostSummaryTriggerV1);
}

export type GithubPostSummaryTargetV1 = Readonly<{
  pluginId: typeof GITHUB_POST_SUMMARY_PLUGIN_ID_V1;
  actionLocalId: typeof GITHUB_POST_SUMMARY_COMMENT_ACTION_LOCAL_ID_V1;
  sourceInstanceId: string;
  localRef: Readonly<{
    kindId: 'issue' | 'pull-request';
    collisionScope: string;
    entryId: string;
  }>;
  routingToken: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Extracts the exact authorized GitHub comment target from a triggering pluginEvent occurrence.
 * Returns null when the occurrence is not an authorized GitHub issue/PR event.
 */
export function resolveGithubPostSummaryTargetV1(input: Readonly<{
  eventRef: Readonly<{ pluginId: string; localId: string }>;
  sourceInstanceId: string;
  payload: JsonValue;
}>): GithubPostSummaryTargetV1 | null {
  if (!isAuthorizedPostSummaryTriggerV1({ kind: 'pluginEvent', eventRef: input.eventRef })) return null;
  if (!input.sourceInstanceId || !isRecord(input.payload)) return null;
  const repository = input.payload.repository;
  if (!isRecord(repository)
    || typeof repository.repositoryId !== 'string' || !/^[1-9][0-9]*$/.test(repository.repositoryId)
    || typeof repository.nameWithOwner !== 'string' || repository.nameWithOwner.length < 3) {
    return null;
  }
  const issue = isRecord(input.payload.issue) ? readPositiveInteger(input.payload.issue.number) : null;
  if (issue !== null) {
    return Object.freeze({
      pluginId: GITHUB_POST_SUMMARY_PLUGIN_ID_V1,
      actionLocalId: GITHUB_POST_SUMMARY_COMMENT_ACTION_LOCAL_ID_V1,
      sourceInstanceId: input.sourceInstanceId,
      localRef: Object.freeze({
        kindId: 'issue' as const,
        collisionScope: `github:${repository.repositoryId}`,
        entryId: String(issue),
      }),
      routingToken: repository.nameWithOwner,
    });
  }
  const pullRequest = isRecord(input.payload.pullRequest)
    ? readPositiveInteger(input.payload.pullRequest.number)
    : isRecord(input.payload.checks)
      ? readPositiveInteger(input.payload.checks.pullRequestNumber)
      : null;
  if (pullRequest !== null) {
    return Object.freeze({
      pluginId: GITHUB_POST_SUMMARY_PLUGIN_ID_V1,
      actionLocalId: GITHUB_POST_SUMMARY_COMMENT_ACTION_LOCAL_ID_V1,
      sourceInstanceId: input.sourceInstanceId,
      localRef: Object.freeze({
        kindId: 'pull-request' as const,
        collisionScope: `github:${repository.repositoryId}`,
        entryId: String(pullRequest),
      }),
      routingToken: repository.nameWithOwner,
    });
  }
  return null;
}
