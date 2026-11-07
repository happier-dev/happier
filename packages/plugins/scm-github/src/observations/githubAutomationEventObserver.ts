import { createHash } from 'node:crypto';
import { isPluginError, PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
  processCheckpointedPluginEventAttemptV1,
  runCheckpointedPluginEventObserverV1,
  type BackgroundServiceContext,
  type PluginCheckpointedEventSourceAdapterV1,
} from '@happier-dev/plugin-sdk/background-services';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { createProtocolStoredReadSchema, defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
  type PluginEventAutomationHistoryGapResetActionResultV1,
  type PluginEventObservationV1,
} from '@happier-dev/plugin-sdk/events';
import {
  PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1,
  PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
  type PluginCollectionRow,
} from '@happier-dev/plugin-sdk/collections';
import { parseForgeLinkHeader } from '@happier-dev/triage-sources/runtime';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import {
  isGithubAutomationEventLocalId,
  GITHUB_AUTOMATION_EVENT_LOCAL_IDS,
  normalizeGithubAutomationEvent,
  type GithubAutomationEventLocalIdV1,
  type GithubAutomationEventPayloadV1,
  type GithubAutomationEventRefV1,
} from '../githubAutomationEvents.js';
import {
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD,
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_INDEX_ID,
  createGithubAutomationEventCheckpointRowId,
  createGithubAutomationEventCheckpointRowV1,
  isGithubAutomationEventCheckpointRowV1,
  type GithubAutomationEventCheckpointRowV1,
} from './githubAutomationEventCheckpoint.js';
import {
  createGithubApiClient,
  decodeGithubJsonResponse,
  GITHUB_RATE_LIMIT_FALLBACK_MS,
  type GithubApiResponseV1,
} from './githubApiClient.js';
import {
  classifyGithubResponseFailure,
  isGithubInaccessibleResourceFailure,
  type GithubResponseFailureV1,
} from './githubResponseFailure.js';
import {
  GITHUB_API_ORIGIN,
  GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
  GITHUB_PLUGIN_ID,
  GITHUB_CONNECTED_ACCOUNT_SERVICE,
  isGithubConnectedAccountRef,
  parseGithubRepositorySourceConfig,
  readGithubPositiveDecimal,
  type GithubAutomationRepositoryEventSourceConfigV1,
  type GithubRepositorySourceConfigV1,
} from './githubProviderContracts.js';
import {
  GithubRepositoryEventsHistoryGapError,
  pollGithubRepositoryEvents,
  type GithubRepositoryEventsPollResultV1,
} from './githubRepositoryEventsPolling.js';
import {
  classifyGithubRepositoryEvents,
  createGithubRepositoryEventsBaseline,
  parseGithubRepositoryEventsCursor,
  reuseGithubRepositoryEventsCheckpointOnNotModified,
  type GithubRepositoryEventsCursorV1,
  type GithubRepositoryTimelineEntryV1,
} from './githubRepositoryEventsCursor.js';
import { requireGithubAccountStorage } from '../requiredAccountStorage.js';
import { projectGithubChecksSourceEvents, githubChecksSourceInstanceId, isGithubChecksEvent, parseGithubChecksSource } from './githubChecksSource.js';
import { readGithubPullRequestChecks } from '../triage/checks.js';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { parseGithubDeploymentMonitoringSourceConfig } from './githubProviderContracts.js';
import { publishGithubDeploymentReviewNoticesV1 } from '../actions/deploymentNotices.js';
import { GithubDeploymentMonitorCursorV1Schema, type GithubDeploymentMonitorCursorV1 } from '../actions/deploymentReviewProtocol.js';
import { readGithubDeploymentReviewCandidateV1, projectGithubDeploymentReviewCandidateV1, type GithubDeploymentReviewCandidateV1 } from './githubDeploymentMonitor.js';
import { GithubCiReadError } from '../actions/reads.js';
import type { GithubDeploymentWebhookWakeV1 } from '../webhookAction.js';

const REPOSITORY_EVENTS_ENDPOINT_KIND = 'repositoryEvents' as const;
const storedRepositoryEventsContinuitySchema = createProtocolStoredReadSchema(defineProtocolObject({
  v: defineProtocolLiteral(1),
  endpointKind: defineProtocolLiteral(REPOSITORY_EVENTS_ENDPOINT_KIND),
  repositoryId: defineProtocolString(),
  historyGap: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' }));
const REPOSITORY_EVENTS_PAGE_SIZE = 100;
const DEFAULT_SOURCE_POLL_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
type JsonRecord = Readonly<Record<string, unknown>>;
type AutomationEventSourcesListResultV1 = PluginActionResultById['automation.event.sources.list'];
export type GithubAutomationEventSourceDefinitionV1 = Extract<
  AutomationEventSourcesListResultV1,
  Readonly<{ kind: 'page' }>
>['definitions'][number];
type AutomationEventSourceStatusReportV1 = PluginActionInputById['automation.event.source.status.report'];
type AutomationEventSourceStatusInputV1 = Extract<
  AutomationEventSourceStatusReportV1,
  Readonly<{ kind: 'source' }>
>;
type AutomationEventSourceStatusStateV1 = AutomationEventSourceStatusInputV1['state'];
type AutomationEventSourceStatusCodeV1 = AutomationEventSourceStatusInputV1['code'];
type AutomationEventCheckpointRetirementCandidateV1 = NonNullable<
  PluginActionInputById['automation.event.sources.list']['checkpointRetirementCandidates']
>[number];

type GithubAutomationRepositoryEventObservationV1 = Readonly<{
  eventRef: GithubAutomationEventRefV1;
  occurrenceId: string;
  occurredAtMs: number;
  payload: GithubAutomationEventPayloadV1;
}>;

type GithubAutomationObservedSourceV1 = Readonly<{
  definition: GithubObservedSourceDefinitionV1;
  credentialRef: ConnectedAccountRef | null;
  repository: GithubRepositorySourceConfigV1;
  checks?: NonNullable<GithubAutomationRepositoryEventSourceConfigV1['checks']>;
  deploymentReview?: NonNullable<GithubAutomationRepositoryEventSourceConfigV1['deploymentReview']>;
  /** The existing watcher or endpoint target is the single monitoring placement. */
  materializationRef: NonNullable<GithubCheckpointedPullSourceDefinitionV1['observationTransport']['watcherMaterializationRef']>;
  daemonMaterializationRef: string;
}>;

type LoadedCheckpointV1 = Readonly<{
  row: PluginCollectionRow<GithubAutomationEventCheckpointRowV1>;
  cursor: GithubRepositoryEventsCursorV1;
  historyGap: boolean;
}>;

type StoredCheckpointRowV1 = PluginCollectionRow<Readonly<Record<string, JsonValue>>>;

type GithubAutomationObservedSourceCandidateV1 =
  | Readonly<{ kind: 'source'; source: GithubAutomationObservedSourceV1 }>
  | Readonly<{ kind: 'incompatible'; definition: GithubAutomationEventSourceDefinitionV1 }>;

type GithubCheckpointedPullSourceDefinitionV1 = GithubAutomationEventSourceDefinitionV1 & Readonly<{
  eventRef: GithubAutomationEventRefV1;
  observationTransport: Extract<
    GithubAutomationEventSourceDefinitionV1['observationTransport'],
    Readonly<{ kind: 'checkpointedPull' }>
  >;
}>;

type GithubObservedSourceDefinitionV1 = GithubCheckpointedPullSourceDefinitionV1 | (GithubAutomationEventSourceDefinitionV1 & Readonly<{
  eventRef: GithubAutomationEventRefV1;
  observationTransport: Extract<GithubAutomationEventSourceDefinitionV1['observationTransport'], Readonly<{ kind: 'durablePush' }>>;
}>);

type SourceFailureStatusV1 = Readonly<{
  state: AutomationEventSourceStatusStateV1;
  code: AutomationEventSourceStatusCodeV1;
  nextRetryAt: number | null;
}>;

type GithubCheckpointRetirementCatalogV1 = Readonly<{
  revision: string;
  knownCurrentCheckpointsByRowId: ReadonlyMap<string, GithubAutomationKnownCurrentCheckpointV1 | null>;
}>;

type GithubAutomationKnownCurrentCheckpointV1 = Readonly<{
  sourceInstanceId: string;
  sourceContractVersion: number;
}>;

type GithubAutomationSourceCycleResultV1 = Readonly<{
  sourceKey: string;
  nextEligibleAt: number | null;
}>;

export type GithubAutomationEventCheckpointedPullObserver = Readonly<{
  /** Runs the source-complete provider loop until the generation is aborted. */
  run(context: BackgroundServiceContext): Promise<void>;
  /** One caller-current source scan; preserved for focused owner tests. */
  runCycle(context: BackgroundServiceContext): Promise<void>;
  /** Host target-Action handler for one exact source credential attempt. */
  runSourceAttempt(input: unknown, context: PluginInvocationContext): Promise<JsonValue>;
  /** A verified ingress wake joins this same background observer's work loop. */
  receiveDeploymentWebhook(wake: GithubDeploymentWebhookWakeV1, signal: AbortSignal): Promise<'accepted' | 'ignored'>;
}>;

export type GithubAutomationEventCheckpointedPullObserverOptions = Readonly<{
  manifest?: Pick<PluginManifest, 'contributes'>;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  reconciliationIntervalMs?: number;
  retryDelayMs?: number;
}>;

class GithubRepositoryEventsResponseError extends Error {
  constructor(readonly response: GithubApiResponseV1) {
    super(`GitHub repository Events API returned ${response.status}`);
  }
}

class GithubRepositoryEventsSourceContractError extends Error {
  constructor(message: string) {
    super(message);
  }
}

class GithubRepositoryEventsAdmissionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

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

function readGithubPollIntervalMs(headers: Readonly<Record<string, string>>): number | null {
  const raw = readTriageResponseHeaderV1(headers, 'x-poll-interval');
  if (raw === null || !/^[1-9][0-9]*$/u.test(raw)) return null;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds)) return null;
  const intervalMs = seconds * 1_000;
  return Number.isSafeInteger(intervalMs) ? intervalMs : null;
}

function readSingleQueryValue(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    throw new GithubRepositoryEventsHistoryGapError(`GitHub repository Events URL repeats '${key}'`);
  }
  return values[0] ?? null;
}

