import {
  normalizeGithubAutomationEvent,
  type GithubAutomationEventFactsV1,
  type GithubAutomationEventPayloadV1,
  type GithubAutomationEventRefV1,
} from '../githubAutomationEvents.js';

export type GithubActorV1 = Readonly<{
  id: string;
  login: string;
  /** Only an attributable GitHub User is authoritative for Channels input. */
  kind: 'human' | 'bot' | 'unsupported';
}>;

export type GithubIssueCommentWebhookObservationV1 = Readonly<{
  occurrenceKey: string;
  repositoryId: string;
  repositoryNameWithOwner: string;
  endpointKind: 'issue' | 'pullRequest';
  audience: 'shared';
  issueNumber: number;
  commentId: string;
  body: string;
  addressingEvidence: 'none';
  createdAtMs: number;
  updatedAtMs: number;
  action: 'created' | 'edited';
  isUnsupportedEdit: boolean;
  actor: GithubActorV1;
}>;

export type GithubAutomationWebhookObservationV1 = Readonly<{
  eventRef: GithubAutomationEventRefV1;
  sourceInstanceId: string;
  occurrenceId: string;
  occurredAtMs: number;
  payload: GithubAutomationEventPayloadV1;
}>;

export type GithubNormalizedWebhookDeliveryV1 = Readonly<{
  providerDeliveryId: string;
  eventType: string;
  comment: GithubIssueCommentWebhookObservationV1 | null;
  automationEvent: GithubAutomationWebhookObservationV1 | null;
}>;

export type GithubWebhookJsonParser = (rawBody: Uint8Array) => unknown;

export class GithubWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubWebhookPayloadError';
  }
}

type JsonObject = Readonly<Record<string, unknown>>;

function defaultParseJson(rawBody: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
}

function readObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GithubWebhookPayloadError(`GitHub webhook payload field '${field}' must be an object`);
  }
  return value as JsonObject;
}

function readString(object: JsonObject, field: string, allowEmpty = false): string {
  const value = object[field];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new GithubWebhookPayloadError(`GitHub webhook payload field '${field}' must be a string`);
  }
  return value;
}

function readPositiveInteger(object: JsonObject, field: string): number {
  const value = object[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GithubWebhookPayloadError(`GitHub webhook payload field '${field}' must be a positive safe integer`);
  }
  return value;
}

function readTimestamp(object: JsonObject, field: string): number {
  const timestamp = Date.parse(readString(object, field));
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new GithubWebhookPayloadError(`GitHub webhook payload field '${field}' must be an ISO timestamp`);
  }
  return timestamp;
}

function readActor(value: unknown, field: string): GithubActorV1 {
  const actor = readObject(value, field);
  const id = String(readPositiveInteger(actor, 'id'));
  const login = readString(actor, 'login');
  const actorType = actor.type;
  return Object.freeze({
    id,
    login,
    // GitHub documents `ghost` as an unresolved placeholder and warns that a
    // webhook sender is not causal authority. Unknown account types must stay
    // non-authoritative so no consumer can recover a false human claim later.
    kind: actorType === 'User' && login.toLowerCase() !== 'ghost'
      ? 'human'
      : actorType === 'Bot'
        ? 'bot'
        : 'unsupported',
  });
}

