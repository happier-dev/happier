import {
  GITHUB_AUTOMATION_EVENT_LOCAL_IDS,
  normalizeGithubAutomationEvent,
  type GithubAutomationEventLocalIdV1,
  type GithubAutomationEventPayloadV1,
  type GithubAutomationEventRefV1,
} from '../githubAutomationEvents.js';
import { readGithubPositiveDecimal, type GithubRepositorySourceConfigV1 } from './githubProviderContracts.js';
import { GithubRepositoryEventsHistoryGapError } from './githubRepositoryEventsPolling.js';
import type { GithubRepositoryTimelineEntryV1 } from './githubRepositoryEventsCursor.js';
import { normalizeGithubPullRequestLifecycle } from './githubWebhookNormalization.js';

type JsonRecord = Readonly<Record<string, unknown>>;

export type GithubRepositoryEventFactsV1 = Readonly<{
  eventId: string;
  occurredAtMs: number;
  raw: JsonRecord;
}>;

type GithubAutomationRepositoryEventObservationV1 = Readonly<{
  eventRef: GithubAutomationEventRefV1;
  occurrenceId: string;
  occurredAtMs: number;
  payload: GithubAutomationEventPayloadV1;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoundedString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    throw new GithubRepositoryEventsHistoryGapError(`GitHub repository Events ${label} is invalid`);
  }
  return value;
}

function readPositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GithubRepositoryEventsHistoryGapError(`GitHub repository Events ${label} is invalid`);
  }
  return value;
}

function readOccurredAtMs(value: unknown): number {
  const raw = readBoundedString(value, 'created_at timestamp', 128);
  const occurredAtMs = Date.parse(raw);
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events created_at timestamp is invalid');
  }
  return occurredAtMs;
}

function createOccurrenceId(repositoryId: string, eventId: string): string {
  return `github:repository:${repositoryId}:event:${eventId}`;
}

function parseRepositoryEventPayload(input: Readonly<{
  eventId: string;
  occurredAtMs: number;
  raw: JsonRecord;
  repository: GithubRepositorySourceConfigV1;
  eventLocalId?: GithubAutomationEventLocalIdV1;
  eventLocalIds?: readonly GithubAutomationEventLocalIdV1[];
}>): ReturnType<typeof normalizeGithubAutomationEvent> | null {
  // Repository timelines mix Event families. Validate payload facts only for
  // subscribers to that family; unrelated entries still establish continuity.
  const accepts = (id: GithubAutomationEventLocalIdV1) => input.eventLocalIds === undefined || input.eventLocalIds.includes(id);
  if (input.raw.type === 'PushEvent' && !accepts(GITHUB_AUTOMATION_EVENT_LOCAL_IDS.push)) return null;
  if (input.raw.type === 'IssuesEvent' && !accepts(GITHUB_AUTOMATION_EVENT_LOCAL_IDS.issueOpened)) return null;
  if (input.raw.type === 'PullRequestEvent' && !accepts(GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened)
    && !accepts(GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestMerged)
    && input.eventLocalId !== GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle) return null;
  const rawPayload = isRecord(input.raw.payload) ? input.raw.payload : null;
  if (rawPayload === null) {
    if (
      input.raw.type === 'PushEvent'
      || input.raw.type === 'IssuesEvent'
      || input.raw.type === 'PullRequestEvent'
    ) {
      throw new GithubRepositoryEventsHistoryGapError('GitHub repository Event lacks its declared payload');
    }
    return null;
  }
  const repository = Object.freeze({
    repositoryId: input.repository.repositoryId,
    nameWithOwner: input.repository.nameWithOwner,
  });
  if (input.raw.type === 'PullRequestEvent' && input.eventLocalId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle) {
    try {
      const pullRequest = normalizeGithubPullRequestLifecycle(rawPayload.pull_request, rawPayload.action, {
        repository, actor: input.raw.actor,
      });
      return pullRequest === null ? null : normalizeGithubAutomationEvent({ kind: 'pullRequestLifecycle', repository, pullRequest });
    } catch {
      throw new GithubRepositoryEventsHistoryGapError('GitHub pull request lifecycle Event has invalid provider facts');
    }
  }
  if (input.raw.type === 'PushEvent') {
    return normalizeGithubAutomationEvent(Object.freeze({
      kind: 'push' as const,
      repository,
      ref: readBoundedString(rawPayload.ref, 'PushEvent ref'),
      before: readBoundedString(rawPayload.before, 'PushEvent before SHA'),
      after: readBoundedString(rawPayload.head, 'PushEvent head SHA'),
    }));
  }
  if (input.raw.type === 'IssuesEvent' && rawPayload.action === 'opened') {
    const issue = isRecord(rawPayload.issue) ? rawPayload.issue : null;
    if (issue === null) {
      throw new GithubRepositoryEventsHistoryGapError('GitHub opened issue Event lacks issue facts');
    }
    if (typeof issue.title !== 'string' || issue.title.length > 1_024) {
      throw new GithubRepositoryEventsHistoryGapError('GitHub opened issue Event has an invalid title');
    }
    return normalizeGithubAutomationEvent(Object.freeze({
      kind: 'issueOpened' as const,
      repository,
      issue: Object.freeze({
        id: readGithubPositiveDecimal(issue.id, 'issue ID'),
        number: readPositiveSafeInteger(issue.number, 'issue number'),
        title: issue.title,
      }),
    }));
  }
  if (input.raw.type === 'PullRequestEvent' && rawPayload.action === 'opened' && accepts(GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened)) {
    const pullRequest = isRecord(rawPayload.pull_request) ? rawPayload.pull_request : null;
    if (pullRequest === null) {
      throw new GithubRepositoryEventsHistoryGapError('GitHub opened pull request Event lacks pull request facts');
    }
    if (typeof pullRequest.title !== 'string' || pullRequest.title.length > 1_024) {
      throw new GithubRepositoryEventsHistoryGapError('GitHub opened pull request Event has an invalid title');
    }
    return normalizeGithubAutomationEvent(Object.freeze({
      kind: 'pullRequestOpened' as const,
      repository,
      pullRequest: Object.freeze({
        id: readGithubPositiveDecimal(pullRequest.id, 'pull request ID'),
        number: readPositiveSafeInteger(pullRequest.number, 'pull request number'),
        title: pullRequest.title,
      }),
    }));
  }
  if (input.raw.type === 'PullRequestEvent' && rawPayload.action === 'closed' && accepts(GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestMerged)) {
    const pullRequest = isRecord(rawPayload.pull_request) ? rawPayload.pull_request : null;
    if (pullRequest === null || pullRequest.merged !== true) return null;
    return normalizeGithubAutomationEvent(Object.freeze({
      kind: 'pullRequestMerged' as const,
      repository,
      pullRequest: Object.freeze({
        id: readGithubPositiveDecimal(pullRequest.id, 'pull request ID'),
        number: readPositiveSafeInteger(pullRequest.number, 'pull request number'),
        mergeCommitSha: readBoundedString(pullRequest.merge_commit_sha, 'pull request merge SHA'),
      }),
    }));
  }
  return null;
}