function createRepositoryEventsUrl(repository: GithubRepositorySourceConfigV1): string {
  const url = new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/events`,
    GITHUB_API_ORIGIN,
  );
  url.searchParams.set('per_page', String(REPOSITORY_EVENTS_PAGE_SIZE));
  return url.toString();
}

/**
 * GitHub controls Link headers. Validate a next page before the exact
 * Connected Account client is allowed to send credentials to it.
 */
function validateRepositoryEventsPageUrl(
  value: string,
  repository: GithubRepositorySourceConfigV1,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events next-page URL is invalid');
  }
  const expectedPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/events`;
  if (
    url.protocol !== 'https:'
    || url.origin !== GITHUB_API_ORIGIN
    || url.username
    || url.password
    || url.hash
    || url.pathname !== expectedPath
  ) {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events next-page URL changed its stream');
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'per_page' && key !== 'page') {
      throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events next-page URL has an unsupported query');
    }
  }
  if (readSingleQueryValue(url, 'per_page') !== String(REPOSITORY_EVENTS_PAGE_SIZE)) {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events next-page URL changed its page size');
  }
  const page = readSingleQueryValue(url, 'page');
  if (page !== null && !/^[1-9][0-9]*$/u.test(page)) {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events next-page URL has an invalid page');
  }
  return url.toString();
}

/**
 * The RFC 8288 grammar is a provider-published standard rather than a GitHub rule, so
 * it is parsed by the shared forge owner. What stays here is GitHub's own validation.
 */
function parseNextPageUrl(
  headers: Readonly<Record<string, string>>,
  repository: GithubRepositorySourceConfigV1,
): string | null {
  const parsed = parseForgeLinkHeader(readTriageResponseHeaderV1(headers, 'link'));
  if (parsed.kind === 'malformed') {
    throw new GithubRepositoryEventsHistoryGapError(
      'GitHub repository Events returned a malformed Link header',
    );
  }
  const next = parsed.kind === 'parsed' ? parsed.links.next : undefined;
  return next === undefined ? null : validateRepositoryEventsPageUrl(next, repository);
}

function credentialRequestKey(credentialRef: ConnectedAccountRef | null): string {
  if (credentialRef === null) return 'native-gh';
  return JSON.stringify([
    credentialRef.service.pluginId,
    credentialRef.service.localId,
    credentialRef.accountId,
  ]);
}

function materializationRequestKey(value: Readonly<{
  pluginId: string;
  machineId: string;
  materializationId: string;
}>): string {
  return JSON.stringify([value.pluginId, value.machineId, value.materializationId]);
}

function repositoryEventsContinuity(repositoryId: string, historyGap = false): JsonValue {
  return Object.freeze({
    v: 1,
    endpointKind: REPOSITORY_EVENTS_ENDPOINT_KIND,
    repositoryId,
    ...(historyGap ? { historyGap: true } : {}),
  }) satisfies JsonValue;
}

function parseRepositoryEventsContinuity(
  value: unknown,
  repositoryId: string,
): Readonly<{ historyGap: boolean }> | null {
  const parsed = storedRepositoryEventsContinuitySchema.safeParse(value);
  if (!parsed.success || parsed.data.repositoryId !== repositoryId) return null;
  return Object.freeze({ historyGap: parsed.data.historyGap === true });
}

function parseGithubAutomationRepositoryEventSourceConfig(
  value: unknown,
): GithubAutomationRepositoryEventSourceConfigV1 {
  if (!isRecord(value) || value.v !== 1 || (!isGithubConnectedAccountRef(value.credentialRef, GITHUB_PLUGIN_ID)
    && !(value.credentialRef === null && value.deploymentReview !== undefined))) {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation source configuration is incompatible');
  }
  try {
    if (value.deploymentReview !== undefined) return parseGithubDeploymentMonitoringSourceConfig(value);
    return Object.freeze({
      v: 1,
      credentialRef: value.credentialRef,
      repository: parseGithubRepositorySourceConfig(value.repository),
      ...(value.checks === undefined ? {} : { checks: parseGithubChecksSource(value.checks) }),
    });
  } catch {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation repository source configuration is incompatible');
  }
}

function parseObservedSource(
  definition: GithubAutomationEventSourceDefinitionV1,
): GithubAutomationObservedSourceV1 | null {
  if (!isGithubObservedDefinition(definition)) return null;
  if (definition.sourceContractVersion !== GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION) {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation source contract version is incompatible');
  }
  const sourceConfig = parseGithubAutomationRepositoryEventSourceConfig(definition.sourceConfig);
  const materializationRef = definition.observationTransport.kind === 'checkpointedPull'
    ? definition.observationTransport.watcherMaterializationRef
    : definition.observationTransport.endpointMaterializationRef;
  if (materializationRef === null) return null;
  const checksEvent = isGithubChecksEvent(definition.eventRef.localId);
  if (checksEvent !== (sourceConfig.checks !== undefined)) {
    throw new GithubRepositoryEventsSourceContractError('GitHub checks configuration must match its Event');
  }
  const deploymentEvent = definition.eventRef.localId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.deploymentReview;
  if (deploymentEvent !== (sourceConfig.deploymentReview !== undefined)
    || (deploymentEvent && sourceConfig.deploymentReview?.monitoringMachineId !== materializationRef.machineId)) {
    throw new GithubRepositoryEventsSourceContractError('Deployment monitoring must match its Event and selected Machine');
  }
  const expectedInstance = sourceConfig.checks
    ? githubChecksSourceInstanceId(sourceConfig.repository.repositoryId, sourceConfig.checks)
    : `github:repository:${sourceConfig.repository.repositoryId}${deploymentEvent ? ':deployment-review' : ''}`;
  if (definition.sourceInstanceId !== expectedInstance) {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation source instance does not match its repository');
  }
  return Object.freeze({
    definition,
    credentialRef: sourceConfig.credentialRef,
    repository: sourceConfig.repository,
    ...(sourceConfig.checks ? { checks: sourceConfig.checks } : {}),
    ...(sourceConfig.deploymentReview ? { deploymentReview: sourceConfig.deploymentReview } : {}),
    materializationRef,
    daemonMaterializationRef: materializationRequestKey(materializationRef),
  });
}

function createOccurrenceId(repositoryId: string, eventId: string): string {
  return `github:repository:${repositoryId}:event:${eventId}`;
}

function parseRepositoryEventPayload(input: Readonly<{
  eventId: string;
  occurredAtMs: number;
  raw: JsonRecord;
  repository: GithubRepositorySourceConfigV1;
}>): ReturnType<typeof normalizeGithubAutomationEvent> | null {
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
  if (input.raw.type === 'PullRequestEvent' && rawPayload.action === 'opened') {
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
  if (input.raw.type === 'PullRequestEvent' && rawPayload.action === 'closed') {
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

export function normalizeGithubRepositoryEventForAutomation(
  value: unknown,
  repository: GithubRepositorySourceConfigV1,
  eventLocalId?: GithubAutomationEventLocalIdV1,
): GithubRepositoryTimelineEntryV1<GithubAutomationRepositoryEventObservationV1> {
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
  const normalized = parseRepositoryEventPayload({ eventId, occurredAtMs, raw: value, repository });
  return Object.freeze({
    eventId,
    createdAtMs: occurredAtMs,
    observation: normalized === null || (eventLocalId !== undefined && normalized.eventRef.localId !== eventLocalId)
      ? null
      : Object.freeze({
        eventRef: normalized.eventRef,
        occurrenceId: createOccurrenceId(repository.repositoryId, eventId),
        occurredAtMs,
        payload: normalized.payload,
      }),
  });
}

async function pollRepositoryEvents(input: Readonly<{
  context: PluginInvocationContext;
  source: GithubAutomationObservedSourceV1;
  cursor: GithubRepositoryEventsCursorV1 | null;
}>): Promise<GithubRepositoryEventsPollResultV1<GithubAutomationRepositoryEventObservationV1>> {
  const client = await createGithubApiClient(input.context, input.source.credentialRef);
  const initialUrl = createRepositoryEventsUrl(input.source.repository);
  return await pollGithubRepositoryEvents({
    initialUrl,
    etag: input.cursor?.etag ?? null,
    getPage: async ({ url, ifNoneMatch }) => {
      input.context.signal.throwIfAborted();
      const validatedUrl = validateRepositoryEventsPageUrl(url, input.source.repository);
      const response = await client.request({
        url: validatedUrl,
        ...(ifNoneMatch === null ? {} : { headers: { 'If-None-Match': ifNoneMatch } }),
      });
      input.context.signal.throwIfAborted();
      if (response.status === 304) {
        if (ifNoneMatch === null) {
          throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events returned an unvalidated 304');
        }
        return Object.freeze({
          kind: 'notModified' as const,
          pollIntervalMs: readGithubPollIntervalMs(response.headers),
        });
      }
      if (response.status !== 200) throw new GithubRepositoryEventsResponseError(response);
      const payload = decodeGithubJsonResponse(response);
      if (!Array.isArray(payload)) {
        throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events response is not an array');
      }
      return Object.freeze({
        kind: 'page' as const,
        etag: readTriageResponseHeaderV1(response.headers, 'etag'),
        nextUrl: parseNextPageUrl(response.headers, input.source.repository),
        events: Object.freeze(payload.map((event) => normalizeGithubRepositoryEventForAutomation(
          event,
          input.source.repository,
        ))),
        pollIntervalMs: readGithubPollIntervalMs(response.headers),
      });
    },
  });
}

function checkpointRowId(source: GithubAutomationObservedSourceV1): string {
  return createGithubAutomationEventCheckpointRowId({
    automationId: source.definition.automationId,
    triggerId: source.definition.triggerId,
    eventRef: source.definition.eventRef,
    sourceSelectorId: source.definition.sourceSelectorId,
  });
}

function loadCheckpoint(input: Readonly<{
  row: StoredCheckpointRowV1;
  source: GithubAutomationObservedSourceV1;
}>): LoadedCheckpointV1 {
  const { row, source } = input;
  const checkpoint = row.value;
  if (row.rowId !== checkpointRowId(source) || !isGithubAutomationEventCheckpointRowV1(checkpoint)) {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation checkpoint is incompatible');
  }
  const payload = checkpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload];
  const continuity = parseRepositoryEventsContinuity(payload.continuity, source.repository.repositoryId);
  if (
    payload.sourceInstanceId !== source.definition.sourceInstanceId
    || payload.sourceContractVersion !== source.definition.sourceContractVersion
    || continuity === null
  ) {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation checkpoint is incompatible');
  }
  try {
    return Object.freeze({
      row: Object.freeze({ rowId: row.rowId, revision: row.revision, value: checkpoint }),
      cursor: parseGithubRepositoryEventsCursor(payload.cursor),
      historyGap: continuity.historyGap,
    });
  } catch {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation checkpoint cursor is incompatible');
  }
}

function createCheckpointRow(input: Readonly<{
  source: GithubAutomationObservedSourceV1;
  cursor: GithubRepositoryEventsCursorV1;
  lastContiguousOccurrenceId: string | null;
  baseline: GithubAutomationEventCheckpointRowV1['payload']['baseline'];
  historyGap?: boolean;
}>): GithubAutomationEventCheckpointRowV1 {
  return createGithubAutomationEventCheckpointRowV1({
    checkpointRowId: checkpointRowId(input.source),
    automationId: input.source.definition.automationId,
    triggerId: input.source.definition.triggerId,
    eventRef: input.source.definition.eventRef,
    sourceSelectorId: input.source.definition.sourceSelectorId,
    sourceInstanceId: input.source.definition.sourceInstanceId,
    sourceContractVersion: input.source.definition.sourceContractVersion,
    cursor: input.cursor,
    lastContiguousOccurrenceId: input.lastContiguousOccurrenceId,
    baseline: input.baseline,
    lastEvaluatedTriggerRevision: input.source.definition.triggerRevision,
    continuity: repositoryEventsContinuity(input.source.repository.repositoryId, input.historyGap),
  });
}

export type GithubAutomationEventHistoryGapBaselineResultV1 = PluginEventAutomationHistoryGapResetActionResultV1;

function isCollectionCurrentnessConflict(error: unknown): boolean {
  return isPluginError(error) && error.code === 'plugin_collection_conflict';
}

function readCheckpointRetirementCandidate(
  row: StoredCheckpointRowV1,
): Readonly<{
  candidate: AutomationEventCheckpointRetirementCandidateV1;
  sourceInstanceId: string;
  sourceContractVersion: number;
}> | null {
  const checkpoint = row.value;
  if (!isGithubAutomationEventCheckpointRowV1(checkpoint)) return null;
  const payload = checkpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload];
  return Object.freeze({
    candidate: Object.freeze({
      automationId: checkpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId],
      triggerId: checkpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId],
      triggerRevision: payload.lastEvaluatedTriggerRevision,
      eventRef: Object.freeze({
        pluginId: checkpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId],
        localId: checkpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId],
      }),
      sourceSelectorId: checkpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId],
      sourceContractVersion: payload.sourceContractVersion,
    }),
    sourceInstanceId: payload.sourceInstanceId,
    sourceContractVersion: payload.sourceContractVersion,
  });
}