function readRepository(
  value: unknown,
  nameField: 'full_name' | 'name' = 'full_name',
): Readonly<{ id: string; nameWithOwner: string }> {
  const repository = readObject(value, 'repository');
  return Object.freeze({
    id: String(readPositiveInteger(repository, 'id')),
    nameWithOwner: readString(repository, nameField),
  });
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIssueComment(payload: JsonObject): GithubIssueCommentWebhookObservationV1 | null {
  const action = payload.action;
  if (action !== 'created' && action !== 'edited') return null;
  const repository = readRepository(payload.repository);
  const issue = readObject(payload.issue, 'issue');
  const comment = readObject(payload.comment, 'comment');
  const commentId = String(readPositiveInteger(comment, 'id'));
  const createdAtMs = readTimestamp(comment, 'created_at');
  const updatedAtMs = readTimestamp(comment, 'updated_at');
  return Object.freeze({
    occurrenceKey: `github:repository:${repository.id}:issue-comment:${commentId}`,
    repositoryId: repository.id,
    repositoryNameWithOwner: repository.nameWithOwner,
    endpointKind: isObject(issue.pull_request) ? 'pullRequest' : 'issue',
    audience: 'shared',
    issueNumber: readPositiveInteger(issue, 'number'),
    commentId,
    body: readString(comment, 'body', true),
    // The signed payload authenticates delivery, not rendered @name text as
    // addressing evidence; GitHub exposes no structured comment reply/mention.
    addressingEvidence: 'none',
    createdAtMs,
    updatedAtMs,
    action,
    isUnsupportedEdit: action === 'edited' || createdAtMs !== updatedAtMs,
    actor: readActor(comment.user, 'comment.user'),
  });
}

function eventRepository(repository: Readonly<{ id: string; nameWithOwner: string }>) {
  return Object.freeze({
    repositoryId: repository.id,
    nameWithOwner: repository.nameWithOwner,
  });
}

function createAutomationWebhookObservation(params: Readonly<{
  repository: Readonly<{ id: string; nameWithOwner: string }>;
  providerDeliveryId: string;
  occurredAtMs: number;
  facts: GithubAutomationEventFactsV1;
}>): GithubAutomationWebhookObservationV1 {
  const normalized = normalizeGithubAutomationEvent(params.facts);
  return Object.freeze({
    eventRef: normalized.eventRef,
    sourceInstanceId: `github:repository:${params.repository.id}`,
    occurrenceId: `github:repository:${params.repository.id}:delivery:${params.providerDeliveryId}`,
    occurredAtMs: params.occurredAtMs,
    payload: normalized.payload,
  });
}

function normalizeAutomationEvent(
  payload: JsonObject,
  eventType: string,
  providerDeliveryId: string,
  receivedAtMs: number,
): GithubAutomationWebhookObservationV1 | null {
  if (eventType !== 'push' && eventType !== 'issues' && eventType !== 'pull_request') return null;
  const repository = readRepository(payload.repository);
  const repositoryPayload = eventRepository(repository);
  if (eventType === 'push') {
    // Unlike issue and pull-request resources, a push webhook has no provider
    // event timestamp. `head_commit.timestamp` is commit authorship time and
    // may be arbitrarily older than the push (or null for ref deletion), so it
    // must not drive Event freshness. The authenticated host receipt is the
    // only transport-owned occurrence clock available for this delivery.
    const occurredAtMs = receivedAtMs;
    const facts = Object.freeze({
      kind: 'push',
      repository: repositoryPayload,
      ref: readString(payload, 'ref'),
      before: readString(payload, 'before'),
      after: readString(payload, 'after'),
    }) satisfies GithubAutomationEventFactsV1;
    return createAutomationWebhookObservation({
      repository,
      providerDeliveryId,
      occurredAtMs,
      facts,
    });
  }
  if (eventType === 'issues') {
    if (payload.action !== 'opened') return null;
    const issue = readObject(payload.issue, 'issue');
    const occurredAtMs = readTimestamp(issue, 'created_at');
    const facts = Object.freeze({
      kind: 'issueOpened',
      repository: repositoryPayload,
      issue: Object.freeze({
        id: String(readPositiveInteger(issue, 'id')),
        number: readPositiveInteger(issue, 'number'),
        title: readString(issue, 'title', true),
      }),
    }) satisfies GithubAutomationEventFactsV1;
    return createAutomationWebhookObservation({
      repository,
      providerDeliveryId,
      occurredAtMs,
      facts,
    });
  }
  if (payload.action !== 'opened' && payload.action !== 'closed') return null;
  const pullRequest = readObject(payload.pull_request, 'pull_request');
  if (payload.action === 'closed' && pullRequest.merged !== true) return null;
  const occurredAtMs = payload.action === 'opened'
    ? readTimestamp(pullRequest, 'created_at')
    : readTimestamp(pullRequest, 'merged_at');
  const commonPullRequest = {
    id: String(readPositiveInteger(pullRequest, 'id')),
    number: readPositiveInteger(pullRequest, 'number'),
  } as const;
  const facts: GithubAutomationEventFactsV1 = payload.action === 'opened'
    ? Object.freeze({
        kind: 'pullRequestOpened',
        repository: repositoryPayload,
        pullRequest: Object.freeze({
          ...commonPullRequest,
          title: readString(pullRequest, 'title', true),
        }),
      })
    : Object.freeze({
        kind: 'pullRequestMerged',
        repository: repositoryPayload,
        pullRequest: Object.freeze({
          ...commonPullRequest,
          mergeCommitSha: readString(pullRequest, 'merge_commit_sha'),
        }),
      });
  return createAutomationWebhookObservation({
    repository,
    providerDeliveryId,
    occurredAtMs,
    facts,
  });
}

/**
 * This is the single raw-body parser used by the provider webhook Action. The
 * generic webhook owner has already authenticated, bounded, and durably
 * committed the bytes; this function deliberately does not verify signatures,
 * resolve an endpoint, or create another delivery record.
 */
export function normalizeGithubWebhookDelivery(input: Readonly<{
  rawBody: Uint8Array;
  eventType: string | undefined;
  providerDeliveryId: string;
  receivedAtMs: number;
  parseJson?: GithubWebhookJsonParser;
}>): GithubNormalizedWebhookDeliveryV1 {
  if (!input.eventType || !input.providerDeliveryId) {
    throw new GithubWebhookPayloadError('GitHub webhook delivery is missing verified event identity');
  }
  let parsed: unknown;
  try {
    parsed = (input.parseJson ?? defaultParseJson)(input.rawBody);
  } catch (error) {
    throw new GithubWebhookPayloadError(
      error instanceof Error ? `GitHub webhook JSON was invalid: ${error.message}` : 'GitHub webhook JSON was invalid',
    );
  }
  const payload = readObject(parsed, 'payload');
  return Object.freeze({
    providerDeliveryId: input.providerDeliveryId,
    eventType: input.eventType,
    comment: input.eventType === 'issue_comment' ? normalizeIssueComment(payload) : null,
    automationEvent: normalizeAutomationEvent(
      payload,
      input.eventType,
      input.providerDeliveryId,
      input.receivedAtMs,
    ),
  });
}