/** Validate timeline identity before the cursor decides whether this occurrence needs its payload. */
export function readGithubRepositoryEventTimeline(
  value: unknown,
  repository: GithubRepositorySourceConfigV1,
): Readonly<{ eventId: string; createdAtMs: number; observation: GithubRepositoryEventFactsV1 }> {
  if (!isRecord(value)) {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events entry is invalid');
  }
  const eventId = readBoundedString(value.id, 'event ID', 256);
  const occurredAtMs = readOccurredAtMs(value.created_at);
  const rawRepository = isRecord(value.repo) ? value.repo : null;
  if (rawRepository === null) {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events entry lacks a repository');
  }
  let repositoryId: string;
  try {
    repositoryId = readGithubPositiveDecimal(rawRepository.id, 'repository ID');
  } catch {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events entry has an invalid repository ID');
  }
  if (
    repositoryId !== repository.repositoryId
    || typeof rawRepository.name !== 'string'
    || rawRepository.name.toLowerCase() !== repository.nameWithOwner.toLowerCase()
  ) {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events entry changed its immutable repository');
  }
  return Object.freeze({
    eventId,
    createdAtMs: occurredAtMs,
    observation: Object.freeze({ eventId, occurredAtMs, raw: value }),
  });
}

/** Project only occurrences selected by the cursor, for this semantic subscriber. */
export function projectGithubRepositoryEventObservations(
  { eventId, occurredAtMs, raw }: GithubRepositoryEventFactsV1,
  repository: GithubRepositorySourceConfigV1,
  eventLocalIds?: readonly GithubAutomationEventLocalIdV1[],
): readonly GithubAutomationRepositoryEventObservationV1[] | null {
  const legacy = eventLocalIds?.every(id => id === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle) ? null
    : parseRepositoryEventPayload({ eventId, occurredAtMs, raw, repository, eventLocalIds });
  const lifecycle = raw.type === 'PullRequestEvent' && eventLocalIds?.includes(GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle)
    ? parseRepositoryEventPayload({ eventId, occurredAtMs, raw, repository, eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle }) : null;
  const observations = [legacy, lifecycle].flatMap(normalized => normalized === null
    || (eventLocalIds !== undefined && !eventLocalIds.includes(normalized.eventRef.localId)) ? [] : [Object.freeze({
      eventRef: normalized.eventRef,
      occurrenceId: createOccurrenceId(repository.repositoryId, eventId),
      occurredAtMs,
      payload: normalized.payload,
    })]);
  return observations.length === 0 ? null : Object.freeze(observations);
}

export function normalizeGithubRepositoryEventForAutomation(
  value: unknown,
  repository: GithubRepositorySourceConfigV1,
  eventLocalId?: GithubAutomationEventLocalIdV1,
): GithubRepositoryTimelineEntryV1<GithubAutomationRepositoryEventObservationV1> {
  const entry = readGithubRepositoryEventTimeline(value, repository);
  const observations = projectGithubRepositoryEventObservations(
    entry.observation, repository, eventLocalId === undefined ? undefined : [eventLocalId],
  );
  return Object.freeze({ ...entry, observation: observations?.[0] ?? null });
}