function checkpointRetirementCandidateForServerClassification(input: Readonly<{
  row: StoredCheckpointRowV1;
  knownCurrentCheckpointsByRowId: ReadonlyMap<string, GithubAutomationKnownCurrentCheckpointV1 | null>;
}>): AutomationEventCheckpointRetirementCandidateV1 | null {
  const checkpoint = readCheckpointRetirementCandidate(input.row);
  if (checkpoint === null) return null;
  const knownCurrent = input.knownCurrentCheckpointsByRowId.get(input.row.rowId);
  // This is only an inquiry reduction: an exact current source has no stale
  // identity to ask the catalog about. Every absence, ambiguity, source change,
  // or contract change is still classified by the server before any CAS.
  if (
    knownCurrent !== undefined
    && knownCurrent !== null
    && checkpoint.sourceInstanceId === knownCurrent.sourceInstanceId
    && checkpoint.sourceContractVersion === knownCurrent.sourceContractVersion
  ) return null;
  return checkpoint.candidate;
}

function checkpointRetirementCandidateKey(candidate: AutomationEventCheckpointRetirementCandidateV1): string {
  return JSON.stringify([
    candidate.automationId,
    candidate.triggerId,
    candidate.triggerRevision,
    candidate.eventRef.pluginId,
    candidate.eventRef.localId,
    candidate.sourceSelectorId,
    candidate.sourceContractVersion,
  ]);
}

/**
 * Once an exact catalog revision is fully adopted, the server classifies each
 * bounded checkpoint page under that same revision. This observer never infers
 * retirement from its caller-scoped projection; it consumes only the returned
 * server subset and keeps the existing Account Collection CAS as deletion owner.
 */
async function reconcileCheckpointRows(input: Readonly<{
  context: BackgroundServiceContext;
  catalog: GithubCheckpointRetirementCatalogV1;
  isCurrent(): Promise<boolean>;
}>): Promise<Readonly<{ complete: boolean }>> {
  const collection = requireGithubAccountStorage(input.context).collection(
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  );
  let cursor: string | undefined;
  let complete = true;
  while (true) {
    input.context.signal.throwIfAborted();
    if (!(await input.isCurrent())) return { complete: false };
    const page = await collection.query({
      index: GITHUB_AUTOMATION_EVENT_CHECKPOINT_INDEX_ID.byAutomationEventSource,
      order: 'asc',
      limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: input.context.signal });
    input.context.signal.throwIfAborted();
    const candidatesByKey = new Map<string, Readonly<{
      row: StoredCheckpointRowV1;
      candidate: AutomationEventCheckpointRetirementCandidateV1;
    }>>();
    for (const row of page.rows) {
      const candidate = checkpointRetirementCandidateForServerClassification({
        row,
        knownCurrentCheckpointsByRowId: input.catalog.knownCurrentCheckpointsByRowId,
      });
      if (candidate !== null) {
        candidatesByKey.set(checkpointRetirementCandidateKey(candidate), Object.freeze({ row, candidate }));
      }
    }
    if (candidatesByKey.size > 0) {
      const result = await input.context.services.actions.execute('automation.event.sources.list', {
        transport: { kind: 'checkpointedPull' },
        knownRevision: input.catalog.revision,
        checkpointRetirementCandidates: [...candidatesByKey.values()].map(({ candidate }) => candidate),
      }, { signal: input.context.signal });
      input.context.signal.throwIfAborted();
      if (
        result.kind !== 'unchanged'
        || result.revision !== input.catalog.revision
        || result.checkpointRetirements === undefined
      ) return Object.freeze({ complete: false });
      const retirementKeys = result.checkpointRetirements.map(checkpointRetirementCandidateKey);
      if (retirementKeys.some((key) => !candidatesByKey.has(key))) {
        return Object.freeze({ complete: false });
      }
      for (const key of retirementKeys) {
        if (!(await input.isCurrent())) return { complete: false };
        const candidate = candidatesByKey.get(key);
        if (candidate === undefined) return Object.freeze({ complete: false });
        try {
          await collection.delete(candidate.row.rowId, {
            expectedRevision: candidate.row.revision,
            signal: input.context.signal,
          });
        } catch (error) {
          input.context.signal.throwIfAborted();
          // A source attempt or another observer may have won this row. Its
          // next ordinary source scan will decide whether any successor remains
          // stale; this path never turns CAS loss into deletion authority.
          if (isCollectionCurrentnessConflict(error)) {
            complete = false;
            continue;
          }
          throw error;
        }
        input.context.signal.throwIfAborted();
      }
    }
    if (page.nextCursor === undefined) return Object.freeze({ complete });
    cursor = page.nextCursor;
  }
}

/**
 * Replaces only a persisted pull history-gap marker after the Action boundary
 * has re-established the source's current host authorization. This is not an
 * observer recovery path: the observer remains blocked until an explicit
 * authenticated Action calls this owner.
 */
export async function replaceGithubAutomationEventHistoryGapWithBaseline(input: Readonly<{
  context: PluginInvocationContext;
  definition: GithubAutomationEventSourceDefinitionV1;
  /**
   * The Action's source-catalog owner captured this exact revision before
   * provider I/O. It must remain current before this owner can mutate the
   * checkpoint row.
   */
  isDefinitionCurrent: () => Promise<boolean>;
  now?: () => number;
}>): Promise<GithubAutomationEventHistoryGapBaselineResultV1> {
  if (input.context.plugin.id !== GITHUB_PLUGIN_ID) {
    throw new GithubRepositoryEventsSourceContractError('GitHub baseline Action ran under a different plugin identity');
  }
  input.context.signal.throwIfAborted();
  let source: GithubAutomationObservedSourceV1 | null;
  try {
    source = parseObservedSource(input.definition);
  } catch {
    return Object.freeze({ kind: 'stale' });
  }
  if (source === null) {
    return Object.freeze({ kind: 'stale' });
  }
  // Checks sources recover current state, not repository occurrence history.
  // The required credential-bound recovery Action therefore has no gap to reset.
  if (source.checks || source.deploymentReview) return Object.freeze({ kind: 'noHistoryGap' });
  const collection = requireGithubAccountStorage(input.context).collection(
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  );
  const row = await collection.get(checkpointRowId(source), { signal: input.context.signal });
  input.context.signal.throwIfAborted();
  if (row === null) {
    return Object.freeze({ kind: 'noHistoryGap' });
  }
  const checkpoint = loadCheckpoint({ row, source });
  if (!checkpoint.historyGap) {
    return Object.freeze({ kind: 'noHistoryGap' });
  }
  input.context.signal.throwIfAborted();
  if (!(await input.isDefinitionCurrent())) {
    input.context.signal.throwIfAborted();
    return Object.freeze({ kind: 'stale' });
  }
  input.context.signal.throwIfAborted();

  // A null cursor deliberately omits If-None-Match and establishes a new
  // current-head baseline. The old cursor is never resumed or deleted.
  const polled = await pollRepositoryEvents({
    context: input.context,
    source,
    cursor: null,
  });
  input.context.signal.throwIfAborted();
  if (polled.kind !== 'events') {
    throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events baseline was unexpectedly not modified');
  }
  const observedAtMs = readObserverNow(input.now ?? Date.now);
  const baseline = createGithubRepositoryEventsBaseline({
    observationStartsAtMs: observedAtMs,
    observedAtMs,
    events: polled.events,
    etag: polled.etag,
  });
  input.context.signal.throwIfAborted();
  if (!(await input.isDefinitionCurrent())) {
    input.context.signal.throwIfAborted();
    return Object.freeze({ kind: 'stale' });
  }
  input.context.signal.throwIfAborted();
  try {
    await collection.put(createCheckpointRow({
      source,
      cursor: baseline,
      lastContiguousOccurrenceId: null,
      baseline: { kind: 'currentHead', establishedAt: observedAtMs },
    }), { expectedRevision: checkpoint.row.revision, signal: input.context.signal });
  } catch (error) {
    input.context.signal.throwIfAborted();
    if (isCollectionCurrentnessConflict(error)) return Object.freeze({ kind: 'stale' });
    throw error;
  }
  input.context.signal.throwIfAborted();
  await reportSourceStatus({
    context: input.context,
    source,
    state: 'baselined',
    code: 'none',
    lastObservedAt: observedAtMs,
    lastDispositionAt: observedAtMs,
  });
  return Object.freeze({ kind: 'baselined' });
}

function readObserverNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('GitHub Automation observer requires a nonnegative safe clock');
  }
  return value;
}

function addDelay(now: number, delayMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + Math.max(0, delayMs));
}

function sourceStatus(input: Readonly<{
  definition: GithubObservedSourceDefinitionV1;
  state: AutomationEventSourceStatusStateV1;
  code: AutomationEventSourceStatusCodeV1;
  lastObservedAt?: number | null;
  lastDispositionAt?: number | null;
  nextRetryAt?: number | null;
  observedDelta?: number;
  admittedDelta?: number;
  skippedDelta?: number;
}>): AutomationEventSourceStatusInputV1 {
  return {
    kind: 'source',
    automationId: input.definition.automationId,
    triggerId: input.definition.triggerId,
    triggerRevision: input.definition.triggerRevision,
    eventRef: input.definition.eventRef,
    sourceSelectorId: input.definition.sourceSelectorId,
    state: input.state,
    code: input.code,
    lastObservedAt: input.lastObservedAt ?? null,
    lastDispositionAt: input.lastDispositionAt ?? null,
    nextRetryAt: input.nextRetryAt ?? null,
    observedDelta: input.observedDelta ?? 0,
    admittedDelta: input.admittedDelta ?? 0,
    skippedDelta: input.skippedDelta ?? 0,
  };
}

async function reportSourceStatus(input: Readonly<{
  context: BackgroundServiceContext | PluginInvocationContext;
  source: GithubAutomationObservedSourceV1;
  state: AutomationEventSourceStatusStateV1;
  code: AutomationEventSourceStatusCodeV1;
  lastObservedAt?: number | null;
  lastDispositionAt?: number | null;
  nextRetryAt?: number | null;
  observedDelta?: number;
  admittedDelta?: number;
  skippedDelta?: number;
}>): Promise<void> {
  input.context.signal.throwIfAborted();
  await input.context.services.actions.execute(
    'automation.event.source.status.report',
    sourceStatus({ ...input, definition: input.source.definition }),
    { signal: input.context.signal },
  );
  input.context.signal.throwIfAborted();
}


function sourceCandidates(
  definitions: readonly GithubAutomationEventSourceDefinitionV1[],
): readonly GithubAutomationObservedSourceCandidateV1[] {
  const candidates: GithubAutomationObservedSourceCandidateV1[] = [];
  for (const definition of definitions) {
    try {
      const source = parseObservedSource(definition);
      if (source !== null) candidates.push(Object.freeze({ kind: 'source', source }));
    } catch {
      // A same-event incompatible definition still needs a host-visible status,
      // while foreign Event contributions remain owned by their own provider.
      if (isGithubObservedDefinition(definition)) {
        candidates.push(Object.freeze({ kind: 'incompatible', definition }));
      }
    }
  }
  return Object.freeze(candidates);
}

function isGithubObservedDefinition(
  definition: GithubAutomationEventSourceDefinitionV1,
): definition is GithubObservedSourceDefinitionV1 {
  return definition.eventRef.pluginId === GITHUB_PLUGIN_ID
    && isGithubAutomationEventLocalId(definition.eventRef.localId)
    && (definition.observationTransport.kind === 'checkpointedPull'
      || (definition.observationTransport.kind === 'durablePush'
        && definition.eventRef.localId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.deploymentReview));
}

function knownCurrentCheckpointsByRowId(
  definitions: readonly GithubAutomationEventSourceDefinitionV1[],
): ReadonlyMap<string, GithubAutomationKnownCurrentCheckpointV1 | null> {
  const current = new Map<string, GithubAutomationKnownCurrentCheckpointV1 | null>();
  for (const definition of definitions) {
    let source: GithubAutomationObservedSourceV1 | null;
    try {
      source = parseObservedSource(definition);
    } catch {
      continue;
    }
    if (source === null) continue;
    const rowId = checkpointRowId(source);
    const next = Object.freeze({
      sourceInstanceId: definition.sourceInstanceId,
      sourceContractVersion: definition.sourceContractVersion,
    });
    const existing = current.get(rowId);
    if (existing === undefined) {
      current.set(rowId, next);
    } else if (
      existing !== null
      && (
        existing.sourceInstanceId !== next.sourceInstanceId
        || existing.sourceContractVersion !== next.sourceContractVersion
      )
    ) {
      // A duplicated source identity is not definite retention evidence, so
      // defer it to the catalog's server-side classifier.
      current.set(rowId, null);
    }
  }
  return current;
}


/**
 * The shared GitHub classifier answers what the provider said; this names that
 * answer in the Automation source-status vocabulary. A credential GitHub
 * rejected, a permission it withheld, and a resource it cannot reach are three
 * different repairs for the owner, and only the throttle arm carries a retry
 * instruction. Statuses GitHub did not decide return `null` so the caller keeps
 * its bounded transient backoff.
 */
function githubResponseSourceStatus(
  response: GithubApiResponseV1,
  now: number,
): SourceFailureStatusV1 | null {
  return githubFailureSourceStatus(classifyGithubResponseFailure(response, now), now);
}

function githubFailureSourceStatus(failure: GithubResponseFailureV1, now: number): SourceFailureStatusV1 | null {
  if (failure.class === 'rateLimit') {
    return Object.freeze({
      state: 'backingOff',
      code: 'rateLimited',
      // Preserve GitHub's absolute retry instant; the shared scheduler owns
      // segmenting waits beyond the JavaScript timer range.
      nextRetryAt: addDelay(
        now,
        failure.retryNotBeforeMs === undefined ? GITHUB_RATE_LIMIT_FALLBACK_MS : failure.retryNotBeforeMs - now,
      ),
    });
  }
  if (failure.class === 'authentication') {
    return Object.freeze({ state: 'attention', code: 'credentialRevoked', nextRetryAt: null });
  }
  if (failure.class === 'permission') {
    return Object.freeze({ state: 'attention', code: 'credentialMissing', nextRetryAt: null });
  }
  // A deleted, renamed, or unreadable repository and a rejected request shape
  // are both answers about the configured source, not about the credential.
  if (isGithubInaccessibleResourceFailure(failure) || failure.class === 'unsupportedContract') {
    return Object.freeze({ state: 'attention', code: 'sourceContractIncompatible', nextRetryAt: null });
  }
  return null;
}

function failureStatus(error: unknown, now: number): SourceFailureStatusV1 {
  if (error instanceof GithubRepositoryEventsSourceContractError) {
    return Object.freeze({ state: 'attention', code: 'sourceContractIncompatible', nextRetryAt: null });
  }
  if (error instanceof GithubRepositoryEventsHistoryGapError) {
    return Object.freeze({ state: 'attention', code: 'historyGap', nextRetryAt: null });
  }
  if (error instanceof GithubCiReadError) {
    const status = githubFailureSourceStatus(error.failure, now);
    if (status !== null) return status;
  }
  if (error instanceof GithubRepositoryEventsResponseError) {
    const status = githubResponseSourceStatus(error.response, now);
    if (status !== null) return status;
  }
  return Object.freeze({ state: 'backingOff', code: 'admissionUnavailable', nextRetryAt: null });
}

/**
 * When the source may next be observed. A provider retry instruction wins; an
 * `attention` status is a repairable answer about the credential, permission,
 * repository, or configuration, so the source re-drives at the bounded
 * reconciliation cadence — an owner who repairs the cause is observed on the
 * next pass, and a definition-revision change still wakes it immediately
 * through its schedule key; everything else keeps the bounded transient retry
 * delay. No extra watcher or persisted attention state participates.
 */
function nextEligibleAfterStatus(input: Readonly<{
  status: SourceFailureStatusV1;
  statusAt: number;
  retryDelayMs: number;
  reconciliationIntervalMs: number;
}>): number {
  if (input.status.nextRetryAt !== null) return input.status.nextRetryAt;
  return addDelay(
    input.statusAt,
    input.status.state === 'attention' ? input.reconciliationIntervalMs : input.retryDelayMs,
  );
}


/** Exact per-trigger row/revision witness for the Account-bound target Action. */
function sourceAttemptKey(candidate: GithubAutomationObservedSourceCandidateV1): string {
  if (candidate.kind === 'source') {
    return `${checkpointRowId(candidate.source)}:${candidate.source.definition.triggerRevision}`;
  }
  return JSON.stringify([
    'incompatible',
    candidate.definition.automationId,
    candidate.definition.triggerId,
    candidate.definition.triggerRevision,
    candidate.definition.eventRef.pluginId,
    candidate.definition.eventRef.localId,
    candidate.definition.sourceSelectorId,
  ]);
}

function sourceCycleResult(sourceKey: string, nextEligibleAt: number | null): GithubAutomationSourceCycleResultV1 {
  return Object.freeze({ sourceKey, nextEligibleAt });
}

/** Endpoint readiness belongs to the Home, never to a retained plugin flag. */
async function hasVerifiedDeploymentWebhookRoute(source: GithubAutomationObservedSourceV1, context: PluginInvocationContext): Promise<boolean> {
  const webhookEndpointId = source.definition.observationTransport.kind === 'durablePush'
    ? source.definition.observationTransport.webhookEndpointId : undefined;
  if (webhookEndpointId === undefined) return false;
  try {
    const endpoint = await context.services.actions.execute('plugin.webhook.endpoint.checkCorrespondence', {
      webhookEndpointId,
      webhookContribution: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-events' },
      targetMaterialization: source.materializationRef,
      sourceInstanceId: source.definition.sourceInstanceId,
      setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
    }, { signal: context.signal });
    context.signal.throwIfAborted();
    if (isPluginActionApprovalRequestCreated(endpoint)) return false;
    if (endpoint.kind !== 'ready') return false;
    // Preserve every exact binding check on the observed nonsecret facts.
    // Older correspondence results have no such observations and stay
    // unverified, so Automatic continues its existing polling path.
    const contribution = 'contribution' in endpoint && isRecord(endpoint.contribution) ? endpoint.contribution : null;
    const target = 'targetMaterialization' in endpoint && isRecord(endpoint.targetMaterialization) ? endpoint.targetMaterialization : null;
    return endpoint.webhookEndpointId === webhookEndpointId
      && 'readiness' in endpoint && endpoint.readiness === 'ready'
      && (!('revokedAt' in endpoint) || endpoint.revokedAt === undefined)
      && contribution !== null && contribution.pluginId === GITHUB_PLUGIN_ID && contribution.localId === 'github-events'
      && 'sourceInstanceId' in endpoint && endpoint.sourceInstanceId === source.definition.sourceInstanceId
      && target !== null && target.pluginId === source.materializationRef.pluginId
      && target.machineId === source.materializationRef.machineId
      && target.materializationId === source.materializationRef.materializationId;
  } catch (error) {
    context.signal.throwIfAborted();
    return false;
  }
}

