import { isPluginError, PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginEventAutomationHistoryGapResetActionResultV1 } from '@happier-dev/plugin-sdk/events';
import {
  PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1,
  PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
  type PluginCollectionRow,
} from '@happier-dev/plugin-sdk/collections';
import { parseForgeLinkHeader } from '@happier-dev/triage-sources/runtime';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import {
  isGithubAutomationEventLocalId,
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
  readGithubRateLimitRetryAfterMs,
  type GithubApiResponseV1,
} from './githubApiClient.js';
import {
  GITHUB_API_ORIGIN,
  GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
  GITHUB_PLUGIN_ID,
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
import { GithubObservationRequestCoalescer } from './githubRequestCoalescer.js';
import { requireGithubAccountStorage } from '../requiredAccountStorage.js';
import { githubAutomationAdmissionCounterDeltas } from './githubAutomationAdmissionAccounting.js';

const REPOSITORY_EVENTS_ENDPOINT_KIND = 'repositoryEvents' as const;
const REPOSITORY_EVENTS_PAGE_SIZE = 100;
const DEFAULT_SOURCE_POLL_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_RECONCILIATION_LATE_AFTER_MS = 60_000;
const MAX_CONCURRENT_SOURCES = 32;
const MAX_PROVIDER_WAIT_MS = 24 * 60 * 60 * 1_000;
type JsonRecord = Readonly<Record<string, unknown>>;
type AutomationEventSourcesListResultV1 = PluginActionResultById['automation.event.sources.list'];
export type GithubAutomationEventSourceDefinitionV1 = Extract<
  AutomationEventSourcesListResultV1,
  Readonly<{ kind: 'page' }>
>['definitions'][number];
type AutomationEventAdmitItemResultV1 = PluginActionResultById['automation.event.admit']['results'][number];
/**
 * The host Action owns what an admitted automation-event payload may be. This
 * observer names that contract instead of a second SDK JSON projection, so a
 * payload it mints can never drift out of what `automation.event.admit` takes.
 */
type AutomationEventSourceStatusReportV1 = PluginActionInputById['automation.event.source.status.report'];
type AutomationEventSourceStatusInputV1 = Extract<
  AutomationEventSourceStatusReportV1,
  Readonly<{ kind: 'source' }>
>;
type AutomationEventSourceStatusStateV1 = AutomationEventSourceStatusInputV1['state'];
type AutomationEventSourceStatusCodeV1 = AutomationEventSourceStatusInputV1['code'];
type AutomationEventCatalogStatusInputV1 = Extract<
  AutomationEventSourceStatusReportV1,
  Readonly<{ kind: 'catalogReconciliation' }>
>;
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
  definition: GithubCheckpointedPullSourceDefinitionV1;
  credentialRef: ConnectedAccountRef;
  repository: GithubRepositorySourceConfigV1;
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

type SourceFailureStatusV1 = Readonly<{
  state: AutomationEventSourceStatusStateV1;
  code: AutomationEventSourceStatusCodeV1;
  nextRetryAt: number | null;
}>;

type GithubAutomationAdoptedSourcesV1 = Readonly<{
  revision: string;
  candidates: readonly GithubAutomationObservedSourceCandidateV1[];
  knownCurrentCheckpointsByRowId: ReadonlyMap<string, GithubAutomationKnownCurrentCheckpointV1 | null>;
}>;

type GithubAutomationKnownCurrentCheckpointV1 = Readonly<{
  sourceInstanceId: string;
  sourceContractVersion: number;
}>;

type GithubAutomationSourceRefreshResultV1 = Readonly<{
  adopted: GithubAutomationAdoptedSourcesV1 | null;
  isCurrent: boolean;
}>;

type GithubAutomationReconciliationV1 = Readonly<{
  observedRevision: string;
  scanStartedAt: number;
}>;

type GithubAutomationSourceCycleResultV1 = Readonly<{
  sourceKey: string;
  nextEligibleAt: number;
}>;

type GithubAutomationObserverStateV1 = {
  adopted: GithubAutomationAdoptedSourcesV1 | null;
  reconciliation: GithubAutomationReconciliationV1 | null;
  /**
   * The adopted catalog revision whose checkpoint rows completed one
   * conflict-free reconciliation pass in this generation. Until that holds,
   * the revision is still reconciling: it is neither published as `current`
   * nor allowed to stop retrying. After it holds, an unchanged catalog has no
   * new retirement information, so the Account-wide scan does not repeat.
   */
  checkpointsReconciledRevision: string | null;
  nextEligibleAtBySource: Map<string, number>;
  nextFairSourceOffset: number;
};

export type GithubAutomationEventCheckpointedPullObserver = Readonly<{
  /** Runs the source-complete provider loop until the generation is aborted. */
  run(context: BackgroundServiceContext): Promise<void>;
  /** One caller-current source scan; preserved for focused owner tests. */
  runCycle(context: BackgroundServiceContext): Promise<void>;
  /** Host target-Action handler for one exact source credential attempt. */
  runSourceAttempt(input: unknown, context: PluginInvocationContext): Promise<JsonValue>;
}>;

export type GithubAutomationEventCheckpointedPullObserverOptions = Readonly<{
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  maxConcurrentSources?: number;
  reconciliationIntervalMs?: number;
  reconciliationLateAfterMs?: number;
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
  return Number.isSafeInteger(intervalMs) && intervalMs <= MAX_PROVIDER_WAIT_MS ? intervalMs : null;
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
  const next = parseForgeLinkHeader(readTriageResponseHeaderV1(headers, 'link')).next;
  return next === undefined ? null : validateRepositoryEventsPageUrl(next, repository);
}

function credentialRequestKey(credentialRef: ConnectedAccountRef): string {
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
  if (!isRecord(value)
    || Object.keys(value).some((key) => key !== 'v'
      && key !== 'endpointKind'
      && key !== 'repositoryId'
      && key !== 'historyGap')
    || value.v !== 1
    || value.endpointKind !== REPOSITORY_EVENTS_ENDPOINT_KIND
    || value.repositoryId !== repositoryId
    || (value.historyGap !== undefined && value.historyGap !== true)) return null;
  return Object.freeze({ historyGap: value.historyGap === true });
}

function parseGithubAutomationRepositoryEventSourceConfig(
  value: unknown,
): GithubAutomationRepositoryEventSourceConfigV1 {
  if (!isRecord(value) || value.v !== 1 || !isGithubConnectedAccountRef(value.credentialRef, GITHUB_PLUGIN_ID)) {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation source configuration is incompatible');
  }
  try {
    return Object.freeze({
      v: 1,
      credentialRef: value.credentialRef,
      repository: parseGithubRepositorySourceConfig(value.repository),
    });
  } catch {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation repository source configuration is incompatible');
  }
}

function parseObservedSource(
  definition: GithubAutomationEventSourceDefinitionV1,
): GithubAutomationObservedSourceV1 | null {
  if (!isGithubCheckpointedPullDefinition(definition)) return null;
  if (definition.sourceContractVersion !== GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION) {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation source contract version is incompatible');
  }
  const sourceConfig = parseGithubAutomationRepositoryEventSourceConfig(definition.sourceConfig);
  if (definition.sourceInstanceId !== `github:repository:${sourceConfig.repository.repositoryId}`) {
    throw new GithubRepositoryEventsSourceContractError('GitHub Automation source instance does not match its repository');
  }
  return Object.freeze({
    definition,
    credentialRef: sourceConfig.credentialRef,
    repository: sourceConfig.repository,
    daemonMaterializationRef: materializationRequestKey(
      definition.observationTransport.watcherMaterializationRef,
    ),
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
  coalescer: GithubObservationRequestCoalescer;
}>): Promise<GithubRepositoryEventsPollResultV1<GithubAutomationRepositoryEventObservationV1>> {
  const client = await createGithubApiClient(input.context, input.source.credentialRef);
  const initialUrl = createRepositoryEventsUrl(input.source.repository);
  let page = 0;
  return await pollGithubRepositoryEvents({
    initialUrl,
    etag: input.cursor?.etag ?? null,
    getPage: async ({ url, ifNoneMatch }) => {
      input.context.signal.throwIfAborted();
      page += 1;
      const validatedUrl = validateRepositoryEventsPageUrl(url, input.source.repository);
      const response = await input.coalescer.run({
        credentialRef: credentialRequestKey(input.source.credentialRef),
        repositoryId: input.source.repository.repositoryId,
        endpointKind: REPOSITORY_EVENTS_ENDPOINT_KIND,
        daemonMaterializationRef: input.source.daemonMaterializationRef,
        url: validatedUrl,
        page,
        etag: ifNoneMatch,
      }, async () => await client.request({
        url: validatedUrl,
        ...(ifNoneMatch === null ? {} : { headers: { 'If-None-Match': ifNoneMatch } }),
      })) as GithubApiResponseV1;
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
  adopted: GithubAutomationAdoptedSourcesV1;
}>): Promise<Readonly<{ complete: boolean }>> {
  const collection = requireGithubAccountStorage(input.context).collection(
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  );
  let cursor: string | undefined;
  let complete = true;
  while (true) {
    input.context.signal.throwIfAborted();
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
        knownCurrentCheckpointsByRowId: input.adopted.knownCurrentCheckpointsByRowId,
      });
      if (candidate !== null) {
        candidatesByKey.set(checkpointRetirementCandidateKey(candidate), Object.freeze({ row, candidate }));
      }
    }
    if (candidatesByKey.size > 0) {
      const result = await input.context.services.actions.execute('automation.event.sources.list', {
        transport: { kind: 'checkpointedPull' },
        knownRevision: input.adopted.revision,
        checkpointRetirementCandidates: [...candidatesByKey.values()].map(({ candidate }) => candidate),
      }, { signal: input.context.signal });
      input.context.signal.throwIfAborted();
      if (
        result.kind !== 'unchanged'
        || result.revision !== input.adopted.revision
        || result.checkpointRetirements === undefined
      ) return Object.freeze({ complete: false });
      const retirementKeys = result.checkpointRetirements.map(checkpointRetirementCandidateKey);
      if (retirementKeys.some((key) => !candidatesByKey.has(key))) {
        return Object.freeze({ complete: false });
      }
      for (const key of retirementKeys) {
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
    coalescer: new GithubObservationRequestCoalescer(),
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
  const boundedDelayMs = Math.min(Math.max(0, delayMs), MAX_PROVIDER_WAIT_MS);
  return Math.min(Number.MAX_SAFE_INTEGER, now + boundedDelayMs);
}

function sourceStatus(input: Readonly<{
  definition: GithubCheckpointedPullSourceDefinitionV1;
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

function catalogStatus(input: Readonly<{
  observedRevision: string;
  adoptedRevision: string | null;
  state: AutomationEventCatalogStatusInputV1['state'];
  scanStartedAt: number | null;
  nextRetryAt: number | null;
}>): AutomationEventCatalogStatusInputV1 {
  return {
    kind: 'catalogReconciliation',
    scope: { kind: 'checkpointedPull' },
    observedRevision: input.observedRevision,
    adoptedRevision: input.adoptedRevision,
    state: input.state,
    scanStartedAt: input.scanStartedAt,
    nextRetryAt: input.nextRetryAt,
  };
}

async function reportCatalogStatus(input: Readonly<{
  context: BackgroundServiceContext;
  observedRevision: string;
  adoptedRevision: string | null;
  state: AutomationEventCatalogStatusInputV1['state'];
  scanStartedAt: number | null;
  nextRetryAt: number | null;
}>): Promise<void> {
  input.context.signal.throwIfAborted();
  await input.context.services.actions.execute('automation.event.source.status.report', catalogStatus(input), {
    signal: input.context.signal,
  });
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
      if (isGithubCheckpointedPullDefinition(definition)) {
        candidates.push(Object.freeze({ kind: 'incompatible', definition }));
      }
    }
  }
  return Object.freeze(candidates);
}

function isGithubCheckpointedPullDefinition(
  definition: GithubAutomationEventSourceDefinitionV1,
): definition is GithubCheckpointedPullSourceDefinitionV1 {
  return definition.eventRef.pluginId === GITHUB_PLUGIN_ID
    && isGithubAutomationEventLocalId(definition.eventRef.localId)
    && definition.observationTransport.kind === 'checkpointedPull';
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

function beginReconciliation(input: Readonly<{
  state: GithubAutomationObserverStateV1;
  observedRevision: string;
  now: number;
}>): GithubAutomationReconciliationV1 {
  const current = input.state.reconciliation;
  if (current !== null && current.observedRevision === input.observedRevision) return current;
  const next = Object.freeze({ observedRevision: input.observedRevision, scanStartedAt: input.now });
  input.state.reconciliation = next;
  return next;
}

async function reportPendingReconciliation(input: Readonly<{
  context: BackgroundServiceContext;
  state: GithubAutomationObserverStateV1;
  observedRevision: string;
  now: number;
  reconciliationLateAfterMs: number;
  retryDelayMs: number;
}>): Promise<void> {
  const reconciliation = beginReconciliation({
    state: input.state,
    observedRevision: input.observedRevision,
    now: input.now,
  });
  const adoptedRevision = input.state.adopted?.revision ?? null;
  const state = input.now - reconciliation.scanStartedAt >= input.reconciliationLateAfterMs
    ? 'reconciliationLate'
    : 'reconciling';
  await reportCatalogStatus({
    context: input.context,
    observedRevision: reconciliation.observedRevision,
    adoptedRevision: adoptedRevision === reconciliation.observedRevision ? null : adoptedRevision,
    state,
    scanStartedAt: reconciliation.scanStartedAt,
    nextRetryAt: addDelay(input.now, input.retryDelayMs),
  });
}

async function reportCurrentCatalog(input: Readonly<{
  context: BackgroundServiceContext;
  state: GithubAutomationObserverStateV1;
  revision: string;
}>): Promise<void> {
  input.state.reconciliation = null;
  await reportCatalogStatus({
    context: input.context,
    observedRevision: input.revision,
    adoptedRevision: input.revision,
    state: 'current',
    scanStartedAt: null,
    nextRetryAt: null,
  });
}

/**
 * A revision-complete catalog is only `current` once its checkpoint rows have
 * reconciled. Reporting `current` first would let the product claim a healthy
 * pull source while a required retirement of stale or incompatible rows had
 * failed with nothing to expose it.
 */
async function reportAdoptedCatalog(input: Readonly<{
  context: BackgroundServiceContext;
  state: GithubAutomationObserverStateV1;
  revision: string;
  now: number;
  reconciliationLateAfterMs: number;
  retryDelayMs: number;
  alreadyReportedPending?: boolean;
}>): Promise<void> {
  if (input.state.checkpointsReconciledRevision === input.revision) {
    await reportCurrentCatalog({
      context: input.context,
      state: input.state,
      revision: input.revision,
    });
    return;
  }
  if (input.alreadyReportedPending === true) return;
  await reportPendingReconciliation({ ...input, observedRevision: input.revision });
}

function sourceRefreshResult(
  adopted: GithubAutomationAdoptedSourcesV1 | null,
  isCurrent: boolean,
): GithubAutomationSourceRefreshResultV1 {
  return Object.freeze({ adopted, isCurrent });
}

/**
 * Reads a complete revision-bound source set before replacing the retained
 * provider snapshot. The public projection is never admission authority;
 * `automation.event.admit` still resolves each tuple against the host's set.
 */
async function refreshCurrentSources(input: Readonly<{
  context: BackgroundServiceContext;
  state: GithubAutomationObserverStateV1;
  now: number;
  reconciliationLateAfterMs: number;
  retryDelayMs: number;
}>): Promise<GithubAutomationSourceRefreshResultV1> {
  const definitions: GithubAutomationEventSourceDefinitionV1[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let revision: string | null = null;
  let reportedPending = false;
  while (true) {
    input.context.signal.throwIfAborted();
    const result = await input.context.services.actions.execute('automation.event.sources.list', {
      transport: { kind: 'checkpointedPull' },
      ...(cursor === undefined && input.state.adopted !== null
        ? { knownRevision: input.state.adopted.revision }
        : cursor === undefined ? {} : { cursor }),
    }, { signal: input.context.signal });
    input.context.signal.throwIfAborted();
    if (result.kind === 'unchanged') {
      if (input.state.adopted !== null && input.state.adopted.revision === result.revision) {
        await reportAdoptedCatalog({ ...input, revision: result.revision });
        return sourceRefreshResult(input.state.adopted, true);
      }
      await reportPendingReconciliation({
        ...input,
        observedRevision: result.revision,
      });
      return sourceRefreshResult(input.state.adopted, false);
    }
    if (result.kind === 'cursorStale') {
      await reportPendingReconciliation({
        ...input,
        observedRevision: result.currentRevision,
      });
      return sourceRefreshResult(input.state.adopted, false);
    }
    if (revision !== null && revision !== result.revision) {
      await reportPendingReconciliation({
        ...input,
        observedRevision: result.revision,
      });
      return sourceRefreshResult(input.state.adopted, false);
    }
    revision ??= result.revision;
    if (result.nextCursor !== null && result.definitions.length === 0) {
      await reportPendingReconciliation({ ...input, observedRevision: revision });
      return sourceRefreshResult(input.state.adopted, false);
    }
    if (input.state.adopted === null || input.state.adopted.revision !== revision) {
      await reportPendingReconciliation({ ...input, observedRevision: revision });
      reportedPending = true;
    }
    definitions.push(...result.definitions);
    if (result.nextCursor === null) {
      const adopted = Object.freeze({
        revision,
        candidates: sourceCandidates(definitions),
        knownCurrentCheckpointsByRowId: knownCurrentCheckpointsByRowId(definitions),
      });
      input.state.adopted = adopted;
      if (input.state.checkpointsReconciledRevision !== revision) {
        input.state.checkpointsReconciledRevision = null;
      }
      await reportAdoptedCatalog({ ...input, revision, alreadyReportedPending: reportedPending });
      return sourceRefreshResult(adopted, true);
    }
    if (seenCursors.has(result.nextCursor)) {
      await reportPendingReconciliation({ ...input, observedRevision: revision });
      return sourceRefreshResult(input.state.adopted, false);
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
    // Yield and observe cancellation between pages rather than monopolizing
    // the background generation.
    await Promise.resolve();
    input.context.signal.throwIfAborted();
  }
}

function classifyUnsafeAdmission(result: AutomationEventAdmitItemResultV1): SourceFailureStatusV1 {
  if (result.kind === 'refreshDefinition') {
    return Object.freeze({ state: 'attention', code: 'definitionStale', nextRetryAt: null });
  }
  if (result.kind === 'blocked' && result.reason === 'capacity') {
    return Object.freeze({ state: 'backingOff', code: 'capacityBlocked', nextRetryAt: null });
  }
  return Object.freeze({ state: 'backingOff', code: 'admissionUnavailable', nextRetryAt: null });
}

function failureStatus(error: unknown, now: number): SourceFailureStatusV1 {
  if (error instanceof GithubRepositoryEventsSourceContractError) {
    return Object.freeze({ state: 'attention', code: 'sourceContractIncompatible', nextRetryAt: null });
  }
  if (error instanceof GithubRepositoryEventsHistoryGapError) {
    return Object.freeze({ state: 'attention', code: 'historyGap', nextRetryAt: null });
  }
  if (error instanceof GithubRepositoryEventsResponseError) {
    const retryAfterMs = readGithubRateLimitRetryAfterMs(error.response, now);
    if (retryAfterMs !== null) {
      return Object.freeze({
        state: 'backingOff',
        code: 'rateLimited',
        nextRetryAt: addDelay(now, retryAfterMs),
      });
    }
    if (error.response.status === 401 || error.response.status === 404) {
      return Object.freeze({ state: 'attention', code: 'credentialMissing', nextRetryAt: null });
    }
    if (error.response.status === 403) {
      return Object.freeze({ state: 'attention', code: 'credentialRevoked', nextRetryAt: null });
    }
  }
  return Object.freeze({ state: 'backingOff', code: 'admissionUnavailable', nextRetryAt: null });
}

function checkpointForSafeObservations(input: Readonly<{
  cursor: GithubRepositoryEventsCursorV1;
  observedAtMs: number;
  etag: string | null;
  events: readonly GithubRepositoryTimelineEntryV1<GithubAutomationRepositoryEventObservationV1>[];
  safeObservationCount: number;
  allObservationCount: number;
}>): GithubRepositoryEventsCursorV1 | null {
  if (input.safeObservationCount === input.allObservationCount) {
    const full = classifyGithubRepositoryEvents({
      cursor: input.cursor,
      observedAtMs: input.observedAtMs,
      etag: input.etag,
      maxEntries: PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1,
      events: input.events,
    });
    return full.kind === 'observations' ? full.checkpoint : null;
  }
  if (input.safeObservationCount === 0) return null;
  const prefix = classifyGithubRepositoryEvents({
    cursor: input.cursor,
    observedAtMs: input.observedAtMs,
    etag: input.etag,
    maxEntries: input.safeObservationCount,
    events: input.events,
  });
  return prefix.kind === 'observations' ? prefix.checkpoint : null;
}

function sourceScheduleKey(candidate: GithubAutomationObservedSourceCandidateV1): string {
  if (candidate.kind === 'source') return checkpointRowId(candidate.source);
  return JSON.stringify([
    'incompatible',
    candidate.definition.automationId,
    candidate.definition.triggerId,
    candidate.definition.eventRef.pluginId,
    candidate.definition.eventRef.localId,
    candidate.definition.sourceSelectorId,
  ]);
}

function sourceCycleResult(sourceKey: string, nextEligibleAt: number): GithubAutomationSourceCycleResultV1 {
  return Object.freeze({ sourceKey, nextEligibleAt });
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
  coalescer: GithubObservationRequestCoalescer;
}>): Promise<GithubAutomationSourceCycleResultV1> {
  const collection = requireGithubAccountStorage(input.context).collection(
    GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  );
  const rowId = checkpointRowId(input.source);
  let existing: LoadedCheckpointV1 | null = null;
  const persistHistoryGap = async (checkpoint: LoadedCheckpointV1): Promise<void> => {
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
    const row = await collection.get(rowId, { signal: input.context.signal });
    input.context.signal.throwIfAborted();
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

    const polled = await pollRepositoryEvents({
      context: input.context,
      source: input.source,
      cursor: existing?.cursor ?? null,
      coalescer: input.coalescer,
    });
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
      await collection.put(createCheckpointRow({
        source: input.source,
        cursor: baseline,
        lastContiguousOccurrenceId: null,
        baseline: { kind: 'currentHead', establishedAt: observedAtMs },
      }), { expectedRevision: 'absent', signal: input.context.signal });
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
      await collection.put(createCheckpointRow({
        source: input.source,
        cursor: checkpoint,
        lastContiguousOccurrenceId: existing.row.value.payload.lastContiguousOccurrenceId,
        baseline: existing.row.value.payload.baseline,
      }), { expectedRevision: existing.row.revision, signal: input.context.signal });
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

    let safeObservationCount = 0;
    let admittedDelta = 0;
    let skippedDelta = 0;
    const matchingObservedDelta = classified.observations.filter(
      (observation) => observation.eventRef.pluginId === input.source.definition.eventRef.pluginId
        && observation.eventRef.localId === input.source.definition.eventRef.localId,
    ).length;
    let lastContiguousOccurrenceId = existing.row.value.payload.lastContiguousOccurrenceId;
    let unsafe: SourceFailureStatusV1 | null = null;
    for (const observation of classified.observations) {
      input.context.signal.throwIfAborted();
      if (observation.eventRef.localId !== input.source.definition.eventRef.localId) {
        safeObservationCount += 1;
        lastContiguousOccurrenceId = observation.occurrenceId;
        continue;
      }
      const admitted = await input.context.services.actions.execute('automation.event.admit', {
        eventRef: observation.eventRef,
        occurrenceId: observation.occurrenceId,
        occurredAt: observation.occurredAtMs,
        observationReceivedAt: observedAtMs,
        payload: observation.payload,
        definitions: [{
          automationId: input.source.definition.automationId,
          triggerId: input.source.definition.triggerId,
          triggerRevision: input.source.definition.triggerRevision,
          sourceSelectorId: input.source.definition.sourceSelectorId,
        }],
      }, { signal: input.context.signal });
      input.context.signal.throwIfAborted();
      if (admitted.results.length !== 1) {
        throw new GithubRepositoryEventsAdmissionError('GitHub Automation admission did not settle one definition');
      }
      const outcome = admitted.results[0]!;
      if (!outcome.checkpointSafe) {
        unsafe = classifyUnsafeAdmission(outcome);
        break;
      }
      safeObservationCount += 1;
      lastContiguousOccurrenceId = observation.occurrenceId;
      const counterDeltas = githubAutomationAdmissionCounterDeltas(outcome);
      admittedDelta += counterDeltas.admittedDelta;
      skippedDelta += counterDeltas.skippedDelta;
    }

    const checkpoint = checkpointForSafeObservations({
      cursor: existing.cursor,
      observedAtMs,
      etag: polled.etag,
      events: polled.events,
      safeObservationCount,
      allObservationCount: classified.observations.length,
    });
    if (checkpoint !== null) {
      await collection.put(createCheckpointRow({
        source: input.source,
        cursor: checkpoint,
        lastContiguousOccurrenceId,
        baseline: existing.row.value.payload.baseline,
      }), { expectedRevision: existing.row.revision, signal: input.context.signal });
      input.context.signal.throwIfAborted();
    }

    await reportSourceStatus({
      context: input.context,
      source: input.source,
      state: unsafe?.state ?? 'observing',
      code: unsafe?.code ?? 'none',
      lastObservedAt: observedAtMs,
      lastDispositionAt: checkpoint === null ? null : observedAtMs,
      nextRetryAt: unsafe?.nextRetryAt ?? null,
      // Cursor safety requires traversing the shared repository timeline, but
      // source counters describe this semantic trigger rather than its sibling
      // GitHub Event kinds.
      observedDelta: matchingObservedDelta,
      admittedDelta,
      skippedDelta,
    });
    return sourceCycleResult(input.sourceKey, unsafe?.nextRetryAt ?? nextEligibleAt);
  } catch (error) {
    if (input.context.signal.aborted) throw error;
    let failure = error;
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
    return sourceCycleResult(input.sourceKey, status.nextRetryAt ?? addDelay(statusAt, input.retryDelayMs));
  }
}

async function runIncompatibleSource(input: Readonly<{
  context: BackgroundServiceContext;
  definition: GithubAutomationEventSourceDefinitionV1;
  sourceKey: string;
  now: () => number;
  retryDelayMs: number;
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
  return sourceCycleResult(input.sourceKey, addDelay(readObserverNow(input.now), input.retryDelayMs));
}

function rotateCandidatesFairly(input: Readonly<{
  state: GithubAutomationObserverStateV1;
  candidates: readonly GithubAutomationObservedSourceCandidateV1[];
}>): readonly GithubAutomationObservedSourceCandidateV1[] {
  if (input.candidates.length === 0) return input.candidates;
  const start = input.state.nextFairSourceOffset % input.candidates.length;
  input.state.nextFairSourceOffset = (start + 1) % input.candidates.length;
  return Object.freeze([...input.candidates.slice(start), ...input.candidates.slice(0, start)]);
}

async function runDueCandidates(input: Readonly<{
  context: BackgroundServiceContext;
  candidates: readonly GithubAutomationObservedSourceCandidateV1[];
  state: GithubAutomationObserverStateV1;
  now: () => number;
  defaultPollIntervalMs: number;
  retryDelayMs: number;
  maxConcurrentSources: number;
}>): Promise<readonly GithubAutomationSourceCycleResultV1[]> {
  const dueNow = readObserverNow(input.now);
  const candidates = rotateCandidatesFairly({ state: input.state, candidates: input.candidates })
    .filter((candidate) => (input.state.nextEligibleAtBySource.get(sourceScheduleKey(candidate)) ?? 0) <= dueNow);
  if (candidates.length === 0) return Object.freeze([]);

  const results: GithubAutomationSourceCycleResultV1[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      input.context.signal.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      if (candidate === undefined) return;
      const sourceKey = sourceScheduleKey(candidate);
      try {
        const result = candidate.kind === 'source'
          ? await runGithubAutomationSourceAttempt({
            context: input.context,
            source: candidate.source,
            sourceKey,
          })
          : await runIncompatibleSource({
            context: input.context,
            definition: candidate.definition,
            sourceKey,
            now: input.now,
            retryDelayMs: input.retryDelayMs,
          });
        results.push(result);
      } catch (error) {
        if (input.context.signal.aborted) throw error;
        results.push(sourceCycleResult(sourceKey, addDelay(readObserverNow(input.now), input.retryDelayMs)));
      }
    }
  };
  const workerCount = Math.min(input.maxConcurrentSources, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, async () => await worker()));
  return Object.freeze(results);
}

function readGithubAutomationSourceCycleResult(
  value: unknown,
  expectedSourceKey: string,
): GithubAutomationSourceCycleResultV1 | null {
  if (!isRecord(value)
    || value.sourceKey !== expectedSourceKey
    || typeof value.nextEligibleAt !== 'number'
    || !Number.isSafeInteger(value.nextEligibleAt)
    || value.nextEligibleAt < 0
  ) return null;
  return Object.freeze({
    sourceKey: expectedSourceKey,
    nextEligibleAt: value.nextEligibleAt,
  });
}

async function runGithubAutomationSourceAttempt(input: Readonly<{
  context: BackgroundServiceContext;
  source: GithubAutomationObservedSourceV1;
  sourceKey: string;
}>): Promise<GithubAutomationSourceCycleResultV1> {
  const result = await input.context.services.actions.execute(
    {
      pluginId: input.context.plugin.id,
      localId: GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
    },
    {
      definition: input.source.definition,
      credentialRef: input.source.credentialRef,
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

function nextCycleAt(input: Readonly<{
  state: GithubAutomationObserverStateV1;
  candidates: readonly GithubAutomationObservedSourceCandidateV1[];
  now: number;
  reconciliationIntervalMs: number;
}>): number {
  let next = addDelay(input.now, input.reconciliationIntervalMs);
  for (const candidate of input.candidates) {
    const eligibleAt = input.state.nextEligibleAtBySource.get(sourceScheduleKey(candidate));
    if (eligibleAt !== undefined && eligibleAt < next) next = eligibleAt;
  }
  return next;
}

function readPositiveOption(input: Readonly<{
  value: number | undefined;
  fallback: number;
  maximum: number;
  label: string;
}>): number {
  const value = input.value ?? input.fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > input.maximum) {
    throw new RangeError(`GitHub Automation observer ${input.label} must be a bounded positive safe integer`);
  }
  return value;
}

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Provider-local source slice only: host Actions own definition projection,
 * currentness, durable admission, and status; the provider owns the long-lived
 * authenticated Events loop and each Automation trigger's private checkpoint CAS.
 */
export function createGithubAutomationEventCheckpointedPullObserver(
  options: GithubAutomationEventCheckpointedPullObserverOptions = {},
): GithubAutomationEventCheckpointedPullObserver {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxConcurrentSources = readPositiveOption({
    value: options.maxConcurrentSources,
    fallback: 8,
    maximum: MAX_CONCURRENT_SOURCES,
    label: 'maxConcurrentSources',
  });
  const reconciliationIntervalMs = readPositiveOption({
    value: options.reconciliationIntervalMs,
    fallback: DEFAULT_RECONCILIATION_INTERVAL_MS,
    maximum: MAX_PROVIDER_WAIT_MS,
    label: 'reconciliationIntervalMs',
  });
  const reconciliationLateAfterMs = readPositiveOption({
    value: options.reconciliationLateAfterMs,
    fallback: DEFAULT_RECONCILIATION_LATE_AFTER_MS,
    maximum: MAX_PROVIDER_WAIT_MS,
    label: 'reconciliationLateAfterMs',
  });
  const retryDelayMs = readPositiveOption({
    value: options.retryDelayMs,
    fallback: DEFAULT_RETRY_DELAY_MS,
    maximum: MAX_PROVIDER_WAIT_MS,
    label: 'retryDelayMs',
  });
  const state: GithubAutomationObserverStateV1 = {
    adopted: null,
    reconciliation: null,
    checkpointsReconciledRevision: null,
    nextEligibleAtBySource: new Map<string, number>(),
    nextFairSourceOffset: 0,
  };
  let activeCycleCoalescer: GithubObservationRequestCoalescer | null = null;

  const runCycleInternal = async (context: BackgroundServiceContext): Promise<number> => {
    if (context.plugin.id !== GITHUB_PLUGIN_ID) {
      throw new GithubRepositoryEventsSourceContractError('GitHub observer ran under a different plugin identity');
    }
    context.signal.throwIfAborted();
    const cycleStartedAt = readObserverNow(now);
    let refreshed: GithubAutomationSourceRefreshResultV1;
    try {
      refreshed = await refreshCurrentSources({
        context,
        state,
        now: cycleStartedAt,
        reconciliationLateAfterMs,
        retryDelayMs,
      });
      if (
        refreshed.isCurrent
        && refreshed.adopted !== null
        && state.checkpointsReconciledRevision !== refreshed.adopted.revision
      ) {
        const reconciled = await reconcileCheckpointRows({ context, adopted: refreshed.adopted });
        if (reconciled.complete) {
          state.checkpointsReconciledRevision = refreshed.adopted.revision;
          await reportCurrentCatalog({
            context,
            state,
            revision: refreshed.adopted.revision,
          });
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      // Source-list/catalog-status Actions and the checkpoint Collection are
      // host boundaries. A transient failure must not terminate the provider
      // loop or discard its last fully adopted source snapshot.
      return addDelay(readObserverNow(now), retryDelayMs);
    }
    const adopted = refreshed.adopted;
    if (adopted === null) return addDelay(readObserverNow(now), retryDelayMs);

    const activeSourceKeys = new Set(adopted.candidates.map(sourceScheduleKey));
    for (const sourceKey of state.nextEligibleAtBySource.keys()) {
      if (!activeSourceKeys.has(sourceKey)) state.nextEligibleAtBySource.delete(sourceKey);
    }
    if (activeCycleCoalescer !== null) {
      throw new GithubRepositoryEventsSourceContractError(
        'GitHub observer cycles cannot overlap within one plugin generation',
      );
    }
    const cycleCoalescer = new GithubObservationRequestCoalescer();
    activeCycleCoalescer = cycleCoalescer;
    let results: readonly GithubAutomationSourceCycleResultV1[];
    try {
      results = await runDueCandidates({
        context,
        candidates: adopted.candidates,
        state,
        now,
        defaultPollIntervalMs: DEFAULT_SOURCE_POLL_INTERVAL_MS,
        retryDelayMs,
        maxConcurrentSources,
      });
    } finally {
      if (activeCycleCoalescer === cycleCoalescer) activeCycleCoalescer = null;
    }
    for (const result of results) state.nextEligibleAtBySource.set(result.sourceKey, result.nextEligibleAt);
    return nextCycleAt({
      state,
      candidates: adopted.candidates,
      now: readObserverNow(now),
      reconciliationIntervalMs,
    });
  };

  const runSourceAttempt = async (
    input: unknown,
    context: PluginInvocationContext,
  ): Promise<JsonValue> => {
    if (context.plugin.id !== GITHUB_PLUGIN_ID) {
      throw new GithubRepositoryEventsSourceContractError(
        'GitHub source attempt ran under a different plugin identity',
      );
    }
    context.signal.throwIfAborted();
    if (
      !isRecord(input)
      || !isGithubConnectedAccountRef(input.credentialRef)
    ) {
      throw new GithubRepositoryEventsSourceContractError(
        'GitHub source attempt input is incompatible',
      );
    }
    let source: GithubAutomationObservedSourceV1 | null;
    try {
      source = parseObservedSource(
        input.definition as GithubAutomationEventSourceDefinitionV1,
      );
    } catch {
      throw new GithubRepositoryEventsSourceContractError(
        'GitHub source attempt definition is incompatible',
      );
    }
    if (
      source === null
      || credentialRequestKey(source.credentialRef)
        !== credentialRequestKey(input.credentialRef)
    ) {
      throw new GithubRepositoryEventsSourceContractError(
        'GitHub source attempt credential does not match its definition',
      );
    }
    const caller = context.caller;
    if (
      caller?.kind !== 'plugin'
      || caller.pluginId !== GITHUB_PLUGIN_ID
      || caller.contribution.id !== GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID
      || caller.contribution.qualifiedId
        !== `${GITHUB_PLUGIN_ID}/backgroundServices/${GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID}`
      || caller.originSurface !== 'background'
    ) {
      throw new GithubRepositoryEventsSourceContractError(
        'GitHub source attempt did not come from its current observer materialization',
      );
    }
    if (materializationRequestKey(caller.materialization) !== source.daemonMaterializationRef) {
      throw new GithubRepositoryEventsSourceContractError(
        'GitHub source attempt did not come from its current observer materialization',
      );
    }
    const coalescer = activeCycleCoalescer;
    if (coalescer === null) {
      throw new GithubRepositoryEventsSourceContractError(
        'GitHub source attempt is not part of the current observer cycle',
      );
    }
    const result = await runObservedSource({
      context,
      source,
      sourceKey: sourceScheduleKey({ kind: 'source', source }),
      now,
      defaultPollIntervalMs: DEFAULT_SOURCE_POLL_INTERVAL_MS,
      retryDelayMs,
      // One source attempt owns one Automation trigger checkpoint. Identical
      // authenticated repository reads coalesce generation-locally and carry
      // no persisted checkpoint authority.
      coalescer,
    });
    return Object.freeze({
      sourceKey: result.sourceKey,
      nextEligibleAt: result.nextEligibleAt,
    }) satisfies JsonValue;
  };

  return Object.freeze({
    async run(context: BackgroundServiceContext): Promise<void> {
      while (!context.signal.aborted) {
        let wakeAt: number;
        try {
          wakeAt = await runCycleInternal(context);
        } catch (error) {
          if (context.signal.aborted) return;
          throw error;
        }
        if (context.signal.aborted) return;
        const delayMs = Math.min(
          MAX_PROVIDER_WAIT_MS,
          Math.max(1, wakeAt - readObserverNow(now)),
        );
        try {
          await sleep(delayMs, context.signal);
        } catch (error) {
          if (context.signal.aborted) return;
          throw error;
        }
      }
    },
    async runCycle(context: BackgroundServiceContext): Promise<void> {
      await runCycleInternal(context);
    },
    runSourceAttempt,
  });
}