function readDeploymentCheckpoint(source: GithubAutomationObservedSourceV1, row: StoredCheckpointRowV1 | null) {
  if (row && (row.rowId !== checkpointRowId(source) || !isGithubAutomationEventCheckpointRowV1(row.value)
    || row.value.payload.sourceInstanceId !== source.definition.sourceInstanceId
    || row.value.payload.sourceContractVersion !== source.definition.sourceContractVersion)) {
    throw new GithubRepositoryEventsSourceContractError('GitHub deployment checkpoint identity is incompatible');
  }
  const retained = row && isGithubAutomationEventCheckpointRowV1(row.value) ? row.value : null;
  const stored = retained ? GithubDeploymentMonitorCursorV1Schema.safeParse(retained.payload.cursor) : null;
  if (stored && !stored.success) throw new GithubRepositoryEventsSourceContractError('Deployment checkpoint cursor is incompatible');
  const priorCursor = stored?.success ? stored.data : null;
  const monitorCursor: GithubDeploymentMonitorCursorV1 | null = retained?.payload.lastEvaluatedTriggerRevision === source.definition.triggerRevision
    ? priorCursor : priorCursor === null ? null : { kind: 'deploymentReview', v: 1, pending: priorCursor.pending };
  return { retained, priorCursor, monitorCursor };
}

function readChecksCheckpoint(source: GithubAutomationObservedSourceV1, row: StoredCheckpointRowV1 | null) {
  if (row && (row.rowId !== checkpointRowId(source) || !isGithubAutomationEventCheckpointRowV1(row.value)
    || row.value.payload.sourceInstanceId !== source.definition.sourceInstanceId
    || row.value.payload.sourceContractVersion !== source.definition.sourceContractVersion)) {
    throw new GithubRepositoryEventsSourceContractError('GitHub checks checkpoint identity is incompatible');
  }
  const previous = row && isRecord(row.value.payload) && isRecord(row.value.payload.cursor) ? row.value.payload.cursor : null;
  if (row && (!previous || previous.kind !== 'pullRequestChecks' || previous.v !== 1)) {
    throw new GithubRepositoryEventsSourceContractError('GitHub checks checkpoint cursor is incompatible');
  }
  return previous;
}

type GithubGroupCheckpointReadV1 = Readonly<{
  source: GithubAutomationObservedSourceV1;
  checkpoint: Promise<StoredCheckpointRowV1 | null>;
}>;
type GithubGroupProviderCandidateV1 =
  | Readonly<{ kind: 'repository'; polled: GithubRepositoryEventsPollResultV1<GithubAutomationRepositoryEventObservationV1> }>
  | Readonly<{ kind: 'checks'; surface: Awaited<ReturnType<typeof readGithubPullRequestChecks>> }>
  | Readonly<{ kind: 'deployment'; candidate: GithubDeploymentReviewCandidateV1 }>;

/** Raw native facts for one finite Account-bound group, never a row's cursor decision. */
async function readGroupProviderCandidate(input: Readonly<{
  context: PluginInvocationContext;
  members: readonly GithubGroupCheckpointReadV1[];
  isCurrent(): Promise<boolean>;
  now: () => number;
  deliveredRunId?: string;
}>): Promise<GithubGroupProviderCandidateV1 | null> {
  const loaded = await Promise.allSettled(input.members.map(async member => ({
    source: member.source, row: await member.checkpoint,
  })));
  const eligible = loaded.flatMap(result => {
    if (result.status === 'rejected') return [];
    const member = result.value;
    try {
      if (member.source.deploymentReview) readDeploymentCheckpoint(member.source, member.row);
      else if (member.source.checks) readChecksCheckpoint(member.source, member.row);
      else if (member.row && loadCheckpoint({ source: member.source, row: member.row }).historyGap) return [];
      return [member];
    } catch {
      // Each row's normal path reports its own invalid retained checkpoint;
      // it cannot authorize a read or suppress an entitled sibling's read.
      return [];
    }
  });
  const first = eligible[0];
  if (!first) return null;
  input.context.signal.throwIfAborted();
  if (!(await input.isCurrent())) throw new GithubRepositoryEventsSourceContractError('GitHub source group is no longer current');
  const source = first.source;
  if (source.deploymentReview) return { kind: 'deployment', candidate: await readGithubDeploymentReviewCandidateV1({
    source: { v: 1, credentialRef: source.credentialRef, repository: source.repository, deploymentReview: source.deploymentReview },
    previousCursors: eligible.map(member => readDeploymentCheckpoint(member.source, member.row).monitorCursor),
    ...(input.deliveredRunId === undefined ? {} : { deliveredRunId: input.deliveredRunId }),
  }, input.context) };
  if (source.checks) {
    const client = await createGithubApiClient(input.context, source.credentialRef);
    return { kind: 'checks', surface: await readGithubPullRequestChecks({ route: source.repository, headSha: source.checks.headSha,
      observation: { pullRequestNumber: source.checks.pullRequestNumber, selection: source.checks.selection },
    }, { client, now: input.now, signal: input.context.signal }) };
  }
  const cursors = eligible.map(member => member.row ? loadCheckpoint({ source: member.source, row: member.row }).cursor : null);
  const cursor = cursors[0] ?? null;
  const agreed = cursor?.etag !== null && cursor?.etag !== undefined && cursors.every(value => value?.etag === cursor.etag);
  return { kind: 'repository', polled: await pollRepositoryEvents({ context: input.context, source, cursor: agreed ? cursor : null }) };
}

async function runObservedSource(input: Readonly<{
  // Source work runs only through the host target-Action attempt, which is
  // where its operation-scoped Account binding is active.
  context: PluginInvocationContext;
  source: GithubAutomationObservedSourceV1;
  sourceKey: string;
  now: () => number;
  defaultPollIntervalMs: number;
  retryDelayMs: number;
  reconciliationIntervalMs: number;
  manifest?: Pick<PluginManifest, 'contributes'>;
  isDefinitionCurrent: () => Promise<boolean>;
  deliveredRunId?: string;
  checkpoint: Promise<StoredCheckpointRowV1 | null>;
  readCandidate(): Promise<GithubGroupProviderCandidateV1 | null>;
}>): Promise<GithubAutomationSourceCycleResultV1> {
  const collection = requireGithubAccountStorage(input.context).collection(
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  );
  const rowId = checkpointRowId(input.source);
  let existing: LoadedCheckpointV1 | null = null;
  const persistHistoryGap = async (checkpoint: LoadedCheckpointV1): Promise<void> => {
    if (!(await input.isDefinitionCurrent())) return;
    await collection.put(createCheckpointRow({
      source: input.source,
      cursor: checkpoint.cursor,
      lastContiguousOccurrenceId: checkpoint.row.value.payload.lastContiguousOccurrenceId,
      baseline: checkpoint.row.value.payload.baseline,
      historyGap: true,
    }), { expectedRevision: checkpoint.row.revision, signal: input.context.signal });
    input.context.signal.throwIfAborted();
  };
  try {
    const row = await input.checkpoint;
    input.context.signal.throwIfAborted();
    if (!(await input.isDefinitionCurrent())) return sourceCycleResult(input.sourceKey, addDelay(readObserverNow(input.now), input.retryDelayMs));
    if (input.source.deploymentReview) {
      const source = input.source;
      const { retained, priorCursor, monitorCursor } = readDeploymentCheckpoint(source, row);
      if (!input.manifest) throw new GithubRepositoryEventsSourceContractError('Deployment review page is unavailable');
      let checkpointRevision: number | 'absent' = row?.revision ?? 'absent';
      let observationId = `${rowId}:${checkpointRevision}:${source.definition.triggerRevision}`;
      const pageAvailable = await publishGithubDeploymentReviewNoticesV1({ current: [], previous: [], manifest: input.manifest, observationId, isCurrent: input.isDefinitionCurrent }, input.context);
      if (pageAvailable.kind !== 'published') throw new GithubRepositoryEventsSourceContractError(pageAvailable.code);
      const previous = priorCursor?.pending ?? [];
      if (!(await input.isDefinitionCurrent())) return sourceCycleResult(input.sourceKey, addDelay(readObserverNow(input.now), input.retryDelayMs));
      const candidate = await input.readCandidate();
      if (candidate?.kind !== 'deployment') throw new GithubRepositoryEventsSourceContractError('Deployment candidate is unavailable');
      const observation = projectGithubDeploymentReviewCandidateV1({ previous: monitorCursor, candidate: candidate.candidate });
      const current = observation.cursor.pending;
      const observedAtMs = readObserverNow(input.now);
      let occurredAtMs = observedAtMs;
      let lastOccurrence = retained?.payload.lastContiguousOccurrenceId ?? null;
      const checkpointBase = {
        checkpointRowId: rowId, automationId: source.definition.automationId, triggerId: source.definition.triggerId,
        eventRef: source.definition.eventRef, sourceSelectorId: source.definition.sourceSelectorId,
        sourceInstanceId: source.definition.sourceInstanceId, sourceContractVersion: source.definition.sourceContractVersion,
        baseline: retained?.payload.baseline ?? { kind: 'currentHead' as const, establishedAt: observedAtMs },
        lastEvaluatedTriggerRevision: source.definition.triggerRevision,
        continuity: { kind: 'deploymentReview', v: 1, repositoryId: source.repository.repositoryId },
      };
      const priorObservation = priorCursor?.observation;
      const observations: PluginEventObservationV1[] = [];
      if (current !== previous) {
        const factsKey = createHash('sha256').update(JSON.stringify([
          source.definition.triggerRevision, current.map(value => JSON.stringify(value)).sort(),
        ])).digest('hex');
        if (priorObservation?.factsKey === factsKey) {
          observationId = priorObservation.id;
          occurredAtMs = priorObservation.occurredAtMs;
        } else {
          if (!(await input.isDefinitionCurrent())) return sourceCycleResult(input.sourceKey, addDelay(observedAtMs, input.retryDelayMs));
          // Persist only retry evidence, not a new pending-state authority. The
          // settled facts stay in `pending`; every retry still reads GitHub.
          const prepared = await collection.put(createGithubAutomationEventCheckpointRowV1({ ...checkpointBase,
            cursor: { ...priorCursor, kind: 'deploymentReview', v: 1, pending: previous,
              observation: { id: observationId, factsKey, occurredAtMs } }, lastContiguousOccurrenceId: lastOccurrence,
          }), { expectedRevision: checkpointRevision, signal: input.context.signal });
          checkpointRevision = prepared.revision;
        }
        const currentKeys = new Set(current.map(value => `${value.runId}/${value.attempt}/${value.environmentId}`));
        const changes = [
          ...current.filter(value => !previous.includes(value)).map(value => ({ ...value, resolved: false })),
          ...previous.filter(value => !currentKeys.has(`${value.runId}/${value.attempt}/${value.environmentId}`)).map(value => ({ ...value, resolved: true })),
        ];
        for (const deploymentReview of changes) {
          if (!(await input.isDefinitionCurrent())) return sourceCycleResult(input.sourceKey, addDelay(observedAtMs, input.retryDelayMs));
          // Observation-only enrollment has no execution occurrence or recipe.
          // Its consumed effect is this same notice publication below.
          if (source.definition.observationOnly !== undefined) continue;
          const occurrenceId = `github:deployment-review:${createHash('sha256').update(JSON.stringify([observationId, deploymentReview])).digest('hex')}`;
          const event = normalizeGithubAutomationEvent({ kind: 'deploymentReview', repository: { repositoryId: source.repository.repositoryId, nameWithOwner: source.repository.nameWithOwner }, deploymentReview });
          observations.push({ eventRef: source.definition.eventRef,
            sourceInstanceId: source.definition.sourceInstanceId, sourceContractVersion: source.definition.sourceContractVersion,
            occurrenceId, occurredAt: occurredAtMs, observationReceivedAt: observedAtMs, observedDelta: 1, payload: event.payload });
          lastOccurrence = occurrenceId;
        }
      }
      const manifest = input.manifest;
      const disposition = await processCheckpointedPluginEventAttemptV1({
        context: input.context, definitions: [input.source.definition], observations, complete: true, isCurrent: input.isDefinitionCurrent,
        save: async () => {
          const published = await publishGithubDeploymentReviewNoticesV1({ current, previous, manifest, observationId, isCurrent: input.isDefinitionCurrent }, input.context);
          if (published.kind !== 'published') throw new GithubRepositoryEventsAdmissionError(published.code);
          if (!(await input.isDefinitionCurrent())) throw new GithubRepositoryEventsAdmissionError('Deployment source changed before checkpoint');
          if (!retained || current !== previous || priorObservation !== undefined
            || observation.cursor.waitingPages !== priorCursor?.waitingPages
            || retained.payload.lastEvaluatedTriggerRevision !== source.definition.triggerRevision) {
            await collection.put(createGithubAutomationEventCheckpointRowV1({ ...checkpointBase,
              cursor: observation.cursor, lastContiguousOccurrenceId: lastOccurrence,
            }), { expectedRevision: checkpointRevision, signal: input.context.signal });
          }
        },
      });
      if (disposition.kind !== 'checkpointSafe') throw new GithubRepositoryEventsAdmissionError('Deployment event admission is unsettled');
      await reportSourceStatus({ context: input.context, source, state: 'observing', code: 'none', lastObservedAt: observedAtMs });
      return sourceCycleResult(input.sourceKey, input.deliveredRunId === undefined || source.definition.observationTransport.kind === 'checkpointedPull' ? addDelay(observedAtMs,
        Math.max(source.deploymentReview?.pollingIntervalMs ?? readGithubPollIntervalMs(observation.responseHeaders) ?? input.defaultPollIntervalMs,
          readGithubPollIntervalMs(observation.responseHeaders) ?? 0)) : null);
    }
    if (input.source.checks) {
      const source = input.source;
      const previous = readChecksCheckpoint(source, row);
      const candidate = await input.readCandidate();
      if (candidate?.kind !== 'checks') throw new GithubRepositoryEventsSourceContractError('Checks candidate is unavailable');
      const surface = candidate.surface;
      const { snapshot, evidenceKey, events } = projectGithubChecksSourceEvents({
        repositoryId: source.repository.repositoryId, nameWithOwner: source.repository.nameWithOwner,
      }, surface);
      const observedAtMs = readObserverNow(input.now);
      let lastOccurrence = row && isGithubAutomationEventCheckpointRowV1(row.value) ? row.value.payload.lastContiguousOccurrenceId : null;
      const changed = previous?.evidenceKey !== evidenceKey;
      const event = events.find((candidate) => candidate.eventRef.localId === source.definition.eventRef.localId);
      const observations: PluginEventObservationV1[] = row && changed && event ? [{
        eventRef: event.eventRef, sourceInstanceId: source.definition.sourceInstanceId,
        sourceContractVersion: source.definition.sourceContractVersion, occurrenceId: event.occurrenceId,
        occurredAt: observedAtMs, observationReceivedAt: observedAtMs, observedDelta: 1, payload: event.payload,
      }] : [];
      if (observations[0]) lastOccurrence = observations[0].occurrenceId;
      const checkpoint = createGithubAutomationEventCheckpointRowV1({
        checkpointRowId: rowId, automationId: source.definition.automationId, triggerId: source.definition.triggerId,
        eventRef: source.definition.eventRef, sourceSelectorId: source.definition.sourceSelectorId,
        sourceInstanceId: source.definition.sourceInstanceId, sourceContractVersion: source.definition.sourceContractVersion,
        cursor: { v: 1, kind: 'pullRequestChecks', snapshot, evidenceKey, observedAtMs }, lastContiguousOccurrenceId: lastOccurrence,
        baseline: row && isGithubAutomationEventCheckpointRowV1(row.value) ? row.value.payload.baseline : { kind: 'currentHead', establishedAt: observedAtMs },
        lastEvaluatedTriggerRevision: source.definition.triggerRevision,
        continuity: { v: 1, endpointKind: 'pullRequestChecks', repositoryId: source.repository.repositoryId },
      });
      const disposition = await processCheckpointedPluginEventAttemptV1({
        context: input.context, definitions: [input.source.definition], observations, complete: true, isCurrent: input.isDefinitionCurrent,
        save: async () => { await collection.put(checkpoint, { expectedRevision: row?.revision ?? 'absent', signal: input.context.signal }); },
      });
      if (disposition.kind !== 'checkpointSafe') return sourceCycleResult(input.sourceKey, addDelay(observedAtMs, input.retryDelayMs));
      input.context.signal.throwIfAborted();
      const failure = surface.checkRunsFailure ?? surface.commitStatusFailure;
      const status = failure ? githubFailureSourceStatus(failure, observedAtMs)
        ?? Object.freeze({ state: 'backingOff' as const, code: 'admissionUnavailable' as const, nextRetryAt: null }) : null;
      await reportSourceStatus({ context: input.context, source,
        state: snapshot.state === 'superseded' ? 'attention' : status?.state ?? (row ? 'observing' : 'baselined'),
        code: snapshot.state === 'superseded' ? 'sourceContractIncompatible' : status?.code ?? 'none',
        nextRetryAt: status?.nextRetryAt ?? null,
        lastObservedAt: observedAtMs, lastDispositionAt: observedAtMs,
      });
      return sourceCycleResult(input.sourceKey, status ? nextEligibleAfterStatus({ status, statusAt: observedAtMs,
        retryDelayMs: input.retryDelayMs, reconciliationIntervalMs: input.reconciliationIntervalMs,
      }) : addDelay(observedAtMs, input.defaultPollIntervalMs));
    }
    if (row !== null) existing = loadCheckpoint({ row, source: input.source });

    if (existing?.historyGap === true) {
      await reportSourceStatus({
        context: input.context,
        source: input.source,
        state: 'attention',
        code: 'historyGap',
      });
      return sourceCycleResult(
        input.sourceKey,
        addDelay(readObserverNow(input.now), input.defaultPollIntervalMs),
      );
    }

    const candidate = await input.readCandidate();
    if (candidate?.kind !== 'repository') throw new GithubRepositoryEventsSourceContractError('Repository candidate is unavailable');
    const polled = candidate.polled;
    input.context.signal.throwIfAborted();
    // The response completion is the provider receipt fact. Do not reuse the
    // cycle-start time when persisting a timeline continuity horizon.
    const observedAtMs = readObserverNow(input.now);
    const nextEligibleAt = addDelay(observedAtMs, polled.pollIntervalMs ?? input.defaultPollIntervalMs);

    if (existing === null) {
      if (polled.kind !== 'events') {
        throw new GithubRepositoryEventsHistoryGapError('GitHub repository Events baseline was unexpectedly not modified');
      }
      const baseline = createGithubRepositoryEventsBaseline({
        observationStartsAtMs: observedAtMs,
        observedAtMs,
        events: polled.events,
        etag: polled.etag,
      });
      const disposition = await processCheckpointedPluginEventAttemptV1({
        context: input.context, definitions: [input.source.definition], observations: [], complete: true, isCurrent: input.isDefinitionCurrent,
        save: async () => { await collection.put(createCheckpointRow({
          source: input.source, cursor: baseline, lastContiguousOccurrenceId: null,
          baseline: { kind: 'currentHead', establishedAt: observedAtMs },
        }), { expectedRevision: 'absent', signal: input.context.signal }); },
      });
      if (disposition.kind !== 'checkpointSafe') return sourceCycleResult(input.sourceKey, addDelay(observedAtMs, input.retryDelayMs));
      input.context.signal.throwIfAborted();
      await reportSourceStatus({
        context: input.context,
        source: input.source,
        state: 'baselined',
        code: 'none',
        lastObservedAt: observedAtMs,
        lastDispositionAt: observedAtMs,
      });
      return sourceCycleResult(input.sourceKey, nextEligibleAt);
    }

    if (polled.kind === 'notModified') {
      const checkpoint = reuseGithubRepositoryEventsCheckpointOnNotModified(existing.cursor, observedAtMs);
      // A 304 is still a completed observation. Its new continuity horizon
      // must be CAS-persisted even when no template field changed.
      const retained = existing;
      const disposition = await processCheckpointedPluginEventAttemptV1({
        context: input.context, definitions: [input.source.definition], observations: [], complete: true, isCurrent: input.isDefinitionCurrent,
        save: async () => { await collection.put(createCheckpointRow({
          source: input.source, cursor: checkpoint,
          lastContiguousOccurrenceId: retained.row.value.payload.lastContiguousOccurrenceId,
          baseline: retained.row.value.payload.baseline,
        }), { expectedRevision: retained.row.revision, signal: input.context.signal }); },
      });
      if (disposition.kind !== 'checkpointSafe') return sourceCycleResult(input.sourceKey, addDelay(observedAtMs, input.retryDelayMs));
      input.context.signal.throwIfAborted();
      await reportSourceStatus({
        context: input.context,
        source: input.source,
        state: 'observing',
        code: 'none',
        lastObservedAt: observedAtMs,
      });
      return sourceCycleResult(input.sourceKey, nextEligibleAt);
    }

    const classified = classifyGithubRepositoryEvents({
      cursor: existing.cursor,
      observedAtMs,
      etag: polled.etag,
      maxEntries: PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1,
      events: polled.events,
    });
    if (classified.kind === 'historyGap') {
      await persistHistoryGap(existing);
      await reportSourceStatus({
        context: input.context,
        source: input.source,
        state: 'attention',
        code: 'historyGap',
        lastObservedAt: observedAtMs,
      });
      return sourceCycleResult(input.sourceKey, nextEligibleAt);
    }

    const observations: PluginEventObservationV1[] = classified.observations
      .filter(observation => observation.eventRef.localId === input.source.definition.eventRef.localId)
      .map(observation => ({
        eventRef: observation.eventRef, sourceInstanceId: input.source.definition.sourceInstanceId,
        sourceContractVersion: input.source.definition.sourceContractVersion,
        occurrenceId: observation.occurrenceId, occurredAt: observation.occurredAtMs,
        observationReceivedAt: observedAtMs, observedDelta: 1, payload: observation.payload,
      }));
    const retained = existing;
    const disposition = await processCheckpointedPluginEventAttemptV1({
      context: input.context, definitions: [input.source.definition], observations, complete: true, isCurrent: input.isDefinitionCurrent,
      save: async () => { await collection.put(createCheckpointRow({
        source: input.source, cursor: classified.checkpoint,
        lastContiguousOccurrenceId: classified.observations.at(-1)?.occurrenceId ?? retained.row.value.payload.lastContiguousOccurrenceId,
        baseline: retained.row.value.payload.baseline,
      }), { expectedRevision: retained.row.revision, signal: input.context.signal }); },
    });
    if (disposition.kind !== 'checkpointSafe') return sourceCycleResult(input.sourceKey, addDelay(observedAtMs, input.retryDelayMs));
    await reportSourceStatus({
      context: input.context,
      source: input.source,
      state: 'observing',
      code: 'none',
      lastObservedAt: observedAtMs,
      lastDispositionAt: observedAtMs,
    });
    return sourceCycleResult(input.sourceKey, nextEligibleAt);
  } catch (error) {
    if (input.context.signal.aborted) throw error;
    // The durable webhook owner retries a failed exact-run read/publication;
    // do not settle it just because a polling attempt would back off.
    if (input.deliveredRunId !== undefined) throw error;
    let failure = error;
    if (input.source.deploymentReview && error instanceof RangeError) {
      failure = new GithubRepositoryEventsSourceContractError(error.message);
    }
    if (failure instanceof GithubRepositoryEventsHistoryGapError && existing !== null) {
      try {
        await persistHistoryGap(existing);
      } catch (persistError) {
        if (input.context.signal.aborted) throw persistError;
        failure = persistError;
      }
    }
    const statusAt = readObserverNow(input.now);
    const status = failureStatus(failure, statusAt);
    await reportSourceStatus({
      context: input.context,
      source: input.source,
      state: status.state,
      code: status.code,
      nextRetryAt: status.nextRetryAt,
    });
    return sourceCycleResult(input.sourceKey, nextEligibleAfterStatus({
      status,
      statusAt,
      retryDelayMs: input.retryDelayMs,
      reconciliationIntervalMs: input.reconciliationIntervalMs,
    }));
  }
}

async function runIncompatibleSource(input: Readonly<{
  context: BackgroundServiceContext;
  definition: GithubAutomationEventSourceDefinitionV1;
  sourceKey: string;
  now: () => number;
  retryDelayMs: number;
  reconciliationIntervalMs: number;
}>): Promise<GithubAutomationSourceCycleResultV1> {
  input.context.signal.throwIfAborted();
  await input.context.services.actions.execute('automation.event.source.status.report', {
    kind: 'source',
    automationId: input.definition.automationId,
    triggerId: input.definition.triggerId,
    triggerRevision: input.definition.triggerRevision,
    eventRef: input.definition.eventRef,
    sourceSelectorId: input.definition.sourceSelectorId,
    state: 'attention',
    code: 'sourceContractIncompatible',
    lastObservedAt: null,
    lastDispositionAt: null,
    nextRetryAt: null,
    observedDelta: 0,
    admittedDelta: 0,
    skippedDelta: 0,
  } satisfies AutomationEventSourceStatusInputV1, { signal: input.context.signal });
  input.context.signal.throwIfAborted();
  return sourceCycleResult(input.sourceKey, nextEligibleAfterStatus({
    status: { state: 'attention', code: 'sourceContractIncompatible', nextRetryAt: null },
    statusAt: readObserverNow(input.now),
    retryDelayMs: input.retryDelayMs,
    reconciliationIntervalMs: input.reconciliationIntervalMs,
  }));
}


function readGithubAutomationSourceCycleResult(
  value: unknown,
  expectedSourceKey: string,
): GithubAutomationSourceCycleResultV1 | null {
  if (!isRecord(value)
    || value.sourceKey !== expectedSourceKey
    || (value.nextEligibleAt !== null && (typeof value.nextEligibleAt !== 'number'
      || !Number.isSafeInteger(value.nextEligibleAt) || value.nextEligibleAt < 0))
  ) return null;
  return Object.freeze({
    sourceKey: expectedSourceKey,
    nextEligibleAt: value.nextEligibleAt,
  });
}

async function runGithubAutomationSourceAttempt(input: Readonly<{
  context: BackgroundServiceContext;
  sources: readonly GithubAutomationObservedSourceV1[];
  sourceKey: string;
  deliveredRunId?: string;
}>): Promise<GithubAutomationSourceCycleResultV1> {
  const source = input.sources[0];
  if (!source) throw new GithubRepositoryEventsSourceContractError('GitHub source group is empty');
  const result = await input.context.services.actions.execute(
    {
      pluginId: input.context.plugin.id,
      localId: GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
    },
    {
      definitions: input.sources.map(member => member.definition),
      ...(source.credentialRef === null ? { nativeService: GITHUB_CONNECTED_ACCOUNT_SERVICE }
        : { credentialRef: source.credentialRef }),
      ...(input.deliveredRunId === undefined ? {} : { deliveredRunId: input.deliveredRunId }),
    },
    { signal: input.context.signal },
  );
  const parsed = readGithubAutomationSourceCycleResult(result, input.sourceKey);
  if (!parsed) {
    throw new GithubRepositoryEventsSourceContractError(
      'GitHub Automation source attempt did not return its current source result',
    );
  }
  return parsed;
}


/**
 * GitHub supplies finite provider and cursor operations. The SDK owns the one
 * source-catalog, host-assignment, eligibility, cancellation and wake lifecycle.
 */
export function createGithubAutomationEventCheckpointedPullObserver(
  options: GithubAutomationEventCheckpointedPullObserverOptions = {},
): GithubAutomationEventCheckpointedPullObserver {
  const now = options.now ?? Date.now;
  const deploymentEvent = options.manifest?.contributes?.events?.find(event => event.id === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.deploymentReview);
  const deploymentAutomation = isRecord(deploymentEvent?.automation) ? deploymentEvent.automation : null;
  const deploymentSource = deploymentAutomation && isRecord(deploymentAutomation.source) ? deploymentAutomation.source : null;
  const transportKinds = Array.isArray(deploymentSource?.supportedObservationTransports)
    && deploymentSource.supportedObservationTransports.includes('durablePush')
    ? ['checkpointedPull', 'durablePush'] as const : ['checkpointedPull'] as const;
  const reconciliationIntervalMs = options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  type ActiveAttempt = Readonly<{
    sources: readonly GithubAutomationObservedSourceV1[];
    signal: AbortSignal;
    isCurrent(): Promise<boolean>;
  }>;
  const activeAttempts = new Map<string, ActiveAttempt>();
  type PendingDelivery = {
    wake: GithubDeploymentWebhookWakeV1;
    signal: AbortSignal;
    matched: boolean;
    failure?: Readonly<{ error: unknown }>;
  };
  // These are the authenticated ingress handler's live promises, not durable
  // delivery state. Ingress retains retry/settlement custody across retirement.
  const deliveries = new Set<PendingDelivery>();
  let wakeForDelivery: ((sourceInstanceId?: string) => Promise<void>) | undefined;

  const matchesDelivery = (source: GithubAutomationObservedSourceV1, wake: GithubDeploymentWebhookWakeV1): boolean =>
    source.definition.observationTransport.kind === 'durablePush'
    && source.deploymentReview !== undefined && source.deploymentReview.deliveryMode !== 'polling'
    && source.repository.repositoryId === wake.repositoryId
    && source.repository.nameWithOwner.toLowerCase() === wake.repositoryNameWithOwner.toLowerCase()
    && (wake.sourceInstanceId === source.definition.sourceInstanceId
      || wake.sourceInstanceId === `github:repository:${wake.repositoryId}`);

  const sourceAdapter: PluginCheckpointedEventSourceAdapterV1<GithubAutomationObservedSourceCandidateV1, never> = {
    decode(definition) { return sourceCandidates([definition])[0] ?? null; },
    async observe(input) {
      let nextEligibleAt: number | null = null;
      const candidates = sourceCandidates(input.definitions);
      const sources = candidates.flatMap(candidate => candidate.kind === 'source' ? [candidate.source] : []);
      const runGroup = async () => {
        const pending = [...deliveries].filter(delivery => !delivery.matched && !delivery.failure
          && sources.some(source => matchesDelivery(source, delivery.wake)));
        const run = async (delivery?: PendingDelivery) => {
          const members = sources;
          const sourceKey = sourceAttemptKey({ kind: 'source', source: members[0]! });
          const signal = delivery ? AbortSignal.any([input.context.signal, delivery.signal]) : input.context.signal;
          const attempt: ActiveAttempt = { sources: members, signal, isCurrent: input.isCurrent };
          for (const source of members) activeAttempts.set(sourceAttemptKey({ kind: 'source', source }), attempt);
          try {
            const result = await runGithubAutomationSourceAttempt({
              context: { ...input.context, signal }, sources: members, sourceKey,
              ...(delivery ? { deliveredRunId: delivery.wake.runId } : {}),
            });
            if (delivery) delivery.matched = true;
            return result;
          } catch (error) {
            if (delivery) delivery.failure = { error };
            throw error;
          } finally {
            for (const source of members) {
              const key = sourceAttemptKey({ kind: 'source', source });
              if (activeAttempts.get(key) === attempt) activeAttempts.delete(key);
            }
          }
        };
        if (pending.length === 0) return await run();
        let latest: PromiseSettledResult<GithubAutomationSourceCycleResultV1> | undefined;
        for (const delivery of pending) {
          try { latest = { status: 'fulfilled', value: await run(delivery) }; }
          catch (error) { input.context.signal.throwIfAborted(); latest = { status: 'rejected', reason: error }; }
        }
        // Every ingress promise keeps its own outcome. Scheduling follows the
        // latest actual observation; the native Account client retains hard
        // provider retry deadlines independently of this normal eligibility.
        if (latest?.status === 'rejected') throw latest.reason;
        return latest?.value ?? null;
      };
      const attempts = await Promise.allSettled([
        ...candidates.flatMap(candidate => candidate.kind !== 'incompatible' ? [] : [runIncompatibleSource({
          context: input.context, definition: candidate.definition, sourceKey: sourceAttemptKey(candidate), now, retryDelayMs, reconciliationIntervalMs,
        })]),
        ...(sources.length === 0 ? [] : [runGroup()]),
      ]);
      for (const attempt of attempts) {
        if (attempt.status === 'rejected') throw attempt.reason;
        const result = attempt.value;
        if (result?.nextEligibleAt !== null && result?.nextEligibleAt !== undefined) {
          nextEligibleAt = nextEligibleAt === null ? result.nextEligibleAt : Math.min(nextEligibleAt, result.nextEligibleAt);
        }
      }
      // Admission and CAS run through the same finite SDK processor inside the
      // target Action, where the host's Account binding remains in scope.
      return { observations: [], complete: false, nextEligibleAt };
    },
    async save() {
      throw new GithubRepositoryEventsSourceContractError('GitHub checkpoints require their Account-bound target Action');
    },
    async retire(input) {
      if (!(await input.isCurrent())) return { complete: false };
      return await reconcileCheckpointRows({ context: input.context, isCurrent: input.isCurrent, catalog: {
        revision: input.revision,
        knownCurrentCheckpointsByRowId: knownCurrentCheckpointsByRowId(input.definitions),
      } });
    },
    retryAt({ error, now: statusAt }) {
      const status = failureStatus(error, statusAt);
      return nextEligibleAfterStatus({ status, statusAt, retryDelayMs, reconciliationIntervalMs });
    },
    subscribeWake(wake) {
      wakeForDelivery = wake;
      return { dispose() { wakeForDelivery = undefined; } };
    },
  };

  const runSourceAttempt = async (input: unknown, context: PluginInvocationContext): Promise<JsonValue> => {
    if (context.plugin.id !== GITHUB_PLUGIN_ID || !isRecord(input)) {
      throw new GithubRepositoryEventsSourceContractError('GitHub source attempt input is incompatible');
    }
    context.signal.throwIfAborted();
    if (!Array.isArray(input.definitions) || input.definitions.length === 0) {
      throw new GithubRepositoryEventsSourceContractError('GitHub source group is empty');
    }
    const definitions: readonly unknown[] = input.definitions;
    // The catalog decoder already validated these typed witnesses. Raw Action
    // input gains no source authority until every member matches that same
    // active group exactly; never assert untrusted input into the source type.
    const attempt = [...activeAttempts.values()].find(current => current.sources.some(member =>
      JSON.stringify(member.definition) === JSON.stringify(definitions[0])));
    if (!attempt) throw new GithubRepositoryEventsSourceContractError('GitHub source group is not active');
    const members = definitions.map(value => {
      const member = attempt.sources.find(current => JSON.stringify(current.definition) === JSON.stringify(value));
      if (!member) throw new GithubRepositoryEventsSourceContractError('GitHub source group member is not active');
      return member;
    });
    const source = members[0]!;
    const credentialRef = isGithubConnectedAccountRef(input.credentialRef) && input.nativeService === undefined
      ? input.credentialRef
      : input.credentialRef === undefined && isRecord(input.nativeService)
        && input.nativeService.pluginId === GITHUB_CONNECTED_ACCOUNT_SERVICE.pluginId
        && input.nativeService.localId === GITHUB_CONNECTED_ACCOUNT_SERVICE.localId ? null : undefined;
    if (credentialRef === undefined || members.some(member => credentialRequestKey(member.credentialRef) !== credentialRequestKey(credentialRef))) {
      throw new GithubRepositoryEventsSourceContractError('GitHub source attempt credential does not match its definition');
    }
    const caller = context.caller;
    if (caller?.kind !== 'plugin' || caller.pluginId !== GITHUB_PLUGIN_ID
      || caller.contribution.id !== GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID
      || caller.contribution.qualifiedId !== `${GITHUB_PLUGIN_ID}/backgroundServices/${GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID}`
      || caller.originSurface !== 'background' || !caller.materialization
      || members.some(member => materializationRequestKey(caller.materialization!) !== member.daemonMaterializationRef)) {
      throw new GithubRepositoryEventsSourceContractError('GitHub source attempt did not come from its current observer materialization');
    }
    const sourceKey = sourceAttemptKey({ kind: 'source', source });
    const providerKey = (member: GithubAutomationObservedSourceV1) => JSON.stringify([
      member.definition.sourceInstanceId, member.definition.sourceContractVersion,
      member.repository, member.checks ?? null, member.deploymentReview ?? null,
    ]);
    if (members.length !== attempt.sources.length
      || new Set(members.map(member => sourceAttemptKey({ kind: 'source', source: member }))).size !== members.length
      || members.some(member => providerKey(member) !== providerKey(source)
        || activeAttempts.get(sourceAttemptKey({ kind: 'source', source: member })) !== attempt
        || !attempt.sources.some(current => JSON.stringify(current.definition) === JSON.stringify(member.definition)))
      || !(await attempt.isCurrent())) {
      throw new GithubRepositoryEventsSourceContractError('GitHub source attempt is not part of the current observer cycle');
    }
    const actionContext = { ...context, signal: AbortSignal.any([context.signal, attempt.signal]) };
    const deliveredRunId = input.deliveredRunId === undefined ? undefined : readGithubPositiveDecimal(input.deliveredRunId, 'run ID');
    if (deliveredRunId !== undefined) {
      let verifiedWake = false;
      for (const member of members) {
        if (!member.deploymentReview || member.deploymentReview.deliveryMode === 'polling') {
          throw new GithubRepositoryEventsSourceContractError('Deployment webhook route is unavailable');
        }
        if (member.definition.observationTransport.kind === 'durablePush'
          && await hasVerifiedDeploymentWebhookRoute(member, actionContext)) verifiedWake = true;
      }
      if (!verifiedWake) throw new GithubRepositoryEventsSourceContractError('Deployment webhook route is unavailable');
    }
    const observing: GithubAutomationObservedSourceV1[] = [];
    for (const member of members) {
      if (deliveredRunId === undefined && member.deploymentReview) {
        const mode = member.deploymentReview.deliveryMode ?? 'automatic';
        const webhookReady = mode !== 'polling' && await hasVerifiedDeploymentWebhookRoute(member, actionContext);
        if (webhookReady || mode === 'webhook') {
          await reportSourceStatus({ context: actionContext, source: member, state: webhookReady ? 'observing' : 'attention',
            code: webhookReady ? 'none' : 'sourceContractIncompatible', lastObservedAt: null });
          continue;
        }
      }
      observing.push(member);
    }
    actionContext.signal.throwIfAborted();
    if (!(await attempt.isCurrent())) throw new GithubRepositoryEventsSourceContractError('GitHub source group is no longer current');
    if (observing.length === 0) return { sourceKey, nextEligibleAt: null };
    // All selectors, revisions, assignment and the common credential principal
    // were admitted above. One operation binding remains alive through every
    // native read, per-row processor and CAS; no sibling borrows retired services.
    const collection = requireGithubAccountStorage(actionContext).collection(GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION);
    const checkpointReads: GithubGroupCheckpointReadV1[] = observing.map(member => ({ source: member,
      checkpoint: collection.get(checkpointRowId(member), { signal: actionContext.signal }),
    }));
    let candidate: Promise<GithubGroupProviderCandidateV1 | null> | undefined;
    const readCandidate = () => candidate ??= readGroupProviderCandidate({ context: actionContext, members: checkpointReads,
      now, isCurrent: attempt.isCurrent, ...(deliveredRunId === undefined ? {} : { deliveredRunId }),
    });
    const results = await Promise.allSettled(checkpointReads.map(member => runObservedSource({
      context: actionContext, source: member.source, sourceKey: sourceAttemptKey({ kind: 'source', source: member.source }), now,
      defaultPollIntervalMs: DEFAULT_SOURCE_POLL_INTERVAL_MS, retryDelayMs, reconciliationIntervalMs,
      manifest: options.manifest, ...(deliveredRunId === undefined ? {} : { deliveredRunId }),
      isDefinitionCurrent: attempt.isCurrent, checkpoint: member.checkpoint, readCandidate,
    })));
    let nextEligibleAt: number | null = null;
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      const next = result.value.nextEligibleAt;
      if (next !== null) nextEligibleAt = nextEligibleAt === null ? next : Math.min(nextEligibleAt, next);
    }
    actionContext.signal.throwIfAborted();
    return { sourceKey, nextEligibleAt };
  };

  const run = async (context: BackgroundServiceContext, mode: 'once' | 'continuous'): Promise<void> => {
    if (context.plugin.id !== GITHUB_PLUGIN_ID) throw new GithubRepositoryEventsSourceContractError('GitHub observer ran under a different plugin identity');
    await runCheckpointedPluginEventObserverV1({ context, source: sourceAdapter, mode, now,
      transportKinds,
      ...(options.sleep ? { sleep: options.sleep } : {}) });
  };
  return Object.freeze({
    async receiveDeploymentWebhook(wake: GithubDeploymentWebhookWakeV1, signal: AbortSignal): Promise<'accepted' | 'ignored'> {
      signal.throwIfAborted();
      const notify = wakeForDelivery;
      if (!notify) throw new GithubRepositoryEventsSourceContractError('Deployment observer is unavailable');
      const delivery: PendingDelivery = { wake, signal, matched: false };
      deliveries.add(delivery);
      try {
        await notify(`github:repository:${wake.repositoryId}:deployment-review`);
        signal.throwIfAborted();
        if (delivery.failure) throw delivery.failure.error;
        return delivery.matched ? 'accepted' : 'ignored';
      } finally {
        deliveries.delete(delivery);
      }
    },
    async run(context: BackgroundServiceContext): Promise<void> { await run(context, 'continuous'); },
    async runCycle(context: BackgroundServiceContext): Promise<void> { await run(context, 'once'); },
    runSourceAttempt,
  });
}
