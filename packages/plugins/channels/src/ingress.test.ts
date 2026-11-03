import { GITHUB_CHANNEL_PULL_REQUESTS } from '../../scm-github/src/githubChannelContribution.js';
import { arePluginMachineExecutionOriginsEqual, definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { arePluginMachineExecutionRoutingsEqual, getPluginMachineExecutionRouting, type PluginMachineExecutionOriginV1, type PluginMachineExecutionRoutingV1 } from '@happier-dev/plugin-sdk/actions';
import type { SessionSendRequest, SessionSummary } from '@happier-dev/plugin-sdk/sessions';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type {
  JsonValue,
  PluginInvocationContext,
  PluginServices,
  TargetedContributionPointRef,
  TargetedContributionSnapshot,
  TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import {
  PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1,
  PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
  type PluginCollectionBatchMeasurement,
  type PluginCollectionLimits,
  type PluginCollectionMutation,
} from '@happier-dev/plugin-sdk/collections';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';
import type {
  ConversationProviderObservationIngestInputV1,
} from '@happier-dev/channels-protocol/v1';
import {
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  ConversationPairingCreateResultV1Schema,
  ConversationPairingFinalizeResultV1Schema,
  ConversationPairingResourceV1Schema,
  ConversationProviderObservationIngestInputV1JsonSchema,
  ConversationProviderObservationIngestInputV1Schema,
  ConversationBindingUpdateInputV1Schema,
  MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES,
  MAX_CONVERSATION_OBSERVATION_CLOCK_SKEW_MS,
  MAX_CONVERSATION_RECEIVE_WAIT_MS,
  SessionPullRequestLinksV1Schema,
  resolveSessionPullRequestLinksV1,
} from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { simpleParser } from 'mailparser';
import { createConversationAttachmentIdV1 } from '@happier-dev/channels-protocol/v1';

import {
  createIngressCensusValue,
  deriveIngressCensusRowId,
  acceptConversationStreamBaselineForInvocation,
  createConversationProviderObservationIngestHandler,
  ingestConversationProviderObservationForInvocation,
  hasConversationCheckpointedPullBaseline,
  partitionIngressPreparationValues,
  prepareConversationIngressObligationForBindingDeletion,
  prepareConversationIngressObligationForConnectionDeletion,
  runConversationCheckpointedPollForInvocation,
  runConversationIngressDueWorkForInvocation,
  runConversationIngressRetentionForInvocation,
  retryConversationIngressForInvocation,
  readConversationSessionInputReplyRelations,
  markConversationSessionInputRepliesProjected,
} from './ingress.js';
import {
  createConversationSessionProjectionCollectionStore,
  createConversationSessionProjectionFrontierRow,
} from './sessionProjection.js';
import {
  confirmConversationCheckpointedPollStopForInvocation,
  retryConversationConnectionPollForInvocation,
  updateConversationConnectionForInvocation,
  createConversationThreadBindingForInvocation,
  updateConversationBindingForInvocation,
  createConversationPairingManagementHandlers,
} from './management.js';
import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
} from './collections.js';
import { isChannelStateJsonRecord, readConversationConnectionUpdateRow, readConversationBindingUpdateRow, withConversationConnectionPayload } from './accountLocalBindingPolicy.js';
import { getConversationConnectionExecutionRouting, getConversationConnectionTransportOrigin, startConversationConnectionTransfer } from './connectionLifecycle.js';
import type { ConversationConnectionTransportOriginV1 } from './connectionLifecycle.js';
import { deliverTelegramMessage, pollTelegramObservations } from '../../channel-telegram/src/channelActions.js';
import { parseDiscordMessageDispatch } from '../../channel-discord/src/discordMessage.js';
import { mapDiscordMessageToSocketIngress } from '../../channel-discord/src/discordObservation.js';
import { createConversationPairingManager } from './pairing.js';
import { createConversationPairingResourceRuntime } from './pairingResource.js';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CHANNELS_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';
import { classifySupervisorFailure } from './supervisorFailure.js';
import { createIngressSupervisor } from './checkpointedPollSupervisor.js';
import { resourceText } from './testkit/resourceContract.js';

/**
 * Retained payloads are read back as opaque JSON here. These fixtures rebuild
 * typed lifecycle inputs from them, so require the exact field rather than
 * threading `unknown` into a typed fixture.
 */
function payloadNumber(payload: Readonly<Record<string, unknown>>, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number') {
    throw new Error(`Expected the retained connection payload to carry a numeric ${field}.`);
  }
  return value;
}

function sentUserTextRequest(
  request: SessionSendRequest | undefined,
): Extract<SessionSendRequest, Readonly<{ kind: 'userText' }>> {
  if (request?.kind !== 'userText') {
    throw new Error('Expected Channels ingress to send a user-text request.');
  }
  return request;
}

function pendingPermissionRequest(input: Readonly<{
  requestId: string;
  turnId: string;
  createdAtMs: number;
  allowedScopes: readonly ('request' | 'session')[];
}>) {
  return {
    kind: 'permission' as const,
    ...input,
    agentRequestSummary: {
      kind: 'permission' as const,
      toolLabel: 'Bash',
      title: 'Run a command',
      detail: 'Command: git',
    },
  };
}

function payloadTransportOrigin(
  payload: Readonly<Record<string, unknown>>,
): ConversationConnectionTransportOriginV1 {
  const value = payload.transportOrigin;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected the retained connection payload to carry a transport origin.');
  }
  return value as ConversationConnectionTransportOriginV1;
}

import {
  createCurrentConversationConnectionFixture,
  createCurrentConversationPendingOldTransportStopFixture,
  type ConversationConnectionFixtureAuthority,
  type CurrentConversationConnectionFixture,
} from './testkit/currentConnectionFixture.js';

import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
const telegramProviderPluginId = 'happier.channel.telegram';
const telegramPollAction = Object.freeze({
  identity: Object.freeze({
    target: Object.freeze({ pluginId: 'happier.channels' }),
    point: Object.freeze({
      pointId: 'providers',
      protocol: Object.freeze({ id: 'happier.channels/providers', version: 1 }),
    }),
    contributor: Object.freeze({
      pluginId: telegramProviderPluginId,
      contributionId: 'telegram-test-provider',
      immutableGenerationId: 'telegram-test-generation',
    }),
    role: 'observationsPoll',
  }),
});

const telegramAutomationEventAdmitAction = Object.freeze({
  identity: Object.freeze({
    target: Object.freeze({ pluginId: 'happier.channels' }),
    point: Object.freeze({
      pointId: 'providers',
      protocol: Object.freeze({ id: 'happier.channels/providers', version: 1 }),
    }),
    contributor: Object.freeze({
      pluginId: telegramProviderPluginId,
      contributionId: 'telegram-test-provider',
      immutableGenerationId: 'telegram-test-generation',
    }),
    role: 'automationEventAdmit',
  }),
});

const telegramExecutionOrigin = {
  serverIdentityId: 'srv_account_one',
  materializationRef: { machineId: 'machine-1', materializationId: 'telegram-install-1', pluginId: telegramProviderPluginId },
} as const;

const telegramConnectionAuthority = {
  providerPluginId: telegramProviderPluginId,
  providerContributionSelection: {
    contributionId: 'telegram-test-provider',
  },
  providerSetupInput: { source: 'test' },
  credentialRef: {
    service: { pluginId: telegramProviderPluginId, localId: 'telegram-bot' },
    accountId: 'telegram-account-1',
  },
  transportOrigin: {
    serverIdentityId: 'srv_account_one',
    machineId: 'machine-1',
  },
  providerConnectionKey: 'telegram-bot:12345',
  providerConfig: { botUsername: 'happier_bot' },
  routingIdentityKey: 'r'.repeat(43),
  integrationPrincipal: { id: 'telegram:bot:12345', label: 'Happier' },
  authorityEpoch: 4,
} as const satisfies ConversationConnectionFixtureAuthority;

const admittedTelegramProviderContribution = Object.freeze({
  // This transport fixture also supplies the native PR observations below.
  descriptor: { v: 1, displayName: 'Ingress fixture', pullRequests: GITHUB_CHANNEL_PULL_REQUESTS },
  contributor: {
    pluginId: telegramProviderPluginId,
    contributionId: 'telegram-test-provider',
    immutableGenerationId: 'telegram-test-generation',
  },
  protocol: { id: 'happier.channels/providers', version: 1 },
  operations: {
    observationsPoll: telegramPollAction,
    automationEventAdmit: telegramAutomationEventAdmitAction,
  },
});

/** The generic host has already admitted this provider contribution. */
function targetedTelegramPollContribution(
  readAdmittedContributions?: () => readonly unknown[],
): TargetedContributionsService {
  return Object.freeze({
    observeForSelf<TContribution>(
      _point: TargetedContributionPointRef<TContribution>,
      _options: Readonly<{ onInvalidated: () => void }>,
    ) {
      return Object.freeze({
        dispose() {},
        async readCurrent(): Promise<TargetedContributionSnapshot<TContribution>> {
          return {
            occurrenceId: 'channels-test-occurrence',
            sourceCustody: { kind: 'development', registeredRootId: 'channels-test-root' },
            contributions: (
              readAdmittedContributions?.() ?? [admittedTelegramProviderContribution]
            ) as unknown as readonly TContribution[],
          };
        },
      });
    },
  });
}

type StoredStateRow = Readonly<{
  rowId: string;
  revision: number;
  value: Readonly<Record<string, unknown>>;
  deleted?: boolean;
}>;

type CollectionMutation = PluginCollectionMutation<Readonly<Record<string, JsonValue>>>;

function stateRow(
  value: Readonly<Record<string, unknown>>,
  revision = 1,
  options?: Readonly<{ deleted?: boolean }>,
): StoredStateRow {
  const rowId = value.id;
  if (typeof rowId !== 'string') throw new Error('State rows require their canonical id.');
  return { rowId, revision, value, ...(options?.deleted === true ? { deleted: true } : {}) };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a persisted record.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function jsonStateRow(row: StoredStateRow | undefined) {
  if (row === undefined || !isChannelStateJsonRecord(row.value)) {
    throw new Error('Expected a host-validated Channel state row.');
  }
  return { rowId: row.rowId, revision: row.revision, value: row.value };
}

function channelConnection() {
  return createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: telegramConnectionAuthority,
    transport: { kind: 'checkpointedPull' },
    overlapSafety: 'providerExclusive',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: 4_096, unit: 'utf8Bytes' },
  });
}

function socketChannelConnection() {
  return createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: telegramConnectionAuthority,
    transport: { kind: 'socket' },
    overlapSafety: 'safe',
    replayContinuity: 'none',
    outboundTextLimit: { maximum: 4_096, unit: 'utf8Bytes' },
  });
}

function durablePushChannelConnection() {
  return createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: telegramConnectionAuthority,
    transport: {
      kind: 'durablePush',
      webhookContributionRef: {
        pluginId: telegramProviderPluginId,
        localId: 'account-endpoint-v1',
      },
      webhookEndpointId: 'webhook-endpoint-1',
      webhookSourceInstanceId: 'channels.connection.connection-1',
    },
    overlapSafety: 'safe',
    replayContinuity: 'none',
    outboundTextLimit: { maximum: 4_096, unit: 'utf8Bytes' },
  });
}

function channelBinding() {
  return {
    id: 'binding-1',
    'record-kind': 'binding',
    v: 1,
    'connection-id': 'connection-1',
    'binding-id': 'binding-1',
    'created-at': 1,
    'updated-at': 1,
    payload: {
      endpoint: {
        kind: 'direct',
        audience: 'direct',
        id: 'telegram:chat:100',
      },
      target: {
        kind: 'session',
        sessionId: 'session-1',
        policy: {
          deliveryMode: 'repliesOnly',
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' },
          newSession: { kind: 'off' },
        },
      },
      allowedPrincipalIds: ['telegram:user:42'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly',
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress',
      senderFeedback: 'off',
      authorityEpoch: 7,
      enabled: true,
      deletionState: 'none',
    },
  } as const;
}

/** The owner-selected pairing destination frozen by these challenges. */
const pairingDestinationEndpoint = {
  kind: 'direct',
  audience: 'direct',
  id: 'telegram:chat:100',
} as const;

function observation(input: Readonly<{
  messageRevision: string;
  messageId?: string;
  messageText?: string;
  actorLabel?: string;
  contentProvenance?: 'original' | 'forwarded' | 'viaBot';
  occurredAt?: number;
  providerTimestamp?: number;
  occurrenceId?: string;
  endpointId?: string;
  transport?: 'poll' | 'socket' | 'webhook';
}>): ConversationProviderObservationIngestInputV1 {
  const now = input.occurredAt ?? Date.now();
  return {
    connectionId: 'connection-1',
    ...(input.transport === 'socket' ? { authorityEpoch: 4 } : {}),
    entry: {
      observation: {
        kind: 'fullText',
        observation: {
          v: 1,
          occurrenceId: input.occurrenceId ?? 'telegram:update:9001',
          occurredAt: now,
          transport: { kind: input.transport ?? 'poll' },
          endpoint: {
            kind: 'direct',
            audience: 'direct',
            id: input.endpointId ?? 'telegram:chat:100',
          },
          actor: {
            principalId: 'telegram:user:42',
            label: input.actorLabel ?? 'Ada',
            kind: 'human',
            isIntegrationSelf: false,
          },
          message: {
            id: input.messageId ?? 'telegram:message:5',
            revision: input.messageRevision,
            text: input.messageText ?? 'Hello from Telegram',
            addressingEvidence: 'none',
            contentProvenance: input.contentProvenance ?? 'original',
            providerTimestamp: input.providerTimestamp ?? now,
          },
        },
      },
      eventCandidate: null,
    },
  };
}

function fullTextIngress(input: ConversationProviderObservationIngestInputV1) {
  if (input.entry.observation.kind !== 'fullText') throw new Error('Expected full-text test ingress.');
  return input.entry.observation.observation;
}

function withTelegramAutomationEventCandidate(
  input: ConversationProviderObservationIngestInputV1,
): ConversationProviderObservationIngestInputV1 {
  return {
    connectionId: input.connectionId,
    entry: {
      observation: input.entry.observation,
      eventCandidate: {
        eventRef: { pluginId: telegramProviderPluginId, localId: 'automation/chat-message-v1' },
        sourceInstanceId: 'telegram:chat:100',
        sourceContractVersion: 1,
        payload: { chatId: '100', messageId: 'telegram:message:5' },
      },
    },
  };
}

function routableNonAdmission(input: Parameters<typeof observation>[0] & Readonly<{
  reason?: 'messageTooLarge' | 'unsupportedContent' | 'unsupportedEdit';
}>): ConversationProviderObservationIngestInputV1 {
  const fullText = observation(input);
  const fullObservation = fullTextIngress(fullText);
  const { text: _text, revision, ...message } = fullObservation.message;
  // A routable non-admission shell always names the message revision it
  // withheld; the full-text union it is derived from leaves it optional.
  if (revision === undefined) {
    throw new Error('Expected the non-admission fixture message to carry a revision.');
  }
  return {
    connectionId: fullText.connectionId,
    entry: {
      observation: {
        kind: 'routableNonAdmission',
        shell: { ...fullObservation, message: { ...message, revision } },
        reason: input.reason ?? 'messageTooLarge',
      },
      eventCandidate: null,
    },
  };
}

type SessionSendResult =
  | Readonly<{ status: 'accepted'; localId: string }>
  | Readonly<{ status: 'alreadyAccepted'; localId: string }>
  | Readonly<{ status: 'rejected'; code: string }>
  | Readonly<{ status: 'outcomeUnknown'; localId: string; code: string }>;

type IngressHarnessOptions = Readonly<{
  connection?: CurrentConversationConnectionFixture;
  sessionSendResult?: SessionSendResult;
  sessionSendResults?: readonly SessionSendResult[];
  sessionSend?: (input: unknown) => Promise<SessionSendResult>;
  availableSessionIds?: readonly string[];
  sessionSummary?: (sessionId: string) => SessionSummary;
  execute?: (actionId: string, input: JsonValue) => Promise<JsonValue> | JsonValue;
  beforeBatch?: (input: Readonly<{
    rows: Map<string, StoredStateRow>;
    operations: readonly CollectionMutation[];
  }>) => void | Promise<void>;
  afterBatch?: (input: Readonly<{ operations: readonly CollectionMutation[] }>) => void;
  loseNextUpdatedBatchResponse?: boolean;
  pollResult?: JsonValue;
  getPollResult?: () => JsonValue | Promise<JsonValue>;
  pollExecution?: (input: JsonValue, signal: AbortSignal) => JsonValue | Promise<JsonValue>;
  pollExecutionError?: unknown;
  automationEventAdmitResults?: readonly JsonValue[];
  automationEventAdmitResult?: JsonValue;
  getAutomationEventAdmitResult?: (input: JsonValue) => JsonValue | Promise<JsonValue>;
  pollExecutionOrigin?: PluginMachineExecutionOriginV1;
  getPollExecutionOrigin?: () => PluginMachineExecutionOriginV1;
  beforeCollectionGet?: (input: Readonly<{ rowId: string }>) => void;
  beforeCollectionPut?: (input: Readonly<{ value: Readonly<Record<string, unknown>> }>) => void;
  beforeCollectionForget?: (input: Readonly<{ rowId: string; expectedRevision: number }>) => void;
  collectionLimits?: PluginCollectionLimits;
  readAdmittedProviderContributions?: () => readonly unknown[];
}>;

function reviseStateRow(rows: Map<string, StoredStateRow>, rowId: string): void {
  const existing = rows.get(rowId);
  if (existing === undefined) throw new Error(`Expected the ${rowId} Channel state row.`);
  rows.set(rowId, stateRow(existing.value, existing.revision + 1));
}

function removeStateRow(rows: Map<string, StoredStateRow>, rowId: string): void {
  if (!rows.delete(rowId)) throw new Error(`Expected the ${rowId} Channel state row.`);
}

function tombstoneStateRow(rows: Map<string, StoredStateRow>, rowId: string): void {
  const existing = rows.get(rowId);
  if (existing === undefined) throw new Error(`Expected the ${rowId} Channel state row.`);
  rows.set(rowId, stateRow(existing.value, existing.revision + 1, { deleted: true }));
}

function replaceConnectionPayload(
  rows: Map<string, StoredStateRow>,
  patch: Readonly<Record<string, unknown>>,
): StoredStateRow {
  const existing = rows.get('connection-1');
  if (existing === undefined) throw new Error('Expected the Channel connection state row.');
  const connection = record(existing.value);
  const payload = record(connection.payload);
  const nextPayload = { ...payload, ...patch };
  if (!isChannelStateJsonRecord(nextPayload)) throw new Error('Expected a JSON connection payload.');
  const next = stateRow(withConversationConnectionPayload({
    row: jsonStateRow(existing),
    payload: nextPayload,
    updatedAt: payloadNumber(connection, 'updated-at'),
  }), existing.revision + 1);
  rows.set(next.rowId, next);
  return next;
}

function setConnectionHistoryGap(rows: Map<string, StoredStateRow>): StoredStateRow {
  return replaceConnectionPayload(rows, {
    historyGap: { reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable' },
  });
}

function setConnectionReplayContinuity(
  rows: Map<string, StoredStateRow>,
  replayContinuity: 'checkpointed' | 'sessionBound' | 'none',
): StoredStateRow {
  return replaceConnectionPayload(rows, { replayContinuity });
}

function advanceConnectionAuthorityEpoch(rows: Map<string, StoredStateRow>): StoredStateRow {
  const existing = rows.get('connection-1');
  if (existing === undefined) throw new Error('Expected the Channel connection state row.');
  const authorityEpoch = record(record(existing.value).payload).authorityEpoch;
  if (typeof authorityEpoch !== 'number') throw new Error('Expected the Channel authority epoch.');
  return replaceConnectionPayload(rows, { authorityEpoch: authorityEpoch + 1 });
}

function replaceConnectionTransportOrigin(
  rows: Map<string, StoredStateRow>,
  machineId: string,
): StoredStateRow {
  const existing = rows.get('connection-1');
  if (existing === undefined) throw new Error('Expected the Channel connection state row.');
  const payload = record(record(existing.value).payload);
  const transportOrigin = record(payload.transportOrigin);
  return replaceConnectionPayload(rows, {
    transportOrigin: {
      ...transportOrigin,
      machineId,
    },
  });
}

function replaceConnectionDuringCapturedPoll(input: Readonly<{
  rows: Map<string, StoredStateRow>;
  incumbentOverlapSafety?: 'safe' | 'providerExclusive' | 'destructive';
  replacementOverlapSafety?: 'safe' | 'providerExclusive' | 'destructive';
  reviseBeforeTransfer?: boolean;
}>): void {
  const current = channelConnection();
  if (input.reviseBeforeTransfer === true) reviseStateRow(input.rows, current.id);
  const incumbent = input.rows.get(current.id);
  if (incumbent === undefined) throw new Error('Expected the incumbent Channel connection state row.');
  const incumbentPayload = record(record(incumbent.value).payload);
  replaceConnectionPayload(input.rows, {
    authorityEpoch: current.payload.authorityEpoch + 1,
    enabled: input.incumbentOverlapSafety === 'destructive' ? false : true,
    transportOrigin: {
      ...current.payload.transportOrigin,
      machineId: 'machine-replacement',
    },
    overlapSafety: input.replacementOverlapSafety ?? 'safe',
    pendingOldTransportStop: {
      ...createCurrentConversationPendingOldTransportStopFixture({
        connectionId: current.id,
        authority: telegramConnectionAuthority,
        predecessorCheckpointedPollInvocation: {
          connectionRevision: incumbent.revision,
          authorityEpoch: payloadNumber(incumbentPayload, 'authorityEpoch'),
          transportOrigin: payloadTransportOrigin(incumbentPayload),
        },
        authorityEpoch: current.payload.authorityEpoch + 1,
        reason: 'transfer',
        predecessorTransportKind: 'socket',
        overlapSafety: input.incumbentOverlapSafety ?? current.payload.overlapSafety,
      }),
    },
  });
}

function isIngressObligationPhase(
  operation: CollectionMutation,
  phase: 'attempting' | 'terminal',
): boolean {
  if (operation.kind !== 'put' || operation.value['record-kind'] !== 'ingress-obligation') return false;
  const payload = operation.value.payload;
  const lifecycle = payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>).lifecycle
    : undefined;
  return lifecycle !== null
    && typeof lifecycle === 'object'
    && !Array.isArray(lifecycle)
    && (lifecycle as Readonly<Record<string, unknown>>).phase === phase;
}

function isCheckpointPut(
  operation: CollectionMutation,
): operation is Extract<CollectionMutation, Readonly<{ kind: 'put' }>> {
  return operation.kind === 'put' && operation.value['record-kind'] === 'checkpoint';
}

function currentCheckpoint(rows: Map<string, StoredStateRow>): StoredStateRow | undefined {
  return [...rows.values()].find(
    (row) => row.deleted !== true && row.value['record-kind'] === 'checkpoint',
  );
}

function markIngressCensusCheckpointCovered(
  rows: Map<string, StoredStateRow>,
  checkpointCoveredAt: number,
): StoredStateRow {
  const census = [...rows.values()].find((row) => (
    row.deleted !== true && row.value['record-kind'] === 'ingress-census'
  ));
  if (census === undefined) throw new Error('Expected a retained ingress census.');
  const value = record(census.value);
  const payload = record(value.payload);
  const covered = stateRow({
    ...value,
    'updated-at': checkpointCoveredAt,
    payload: { ...payload, checkpointCoveredAt },
  }, census.revision + 1);
  rows.set(covered.rowId, covered);
  return covered;
}

function markIngressCensusOccurrenceConflict(rows: Map<string, StoredStateRow>): StoredStateRow {
  const census = [...rows.values()].find((row) => (
    row.deleted !== true && row.value['record-kind'] === 'ingress-census'
  ));
  if (census === undefined) throw new Error('Expected a retained ingress census.');
  const value = record(census.value);
  const payload = record(value.payload);
  const conflicted = stateRow({
    ...value,
    attention: true,
    'updated-at': Number(value['updated-at']) + 1,
    payload: {
      ...payload,
      conflict: { kind: 'occurrenceEvidenceMismatch' },
    },
  }, census.revision + 1);
  rows.set(conflicted.rowId, conflicted);
  return conflicted;
}

/**
 * A mention-gated group binding: the highest-volume real shape, where most
 * observed messages are refused as `notAddressed`.
 */
function setSharedMentionGatedBinding(rows: Map<string, StoredStateRow>): void {
  const existing = rows.get('binding-1');
  if (existing === undefined) throw new Error('Expected the bound Channel state row.');
  const binding = record(existing.value);
  const payload = record(binding.payload);
  rows.set(existing.rowId, stateRow({
    ...binding,
    payload: {
      ...payload,
      endpoint: { kind: 'shared', audience: 'shared', id: 'telegram:chat:200' },
      inputMode: 'directMentionsOnly',
    },
  }, existing.revision + 1));
}

function sharedGroupObservation(input: Parameters<typeof observation>[0]): ConversationProviderObservationIngestInputV1 {
  const base = observation(input);
  const fullText = fullTextIngress(base);
  return {
    connectionId: base.connectionId,
    entry: {
      observation: {
        kind: 'fullText',
        observation: {
          ...fullText,
          endpoint: { kind: 'shared', audience: 'shared', id: 'telegram:chat:200' },
        },
      },
      eventCandidate: null,
    },
  };
}

function obligationOccurrenceId(
  rows: Map<string, StoredStateRow>,
  obligation: StoredStateRow,
): string | undefined {
  const censusId = record(obligation.value.payload).censusId;
  if (typeof censusId !== 'string') return undefined;
  const census = rows.get(censusId);
  if (census === undefined) return undefined;
  const ingress = record(record(census.value.payload).normalizedIngress);
  const shell = ingress.kind === 'fullText' ? record(ingress.observation) : record(ingress.shell);
  return typeof shell.occurrenceId === 'string' ? shell.occurrenceId : undefined;
}

function isIngressCensusPut(operation: CollectionMutation): boolean {
  return operation.kind === 'put' && operation.value['record-kind'] === 'ingress-census';
}

function isStaleAuthorityTerminalization(operations: readonly CollectionMutation[]): boolean {
  if (operations.length !== 1) return false;
  const [operation] = operations;
  if (operation?.kind !== 'put' || operation.value['record-kind'] !== 'ingress-obligation') return false;
  const payload = record(operation.value.payload);
  return record(payload.lifecycle).phase === 'terminal'
    && payload.disposition === 'staleAuthority'
    && record(payload.nonAdmission).senderFeedbackEligible === false;
}

function expectExactIngressAuthorityAssertions(operations: readonly CollectionMutation[]): void {
  expect(operations).toEqual(expect.arrayContaining([
    { kind: 'assert', rowId: 'connection-1', expectedRevision: 1 },
    { kind: 'assert', rowId: 'binding-1', expectedRevision: 1 },
  ]));
}

function setAutomationBindingWithoutFinalResult(rows: Map<string, StoredStateRow>): void {
  const existing = rows.get('binding-1');
  if (existing === undefined) throw new Error('Expected the bound Channel state row.');
  const binding = record(existing.value);
  const payload = record(binding.payload);
  rows.set(existing.rowId, stateRow({
    ...binding,
    payload: {
      ...payload,
      target: {
        kind: 'automation',
        automationId: 'automation-1',
        policy: { resultDelivery: 'none' },
      },
    },
  }, existing.revision + 1));
}

function setAutomationBindingWithFinalResult(
  rows: Map<string, StoredStateRow>,
  bindingId = 'binding-1',
): void {
  const existing = rows.get(bindingId);
  if (existing === undefined) throw new Error('Expected the bound Channel state row.');
  const binding = record(existing.value);
  const payload = record(binding.payload);
  rows.set(existing.rowId, stateRow({
    ...binding,
    payload: {
      ...payload,
      target: {
        kind: 'automation',
        automationId: 'automation-1',
        policy: { resultDelivery: 'finalResult' },
      },
    },
  }, existing.revision + 1));
}

function setBindingNewSessionEnabled(rows: Map<string, StoredStateRow>): void {
  const existing = rows.get('binding-1');
  if (existing === undefined) throw new Error('Expected the bound Channel state row.');
  const binding = record(existing.value);
  const payload = record(binding.payload);
  const target = record(payload.target);
  const policy = record(target.policy);
  rows.set(existing.rowId, stateRow({
    ...binding,
    payload: {
      ...payload,
      target: {
        ...target,
        policy: {
          ...policy,
          newSession: {
            kind: 'enabled',
            principalIds: ['telegram:user:42'],
            recipe: {
              executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
              directory: { kind: 'path', path: '/workspace/channels' },
              agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              },
            },
          },
        },
      },
    },
  }, existing.revision + 1));
}

function setBindingApprovalEnabled(
  rows: Map<string, StoredStateRow>,
  approvals: Readonly<{
    maximumScope?: 'request' | 'session';
    principalIds?: readonly string[];
  }> = {},
): void {
  const existing = rows.get('binding-1');
  if (existing === undefined) throw new Error('Expected the bound Channel state row.');
  const binding = record(existing.value);
  const payload = record(binding.payload);
  const target = record(payload.target);
  const policy = record(target.policy);
  rows.set(existing.rowId, stateRow({
    ...binding,
    payload: {
      ...payload,
      target: {
        ...target,
        policy: {
          ...policy,
          approvals: {
            kind: 'enabled',
            maximumScope: approvals.maximumScope ?? 'request',
            ...(approvals.principalIds === undefined
              ? {}
              : { principalIds: [...approvals.principalIds] }),
          },
        },
      },
    },
  }, existing.revision + 1));
}

function setBindingSenderFeedback(
  rows: Map<string, StoredStateRow>,
  senderFeedback: 'off' | 'eligibleRefusals',
): void {
  const existing = rows.get('binding-1');
  if (existing === undefined) throw new Error('Expected the bound Channel state row.');
  const binding = record(existing.value);
  const payload = record(binding.payload);
  rows.set(existing.rowId, stateRow({
    ...binding,
    payload: {
      ...payload,
      senderFeedback,
    },
  }, existing.revision + 1));
}

function addMatchingBinding(rows: Map<string, StoredStateRow>, bindingId = 'binding-2'): void {
  const binding = channelBinding();
  rows.set(bindingId, stateRow({
    ...binding,
    id: bindingId,
    'binding-id': bindingId,
  }));
}

function addBindingForEndpoint(input: Readonly<{
  rows: Map<string, StoredStateRow>;
  bindingId: string;
  endpointId: string;
  sessionId: string;
}>): void {
  const binding = channelBinding();
  input.rows.set(input.bindingId, stateRow({
    ...binding,
    id: input.bindingId,
    'binding-id': input.bindingId,
    payload: {
      ...binding.payload,
      endpoint: { kind: 'direct', audience: 'direct', id: input.endpointId },
      target: { ...binding.payload.target, sessionId: input.sessionId },
    },
  }));
}

function supersedeBindingSessionTarget(
  rows: Map<string, StoredStateRow>,
  sessionId: string,
): void {
  const existing = rows.get('binding-1');
  if (existing === undefined) throw new Error('Expected the bound Channel state row.');
  const binding = record(existing.value);
  const payload = record(binding.payload);
  const target = record(payload.target);
  const authorityEpoch = payload.authorityEpoch;
  if (typeof authorityEpoch !== 'number') throw new Error('Expected the binding authority epoch.');
  rows.set(existing.rowId, stateRow({
    ...binding,
    payload: {
      ...payload,
      authorityEpoch: authorityEpoch + 1,
      target: { ...target, sessionId },
    },
  }, existing.revision + 1));
}

function replaceBindingPermissionCeiling(
  rows: Map<string, StoredStateRow>,
  permissionCeiling: 'read-only' | 'yolo',
): void {
  const existing = rows.get('binding-1');
  if (existing === undefined) throw new Error('Expected the bound Channel state row.');
  const binding = record(existing.value);
  const payload = record(binding.payload);
  const target = record(payload.target);
  const policy = record(target.policy);
  const authorityEpoch = payload.authorityEpoch;
  if (typeof authorityEpoch !== 'number') throw new Error('Expected the binding authority epoch.');
  rows.set(existing.rowId, stateRow({
    ...binding,
    payload: {
      ...payload,
      authorityEpoch: authorityEpoch + 1,
      target: {
        ...target,
        policy: { ...policy, permissionCeiling },
      },
    },
  }, existing.revision + 1));
}

function markIngressObligationAttempting(rows: Map<string, StoredStateRow>): void {
  const existing = [...rows.values()].find(
    (row) => row.value['record-kind'] === 'ingress-obligation',
  );
  if (existing === undefined) throw new Error('Expected an ingress obligation.');
  const obligation = record(existing.value);
  const payload = record(obligation.payload);
  const now = Date.now();
  rows.set(existing.rowId, stateRow({
    ...obligation,
    terminal: false,
    attention: false,
    'due-at': now,
    payload: {
      ...payload,
      lifecycle: { phase: 'attempting', attemptCount: 1, dueAt: now },
      disposition: null,
      nonAdmission: null,
    },
  }, existing.revision + 1));
}

function createIngressHarness(options: IngressHarnessOptions = {}) {
  const initialConnection = options.connection ?? channelConnection();
  const rows = new Map<string, StoredStateRow>([
    ['connection-1', stateRow(initialConnection)],
    ['binding-1', stateRow(channelBinding())],
  ]);
  let sendResultIndex = 0;
  let loseNextUpdatedBatchResponse = options.loseNextUpdatedBatchResponse === true;
  const send = vi.fn(async (input: SessionSendRequest) => (
    await options.sessionSend?.(input)
      ?? options.sessionSendResults?.[sendResultIndex++]
      ?? options.sessionSendResult
      ?? ({ status: 'accepted' as const, localId: 'pending-1' })
  ));
  const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
    operation: unknown,
    input: JsonValue,
    executionOptions: Readonly<{ signal: AbortSignal; expectedExecutionOrigin?: PluginMachineExecutionOriginV1; expectedExecutionRouting?: PluginMachineExecutionRoutingV1 }>,
  ) => {
    const executionOrigin = options.getPollExecutionOrigin?.()
      ?? options.pollExecutionOrigin
      ?? telegramExecutionOrigin;
    // This is the host Action boundary: reject a misrouted target before its
    // provider callback or poll body can produce an effect.
    if ((executionOptions.expectedExecutionRouting !== undefined
      && !arePluginMachineExecutionRoutingsEqual(executionOptions.expectedExecutionRouting, getPluginMachineExecutionRouting(executionOrigin)))
      || (executionOptions.expectedExecutionOrigin !== undefined
        && !arePluginMachineExecutionOriginsEqual(executionOptions.expectedExecutionOrigin, executionOrigin))) {
      throw new PluginError({ code: 'plugin_action_execution_origin_mismatch', message: 'The provider route differs from its retained target.' });
    }
    if (operation === telegramAutomationEventAdmitAction) {
      const callIndex = executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls
        .filter(([calledOperation]) => calledOperation === telegramAutomationEventAdmitAction).length - 1;
      return {
        result: await options.getAutomationEventAdmitResult?.(input)
          ?? options.automationEventAdmitResults?.[callIndex]
          ?? options.automationEventAdmitResult
          ?? { kind: 'checkpointSafe' },
        executionOrigin,
      };
    }
    if (options.pollExecutionError !== undefined) throw options.pollExecutionError;
    const scriptedPollResult = options.pollExecution === undefined
      ? await options.getPollResult?.()
      : await options.pollExecution(input, executionOptions.signal);
    return {
      result: scriptedPollResult
        ?? options.pollResult
        ?? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'checkpoint' } },
      executionOrigin,
    };
  });
  const execute = vi.fn(async (actionId: string, input: JsonValue) => {
    if (options.execute === undefined) {
      throw new Error(`Unexpected generic Action '${actionId}'.`);
    }
    return await options.execute(actionId, input);
  });

  const put = async (
    value: Readonly<Record<string, unknown>>,
    putOptions: Readonly<{ expectedRevision: number | 'absent' }>,
  ): Promise<StoredStateRow> => {
    options.beforeCollectionPut?.({ value });
    const id = value.id;
    if (typeof id !== 'string') throw new Error('State writes require a canonical id.');
    const existing = rows.get(id);
    if (
      (putOptions.expectedRevision === 'absent' && existing !== undefined)
      || (typeof putOptions.expectedRevision === 'number'
        && (existing === undefined || existing.revision !== putOptions.expectedRevision))
    ) {
      throw new Error(`Collection CAS conflict for ${id}.`);
    }
    const row = stateRow(value, (existing?.revision ?? 0) + 1);
    rows.set(id, row);
    return row;
  };

  const collection = {
    async get(rowId: string): Promise<StoredStateRow | null> {
      options.beforeCollectionGet?.({ rowId });
      const row = rows.get(rowId);
      return row?.deleted === true ? null : row ?? null;
    },
    put,
    async query(request: Readonly<{
      index: string;
      prefix?: readonly unknown[];
      range?: Readonly<{ lower?: number; upper?: number }>;
      order?: 'asc' | 'desc';
      cursor?: string;
      limit: number;
    }>) {
      assertChannelsTestCollectionQueryLimit(request.limit);
      const prefix = request.prefix ?? [];
      const matched = [...rows.values()].filter((row) => {
        if (row.deleted === true) return false;
        if (request.index === 'by-kind') return row.value['record-kind'] === prefix[0];
        if (request.index === 'by-connection') return row.value['connection-id'] === prefix[0];
        if (request.index === 'by-binding') return row.value['binding-id'] === prefix[0];
        if (request.index === 'by-attention') return row.value.attention === prefix[0];
        if (request.index === 'by-connection-binding-v2') {
          return row.value['connection-id'] === prefix[0]
            && (row.value['binding-id'] ?? null) === prefix[1]
            && row.value['record-kind'] === prefix[2]
            && (prefix.length < 4 || row.value.attention === prefix[3]);
        }
        if (request.index === 'by-ingress-due') {
          // Mirrors the canonical raw-ordinal index order: a null due-at key
          // (0x00) sorts before every numeric key (0x01 ‖ float64), so a range
          // with no numeric lower bound admits null-due retained rows ahead of
          // due work, and any numeric lower bound excludes them.
          const dueAt = row.value['due-at'];
          if (row.value['record-kind'] !== prefix[0]) return false;
          if (typeof dueAt !== 'number') return request.range?.lower === undefined;
          return (request.range?.lower === undefined || dueAt >= request.range.lower)
            && (request.range?.upper === undefined || dueAt <= request.range.upper);
        }
        return false;
      }).sort((left, right) => {
        if (request.index !== 'by-ingress-due') {
          return left.rowId === right.rowId ? 0 : left.rowId < right.rowId ? -1 : 1;
        }
        const dueAtKey = (row: StoredStateRow): number | null => {
          const dueAt = row.value['due-at'];
          return typeof dueAt === 'number' ? dueAt : null;
        };
        const leftDueAt = dueAtKey(left);
        const rightDueAt = dueAtKey(right);
        const naturalOrder = leftDueAt === null && rightDueAt === null
          ? 0
          : leftDueAt === null
            ? -1
            : rightDueAt === null
              ? 1
              : leftDueAt - rightDueAt;
        return (naturalOrder * (request.order === 'desc' ? -1 : 1))
          || (left.rowId === right.rowId ? 0 : left.rowId < right.rowId ? -1 : 1);
      });
      const cursorIndex = request.cursor === undefined
        ? -1
        : matched.findIndex((row) => row.rowId === request.cursor);
      const pageStart = cursorIndex + 1;
      const pageRows = matched.slice(pageStart, pageStart + request.limit);
      return {
        rows: pageRows,
        changeCursor: 1,
        ...(pageStart + pageRows.length < matched.length && pageRows.length > 0
          ? { nextCursor: pageRows.at(-1)!.rowId }
          : {}),
      };
    },
    async limits() {
      return options.collectionLimits ?? deploymentLimits({
        maxBatchRows: 100,
        maxBatchBytes: 16 * 1024 * 1024,
      });
    },
    async measureBatch(operations: readonly CollectionMutation[]) {
      // The Account Data owner reports the request shell and then each
      // operation plus the separator joining it to the previous one. This
      // boundary mirrors that decomposition on a plain Account so the packer
      // is exercised on real encoded lengths rather than an invented cost.
      return {
        overheadEncodedBytes: encodedJsonBytes({
          pluginId: 'happier.channels',
          collectionId: 'channel-state',
          writerContext: { schemaVersion: 1, contractDigest: 'x'.repeat(43) },
          operations: [],
        }),
        operationEncodedBytes: operations.map((operation) => 1 + encodedJsonBytes(
          operation.kind === 'put'
            ? {
              kind: 'put',
              rowId: operation.value.id,
              expectedRevision: operation.expectedRevision,
              content: { t: 'plain', v: operation.value },
              projection: {},
            }
            : operation,
        )),
      };
    },
    async forget(rowId: string, forgetOptions: Readonly<{ expectedRevision: number }>) {
      options.beforeCollectionForget?.({ rowId, expectedRevision: forgetOptions.expectedRevision });
      const existing = rows.get(rowId);
      // The real Collection forget is response-loss-idempotent: an exact
      // retention retry may observe that this identity was already physically
      // reclaimed while it was between snapshots. DATA also accepts an exact
      // live revision and applies logical cleanup plus physical reclamation in
      // one transaction once Channels has proved the row unreachable.
      if (existing === undefined) return { rowId, forgotten: true as const };
      if (existing.revision !== forgetOptions.expectedRevision) {
        throw new Error('Collection forget conflicted.');
      }
      rows.delete(rowId);
      return { rowId, forgotten: true as const };
    },
    async batch(operations: readonly CollectionMutation[]) {
      await options.beforeBatch?.({ rows, operations });
      const snapshot = new Map(rows);
      const results: Array<Readonly<{ rowId: string; revision: number; deleted: boolean }>> = [];
      for (const operation of operations) {
        if (operation.kind === 'assert') {
          const existing = snapshot.get(operation.rowId);
          if (
            existing === undefined
            || existing.deleted === true
            || existing.revision !== operation.expectedRevision
          ) {
            return {
              status: 'conflict' as const,
              conflicts: [{
                rowId: operation.rowId,
                revision: existing?.revision ?? null,
                deleted: existing?.deleted === true,
              }],
            };
          }
          continue;
        }
        if (operation.kind === 'put') {
          const id = operation.value.id;
          if (typeof id !== 'string') throw new Error('State writes require a canonical id.');
          const existing = snapshot.get(id);
          if (
            (operation.expectedRevision === 'absent' && existing !== undefined)
            || (typeof operation.expectedRevision === 'number'
              && (existing === undefined || existing.revision !== operation.expectedRevision))
          ) {
            return {
              status: 'conflict' as const,
              conflicts: [{ rowId: id, revision: existing?.revision ?? null, deleted: existing?.deleted === true }],
            };
          }
          const next = stateRow(operation.value, (existing?.revision ?? 0) + 1);
          snapshot.set(id, next);
          results.push({ rowId: id, revision: next.revision, deleted: false });
          continue;
        }
        const existing = snapshot.get(operation.rowId);
        if (existing === undefined || existing.deleted === true || existing.revision !== operation.expectedRevision) {
          return {
            status: 'conflict' as const,
            conflicts: [{
              rowId: operation.rowId,
              revision: existing?.revision ?? null,
              deleted: existing?.deleted === true,
            }],
          };
        }
        snapshot.set(operation.rowId, stateRow(existing.value, existing.revision + 1, { deleted: true }));
        results.push({ rowId: operation.rowId, revision: existing.revision + 1, deleted: true });
      }
      rows.clear();
      for (const [id, row] of snapshot) rows.set(id, row);
      options.afterBatch?.({ operations });
      if (loseNextUpdatedBatchResponse) {
        loseNextUpdatedBatchResponse = false;
        throw new Error('Simulated Account Collection response loss.');
      }
      return { status: 'updated' as const, results, changeCursor: 1 };
    },
  };

  // The fixture supplies only genuine host boundaries: Account collection and Session admission.
  const services = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    storage: { account: { collection: () => collection } },
    actions: { execute, executeAdmittedTargetedOperationWithExecutionOrigin,
      getCurrentExecutionRouting: async () => ({ ...getPluginMachineExecutionRouting(options.getPollExecutionOrigin?.()
        ?? options.pollExecutionOrigin ?? telegramExecutionOrigin), pluginId: 'happier.channels' }) },
    targetedContributions: targetedTelegramPollContribution(options.readAdmittedProviderContributions),
    sessions: {
      get: async (sessionId: string) => (options.availableSessionIds ?? ['session-1']).includes(sessionId)
        ? { send, summary: async () => options.sessionSummary?.(sessionId) ?? {
          id: sessionId, state: 'idle', runtimeAvailability: { status: 'available' },
          storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1,
        } }
        : null,
    },
  } as unknown as PluginServices;
  const context: PluginInvocationContext = {
    invokedAtMs: 1_700_000_000_000,
    plugin: { id: 'happier.channels', version: '0.0.0' },
    contribution: {
      id: 'provider/observation-ingest-v1',
      qualifiedId: 'happier.channels/actions/provider/observation-ingest-v1',
    },
    surface: 'plugin',
    caller: {
      kind: 'plugin',
      pluginId: 'happier.channel.telegram',
      contribution: {
        id: 'channel-poller',
        qualifiedId: 'happier.channel.telegram/background/channel-poller',
      },
      occurrenceId: 'channels-ingress-telegram-fixture-occurrence',
      sourceCustody: { kind: 'development', registeredRootId: 'channels-ingress-telegram-root' },
      materialization: telegramExecutionOrigin.materializationRef,
      executionOrigin: telegramExecutionOrigin,
    },
    signal: new AbortController().signal,
    services,
  };
  return { rows, send, execute, executeAdmittedTargetedOperationWithExecutionOrigin, context };
}

/** Complete reply projection through the real relation and frontier owners. */
async function settleAcceptedInputReplyProjection(
  harness: ReturnType<typeof createIngressHarness>,
  bindingId = 'binding-1',
): Promise<void> {
  const binding = harness.rows.get(bindingId);
  const target = record(record(binding?.value.payload).target);
  const sessionId = target.sessionId;
  if (typeof sessionId !== 'string') throw new Error('Expected a Session binding.');
  const stateCollection = harness.context.services.storage.account?.collection(CHANNEL_STATE_COLLECTION);
  if (stateCollection === undefined) throw new Error('Expected Account storage.');
  const localIds = [...harness.rows.values()].flatMap(row => {
    if (row.value['binding-id'] !== bindingId || row.value['record-kind'] !== 'ingress-obligation') return [];
    const accepted = record(record(row.value.payload).sessionInput);
    return accepted.sessionId === sessionId && typeof accepted.localId === 'string' ? [accepted.localId] : [];
  });
  const relations = await readConversationSessionInputReplyRelations({
    stateCollection, bindingId, connectionId: 'connection-1', sessionId,
    consumedLocalIds: localIds, signal: harness.context.signal,
  });
  expect(relations).toHaveLength(localIds.length);
  expect(relations.length).toBeGreaterThan(0);
  await markConversationSessionInputRepliesProjected({
    stateCollection, relations, seq: 1, signal: harness.context.signal,
  });
  // The database boundary begins with a no-history frontier, as binding creation does.
  const frontier = createConversationSessionProjectionFrontierRow({
    bindingId, targetSessionId: sessionId, transcriptCursor: null, lastScannedSeq: 0,
    revision: 1, now: 1_000,
  });
  harness.rows.set(frontier.id, stateRow(frontier));
  const store = createConversationSessionProjectionCollectionStore({ stateCollection, signal: harness.context.signal });
  const current = await store.read({ bindingId, signal: harness.context.signal });
  if (current.kind !== 'ready') throw new Error('Expected a readable projection frontier.');
  await expect(store.compareAndSwap({
    bindingId, expectedBindingRevision: current.binding.revision,
    frontierRowId: current.frontierRowId, expectedFrontierRowRevision: current.frontierRowRevision,
    frontier: { ...current.frontier, transcriptCursor: 'projected-reply', lastScannedSeq: 1, revision: 2 },
  })).resolves.toEqual({ kind: 'updated' });
}

function routerFixture(rows: Map<string, StoredStateRow>, unmatched = false): void {
  const binding = channelBinding();
  rows.set(binding.id, stateRow({
    ...binding,
    payload: {
      ...binding.payload,
      inputMode: 'allAllowedMessages',
      target: {
        kind: 'threadRouter',
        principalGroups: [
          { id: 'sales', principalIds: ['telegram:user:42'] },
          { id: 'questions', principalIds: ['telegram:user:42', 'telegram:user:43'] },
        ],
        routes: [{
          id: 'intake',
          when: { group: 'sales', forwarded: unmatched ? true : 'any' },
          recipe: {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/workspace/channels' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          },
          policy: binding.payload.target.policy,
        }],
      },
    },
  }));
}

function topicObservation(occurrenceId: string, principalId = 'telegram:user:42', messageText?: string, label?: string): ConversationProviderObservationIngestInputV1 {
  const input = observation({ occurrenceId, messageRevision: '1', transport: 'socket', messageText });
  const full = fullTextIngress(input);
  return { ...input, entry: { ...input.entry, observation: { kind: 'fullText', observation: {
    ...full,
    endpoint: { kind: 'thread', audience: 'direct', id: 'telegram:topic:7', parentId: 'telegram:chat:100', ...(label ? { label } : {}) },
    actor: { ...full.actor, principalId },
  } } } };
}

function threadSpawnBoundary(actionId: string, input: JsonValue): JsonValue {
  if (actionId === 'session.spawn_new') {
    expect(input).toMatchObject({
      creationKey: 'channel-thread:binding-1:telegram:topic:7',
      attestedContext: { externalPrincipalId: 'telegram:user:42', sourceMessageId: 'telegram:message:5' },
    });
    return { type: 'success', disposition: 'created', sessionId: 'session-2',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
  }
  if (actionId === 'session.transcript.get') return { ok: true, projection: 'externalShareableV1', sessionId: 'session-2',
    items: [], scannedThroughSeq: 0, hasMore: false };
  throw new Error(`Unexpected thread Action ${actionId}`);
}

describe('thread router admission', () => {
  it('routes an ordinary Telegram supergroup reply to the existing group binding and replies natively without a topic', async () => {
    let polled = false;
    const nativeSends: unknown[] = [];
    const providerContext = (signal: AbortSignal): PluginInvocationContext => ({
      plugin: { id: telegramProviderPluginId, version: '0.0.0' },
      contribution: { id: 'telegram/poll-updates', qualifiedId: `${telegramProviderPluginId}/actions/telegram/poll-updates` },
      surface: 'plugin', invokedAtMs: Date.now(), signal,
      caller: { kind: 'plugin', pluginId: 'happier.channels',
        contribution: { id: 'ingress-supervisor', qualifiedId: 'happier.channels/background/ingress-supervisor' },
        occurrenceId: 'ordinary-reply', sourceCustody: { kind: 'development', registeredRootId: 'reply-fixture' },
        materialization: telegramExecutionOrigin.materializationRef },
      // Only credentials and the provider's HTTP boundary are substituted.
      services: { connectedAccounts: { materialize: async () => ({ kind: 'environment', env: { TELEGRAM_BOT_TOKEN: '12345:fixture-token' } }) },
        http: { request: async (request: Parameters<PluginServices['http']['request']>[0]) => {
          let result: JsonValue;
          if (request.url.endsWith('/getMe')) result = { id: 12345, is_bot: true, first_name: 'Happier', username: 'happier_bot', can_read_all_group_messages: true };
          else if (request.url.endsWith('/getChat')) result = { id: -100456, type: 'supergroup', title: 'Group' };
          else if (request.url.endsWith('/sendMessage')) {
            nativeSends.push(JSON.parse(new TextDecoder().decode(request.body)));
            result = { message_id: 99 };
          } else if (request.url.endsWith('/getUpdates')) {
            result = polled ? [{ update_id: 9001, message: {
              message_id: 8, message_thread_id: 11, date: Math.floor(Date.now() / 1000),
              chat: { id: -100456, type: 'supergroup' }, from: { id: 42, is_bot: false }, text: 'continue here',
              reply_to_message: { message_id: 7, from: { id: 12345, is_bot: true } },
            } }] : [];
            polled = true;
          } else throw new Error(`Unexpected Telegram request ${request.url}`);
          return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({ ok: true, result })) };
        } },
      } as unknown as PluginServices,
    });
    const harness = createIngressHarness({ pollExecution: (input, signal) => pollTelegramObservations(input, providerContext(signal)) });
    const binding = channelBinding();
    const endpoint = { kind: 'shared' as const, audience: 'shared' as const, id: '-100456' };
    harness.rows.set(binding.id, stateRow({ ...binding, payload: { ...binding.payload, endpoint,
      inputMode: 'addressedMessages', allowedPrincipalIds: ['42'] } }));
    replaceConnectionPayload(harness.rows, { providerConfig: { botUsername: 'happier_bot', canReadAllGroupMessages: true } });
    await runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context);
    await runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context);
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(sentUserTextRequest(harness.send.mock.calls[0]?.[0])).toMatchObject({ text: 'continue here' });
    const stateCollection = harness.context.services.storage.account?.collection(CHANNEL_STATE_COLLECTION);
    if (!stateCollection) throw new Error('Expected Account storage.');
    const relations = await readConversationSessionInputReplyRelations({ stateCollection, bindingId: binding.id,
      connectionId: 'connection-1', sessionId: 'session-1', consumedLocalIds: ['pending-1'], signal: harness.context.signal });
    expect(relations).toHaveLength(1);
    await expect(deliverTelegramMessage({ v: 1, connectionId: 'connection-1',
      providerConnectionKey: telegramConnectionAuthority.providerConnectionKey, providerConfigVersion: 1,
      providerConfig: { botUsername: 'happier_bot', canReadAllGroupMessages: true }, credentialRef: telegramConnectionAuthority.credentialRef,
      endpoint, content: { text: 'answer @SomeActualUsername' }, deliveryKey: 'ordinary-reply', replyContext: relations[0]!.replyContext,
      mentionPolicy: 'suppress', linkPreviewPolicy: 'suppress',
    }, providerContext(harness.context.signal))).resolves.toMatchObject({ kind: 'delivered' });
    expect(nativeSends).toEqual([{ chat_id: '-100456', text: 'answer ＠SomeActualUsername',
      reply_parameters: { message_id: 8 }, link_preview_options: { is_disabled: true } }]);
  });

  it.each(['telegram', 'discord'] as const)('pairs real %s shared proof into a paused parent router before ordinary enable and thread admission', async provider => {
    const providerPluginId = `happier.channel.${provider}`;
    const executionOrigin = {
      ...telegramExecutionOrigin,
      serverIdentityId: provider === 'discord' ? 'srv_plugin_testkit' : telegramExecutionOrigin.serverIdentityId,
      materializationRef: { ...telegramExecutionOrigin.materializationRef, pluginId: providerPluginId },
    };
    const parentEndpoint = provider === 'telegram'
      ? { kind: 'shared' as const, audience: 'shared' as const, id: '100' }
      : { kind: 'shared' as const, audience: 'shared' as const, id: 'discord:channel:parent-1' };
    const proofEndpoint = provider === 'telegram'
      ? { kind: 'thread' as const, audience: 'shared' as const, id: '100:7', parentId: '100' }
      : parentEndpoint;
    const principalId = provider === 'telegram' ? '42' : 'discord:user:42';
    const mention = provider === 'telegram' ? '@happier_bot' : '<@12345>';
    const freshThreadId = provider === 'telegram' ? '100:8' : 'discord:channel:thread-1';
    const connection = createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: {
        ...telegramConnectionAuthority,
        providerPluginId,
        transportOrigin: { serverIdentityId: executionOrigin.serverIdentityId, machineId: 'machine-1' },
        providerConfig: { botUsername: 'happier_bot', canReadAllGroupMessages: true },
        integrationPrincipal: { id: provider === 'telegram' ? '12345' : 'discord:user:12345' },
      },
      transport: provider === 'telegram' ? { kind: 'checkpointedPull' } : { kind: 'socket' },
      overlapSafety: 'safe',
      replayContinuity: provider === 'telegram' ? 'checkpointed' : 'none',
      outboundTextLimit: { maximum: 4_096, unit: 'utf8Bytes' },
    });
    const manager = createConversationPairingManager({
      generationId: 'pairing-router-generation',
      now: () => Date.now(),
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: kind => `${kind}-paired-router`,
    });
    let messageNumber = 0;
    let pairedRouterId = '';
    let nextTelegramMessage: JsonValue | null = null;
    const harness = createIngressHarness({ connection, availableSessionIds: ['session-2'],
      execute: (actionId, input) => {
        if (actionId === 'session.spawn_new') {
          expect(input).toMatchObject({
            creationKey: `channel-thread:${pairedRouterId}:${freshThreadId}`,
            attestedContext: { externalPrincipalId: principalId, sourceMessageId: '3' },
          });
          return { type: 'success', disposition: 'created', sessionId: 'session-2',
            attestedContext: { externalPrincipalId: principalId, sourceMessageId: '3' },
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        }
        return threadSpawnBoundary(actionId, input);
      },
      pollExecution: async (input, signal) => pollTelegramObservations(input, {
        plugin: { id: providerPluginId, version: '0.0.0' },
        contribution: { id: 'telegram/poll-updates', qualifiedId: `${providerPluginId}/actions/telegram/poll-updates` },
        surface: 'plugin', invokedAtMs: Date.now(),
        caller: { kind: 'plugin', pluginId: 'happier.channels',
          contribution: { id: 'ingress-supervisor', qualifiedId: 'happier.channels/background/ingress-supervisor' },
          occurrenceId: 'paired-router-poll', sourceCustody: { kind: 'development', registeredRootId: 'paired-router-test' },
          materialization: executionOrigin.materializationRef },
        signal,
        // Only Telegram HTTP and Connected Account materialization are substituted.
        services: {
          connectedAccounts: { materialize: async () => ({ kind: 'environment', env: { TELEGRAM_BOT_TOKEN: '12345:fixture-token' } }) },
          http: { request: async (request: Readonly<{ url: string }>) => {
            let result: JsonValue;
            if (request.url.endsWith('/getMe')) result = { id: 12345, is_bot: true, first_name: 'Happier', username: 'happier_bot', can_read_all_group_messages: true };
            else if (request.url.endsWith('/getUpdates')) {
              result = nextTelegramMessage === null ? [] : [nextTelegramMessage];
              nextTelegramMessage = null;
            } else throw new Error(`Unexpected Telegram endpoint ${request.url}`);
            return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/json' },
              body: new TextEncoder().encode(JSON.stringify({ ok: true, result })) };
          } },
        } as unknown as PluginInvocationContext['services'],
      }),
    });
    harness.rows.delete('binding-1');
    const endpointResolve = { identity: { ...telegramPollAction.identity,
      contributor: { ...telegramPollAction.identity.contributor, pluginId: providerPluginId }, role: 'endpointResolve' } };
    const providerContribution = { ...admittedTelegramProviderContribution,
      contributor: { ...admittedTelegramProviderContribution.contributor, pluginId: providerPluginId },
      operations: provider === 'telegram'
        ? { ...admittedTelegramProviderContribution.operations, endpointResolve }
        : { endpointResolve } };
    const services: PluginServices = {
      ...harness.context.services,
      targetedContributions: targetedTelegramPollContribution(() => [providerContribution]),
      actions: {
        ...harness.context.services.actions,
        // Endpoint resolution is a provider Action boundary. Pairing, target
        // validation, storage transitions, parsing and routing all stay real.
        executeAdmittedTargetedOperationWithExecutionOrigin: async (operation, input, options) => Object.is(operation, endpointResolve)
          ? { result: { kind: 'resolved', candidates: provider === 'telegram' ? [parentEndpoint, proofEndpoint] : [parentEndpoint] }, executionOrigin }
          : harness.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(operation, input, options),
      } as PluginServices['actions'],
    };
    const context: PluginInvocationContext = { ...harness.context, services,
      caller: { kind: 'plugin', pluginId: providerPluginId,
        contribution: { id: 'channel-worker', qualifiedId: `${providerPluginId}/background/channel-worker` },
        occurrenceId: 'paired-router-provider', sourceCustody: { kind: 'development', registeredRootId: 'paired-router-test' },
        materialization: executionOrigin.materializationRef, executionOrigin } };
    const pairingHandlers = createConversationPairingManagementHandlers(manager);
    const ingest = createConversationProviderObservationIngestHandler(manager);
    const pairingActionIds = new Set<string>([
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
      'provider/observation-ingest-v1',
    ]);
    const kit = await createPluginTestkit({ manifest: provider === 'discord' ? PLUGIN_MANIFEST : {
      ...PLUGIN_MANIFEST,
      contributes: {
        actions: PLUGIN_MANIFEST.contributes?.actions?.filter(action => pairingActionIds.has(action.id)) ?? [],
        resources: PLUGIN_MANIFEST.contributes?.resources?.filter(resource => resource.id === 'pairing-v1' || resource.id === 'brand-icon') ?? [],
      },
    }, services,
      module: provider === 'discord' ? CHANNELS_PLUGIN : { activate(api) {
        api.actions.register(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate, pairingHandlers.create);
        api.actions.register(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize, pairingHandlers.finalize);
        api.actions.register(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate, updateConversationBindingForInvocation);
        api.actions.register('provider/observation-ingest-v1', ingest);
        api.resources.registerDynamicResource('pairing-v1', createConversationPairingResourceRuntime(manager));
      } },
    });
    const discordSource = definePlugin({ id: providerPluginId, version: '0.0.0',
      actions: { 'fixture/ingest': {
        title: 'Deliver provider observation', surfaces: ['cli'], dangerLevel: 'safe',
        inputSchema: ConversationProviderObservationIngestInputV1JsonSchema,
        async run(input, invocation) {
          await invocation.services.actions.execute({ pluginId: 'happier.channels', localId: 'provider/observation-ingest-v1' }, input);
        },
      } },
    });
    let discordSourceKit: Awaited<ReturnType<typeof createPluginTestkit>> | null = null;
    const deliver = async (text: string, threadId: number | null, senderId = '42') => {
      messageNumber += 1;
      if (provider === 'telegram') {
        nextTelegramMessage = { update_id: 9000 + messageNumber, message: {
          message_id: messageNumber, message_thread_id: threadId, is_topic_message: threadId !== null,
          date: Math.floor(Date.now() / 1000), chat: { id: 100, type: 'supergroup', title: 'Forum', is_forum: true },
          from: { id: Number(senderId), is_bot: false, first_name: 'Ada' }, text,
          ...(text.startsWith('@happier_bot') ? { entities: [{ type: 'mention', offset: 0, length: 12 }] } : {}),
        } };
        await runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, context, manager);
      } else {
        const parsed = parseDiscordMessageDispatch({ event: 'MESSAGE_CREATE',
          channel: threadId === null
            ? { kind: 'shared', channelId: 'parent-1' }
            : { kind: 'thread', channelId: `thread-${threadId}`, parentChannelId: 'parent-1' },
          payload: { id: String(messageNumber), timestamp: new Date().toISOString(), content: text,
            type: 0, author: { id: senderId, bot: false },
            mentions: text.startsWith('<@12345>') ? [{ id: '12345' }] : [] },
          context: { botUserId: '12345', applicationId: 'application-1', botRoleIds: [], messageContentIntentEnabled: true },
        });
        const normalized = mapDiscordMessageToSocketIngress({ parsed });
        if (normalized === null) throw new Error('Expected an authenticated Discord message.');
        if (discordSourceKit === null) throw new Error('Expected the authenticated Discord provider Action source.');
        await discordSourceKit.invokeAction('fixture/ingest', {
          connectionId: 'connection-1', entry: { observation: normalized, eventCandidate: null },
        });
      }
    };
    try {
      if (provider === 'discord') {
        discordSourceKit = await createPluginTestkit({
          manifest: discordSource.manifest, module: discordSource, actionTargets: [kit],
          resolveCurrentPluginMaterializationRef: () => executionOrigin.materializationRef,
        });
      }
      if (provider === 'telegram') {
        await runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, context, manager);
      }
      const endpointSelection = (endpoint: typeof parentEndpoint | typeof proofEndpoint) => ({ query: endpoint.id, selected: endpoint });
      const challenge = ConversationPairingCreateResultV1Schema.parse(await kit.invokeAction(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
        { connectionId: 'connection-1', expectedConnectionRevision: connection.payload.configurationRevision,
          pairingRequestId: 'pairing-router-request', endpointSelection: endpointSelection(parentEndpoint),
          proofEndpointSelection: endpointSelection(proofEndpoint),
          target: { kind: 'threadRouter', principalGroups: [{ id: 'owner', principalIds: [] }], routes: [{
            id: 'owner-route', when: { group: 'owner', forwarded: 'any' },
            recipe: { executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
              directory: { kind: 'path', path: '/workspace/channels' },
              agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
            policy: channelBinding().payload.target.policy,
          }] } }, { surface: 'agent' },
      ));
      if (challenge.kind !== 'created') throw new Error('Expected the shared router challenge.');
      expect(challenge).toMatchObject({ proofEndpoint, deepLinkUrl: null });
      await deliver(`/pair ${challenge.manualToken}`, provider === 'telegram' ? 7 : null);
      const pairingResource = kit.registration('resources', 'pairing-v1');
      if (pairingResource === undefined) throw new Error('Expected the activated Channels pairing Resource.');
      const accountStorage = services.storage.account;
      if (accountStorage === undefined) throw new Error('Expected the pairing Resource Account storage boundary.');
      const projection = ConversationPairingResourceV1Schema.parse(JSON.parse(resourceText(await pairingResource.read({
        signal: context.signal, context: { kind: 'global' }, accountStorage,
      }))));
      expect(projection.proposals).toHaveLength(1);
      const proposal = projection.proposals[0];
      if (proposal === undefined) throw new Error('Expected the actual sender proposal.');
      expect(proposal).toMatchObject({ principalId, proofEndpoint });
      expect(harness.execute.mock.calls.filter(([action]) => action === 'session.spawn_new')).toHaveLength(0);
      expect(harness.send).not.toHaveBeenCalled();
      expect([...harness.rows.values()].filter(row => row.value['record-kind'] === 'binding')).toHaveLength(0);
      const finalized = ConversationPairingFinalizeResultV1Schema.parse(await kit.invokeAction(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize,
        { generationId: challenge.generationId, proposalId: proposal.proposalId, connectionId: 'connection-1',
          expectedConnectionRevision: connection.payload.configurationRevision, finalizeIdempotencyKey: 'pairing-router-finalize' },
        { surface: 'agent' },
      ));
      if (finalized.kind !== 'created') throw new Error(`Expected a new paused router, got ${finalized.kind}.`);
      expect(finalized.binding).toMatchObject({ endpoint: parentEndpoint, enabled: false, allowedPrincipalIds: [principalId],
        target: { kind: 'threadRouter', principalGroups: [{ id: 'owner', principalIds: [principalId] }] } });
      const routerId = finalized.binding.id;
      pairedRouterId = routerId;
      const readRouter = () => {
        const row = harness.rows.get(routerId);
        if (row === undefined) throw new Error('Expected the persisted parent router.');
        return row;
      };
      expect(readRouter().value.payload).toMatchObject({ endpoint: parentEndpoint, enabled: false, allowedPrincipalIds: [principalId] });
      await deliver(`${mention} paused topic`, provider === 'telegram' ? 6 : 0);
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.execute.mock.calls.filter(([action]) => action === 'session.spawn_new')).toHaveLength(0);
      await kit.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
        { bindingId: routerId, expectedRevision: readRouter().revision, enabled: true, inboundDebounceMs: 0 }, { surface: 'agent' });
      await deliver(`${mention} first topic message`, provider === 'telegram' ? 8 : 1);
      await deliver(`${mention} follow-up`, provider === 'telegram' ? 8 : 1);
      const children = [...harness.rows.values()].filter(row => record(row.value.payload).parentBindingId === routerId);
      expect(children).toHaveLength(1);
      expect(children[0]?.value.payload).toMatchObject({
        endpoint: { kind: 'thread', audience: 'shared', id: freshThreadId, parentId: parentEndpoint.id },
        target: { kind: 'session', sessionId: 'session-2' }, allowedPrincipalIds: [principalId],
      });
      expect(harness.execute.mock.calls.filter(([action]) => action === 'session.spawn_new')).toHaveLength(1);
      expect(harness.send.mock.calls.map(([request]) => sentUserTextRequest(request).text))
        .toEqual([`${mention} first topic message`, `${mention} follow-up`]);
      await deliver(`${mention} unknown sender`, provider === 'telegram' ? 9 : 2, '99');
      await deliver(`${mention} unknown child sender`, provider === 'telegram' ? 8 : 1, '99');
      await kit.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
        { bindingId: routerId, expectedRevision: readRouter().revision, enabled: false }, { surface: 'agent' });
      await deliver(`${mention} disabled child`, provider === 'telegram' ? 8 : 1);
      await deliver(`${mention} disabled new thread`, provider === 'telegram' ? 10 : 3);
      expect(harness.send).toHaveBeenCalledTimes(2);
      expect(harness.execute.mock.calls.filter(([action]) => action === 'session.spawn_new')).toHaveLength(1);
      expect([...harness.rows.values()].filter(row => record(row.value.payload).parentBindingId === routerId)).toHaveLength(1);
    } finally {
      await discordSourceKit?.dispose();
      await kit.dispose();
      manager.dispose();
    }
  });

  it('preserves the typed Session refusal in content-free direct and supervisor diagnostics', async () => {
    const harness = createIngressHarness({ connection: socketChannelConnection(), execute: (actionId, input) => {
      if (actionId === 'session.spawn_new') return { type: 'error', code: 'spawn_failed', retryable: true,
        launchError: { kind: 'launch_error', code: 'SPAWN_VALIDATION_FAILED',
          message: 'private-message sales@example.test secret-token' } };
      return threadSpawnBoundary(actionId, input);
    } });
    routerFixture(harness.rows);
    const warn = vi.spyOn(harness.context.services.logger, 'warn');
    const failure = await ingestConversationProviderObservationForInvocation(topicObservation('spawn-refused'), harness.context)
      .catch((error: unknown) => error);
    expect(classifySupervisorFailure(failure)).toEqual({ code: 'channels_thread_spawn_failed', retryable: true,
      sessionSpawnCode: 'spawn_failed', sessionSpawnReason: 'SPAWN_VALIDATION_FAILED' });
    expect(JSON.stringify(classifySupervisorFailure(failure))).not.toMatch(/private-message|sales@|secret-token/);
    expect(warn).toHaveBeenCalledWith('[Channels] thread Session creation refused', {
      code: 'channels_thread_spawn_failed', retryable: true,
      sessionSpawnCode: 'spawn_failed', sessionSpawnReason: 'SPAWN_VALIDATION_FAILED',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-message|sales@|secret-token/);
    expect(JSON.stringify(failure)).not.toMatch(/private-message|sales@|secret-token/);
    expect(harness.send).not.toHaveBeenCalled();
    expect([...harness.rows.values()].filter(row => record(row.value.payload).parentBindingId === 'binding-1')).toHaveLength(0);
  });

  it.each([
    { reason: 'actorUnattributable', kind: 'unknown', principalId: null },
    { reason: 'actorNotAllowed', kind: 'human', principalId: 'private-unlisted@example.test' },
    { reason: 'botSenderDisabled', kind: 'bot', principalId: 'telegram:user:42' },
  ] as const)('projects the real $reason drop without message or sender evidence', async ({ reason, kind, principalId }) => {
    const harness = createIngressHarness();
    const input = observation({ messageRevision: 'private-revision', messageText: 'private-message-content' });
    const normalized = fullTextIngress(input);
    const rejected = {
      ...input,
      entry: { ...input.entry, observation: {
        kind: 'fullText' as const,
        observation: { ...normalized, actor: { ...normalized.actor, kind, principalId } },
      } },
    };
    await ingestConversationProviderObservationForInvocation(rejected, harness.context);
    expect(harness.send).not.toHaveBeenCalled();
    // The real ingress writer's retained row crosses the same strict Action
    // reader used by Agents/MCP, rather than a reconstructed attention DTO.
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: CHANNELS_PLUGIN,
      services: { storage: harness.context.services.storage } });
    try {
      const attention = await kit.invokeAction('ingress/attention-v1', {}, { surface: 'agent' });
      expect(attention).toMatchObject({ obligations: [{ kind: 'terminal', category: 'informational', reason }] });
      expect(JSON.stringify(attention)).not.toMatch(/private-|telegram:user:42|Ada|telegram:message:5/);
    } finally { await kit.dispose(); }
  });

  it('routes real Telegram forum-topic observations from the existing poll provider', async () => {
    let pollNumber = 0;
    const bornSessions = new Set<string>();
    const heldThreadPollBindings: unknown[] = [];
    const harness = createIngressHarness({ availableSessionIds: ['session-2'],
      execute: (actionId, input) => {
        if (actionId === 'session.spawn_new') {
          const request = record(input);
          expect(request.creationKey).toBe('channel-thread:binding-1:100:7');
          bornSessions.add(String(request.creationKey));
          return { type: 'success', disposition: 'created', sessionId: 'session-2',
            attestedContext: { externalPrincipalId: '42', sourceMessageId: '5' },
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        }
        return threadSpawnBoundary(actionId, input);
      },
      pollExecution: async (input, signal) => {
        if (pollNumber > 1) heldThreadPollBindings.push(record(input).bindings);
        return pollTelegramObservations(input, {
        plugin: { id: telegramProviderPluginId, version: '0.0.0' },
        contribution: { id: 'telegram/poll-updates', qualifiedId: 'happier.channel.telegram/actions/telegram/poll-updates' },
        surface: 'plugin', invokedAtMs: Date.now(),
        caller: { kind: 'plugin', pluginId: 'happier.channels',
          contribution: { id: 'ingress-supervisor', qualifiedId: 'happier.channels/background/ingress-supervisor' },
          occurrenceId: 'topic-provider-fixture', sourceCustody: { kind: 'development', registeredRootId: 'topic-fixture' },
          materialization: telegramExecutionOrigin.materializationRef },
        signal,
        // Genuine HTTP and credential-materialization boundaries; the provider parser and core are real.
        services: { connectedAccounts: { materialize: async () => ({ kind: 'environment', env: { TELEGRAM_BOT_TOKEN: '12345:fixture-token' } }) },
          http: { request: async (request: Readonly<{ url: string }>) => {
            let result: JsonValue;
            if (request.url.endsWith('/getMe')) result = { id: 12345, is_bot: true, first_name: 'Happier', username: 'happier_bot', can_read_all_group_messages: true };
            else if (request.url.endsWith('/getUpdates')) {
              const index = pollNumber++;
              result = index === 0 ? [] : [{ update_id: 9000 + index, message: {
                message_id: index + 4, message_thread_id: 7, is_topic_message: true, date: Math.floor(Date.now() / 1000),
                chat: { id: 100, type: 'supergroup', title: 'Forum', is_forum: true },
                from: { id: index === 3 ? 99 : 42, is_bot: false, first_name: 'Ada' },
                text: `topic message ${index}`,
              } }];
            } else throw new Error(`Unexpected Telegram endpoint ${request.url}`);
            return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/json' },
              body: new TextEncoder().encode(JSON.stringify({ ok: true, result })) };
          } },
        } as unknown as PluginInvocationContext['services'],
      });
      },
    });
    routerFixture(harness.rows);
    const router = harness.rows.get('binding-1');
    if (router === undefined) throw new Error('Missing router');
    const payload = record(router.value.payload);
    const target = record(payload.target);
    harness.rows.set(router.rowId, stateRow({ ...router.value, payload: { ...payload,
      endpoint: { kind: 'shared', audience: 'shared', id: '100' },
      target: { ...target, principalGroups: [{ id: 'sales', principalIds: ['42'] }] },
    } }));
    replaceConnectionPayload(harness.rows, { providerConfig: { botUsername: 'happier_bot', canReadAllGroupMessages: true } });
    for (let index = 0; index < 4; index += 1) await runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context);
    expect(bornSessions.size).toBe(1);
    expect(harness.send.mock.calls.map(([request]) => sentUserTextRequest(request).text)).toEqual(['topic message 1', 'topic message 2']);
    expect(heldThreadPollBindings).toMatchObject([0, 1].map(() => [{
      endpoint: { kind: 'thread', audience: 'shared', id: '100:7', parentId: '100' },
      excludedMessageIds: ['5'],
    }]));
    const children = [...harness.rows.values()].filter(row => record(row.value.payload).parentBindingId === 'binding-1');
    expect(children).toHaveLength(1);
    expect(children[0]?.value.payload).toMatchObject({ endpoint: { kind: 'thread', id: '100:7', parentId: '100' },
      target: { sessionId: 'session-2' }, allowedPrincipalIds: ['42'] });
  });

  it('does not bind a Session whose birth attestation was not persisted', async () => {
    const harness = createIngressHarness({ connection: socketChannelConnection(), availableSessionIds: ['session-2'], execute: threadSpawnBoundary });
    routerFixture(harness.rows);
    await expect(ingestConversationProviderObservationForInvocation(topicObservation('missing-birth'), harness.context))
      .rejects.toMatchObject({ code: 'channels_thread_attestation_unavailable' });
    expect(harness.send).not.toHaveBeenCalled();
    expect([...harness.rows.values()].filter(row => record(row.value.payload).parentBindingId === 'binding-1')).toHaveLength(0);
  });

  it('spawns a forum topic once and admits replay/follow-up through an ordinary sender-only child', async () => {
    const harness = createIngressHarness({ connection: socketChannelConnection(), availableSessionIds: ['session-2'], execute: threadSpawnWithBirthBoundary });
    routerFixture(harness.rows);
    const first = topicObservation('topic-first', 'telegram:user:42', undefined, 'Furniture lead');
    const admit = async (input: ConversationProviderObservationIngestInputV1) => {
      try {
        await ingestConversationProviderObservationForInvocation(input, harness.context);
      } catch (cause) {
        const custody = [...harness.rows.values()]
          .filter(row => row.value['record-kind'] === 'ingress-obligation')
          .map(row => {
            const payload = record(row.value.payload);
            return { lifecycle: payload.lifecycle, disposition: payload.disposition, nonAdmission: payload.nonAdmission };
          });
        throw new Error(`Forum ingress ${fullTextIngress(input).occurrenceId} at ${Date.now()}: ${JSON.stringify(custody)}`, { cause });
      }
    };
    await admit(first);
    await admit(first);
    await admit(topicObservation('topic-follow-up'));
    const children = [...harness.rows.values()].filter(row => record(row.value.payload).parentBindingId === 'binding-1');
    expect(children).toHaveLength(1);
    expect(children[0]?.value.payload).toMatchObject({
      endpoint: { label: 'Furniture lead' },
      target: { kind: 'session', sessionId: 'session-2' }, allowedPrincipalIds: ['telegram:user:42'],
    });
    expect(harness.send.mock.calls.map(([request]) => sentUserTextRequest(request).text)).toEqual(['Hello from Telegram', 'Hello from Telegram']);
    const births = harness.execute.mock.calls.filter(([action]) => action === 'session.spawn_new');
    expect(births).toHaveLength(1);
    expect(births[0]?.[1]).toMatchObject({ title: 'Furniture lead' });
    await ingestConversationProviderObservationForInvocation(topicObservation('other-sender', 'telegram:user:43'), harness.context);
    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it('records unmatched routes without spawning or retaining their content', async () => {
    const harness = createIngressHarness({ connection: socketChannelConnection() });
    routerFixture(harness.rows, true);
    const input = topicObservation('unmatched', 'telegram:user:42', undefined, 'Rejected private subject');
    Object.assign(fullTextIngress(input).endpoint, { parentLabel: 'Rejected private mailbox' });
    await ingestConversationProviderObservationForInvocation(input, harness.context);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation');
    expect(obligation?.value.payload).toMatchObject({ target: null, nonAdmission: { reason: 'routeNotMatched', senderFeedbackEligible: false } });
    await runConversationIngressRetentionForInvocation({}, harness.context);
    const census = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-census');
    expect(JSON.stringify(census?.value)).not.toContain('Hello from Telegram');
    expect(JSON.stringify(census?.value)).not.toContain('Rejected private');
  });

  it('stops children when their router is disabled and rejoins its creation key after child deletion', async () => {
    const harness = createIngressHarness({ connection: socketChannelConnection(), availableSessionIds: ['session-2'], execute: threadSpawnWithBirthBoundary });
    routerFixture(harness.rows);
    await ingestConversationProviderObservationForInvocation(topicObservation('first'), harness.context);
    const child = [...harness.rows.values()].find(row => record(row.value.payload).parentBindingId === 'binding-1');
    expect(child).toBeDefined();
    if (child === undefined) throw new Error('Missing child');
    const router = harness.rows.get('binding-1');
    if (router === undefined) throw new Error('Missing router');
    harness.rows.set(router.rowId, stateRow({ ...router.value, payload: { ...record(router.value.payload), enabled: false } }, router.revision + 1));
    await ingestConversationProviderObservationForInvocation(topicObservation('disabled'), harness.context);
    expect(harness.send).toHaveBeenCalledTimes(1);
    harness.rows.set(router.rowId, stateRow(router.value, router.revision + 2));
    harness.rows.delete(child.rowId);
    for (const row of harness.rows.values()) if (row.value['record-kind'] === 'projection-frontier' && row.value['binding-id'] === child.rowId) harness.rows.delete(row.rowId);
    await ingestConversationProviderObservationForInvocation(topicObservation('after-delete'), harness.context);
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.execute.mock.calls.filter(([action]) => action === 'session.spawn_new')).toHaveLength(2);
    const replacement = [...harness.rows.values()].find(row => record(row.value.payload).parentBindingId === 'binding-1');
    expect(replacement?.value.payload).toMatchObject({ target: { sessionId: 'session-2' } });
  });

  it('converges simultaneous first topic messages and preserves the first matching route', async () => {
    const keys = new Set<string>();
    const harness = createIngressHarness({ connection: socketChannelConnection(), availableSessionIds: ['session-2'], execute: (actionId, input) => {
      if (actionId === 'session.spawn_new') {
        const request = record(input);
        expect(record(request.directory).path).toBe('/workspace/channels');
        if (typeof request.creationKey !== 'string') throw new Error('Missing creation key');
        keys.add(request.creationKey);
      }
      return threadSpawnWithBirthBoundary(actionId, input);
    } });
    routerFixture(harness.rows);
    const router = harness.rows.get('binding-1');
    if (router === undefined) throw new Error('Missing router');
    const payload = record(router.value.payload);
    const target = record(payload.target);
    const routes = target.routes;
    if (!Array.isArray(routes)) throw new Error('Missing routes');
    const first = record(routes[0]);
    harness.rows.set(router.rowId, stateRow({ ...router.value, payload: { ...payload, target: { ...target,
      routes: [...routes, { ...first, id: 'later', when: { group: 'questions', forwarded: 'any' },
        recipe: { ...record(first.recipe), directory: { kind: 'path', path: '/wrong-route' } } }],
    } } }));
    await Promise.all([
      ingestConversationProviderObservationForInvocation(topicObservation('concurrent-a'), harness.context),
      ingestConversationProviderObservationForInvocation(topicObservation('concurrent-b'), harness.context),
    ]);
    expect(keys.size).toBe(1);
    expect([...harness.rows.values()].filter(row => record(row.value.payload).parentBindingId === 'binding-1')).toHaveLength(1);
    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it('keeps a competing sender out of a Session born for the winning sender', async () => {
    let birth: JsonValue | undefined;
    const harness = createIngressHarness({ connection: socketChannelConnection(), availableSessionIds: ['session-2'], execute: (actionId, input) => {
      if (actionId === 'session.spawn_new') {
        const request = record(input);
        const created = birth === undefined;
        birth ??= request.attestedContext as JsonValue;
        return { type: 'success', disposition: created ? 'created' : 'rejoined', sessionId: 'session-2', attestedContext: birth,
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' }, organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
      }
      return threadSpawnBoundary(actionId, input);
    } });
    routerFixture(harness.rows);
    const router = harness.rows.get('binding-1');
    if (router === undefined) throw new Error('Missing router');
    const payload = record(router.value.payload);
    const target = record(payload.target);
    const routes = target.routes;
    if (!Array.isArray(routes)) throw new Error('Missing routes');
    harness.rows.set(router.rowId, stateRow({ ...router.value, payload: { ...payload, target: { ...target,
      routes: routes.map(route => ({ ...record(route), when: { group: 'any', forwarded: 'any' } })),
    } } }));
    await Promise.all([
      ingestConversationProviderObservationForInvocation(topicObservation('author-a', 'telegram:user:42', 'Message from A'), harness.context),
      ingestConversationProviderObservationForInvocation(topicObservation('author-b', 'telegram:user:43', 'Message from B'), harness.context),
    ]);
    // Either concurrent caller can win the host's creation key; only that
    // immutable birth principal may become the ordinary child audience.
    const origin = record(birth).externalPrincipalId;
    expect(['telegram:user:42', 'telegram:user:43']).toContain(origin);
    const children = [...harness.rows.values()].filter(row => record(row.value.payload).parentBindingId === 'binding-1');
    expect(children).toHaveLength(1);
    expect(children[0]?.value.payload).toMatchObject({ allowedPrincipalIds: [origin] });
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(sentUserTextRequest(harness.send.mock.calls[0]?.[0]).text)
      .toBe(origin === 'telegram:user:42' ? 'Message from A' : 'Message from B');
    expect([...harness.rows.values()].filter(row => row.value['record-kind'] === 'ingress-obligation').map(row => record(row.value.payload).nonAdmission))
      .toContainEqual({ reason: 'actorNotAllowed', senderFeedbackEligible: false });
  });
});

function threadSpawnWithBirthBoundary(actionId: string, input: JsonValue): JsonValue {
  const result = threadSpawnBoundary(actionId, input);
  if (actionId !== 'session.spawn_new') return result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected Session creation result');
  return { ...result, attestedContext: { externalPrincipalId: 'telegram:user:42', sourceMessageId: 'telegram:message:5' } };
}

function encodedJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** A deployment-published limit set, the basis a plugin actually plans against. */
function deploymentLimits(
  input: Readonly<{ maxBatchRows: number; maxBatchBytes: number }>,
): PluginCollectionLimits {
  return {
    maxRowEncodedBytes: 512 * 1024,
    maxRows: 10_000,
    maxCollectionEncodedBytes: 256 * 1024 * 1024,
    maxBatchBytes: input.maxBatchBytes,
    maxBatchRows: input.maxBatchRows,
    maxAccountRows: 10_000,
    maxAccountBytes: 256 * 1024 * 1024,
    basis: 'deployment',
  };
}

/**
 * The Account Data owner measures `[fence, ...puts]`; this mirrors that shape
 * so the packer is exercised on the decomposition it consumes in production.
 */
function measurementFor(
  values: readonly unknown[],
  putEncodedBytes: number,
): PluginCollectionBatchMeasurement {
  return {
    overheadEncodedBytes: 298,
    operationEncodedBytes: [88, ...values.map(() => putEncodedBytes)],
  };
}

describe('Conversation provider observation ingress', () => {
  it('refuses a socket worker without its captured connection generation', async () => {
    const harness = createIngressHarness({ connection: socketChannelConnection() });
    const { authorityEpoch: _missing, ...input } = observation({ messageRevision: 'old-worker', transport: 'socket' });
    await expect(ingestConversationProviderObservationForInvocation(
      input, harness.context,
    )).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });
    expect(harness.send).not.toHaveBeenCalled();
  });
  it('admits the current socket generation but refuses the retired worker after a generation change', async () => {
    const harness = createIngressHarness({ connection: socketChannelConnection() });
    await ingestConversationProviderObservationForInvocation({
      ...observation({ messageRevision: 'socket-current', transport: 'socket' }), authorityEpoch: 4,
    }, harness.context);
    expect(harness.send).toHaveBeenCalledOnce();
    advanceConnectionAuthorityEpoch(harness.rows);
    const replacement = observation({ messageRevision: 'socket-next', transport: 'socket',
      occurrenceId: 'socket:next', messageId: 'socket:message:next' });
    await expect(ingestConversationProviderObservationForInvocation({
      ...replacement, authorityEpoch: 4,
    }, harness.context)).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });
    expect(harness.send).toHaveBeenCalledOnce();
    await ingestConversationProviderObservationForInvocation({ ...replacement, authorityEpoch: 5 }, harness.context);
    expect(harness.send).toHaveBeenCalledTimes(2);
  });
  it.each([0, 59_999, 31 * 86_400_000])('admits a current observation with representable freshness %s', async maximumObservationAgeMs => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const harness = createIngressHarness();
      replaceConnectionPayload(harness.rows, { maximumObservationAgeMs });
      await ingestConversationProviderObservationForInvocation(observation({ messageRevision: 'freshness:1', occurredAt: now }), harness.context);
      expect(harness.send).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('includes attachment descriptors in compacted occurrence replay identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      const input = observation({ messageRevision: 'files:compacted', occurredAt: 1_000 });
      Object.assign(fullTextIngress(input).message, { attachments: [{ attachmentId: 'part-1', name: 'lead.png', mediaType: 'image/png' }] });
      await ingestConversationProviderObservationForInvocation(input, harness.context);
      markIngressCensusCheckpointCovered(harness.rows, 1_000);
      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context)).resolves.toMatchObject({ compactedCensuses: 1 });
      await expect(ingestConversationProviderObservationForInvocation(input, harness.context)).resolves.toBeUndefined();
      const changed = structuredClone(input);
      Object.assign(fullTextIngress(changed).message, { attachments: [{ attachmentId: 'part-2', name: 'different.png', mediaType: 'image/png' }] });
      await expect(ingestConversationProviderObservationForInvocation(changed, harness.context)).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
      expect(harness.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['Hello from Telegram', ''])('admits file descriptors through the declared Session attachment lifecycle once across replay (text=%j)', async text => {
    const harness = createIngressHarness();
    const input = observation({ messageRevision: 'files:1' });
    const fullText = fullTextIngress(input);
    Object.assign(fullText.message, { text, attachments: [{ attachmentId: 'part-2', name: 'lead.png', mediaType: 'image/png' }] });
    await ingestConversationProviderObservationForInvocation(input, harness.context);
    await ingestConversationProviderObservationForInvocation(input, harness.context);
    const request = sentUserTextRequest(harness.send.mock.calls[0]?.[0]);
    expect(request.text).toBe(text);
    expect(request.attachments).toEqual([expect.objectContaining({
      attachmentLocalId: 'channel-file',
      value: expect.objectContaining({
        value: expect.objectContaining({ connectionId: 'connection-1', messageId: fullText.message.id, descriptor: expect.objectContaining({ attachmentId: 'part-2' }) }),
      }),
    })]);
    expect(harness.send).toHaveBeenCalledTimes(1);
    const obligation = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation');
    expect(record(obligation?.value.payload).disposition).toBe('admitted');
  });

  it('restores an archived Session before admitting a new message to the same binding target', async () => {
    let archived = true;
    const harness = createIngressHarness({
      sessionSummary: (id) => ({
        id, state: archived ? 'archived' : 'idle', runtimeAvailability: archived
          ? { status: 'unavailable', code: 'session_archived' } : { status: 'available' },
        storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1,
      }),
      sessionSend: async () => archived
        ? { status: 'rejected', code: 'session_input_archived' }
        : { status: 'accepted', localId: 'restored-input' },
      execute: async (actionId, input) => {
        expect([actionId, input]).toEqual(['session.unarchive', { sessionId: 'session-1' }]);
        archived = false;
        return { ok: true };
      },
    });
    const input = observation({ messageRevision: 'archive:1' });
    await ingestConversationProviderObservationForInvocation(input, harness.context);
    await ingestConversationProviderObservationForInvocation(input, harness.context);
    const obligation = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation');
    expect(obligation?.value.payload).toMatchObject({
      disposition: 'admitted', sessionInput: { sessionId: 'session-1', localId: 'restored-input' },
    });
    expect(archived).toBe(false);
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('keeps archived Session input retryable when the canonical unarchive Action fails', async () => {
    const harness = createIngressHarness({
      sessionSummary: (id) => ({
        id, state: 'archived', runtimeAvailability: { status: 'unavailable', code: 'session_archived' },
        storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1,
      }),
      execute: () => ({ ok: false, errorCode: 'unavailable' }),
    });
    await expect(ingestConversationProviderObservationForInvocation(
      observation({ messageRevision: 'archive:failed' }), harness.context,
    )).rejects.toMatchObject({ code: 'channels_ingress_session_unavailable', retryable: true });
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation');
    expect(obligation?.value.terminal).toBe(false);
  });

  it('retains each accepted Session input identity with its exact provider reply relation across replay and compaction', async () => {
    const harness = createIngressHarness({
      connection: socketChannelConnection(),
      sessionSendResults: [
        { status: 'accepted', localId: 'local-M1' },
        { status: 'accepted', localId: 'local-M2' },
      ],
    });
    for (const ordinal of [1, 2]) {
      const input = observation({ occurrenceId: `socket:M${ordinal}`, messageId: `M${ordinal}`, messageRevision: '1', transport: 'socket' });
      await ingestConversationProviderObservationForInvocation(input, harness.context);
      await ingestConversationProviderObservationForInvocation(input, harness.context);
    }
    expect(harness.send).toHaveBeenCalledTimes(2);
    const relations = () => [...harness.rows.values()]
      .filter(row => row.value['record-kind'] === 'ingress-obligation')
      .map(row => record(row.value.payload).sessionInput);
    expect(relations()).toEqual(expect.arrayContaining([
      { sessionId: 'session-1', localId: 'local-M1', projectedReplySeq: null },
      { sessionId: 'session-1', localId: 'local-M2', projectedReplySeq: null },
    ]));
    const account = harness.context.services.storage.account;
    if (!account) throw new Error('Expected admitted Account storage');
    const stateCollection = account.collection(CHANNEL_STATE_COLLECTION);
    const replyRelations = await readConversationSessionInputReplyRelations({ stateCollection,
      bindingId: 'binding-1', connectionId: 'connection-1', sessionId: 'session-1', consumedLocalIds: ['local-M1'],
      signal: harness.context.signal });
    expect(replyRelations).toHaveLength(1);
    await markConversationSessionInputRepliesProjected({ stateCollection, relations: replyRelations,
      seq: 2, signal: harness.context.signal });
    const projected = harness.rows.get(replyRelations[0]!.row.rowId);
    if (!projected) throw new Error('Expected projected reply relation');
    const validator = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    expect(isValidPluginJsonSchemaValue(validator, projected.value)).toBe(true);
    await runConversationIngressRetentionForInvocation({ now: Date.now() }, harness.context);
    expect(relations()).toHaveLength(2);
    await runConversationIngressRetentionForInvocation({ now: Date.now() + 31 * 86_400_000 }, harness.context);
    expect(relations()).toHaveLength(2);
  });
  it.each<Readonly<{ label: string; result: JsonValue }>>([
    { label: 'native success', result: { ok: true } },
    { label: 'acknowledged CLI request', result: { requested: true } },
  ])('cancels the bound turn once for /stop, bypasses debounce, and rejoins after reload ($label)', async ({ result }) => {
    const harness = createIngressHarness({
      execute: (): JsonValue => result,
    });
    const binding = channelBinding();
    harness.rows.set(binding.id, stateRow({
      ...binding, payload: { ...binding.payload, inboundDebounceMs: 5_000 },
    }));
    const command = observation({ messageRevision: 'stop:1', messageText: '/stop' });
    await ingestConversationProviderObservationForInvocation(command, harness.context);
    expect(harness.execute.mock.calls).toEqual([
      ['session.turn.cancel', { sessionId: 'session-1' }],
    ]);
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
    expect(obligation?.value.payload).toMatchObject({
      target: { kind: 'session', sessionId: 'session-1', stop: true },
      lifecycle: { phase: 'terminal' }, disposition: 'admitted',
    });
    const acknowledgement = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'outward-delivery');
    expect(acknowledgement?.value).toMatchObject({
      payload: { source: { kind: 'controlResponse', controlKind: 'stop' }, state: 'ready' },
    });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), obligation?.value)).toBe(true);
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_DELIVERIES_COLLECTION.schema), acknowledgement?.value)).toBe(true);
    const reloaded = createIngressHarness({ execute: () => { throw new Error('Must not cancel again'); } });
    for (const [id, row] of harness.rows) reloaded.rows.set(id, row);
    await ingestConversationProviderObservationForInvocation(command, reloaded.context);
    expect(reloaded.execute).not.toHaveBeenCalled();
    expect(reloaded.send).not.toHaveBeenCalled();
    expect([...reloaded.rows.values()].filter((row) => row.value['record-kind'] === 'outward-delivery')).toHaveLength(1);
  });

  it.each(['forwarded', 'viaBot', 'bot'] as const)('admits %s /stop as ordinary text with the binding debounce', async (provenance) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const harness = createIngressHarness();
      const binding = channelBinding();
      harness.rows.set(binding.id, stateRow({
        ...binding, payload: { ...binding.payload, allowBotSenders: true, inboundDebounceMs: 750 },
      }));
      const original = observation({
        messageRevision: `stop:${provenance}`, messageText: '/stop', transport: 'socket',
        contentProvenance: provenance === 'bot' ? 'original' : provenance,
      });
      const observed = fullTextIngress(original);
      const command = provenance === 'bot' ? {
        ...original,
        entry: { ...original.entry, observation: {
          kind: 'fullText' as const,
          observation: { ...observed, actor: { ...observed.actor, kind: 'bot' as const } },
        } },
      } : original;
      harness.rows.set('connection-1', stateRow(socketChannelConnection()));
      await ingestConversationProviderObservationForInvocation(command, harness.context);
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      vi.setSystemTime(1_750);
      await runConversationIngressDueWorkForInvocation({}, harness.context);
      expect(sentUserTextRequest(harness.send.mock.calls[0]?.[0]).text).toBe('/stop');
      expect(harness.execute).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('refuses /stop from a non-allowlisted principal and for an Automation target', async () => {
    for (const targetKind of ['notAllowed', 'automation'] as const) {
      const harness = createIngressHarness();
      const binding = channelBinding();
      harness.rows.set(binding.id, stateRow({
        ...binding, payload: {
          ...binding.payload,
          ...(targetKind === 'notAllowed' ? { allowedPrincipalIds: ['telegram:user:99'] } : {
            target: { kind: 'automation', automationId: 'automation-1', policy: { resultDelivery: 'none' } },
          }),
        },
      }));
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'stop:refused', messageText: '/stop' }), harness.context,
      );
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      const obligation = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
      expect(obligation?.value.payload).toMatchObject({
        lifecycle: { phase: 'terminal' }, disposition: 'rejected',
        nonAdmission: { reason: targetKind === 'notAllowed' ? 'actorNotAllowed' : 'commandNotAuthorized' },
      });
    }
  });

  it.each<Readonly<{ label: string; result: JsonValue }>>([
    { label: 'no active turn', result: { ok: false, errorCode: 'no_active_turn' } },
    { label: 'empty result', result: {} },
    { label: 'malformed acknowledgement', result: { requested: 'true' } },
    { label: 'explicit refusal beside acknowledgement', result: { ok: false, requested: true } },
  ])('settles a /stop refusal through control custody without admitting it as input ($label)', async ({ result }) => {
    const harness = createIngressHarness({ execute: (): JsonValue => result });
    const command = observation({ messageRevision: 'stop:idle', messageText: '/stop' });
    await ingestConversationProviderObservationForInvocation(command, harness.context);
    await ingestConversationProviderObservationForInvocation(command, harness.context);
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
    expect(obligation?.value.payload).toMatchObject({ disposition: 'rejected', nonAdmission: { reason: 'targetUnavailable' } });
    expect([...harness.rows.values()].filter((row) => row.value['record-kind'] === 'outward-delivery')).toHaveLength(1);
  });

  it('never repeats /stop after cancellation succeeds but terminal settlement is lost', async () => {
    let failSettlement = true;
    const harness = createIngressHarness({
      execute: () => ({ ok: true }),
      beforeBatch: ({ operations }) => {
        if (failSettlement && operations.some((operation) => isIngressObligationPhase(operation, 'terminal'))) {
          failSettlement = false;
          throw new Error('Lost terminal settlement');
        }
      },
    });
    const command = observation({ messageRevision: 'stop:lost', messageText: '/stop' });
    await expect(ingestConversationProviderObservationForInvocation(command, harness.context)).rejects.toThrow('Lost terminal settlement');
    await ingestConversationProviderObservationForInvocation(command, harness.context);
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
    expect(obligation?.value.payload).toMatchObject({ lifecycle: { phase: 'terminal' }, disposition: 'admitted' });
  });

  it('never repeats /stop when cancellation succeeds but its result cannot be recorded', async () => {
    let loseResultWrite = false;
    const harness = createIngressHarness({
      execute: () => { loseResultWrite = true; return { ok: true }; },
      beforeBatch: () => {
        if (loseResultWrite) {
          loseResultWrite = false;
          throw new Error('Cancellation result write lost');
        }
      },
    });
    const command = observation({ messageRevision: 'stop:result-lost', messageText: '/stop' });
    await expect(ingestConversationProviderObservationForInvocation(command, harness.context)).rejects.toThrow('Cancellation result write lost');
    await ingestConversationProviderObservationForInvocation(command, harness.context);
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
    expect(obligation?.value.payload).toMatchObject({ lifecycle: { phase: 'terminal' }, disposition: 'rejected' });
    expect([...harness.rows.values()].filter((row) => row.value['record-kind'] === 'outward-delivery')).toHaveLength(1);
  });

  it('never retries an ambiguous /stop cancellation through the ingress due-work pump', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const harness = createIngressHarness({ execute: () => { throw new Error('Cancellation response lost'); } });
      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'stop:unknown', messageText: '/stop' }), harness.context,
      )).rejects.toThrow('Cancellation response lost');
      vi.setSystemTime(100_000);
      await runConversationIngressDueWorkForInvocation({}, harness.context);
      expect(harness.execute).toHaveBeenCalledTimes(1);
      expect(harness.send).not.toHaveBeenCalled();
      const obligation = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
      expect(obligation?.value.payload).toMatchObject({ lifecycle: { phase: 'terminal' }, disposition: 'rejected' });
      expect([...harness.rows.values()].filter((row) => row.value['record-kind'] === 'outward-delivery')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('recovers /stop acknowledgement custody after cancellation settlement without cancelling again', async () => {
    let refuseCustody = true;
    const harness = createIngressHarness({
      execute: () => ({ ok: true }),
      beforeCollectionPut: ({ value }) => {
        if (refuseCustody && value['record-kind'] === 'outward-delivery') {
          refuseCustody = false;
          throw new Error('Custody unavailable');
        }
      },
    });
    const command = observation({ messageRevision: 'stop:custody', messageText: '/stop' });
    await expect(ingestConversationProviderObservationForInvocation(command, harness.context)).rejects.toMatchObject({
      code: 'channels_ingress_admission_unsettled',
    });
    await ingestConversationProviderObservationForInvocation(command, harness.context);
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
    expect(obligation?.value.payload).toMatchObject({ lifecycle: { phase: 'terminal' }, disposition: 'admitted' });
    expect([...harness.rows.values()].filter((row) => row.value['record-kind'] === 'outward-delivery')).toHaveLength(1);
  });

  it('reschedules /stop custody recovery at the existing deadline without repeating cancellation', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const harness = createIngressHarness({
        execute: () => ({ ok: true }),
        beforeCollectionPut: ({ value }) => {
          if (value['record-kind'] === 'outward-delivery') throw new Error('Custody unavailable');
        },
      });
      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'stop:retry-custody', messageText: '/stop' }), harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled' });
      vi.setSystemTime(100_000);
      await runConversationIngressDueWorkForInvocation({}, harness.context);
      expect(harness.execute).toHaveBeenCalledTimes(1);
      expect(harness.send).not.toHaveBeenCalled();
      const obligation = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
      expect(obligation?.value.payload).toMatchObject({ lifecycle: { phase: 'attempting' }, stopOutcome: 'cancelled' });
      expect(obligation?.value['due-at']).toBeGreaterThan(100_000);
    } finally { vi.useRealTimers(); }
  });

  it('terminalizes blocked custody during connection and binding deletion, while retaining attempting custody', async () => {
    const harness = createIngressHarness({
      sessionSendResult: {
        status: 'outcomeUnknown',
        localId: 'pending-delete-blocked',
        code: 'session_admission_outcome_unknown',
      },
    });
    await expect(ingestConversationProviderObservationForInvocation(
      observation({ messageRevision: 'delete-blocked' }),
      harness.context,
    )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled' });
    const current = [...harness.rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
    if (current === undefined) throw new Error('Expected a retained ingress obligation.');
    const { ['due-at']: _dueAt, ...currentWithoutDueAt } = current.value;
    const blockedValue = {
      ...currentWithoutDueAt,
      attention: true,
      terminal: false,
      payload: {
        ...record(current.value.payload),
        lifecycle: { phase: 'blocked', attemptCount: 3, dueAt: null },
        disposition: null,
        nonAdmission: null,
      },
    };
    expect(prepareConversationIngressObligationForConnectionDeletion({
      rowId: current.rowId,
      revision: current.revision,
      value: blockedValue,
      now: 2_000,
    })).toMatchObject({ kind: 'readyToSettle', connectionId: 'connection-1' });
    expect(prepareConversationIngressObligationForBindingDeletion({
      rowId: current.rowId,
      revision: current.revision,
      value: blockedValue,
      now: 2_000,
    })).toMatchObject({ kind: 'readyToSettle', connectionId: 'connection-1', bindingId: 'binding-1' });

    const attemptingValue = {
      ...blockedValue,
      attention: false,
      payload: {
        ...record(blockedValue.payload),
        lifecycle: { phase: 'attempting', attemptCount: 3, dueAt: null },
      },
    };
    expect(prepareConversationIngressObligationForConnectionDeletion({
      rowId: current.rowId,
      revision: current.revision,
      value: attemptingValue,
      now: 2_000,
    })).toMatchObject({ kind: 'blocked', connectionId: 'connection-1' });
  });
  it('admits text beyond the former UTF-8 ceiling through the schema and Session boundary', async () => {
    const input = observation({
      messageRevision: 'utf8-overflow:1',
      messageText: '😀'.repeat(20_000),
    });
    const manifestValidator = compilePluginJsonSchema(ConversationProviderObservationIngestInputV1JsonSchema);
    const harness = createIngressHarness();

    expect(isValidPluginJsonSchemaValue(manifestValidator, input)).toBe(true);
    expect(ConversationProviderObservationIngestInputV1Schema.safeParse(input).success).toBe(true);

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context)).resolves.toBeUndefined();
    expect(sentUserTextRequest(harness.send.mock.calls[0]?.[0]).text).toBe(fullTextIngress(input).message.text);
  });

  it('rejects a retained UTF-8-overflow allowlist before census or Session admission', async () => {
    const harness = createIngressHarness();
    const existing = harness.rows.get('binding-1');
    if (existing === undefined) throw new Error('Expected the bound Channel state row.');
    const binding = record(existing.value);
    const payload = record(binding.payload);
    harness.rows.set(existing.rowId, stateRow({
      ...binding,
      payload: {
        ...payload,
        allowedPrincipalIds: ['telegram:user:42', '😀'.repeat(128)],
      },
    }, existing.revision + 1));

    await expect(ingestConversationProviderObservationForInvocation(
      observation({ messageRevision: 'retained-utf8-overflow:1' }),
      harness.context,
    )).rejects.toMatchObject({ code: 'channels_binding_set_enabled_corrupt' });

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.rows).toHaveLength(2);
  });

  it('normalizes zero, one, and multi-binding census replays into one immutable canonical set', () => {
    const base = {
      censusId: 'D'.repeat(43),
      connectionId: 'connection-1',
      ingress: observation({
        messageRevision: 'edit:1',
      }).entry.observation,
      connectionAuthorityEpoch: 4,
      maximumObservationAgeMs: 120_000,
      now: 1,
    } as const;

    expect(createIngressCensusValue({ ...base, matchedBindings: [] })).toMatchObject({
      id: base.censusId,
      'record-kind': 'ingress-census',
      'connection-id': base.connectionId,
      payload: {
        normalizedIngress: {
          kind: 'fullText',
          observation: expect.objectContaining({
            occurrenceId: 'telegram:update:9001',
            message: expect.objectContaining({ text: expect.any(String) }),
          }),
        },
        phase: 'preparing',
        connectionAuthorityEpoch: 4,
        maximumObservationAgeMs: 120_000,
        checkpointCoveredAt: null,
        conflict: null,
        matchedBindings: [],
      },
    });

    expect(createIngressCensusValue({
      ...base,
      matchedBindings: [{
        bindingId: 'binding-1',
        bindingRevision: 3,
        bindingAuthorityEpoch: 7,
      }],
    }).payload).toEqual({
      normalizedIngress: expect.any(Object),
      compacted: null,
      phase: 'preparing',
      connectionAuthorityEpoch: 4,
      maximumObservationAgeMs: 120_000,
      checkpointCoveredAt: null,
      conflict: null,
      eventCandidate: null,
      matchedBindings: [{
        bindingId: 'binding-1',
        bindingRevision: 3,
        bindingAuthorityEpoch: 7,
      }],
    });

    const first = createIngressCensusValue({
      ...base,
      matchedBindings: [
        { bindingId: 'binding-z', bindingRevision: 9, bindingAuthorityEpoch: 11 },
        { bindingId: 'binding-a', bindingRevision: 2, bindingAuthorityEpoch: 5 },
      ],
    });
    const replay = createIngressCensusValue({
      ...base,
      matchedBindings: [
        { bindingId: 'binding-a', bindingRevision: 2, bindingAuthorityEpoch: 5 },
        { bindingId: 'binding-z', bindingRevision: 9, bindingAuthorityEpoch: 11 },
      ],
    });

    expect(replay).toEqual(first);
    expect(first.payload).toEqual({
      normalizedIngress: expect.any(Object),
      compacted: null,
      phase: 'preparing',
      connectionAuthorityEpoch: 4,
      maximumObservationAgeMs: 120_000,
      checkpointCoveredAt: null,
      conflict: null,
      eventCandidate: null,
      matchedBindings: [
        { bindingId: 'binding-a', bindingRevision: 2, bindingAuthorityEpoch: 5 },
        { bindingId: 'binding-z', bindingRevision: 9, bindingAuthorityEpoch: 11 },
      ],
    });
    expect(createIngressCensusValue({
      ...base,
      connectionAuthorityEpoch: 5,
      matchedBindings: [
        { bindingId: 'binding-a', bindingRevision: 2, bindingAuthorityEpoch: 5 },
        { bindingId: 'binding-z', bindingRevision: 9, bindingAuthorityEpoch: 11 },
      ],
    })).not.toEqual(first);
    expect(createIngressCensusValue({
      ...base,
      matchedBindings: [
        { bindingId: 'binding-a', bindingRevision: 3, bindingAuthorityEpoch: 5 },
        { bindingId: 'binding-z', bindingRevision: 9, bindingAuthorityEpoch: 11 },
      ],
    })).not.toEqual(first);
    expect(createIngressCensusValue({
      ...base,
      matchedBindings: [
        { bindingId: 'binding-a', bindingRevision: 2, bindingAuthorityEpoch: 6 },
        { bindingId: 'binding-z', bindingRevision: 9, bindingAuthorityEpoch: 11 },
      ],
    })).not.toEqual(first);
    expect(() => createIngressCensusValue({
      ...base,
      matchedBindings: [
        { bindingId: 'binding-a', bindingRevision: 2, bindingAuthorityEpoch: 5 },
        { bindingId: 'binding-a', bindingRevision: 3, bindingAuthorityEpoch: 6 },
      ],
    })).toThrowError(expect.objectContaining({ code: 'channels_ingress_census_binding_duplicate' }));
  });

  it('derives one connection-keyed ingress-census identity for an occurrence replay', async () => {
    const base = {
      routingIdentityKey: 'r'.repeat(43),
      connectionId: 'connection-1',
      occurrenceId: 'telegram:update:9001',
    } as const;

    const first = await deriveIngressCensusRowId(base);
    expect(first).toBe('g75ITGbEZT_9TqAet-NS6tMuD3Pi7f-bIfJnz2LtlIk');
    await expect(deriveIngressCensusRowId(base)).resolves.toBe(first);
    await expect(deriveIngressCensusRowId({ ...base, connectionId: 'connection-2' }))
      .resolves.not.toBe(first);
    await expect(deriveIngressCensusRowId({ ...base, occurrenceId: 'telegram:update:9002' }))
      .resolves.not.toBe(first);

    await expect(deriveIngressCensusRowId({ ...base, routingIdentityKey: 'not-base64url%' }))
      .rejects.toMatchObject({ code: 'channels_ingress_routing_key_invalid', retryable: false });
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(deriveIngressCensusRowId(base))
        .rejects.toMatchObject({ code: 'channels_ingress_crypto_unavailable', retryable: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps census and per-binding obligation identities in distinct ingress domains', async () => {
    const harness = createIngressHarness();

    await expect(ingestConversationProviderObservationForInvocation(
      observation({ messageRevision: 'edit:1' }),
      harness.context,
    )).resolves.toBeUndefined();

    const census = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-census',
    );
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(census?.rowId).toBe('g75ITGbEZT_9TqAet-NS6tMuD3Pi7f-bIfJnz2LtlIk');
    expect(census?.value.payload).toMatchObject({ phase: 'prepared' });
    expect(obligation?.rowId).toBe('V-VqzKZdr9-a-9crPZOQ3B1dDoTSouTmAsXNBxJTvrs');
    expect(obligation?.rowId).not.toBe(census?.rowId);
  });

  it('fills a 256-binding preparation up to the operations the deployment admits', () => {
    const values = Array.from({ length: 256 }, (_, index) => ({
      id: `obligation-${index}`,
      payload: { padding: 'x'.repeat(96) },
    }));
    const measurement = measurementFor(values, 1_200);
    const batches = partitionIngressPreparationValues({
      values,
      limits: deploymentLimits({ maxBatchRows: 100, maxBatchBytes: 16 * 1024 * 1024 }),
      measurement,
    });

    expect(batches.flat()).toEqual(values);
    // One fence assert plus ninety-nine puts is the whole atomic batch.
    expect(batches.map((batch) => batch.length)).toEqual([99, 99, 58]);
  });

  it('keeps a deployment-sized checkpointed-poll settlement within the supplied batch budget', () => {
    const limits = deploymentLimits({ maxBatchRows: 100, maxBatchBytes: 8 * 1024 * 1024 });
    const encodedJsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const maximumConnectionBase = {
      id: 'connection-1',
      'record-kind': 'connection',
      payload: { padding: '' },
    };
    const maximumConnectionValue = {
      ...maximumConnectionBase,
      payload: { padding: 'x'.repeat(limits.maxRowEncodedBytes - encodedJsonBytes(maximumConnectionBase)) },
    };
    const checkpointToken = 'x'.repeat(48 * 1024);
    const censusAssertionIds = Array.from({ length: 98 }, (_, index) => (
      `census-${String(index).padStart(3, '0')}-${'x'.repeat(245)}`
    ));

    expect(encodedJsonBytes(maximumConnectionValue)).toBe(limits.maxRowEncodedBytes);
    expect(encodedJsonBytes(checkpointToken)).toBe(48 * 1024 + 2);
    expect(censusAssertionIds).toHaveLength(98);
    expect(censusAssertionIds.every((rowId) => encodedJsonBytes(rowId) - 2 === 256)).toBe(true);

    const request = {
      pluginId: 'happier.channels',
      collectionId: 'channel-state',
      writerContext: { schemaVersion: 2, contractDigest: 'a'.repeat(43) },
      operations: [
        {
          kind: 'put',
          rowId: 'connection-1',
          expectedRevision: 17,
          content: { t: 'plain', v: maximumConnectionValue },
          projection: {},
        },
        ...censusAssertionIds.map((rowId) => ({ kind: 'assert' as const, rowId, expectedRevision: 23 })),
        {
          kind: 'put',
          rowId: 'checkpoint-1',
          expectedRevision: 19,
          content: { t: 'plain', v: { opaqueToken: checkpointToken } },
          projection: {},
        },
      ],
    } as const;

    expect(request.operations).toHaveLength(limits.maxBatchRows);
    expect(encodedJsonBytes(request)).toBeLessThan(limits.maxBatchBytes);
  });

  it('packs near-limit private rows to the measured byte budget without overfilling a batch', () => {
    const values = Array.from({ length: 35 }, (_, index) => ({
      id: `${String(index).padStart(2, '0')}${'A'.repeat(41)}`,
      payload: { padding: 'x'.repeat(180_000) },
    }));
    // A sealed 180 KB private row costs about a third more on the wire than its
    // plaintext, which is exactly the expansion a plugin must not guess.
    const putEncodedBytes = 240_400;
    const limits = deploymentLimits({ maxBatchRows: 100, maxBatchBytes: 4 * 1024 * 1024 });
    const measurement = measurementFor(values, putEncodedBytes);
    const batches = partitionIngressPreparationValues({ values, limits, measurement });

    expect(batches.flat()).toEqual(values);
    const budget = limits.maxBatchBytes
      - measurement.overheadEncodedBytes
      - measurement.operationEncodedBytes[0]!;
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(limits.maxBatchRows - 1);
      expect(batch.length * putEncodedBytes).toBeLessThanOrEqual(budget);
    }
    // Maximal packing: every batch but the last is one put short of overflowing.
    for (const batch of batches.slice(0, -1)) {
      expect((batch.length + 1) * putEncodedBytes).toBeGreaterThan(budget);
    }
    expect(batches.map((batch) => batch.length)).toEqual([17, 17, 1]);
  });

  it('refuses a single preparation value the deployment cannot carry in one batch', () => {
    const values = [{ id: `${'A'.repeat(43)}`, payload: { padding: 'x'.repeat(4_000_000) } }];

    expect(() => partitionIngressPreparationValues({
      values,
      limits: deploymentLimits({ maxBatchRows: 100, maxBatchBytes: 1024 * 1024 }),
      measurement: measurementFor(values, 5_400_000),
    })).toThrow(PluginError);
  });

  it('settles an empty immutable census without fabricating an admission obligation', async () => {
    const harness = createIngressHarness();
    removeStateRow(harness.rows, 'binding-1');
    const input = observation({
      messageRevision: 'edit:1',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .resolves.toBeUndefined();

    expect(harness.send).not.toHaveBeenCalled();
    const census = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-census',
    );
    expect(census?.value.payload).toMatchObject({ matchedBindings: [] });
    expect([...harness.rows.values()].some(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    )).toBe(false);
    expect([...harness.rows.values()].some(
      (row) => row.value['record-kind'] === 'checkpoint',
    )).toBe(false);
  });

  it('absent-CASes the preparing census alone under the exact connection revision before any obligation', async () => {
    let censusBatch: readonly CollectionMutation[] | undefined;
    const harness = createIngressHarness({
      beforeBatch: ({ rows, operations }) => {
        if (!operations.some(isIngressCensusPut)) return;
        censusBatch = operations;
        reviseStateRow(rows, 'connection-1');
      },
    });
    const input = observation({
      messageRevision: 'edit:1',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_stale_authority', retryable: true });

    expect(censusBatch).toBeDefined();
    const assertions = censusBatch!.filter((operation) => operation.kind === 'assert');
    expect(assertions).toEqual([
      { kind: 'assert', rowId: 'connection-1', expectedRevision: 1 },
    ]);
    const censusIndex = censusBatch!.findIndex(isIngressCensusPut);
    const firstObligationIndex = censusBatch!.findIndex((operation) => (
      operation.kind === 'put' && operation.value['record-kind'] === 'ingress-obligation'
    ));
    expect(censusBatch![censusIndex]).toMatchObject({ expectedRevision: 'absent' });
    expect(censusIndex).toBeGreaterThan(-1);
    expect(firstObligationIndex).toBe(-1);
    expect(harness.send).not.toHaveBeenCalled();
    expect([...harness.rows.values()].some(
      (row) => row.value['record-kind'] === 'ingress-census'
        || row.value['record-kind'] === 'ingress-obligation',
    )).toBe(false);
  });

  it('marks a mismatched winning absent-census race as an immutable occurrence conflict', async () => {
    const connection = channelConnection();
    const original = observation({
      messageRevision: 'absent-race:original',
      occurrenceId: 'telegram:update:absent-race',
    });
    const winner = observation({
      messageRevision: 'absent-race:winner',
      occurrenceId: fullTextIngress(original).occurrenceId,
      occurredAt: fullTextIngress(original).occurredAt,
    });
    const censusId = await deriveIngressCensusRowId({
      routingIdentityKey: connection.payload.routingIdentityKey,
      connectionId: connection.id,
      occurrenceId: fullTextIngress(original).occurrenceId,
    });
    const winningCensus = createIngressCensusValue({
      censusId,
      connectionId: connection.id,
      ingress: winner.entry.observation,
      connectionAuthorityEpoch: connection.payload.authorityEpoch,
      maximumObservationAgeMs: connection.payload.maximumObservationAgeMs,
      matchedBindings: [{
        bindingId: 'binding-1',
        bindingRevision: 1,
        bindingAuthorityEpoch: 7,
      }],
      now: Date.now(),
    });
    let winnerInserted = false;
    let conflictBatch: readonly CollectionMutation[] | undefined;
    const harness = createIngressHarness({
      connection,
      beforeBatch: ({ rows, operations }) => {
        if (!winnerInserted && operations.some((operation) => (
          operation.kind === 'put'
          && operation.expectedRevision === 'absent'
          && operation.value['record-kind'] === 'ingress-census'
        ))) {
          winnerInserted = true;
          rows.set(censusId, stateRow(winningCensus));
        }
        if (operations.some((operation) => (
          operation.kind === 'put'
          && operation.value['record-kind'] === 'ingress-census'
          && operation.value.attention === true
        ))) {
          conflictBatch = operations;
        }
      },
    });

    await expect(ingestConversationProviderObservationForInvocation(original, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict', retryable: false });

    expect(winnerInserted).toBe(true);
    expect(conflictBatch).toEqual([
      { kind: 'put', value: connection, expectedRevision: 1 },
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 1,
        value: expect.objectContaining({
          'record-kind': 'ingress-census',
          attention: true,
          payload: expect.objectContaining({
            conflict: { kind: 'occurrenceEvidenceMismatch' },
          }),
        }),
      }),
    ]);
    expect(harness.rows.get(censusId)?.value).toMatchObject({
      attention: true,
      payload: { conflict: { kind: 'occurrenceEvidenceMismatch' } },
    });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rejoins the whole first census without appending a subsequently added matching binding', async () => {
    const harness = createIngressHarness();
    const first = observation({
      messageRevision: 'edit:1',
    });
    await ingestConversationProviderObservationForInvocation(first, harness.context);
    addMatchingBinding(harness.rows);

    const replay = observation({
      messageRevision: 'edit:1',
      occurredAt: fullTextIngress(first).occurredAt,
    });
    await expect(ingestConversationProviderObservationForInvocation(replay, harness.context))
      .resolves.toBeUndefined();

    expect(harness.send).toHaveBeenCalledTimes(1);
    const census = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-census',
    );
    expect(census?.value.payload).toMatchObject({
      matchedBindings: [{ bindingId: 'binding-1', bindingRevision: 1, bindingAuthorityEpoch: 7 }],
    });
    expect([...harness.rows.values()].filter(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    )).toHaveLength(1);
  });

  it('replays an interrupted >99-member census with its frozen connection facts across an epoch and policy change', async () => {
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      let preparationBatches = 0;
      let interrupted = false;
      const harness = createIngressHarness({
        beforeBatch: ({ operations }) => {
          if (!operations.some((operation) => (
            operation.kind === 'put' && operation.value['record-kind'] === 'ingress-obligation'
          ))) return;
          preparationBatches += 1;
          if (!interrupted && preparationBatches === 2) {
            interrupted = true;
            throw new Error('simulated ingress preparation interruption');
          }
        },
      });
      replaceConnectionPayload(harness.rows, { maximumObservationAgeMs: 120_000 });
      for (let index = 2; index <= 100; index += 1) {
        addMatchingBinding(harness.rows, `binding-${index}`);
      }
      const input = observation({
        messageRevision: 'interrupted-census:1',
        occurredAt: now - 90_000,
      });

      await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
        .rejects.toThrow('simulated ingress preparation interruption');

      expect(preparationBatches).toBe(2);
      const interruptedCensus = [...harness.rows.values()].find(
        (row) => row.value['record-kind'] === 'ingress-census',
      );
      expect(record(interruptedCensus?.value.payload).matchedBindings).toHaveLength(100);
      const interruptedObligations = [...harness.rows.values()].filter(
        (row) => row.value['record-kind'] === 'ingress-obligation',
      );
      expect(interruptedObligations.length).toBeGreaterThan(0);
      expect(interruptedObligations.length).toBeLessThan(100);
      replaceConnectionPayload(harness.rows, {
        authorityEpoch: 5,
        maximumObservationAgeMs: 60_000,
      });

      await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
        .resolves.toBeUndefined();

      const census = [...harness.rows.values()].find(
        (row) => row.value['record-kind'] === 'ingress-census',
      );
      expect(census?.value.payload).toMatchObject({
        phase: 'prepared',
        connectionAuthorityEpoch: 4,
      });
      const obligations = [...harness.rows.values()].filter(
        (row) => row.value['record-kind'] === 'ingress-obligation',
      );
      expect(obligations).toHaveLength(100);
      for (const obligation of obligations) {
        expect(obligation.value.payload).toMatchObject({
          sourceAuthority: { connectionAuthorityEpoch: 4 },
          lifecycle: { phase: 'terminal' },
          disposition: 'staleAuthority',
        });
      }
      expect(census?.value.payload).toMatchObject({ maximumObservationAgeMs: 120_000 });
      expect(harness.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays an interrupted census with its frozen observation-age policy when its connection epoch is unchanged', async () => {
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      let preparationBatches = 0;
      let interrupted = false;
      const harness = createIngressHarness({
        beforeBatch: ({ operations }) => {
          if (!operations.some((operation) => (
            operation.kind === 'put' && operation.value['record-kind'] === 'ingress-obligation'
          ))) return;
          preparationBatches += 1;
          if (!interrupted && preparationBatches === 2) {
            interrupted = true;
            throw new Error('simulated ingress preparation interruption');
          }
        },
      });
      replaceConnectionPayload(harness.rows, { maximumObservationAgeMs: 120_000 });
      for (let index = 2; index <= 100; index += 1) {
        addMatchingBinding(harness.rows, `binding-${index}`);
      }
      const input = observation({
        messageRevision: 'interrupted-policy-census:1',
        occurredAt: now - 90_000,
      });

      await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
        .rejects.toThrow('simulated ingress preparation interruption');

      expect(preparationBatches).toBe(2);
      replaceConnectionPayload(harness.rows, { maximumObservationAgeMs: 60_000 });

      await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
        .resolves.toBeUndefined();

      const obligations = [...harness.rows.values()].filter(
        (row) => row.value['record-kind'] === 'ingress-obligation',
      );
      expect(obligations).toHaveLength(100);
      for (const obligation of obligations) {
        expect(obligation.value.payload).toMatchObject({
          sourceAuthority: { connectionAuthorityEpoch: 4 },
          lifecycle: { phase: 'terminal' },
          disposition: 'admitted',
        });
      }
      expect(harness.send).toHaveBeenCalledTimes(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminalizes bodyless non-admission and writes eligible refusal custody without Session admission', async () => {
    const harness = createIngressHarness();
    setBindingSenderFeedback(harness.rows, 'eligibleRefusals');
    const input = routableNonAdmission({
      messageRevision: 'edit:1',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .resolves.toBeUndefined();

    expect(harness.send).not.toHaveBeenCalled();
    const ingressObligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(ingressObligation?.value).toMatchObject({
      terminal: true,
      attention: true,
      payload: {
        lifecycle: { phase: 'terminal' },
        disposition: 'rejected',
        nonAdmission: { reason: 'messageTooLarge', senderFeedbackEligible: true },
        censusId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    });
    const ingressPayload = record(ingressObligation?.value.payload);
    const census = harness.rows.get(String(ingressPayload.censusId));
    const normalizedInput = record(record(census?.value.payload).normalizedIngress);
    expect(record(record(normalizedInput.shell).message)).not.toHaveProperty('text');

    const refusalCustody = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(refusalCustody?.value).toMatchObject({
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      terminal: false,
      attention: false,
      payload: {
        source: { kind: 'controlResponse', controlKind: 'refusal' },
        state: 'ready',
        content: { text: 'This message could not be admitted.' },
      },
    });
  });

  it('writes a mediating ingress obligation the shipped Collection schema accepts', async () => {
    // The in-memory harness accepts any JSON, but the real Account Collection
    // closes the frozen Session-target branch with `additionalProperties:
    // false`. Validate the writer's own row against the shipped schema so an
    // undeclared frozen field fails here instead of only against a live Account.
    const validateChannelState = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const harness = createIngressHarness({
      execute: async (actionId): Promise<JsonValue> => {
        if (actionId === 'session.permission.remote.pending.list') {
          return { requests: [], truncated: false, nextCursor: null };
        }
        throw new Error(`Unexpected Action '${actionId}'.`);
      },
    });
    setBindingApprovalEnabled(harness.rows, { maximumScope: 'session' });
    // Exactly the largest identifier the command classifier admits, so the
    // admitted and persisted approval bounds cannot drift apart silently.
    const maximalRequestId = 'r'.repeat(MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES);

    await ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-schema:1',
      messageText: `/allow ${maximalRequestId} session`,
    }), harness.context);

    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(record(record(obligation?.value.payload).target)).toMatchObject({
      remoteApprovalMaxScope: 'session',
      approval: { requestId: maximalRequestId, decision: 'allow', scope: 'session' },
    });
    expect(isValidPluginJsonSchemaValue(validateChannelState, obligation?.value)).toBe(true);
  });

  it('refuses an approval request id past the bound the frozen obligation can persist', async () => {
    // Ingress text is bounded at 64 KiB while the frozen approval the writer
    // persists is bounded at the canonical Permission request-id contract. An
    // admitted oversized `/allow` would make the whole census batch fail its
    // admitted Collection schema, and that write has no settlement: the
    // observation would be re-ingested forever and hold the poll checkpoint.
    const validateChannelState = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const harness = createIngressHarness({
      execute: async (actionId): Promise<JsonValue> => {
        throw new Error(`An unpersistable approval request must not reach ${actionId}.`);
      },
    });
    setBindingApprovalEnabled(harness.rows, { maximumScope: 'session' });

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-oversized:1',
      messageText: `/allow ${'r'.repeat(MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES + 1)} session`,
    }), harness.context)).resolves.toBeUndefined();

    expect(harness.execute).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'rejected',
      nonAdmission: { reason: 'malformedCommand' },
    });
    expect(record(record(obligation?.value.payload).target).approval).toBeNull();
    expect(isValidPluginJsonSchemaValue(validateChannelState, obligation?.value)).toBe(true);
  });

  it('refuses an approval command when the persisted binding policy leaves approvals off', async () => {
    const harness = createIngressHarness();

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval:1',
      messageText: '/allow permission-request-1 session',
    }), harness.context)).resolves.toBeUndefined();

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'rejected',
      nonAdmission: { reason: 'commandNotAuthorized', senderFeedbackEligible: false },
    });
    expect([...harness.rows.values()].some(
      (row) => row.value['record-kind'] === 'outward-delivery',
    )).toBe(false);
  });

  it('refuses an approval command from a principal outside the approval subset', async () => {
    const harness = createIngressHarness();
    setBindingApprovalEnabled(harness.rows, { principalIds: ['telegram:user:99'] });

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-subset:1',
      messageText: '/allow permission-request-1',
    }), harness.context)).resolves.toBeUndefined();

    expect(harness.execute).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      disposition: 'rejected',
      nonAdmission: { reason: 'commandNotAuthorized' },
    });
  });

  it('stamps the persisted binding approval ceiling on ordinary Session admission', async () => {
    const harness = createIngressHarness();
    setBindingApprovalEnabled(harness.rows, { maximumScope: 'session' });

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-source:1',
    }), harness.context)).resolves.toBeUndefined();

    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        sourceRef: 'channels:binding:binding-1',
        sourceRevisionOrEpoch: '4:7',
        remoteApprovalMaxScope: 'session',
        requestedPermissionCeiling: 'read-only',
      }),
    }), { signal: harness.context.signal });
  });

  it('stamps an off approval ceiling when the persisted policy leaves approvals off', async () => {
    const harness = createIngressHarness();

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-source-off:1',
    }), harness.context)).resolves.toBeUndefined();

    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ remoteApprovalMaxScope: 'off' }),
    }), { signal: harness.context.signal });
  });

  it('mediates an admitted /allow through the canonical exact-turn Permission Actions', async () => {
    const actionCalls: Array<Readonly<{ actionId: string; input: JsonValue }>> = [];
    const harness = createIngressHarness({
      execute: async (actionId, input): Promise<JsonValue> => {
        actionCalls.push({ actionId, input });
        if (actionId === 'session.permission.remote.pending.list') {
          return {
            requests: [
              pendingPermissionRequest({
                requestId: 'permission-request-0',
                turnId: 'turn-1',
                createdAtMs: 1,
                allowedScopes: ['request'],
              }),
              pendingPermissionRequest({
                requestId: 'permission-request-1',
                turnId: 'turn-9',
                createdAtMs: 2,
                allowedScopes: ['request', 'session'],
              }),
            ],
            truncated: false,
            nextCursor: null,
          };
        }
        if (actionId === 'session.permission.remote.respond') {
          return {
            status: 'applied',
            settlementId: 'settlement-1',
            requestId: 'permission-request-1',
            decision: 'allow',
            effect: { kind: 'allowOnce' },
          };
        }
        throw new Error(`Unexpected Action '${actionId}'.`);
      },
    });
    setBindingApprovalEnabled(harness.rows, { maximumScope: 'session' });

    const binding = record(harness.rows.get('binding-1')?.value);
    harness.rows.set('binding-1', stateRow({
      ...binding,
      payload: { ...record(binding.payload), inboundDebounceMs: 5_000 },
    }));

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-command:1',
      messageText: '/allow permission-request-1',
    }), harness.context)).resolves.toBeUndefined();

    // No Session input: an approval command is mediation, never transcript text.
    expect(harness.send).not.toHaveBeenCalled();
    expect(actionCalls.map((call) => call.actionId)).toEqual([
      'session.permission.remote.pending.list',
      'session.permission.remote.respond',
    ]);
    expect(actionCalls[0]?.input).toEqual({
      sessionId: 'session-1',
      sourceRef: 'channels:binding:binding-1',
      sourceRevisionOrEpoch: '4:7',
    });
    expect(actionCalls[1]?.input).toEqual({
      sessionId: 'session-1',
      sourceRef: 'channels:binding:binding-1',
      sourceRevisionOrEpoch: '4:7',
      turnId: 'turn-9',
      requestId: 'permission-request-1',
      idempotencyKey: expect.stringMatching(/^channels:approval:v1:[A-Za-z0-9_-]{43}$/),
      actor: { namespace: 'happier.channel.telegram', principalId: 'telegram:user:42' },
      decision: 'allow',
      scope: 'request',
    });
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'approvalConsumed',
      nonAdmission: null,
    });
    const acknowledgement = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(acknowledgement?.value).toMatchObject({
      'binding-id': 'binding-1',
      payload: {
        source: { kind: 'controlResponse', controlKind: 'approval' },
        state: 'ready',
        content: { text: 'Approved the pending permission request.' },
      },
    });
  });

  it('mediates an admitted /answer through the canonical exact-turn user-action Action', async () => {
    const actionCalls: Array<Readonly<{ actionId: string; input: JsonValue }>> = [];
    const harness = createIngressHarness({
      execute: async (actionId, input): Promise<JsonValue> => {
        actionCalls.push({ actionId, input });
        if (actionId === 'session.permission.remote.pending.list') {
          return {
            requests: [{
              kind: 'user_action',
              requestId: 'question-request-1',
              turnId: 'turn-question-9',
              createdAtMs: 2,
              agentRequestSummary: {
                kind: 'user_action',
                questions: [{
                  question: 'Select the release mode',
                  selection: 'single',
                  required: true,
                  allowCustom: false,
                  choices: ['safe', 'fast'],
                }],
              },
            }],
            truncated: false,
            nextCursor: null,
          };
        }
        if (actionId === 'session.user_action.remote.answer') {
          return { status: 'applied', requestId: 'question-request-1' };
        }
        throw new Error(`Unexpected Action '${actionId}'.`);
      },
    });
    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'user-action-command:1',
      messageText: '/answer question-request-1 [{"questionIndex":0,"values":["fast"]}]',
    }), harness.context)).resolves.toBeUndefined();

    // A user-action answer is mediated control, never ordinary Session text.
    expect(harness.send).not.toHaveBeenCalled();
    expect(actionCalls.map((call) => call.actionId)).toEqual([
      'session.permission.remote.pending.list',
      'session.user_action.remote.answer',
    ]);
    expect(actionCalls[0]?.input).toEqual({
      sessionId: 'session-1',
      sourceRef: 'channels:binding:binding-1',
      sourceRevisionOrEpoch: '4:7',
    });
    expect(actionCalls[1]?.input).toEqual({
      sessionId: 'session-1',
      sourceRef: 'channels:binding:binding-1',
      sourceRevisionOrEpoch: '4:7',
      turnId: 'turn-question-9',
      requestId: 'question-request-1',
      answers: [{ questionIndex: 0, values: ['fast'] }],
    });
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'userActionConsumed',
      approvalTurnId: null,
      userActionAnswerTurnId: 'turn-question-9',
      nonAdmission: null,
    });
    const acknowledgement = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(acknowledgement?.value).toMatchObject({
      'binding-id': 'binding-1',
      payload: {
        source: { kind: 'controlResponse', controlKind: 'userAction' },
        state: 'ready',
        content: { text: 'That question is no longer pending.' },
      },
    });
  });

  it('replays a lost /answer result through its frozen exact user-action tuple', async () => {
    const actionCalls: Array<Readonly<{ actionId: string; input: JsonValue }>> = [];
    let questionStillPending = true;
    let loseAnswerResponse = true;
    const harness = createIngressHarness({
      execute: async (actionId, input): Promise<JsonValue> => {
        actionCalls.push({ actionId, input });
        if (actionId === 'session.permission.remote.pending.list') {
          return questionStillPending
            ? {
              requests: [{
                kind: 'user_action',
                requestId: 'question-request-1',
                turnId: 'turn-question-9',
                createdAtMs: 2,
                agentRequestSummary: {
                  kind: 'user_action',
                  questions: [{
                    question: 'Select the release mode',
                    selection: 'single',
                    required: true,
                    allowCustom: false,
                    choices: ['safe', 'fast'],
                  }],
                },
              }],
              truncated: false,
              nextCursor: null,
            }
            : { requests: [], truncated: false, nextCursor: null };
        }
        if (actionId !== 'session.user_action.remote.answer') {
          throw new Error(`Unexpected Action '${actionId}'.`);
        }
        // The owner accepted the answer, then its response was lost before
        // Channels could write sender-visible custody.
        questionStillPending = false;
        if (loseAnswerResponse) {
          loseAnswerResponse = false;
          throw new Error('Simulated answer response loss after the accepted effect.');
        }
        return { status: 'rejected', code: 'requestNotPending' };
      },
    });
    setBindingApprovalEnabled(harness.rows);
    const command = observation({
      messageRevision: 'user-action-lost-response:1',
      messageText: '/answer question-request-1 [{"questionIndex":0,"values":["fast"]}]',
    });

    await expect(ingestConversationProviderObservationForInvocation(command, harness.context))
      .rejects.toThrow();
    markIngressObligationAttempting(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(command, harness.context))
      .resolves.toBeUndefined();

    // The retained host turn bypasses a now-empty projection and re-enters the
    // one canonical Action. `requestNotPending` is intentionally neutral: it
    // may mean our accepted answer or a concurrent completion, never a lookup.
    expect(actionCalls.map((call) => call.actionId)).toEqual([
      'session.permission.remote.pending.list',
      'session.user_action.remote.answer',
      'session.user_action.remote.answer',
    ]);
    expect(actionCalls[2]?.input).toEqual(actionCalls[1]?.input);
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'rejected',
      userActionAnswerTurnId: 'turn-question-9',
      nonAdmission: { reason: 'targetUnavailable' },
    });
    const acknowledgements = [...harness.rows.values()].filter(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(acknowledgements).toHaveLength(1);
  });

  it('does not re-answer a consumed approval when the same observation replays after restart', async () => {
    const actionIds: string[] = [];
    const harness = createIngressHarness({
      execute: async (actionId): Promise<JsonValue> => {
        actionIds.push(actionId);
        if (actionId === 'session.permission.remote.pending.list') {
          return {
            requests: [pendingPermissionRequest({
              requestId: 'permission-request-1',
              turnId: 'turn-9',
              createdAtMs: 2,
              allowedScopes: ['request'],
            })],
            truncated: false,
            nextCursor: null,
          };
        }
        return {
          status: 'applied',
          settlementId: 'settlement-1',
          requestId: 'permission-request-1',
          decision: 'allow',
          effect: { kind: 'allowOnce' },
        };
      },
    });
    setBindingApprovalEnabled(harness.rows);
    const replayed = observation({
      messageRevision: 'approval-replay:1',
      messageText: '/allow permission-request-1',
    });

    await ingestConversationProviderObservationForInvocation(replayed, harness.context);
    expect(actionIds).toEqual([
      'session.permission.remote.pending.list',
      'session.permission.remote.respond',
    ]);

    // A restart replays the same durable observation. The consumed obligation
    // is terminal, so no second verdict reaches the canonical mediation owner.
    await ingestConversationProviderObservationForInvocation(replayed, harness.context);

    expect(actionIds).toEqual([
      'session.permission.remote.pending.list',
      'session.permission.remote.respond',
    ]);
    const obligations = [...harness.rows.values()].filter(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'approvalConsumed',
    });
    expect([...harness.rows.values()].filter(
      (row) => row.value['record-kind'] === 'outward-delivery',
    )).toHaveLength(1);
  });

  it('passes an explicit Session scope to the mediation owner without narrowing it', async () => {
    const respondInputs: JsonValue[] = [];
    const harness = createIngressHarness({
      execute: async (actionId, input): Promise<JsonValue> => {
        if (actionId === 'session.permission.remote.pending.list') {
          return {
            requests: [pendingPermissionRequest({
              requestId: 'permission-request-1',
              turnId: 'turn-9',
              createdAtMs: 2,
              allowedScopes: ['request'],
            })],
            truncated: false,
            nextCursor: null,
          };
        }
        respondInputs.push(input);
        return { status: 'rejected', code: 'scopeExceedsPolicy' };
      },
    });
    // The owner ceiling is deliberately narrower than the requested scope.
    setBindingApprovalEnabled(harness.rows, { maximumScope: 'request' });

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-scope:1',
      messageText: '/allow permission-request-1 session',
    }), harness.context)).resolves.toBeUndefined();

    expect(respondInputs).toEqual([expect.objectContaining({ scope: 'session' })]);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'rejected',
      nonAdmission: { reason: 'targetUnavailable', senderFeedbackEligible: false },
    });
    const acknowledgement = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(acknowledgement).toBeDefined();
  });

  it('re-answers the exact stored turn when the mediated decision committed but its acknowledgement was lost', async () => {
    // The remote effect is the irreversible half of a chat approval. If the
    // canonical owner commits it and the response never reaches Channels, the
    // replay must reach that same idempotent owner tuple instead of asking a
    // projection that can no longer see the answered request.
    const actionCalls: Array<Readonly<{ actionId: string; input: JsonValue }>> = [];
    let requestStillPending = true;
    let loseRespondResponse = true;
    const harness = createIngressHarness({
      execute: async (actionId, input): Promise<JsonValue> => {
        actionCalls.push({ actionId, input });
        if (actionId === 'session.permission.remote.pending.list') {
          return requestStillPending
            ? {
              requests: [pendingPermissionRequest({
                requestId: 'permission-request-1',
                turnId: 'turn-9',
                createdAtMs: 2,
                allowedScopes: ['request'],
              })],
              truncated: false,
              nextCursor: null,
            }
            : { requests: [], truncated: false, nextCursor: null };
        }
        if (actionId !== 'session.permission.remote.respond') {
          throw new Error(`Unexpected Action '${actionId}'.`);
        }
        // The canonical owner applies and durably records the decision.
        requestStillPending = false;
        if (loseRespondResponse) {
          loseRespondResponse = false;
          throw new Error('Simulated mediation response loss after the committed effect.');
        }
        return {
          status: 'alreadyApplied',
          settlementId: 'settlement-1',
          requestId: 'permission-request-1',
          decision: 'allow',
          effect: { kind: 'allowOnce' },
        };
      },
    });
    setBindingApprovalEnabled(harness.rows);
    const command = observation({
      messageRevision: 'approval-lost-response:1',
      messageText: '/allow permission-request-1',
    });

    await expect(ingestConversationProviderObservationForInvocation(command, harness.context))
      .rejects.toThrow();
    expect(actionCalls.map((call) => call.actionId)).toEqual([
      'session.permission.remote.pending.list',
      'session.permission.remote.respond',
    ]);
    expect([...harness.rows.values()].some(
      (row) => row.value['record-kind'] === 'outward-delivery',
    )).toBe(false);

    // The daemon dies mid-attempt and restarts against the same durable rows.
    markIngressObligationAttempting(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(command, harness.context))
      .resolves.toBeUndefined();

    expect(actionCalls.map((call) => call.actionId)).toEqual([
      'session.permission.remote.pending.list',
      'session.permission.remote.respond',
      'session.permission.remote.respond',
    ]);
    expect(actionCalls[2]?.input).toEqual(actionCalls[1]?.input);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'approvalConsumed',
      nonAdmission: null,
    });
    const acknowledgements = [...harness.rows.values()].filter(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(acknowledgements).toHaveLength(1);
  });

  it('continues the bounded pending projection until it reaches the admitted request', async () => {
    // The canonical projection answers in bounded keyset pages. A person whose
    // request sorts behind the first page must still be able to approve it
    // instead of waiting for every older request in the session to settle.
    const cursors: Array<string | null> = [];
    const respondInputs: JsonValue[] = [];
    const harness = createIngressHarness({
      execute: async (actionId, input): Promise<JsonValue> => {
        if (actionId === 'session.permission.remote.pending.list') {
          const cursor = record(input).cursor;
          cursors.push(typeof cursor === 'string' ? cursor : null);
          if (cursor === undefined) {
            return {
              requests: Array.from({ length: 32 }, (_unused, index) => pendingPermissionRequest({
                requestId: `older-request-${index}`,
                turnId: `turn-${index}`,
                createdAtMs: index + 1,
                allowedScopes: ['request'],
              })),
              truncated: false,
              nextCursor: 'page-2',
            };
          }
          return {
            requests: [pendingPermissionRequest({
              requestId: 'permission-request-1',
              turnId: 'turn-9',
              createdAtMs: 64,
              allowedScopes: ['request'],
            })],
            truncated: false,
            nextCursor: null,
          };
        }
        respondInputs.push(input);
        return {
          status: 'applied',
          settlementId: 'settlement-1',
          requestId: 'permission-request-1',
          decision: 'allow',
          effect: { kind: 'allowOnce' },
        };
      },
    });
    setBindingApprovalEnabled(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-paged:1',
      messageText: '/allow permission-request-1',
    }), harness.context)).resolves.toBeUndefined();

    expect(cursors).toEqual([null, 'page-2']);
    expect(respondInputs).toEqual([expect.objectContaining({
      turnId: 'turn-9',
      requestId: 'permission-request-1',
    })]);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'approvalConsumed',
    });
    const acknowledgement = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(acknowledgement).toBeDefined();
  });

  it('keeps custody when the pending projection cannot advance its own continuation', async () => {
    // A continuation that repeats itself is a broken owner response. Channels
    // must not loop on it, and must not read the incomplete walk as proof the
    // admitted request is gone.
    let listCalls = 0;
    const harness = createIngressHarness({
      execute: async (actionId): Promise<JsonValue> => {
        if (actionId !== 'session.permission.remote.pending.list') {
          throw new Error(`An unfinished projection must not reach ${actionId}.`);
        }
        listCalls += 1;
        return {
          requests: [pendingPermissionRequest({
            requestId: 'older-request',
            turnId: 'turn-1',
            createdAtMs: 1,
            allowedScopes: ['request'],
          })],
          truncated: false,
          nextCursor: 'stuck',
        };
      },
    });
    setBindingApprovalEnabled(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-stuck-cursor:1',
      messageText: '/allow permission-request-1',
    }), harness.context)).rejects.toThrow();

    expect(listCalls).toBe(2);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'retryDue' },
      disposition: null,
    });
    expect([...harness.rows.values()].some(
      (row) => row.value['record-kind'] === 'outward-delivery',
    )).toBe(false);
  });

  it('retries an approval whose request is absent from a truncated pending projection', async () => {
    const actionIds: string[] = [];
    const harness = createIngressHarness({
      execute: async (actionId): Promise<JsonValue> => {
        actionIds.push(actionId);
        if (actionId === 'session.permission.remote.pending.list') {
          return { requests: [], truncated: true };
        }
        throw new Error(`A truncated projection must not reach ${actionId}.`);
      },
    });
    setBindingApprovalEnabled(harness.rows);

    // An unsettled admission stays retryable at the ingest boundary; the
    // obligation is what carries the bounded retry, not a mediation-local timer.
    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-truncated:1',
      messageText: '/deny permission-request-1',
    }), harness.context)).rejects.toMatchObject({
      code: 'channels_ingress_admission_unsettled',
      retryable: true,
    });

    expect(actionIds).toEqual(['session.permission.remote.pending.list']);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'retryDue' },
      disposition: null,
    });
    expect([...harness.rows.values()].some(
      (row) => row.value['record-kind'] === 'outward-delivery',
    )).toBe(false);
  });

  it('settles an approval as no-longer-pending on a complete negative projection', async () => {
    const actionIds: string[] = [];
    const harness = createIngressHarness({
      execute: async (actionId): Promise<JsonValue> => {
        actionIds.push(actionId);
        if (actionId === 'session.permission.remote.pending.list') {
          return { requests: [], truncated: false, nextCursor: null };
        }
        throw new Error(`A complete negative projection must not reach ${actionId}.`);
      },
    });
    setBindingApprovalEnabled(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-absent:1',
      messageText: '/deny permission-request-1',
    }), harness.context)).resolves.toBeUndefined();

    expect(actionIds).toEqual(['session.permission.remote.pending.list']);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'rejected',
      nonAdmission: { reason: 'targetUnavailable' },
    });
    const acknowledgement = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(acknowledgement).toBeDefined();
  });

  it('acknowledges a mediated /deny and consumes the ingress obligation', async () => {
    const harness = createIngressHarness({
      execute: async (actionId): Promise<JsonValue> => {
        if (actionId === 'session.permission.remote.pending.list') {
          return {
            requests: [pendingPermissionRequest({
              requestId: 'permission-request-1',
              turnId: 'turn-9',
              createdAtMs: 2,
              allowedScopes: ['request'],
            })],
            truncated: false,
            nextCursor: null,
          };
        }
        return {
          status: 'alreadyApplied',
          settlementId: 'settlement-2',
          requestId: 'permission-request-1',
          decision: 'deny',
          effect: { kind: 'deny' },
        };
      },
    });
    setBindingApprovalEnabled(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-deny:1',
      messageText: '/deny permission-request-1',
    }), harness.context)).resolves.toBeUndefined();

    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'approvalConsumed',
    });
    const acknowledgement = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(acknowledgement).toBeDefined();
  });

  it('settles a definitely refused mediation call instead of re-observing the message forever', async () => {
    let respondCalls = 0;
    const harness = createIngressHarness({
      execute: async (actionId): Promise<JsonValue> => {
        if (actionId === 'session.permission.remote.pending.list') {
          return {
            requests: [pendingPermissionRequest({
              requestId: 'permission-request-1',
              turnId: 'turn-9',
              createdAtMs: 2,
              allowedScopes: ['request'],
            })],
            truncated: false,
            nextCursor: null,
          };
        }
        respondCalls += 1;
        // A definite Action-boundary refusal, e.g. an input the canonical
        // Permission schema rejects outright.
        throw new PluginError({
          code: 'invalid_parameters',
          message: 'Permission respond input is invalid.',
          retryable: false,
        });
      },
    });
    setBindingApprovalEnabled(harness.rows);

    // The ingest boundary settles rather than throwing, so the connection
    // checkpoint can advance past a command that can never succeed.
    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-invalid:1',
      messageText: '/allow permission-request-1',
    }), harness.context)).resolves.toBeUndefined();

    expect(respondCalls).toBe(1);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'rejected',
      nonAdmission: { reason: 'targetUnavailable' },
    });
    const acknowledgement = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'outward-delivery',
    );
    expect(acknowledgement).toBeDefined();
  });

  it('retries an approval when the mediation owner reports its state unavailable', async () => {
    const harness = createIngressHarness({
      execute: async (actionId): Promise<JsonValue> => {
        if (actionId === 'session.permission.remote.pending.list') {
          return {
            requests: [pendingPermissionRequest({
              requestId: 'permission-request-1',
              turnId: 'turn-9',
              createdAtMs: 2,
              allowedScopes: ['request'],
            })],
            truncated: false,
            nextCursor: null,
          };
        }
        return { status: 'rejected', code: 'mediationStateUnavailable' };
      },
    });
    setBindingApprovalEnabled(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-unavailable:1',
      messageText: '/allow permission-request-1',
    }), harness.context)).rejects.toMatchObject({
      code: 'channels_ingress_admission_unsettled',
      retryable: true,
    });

    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'retryDue' },
      disposition: null,
    });
    expect([...harness.rows.values()].some(
      (row) => row.value['record-kind'] === 'outward-delivery',
    )).toBe(false);
  });

  it('drops an expired /new message before the census and admission owners', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(61_001);
    try {
      const harness = createIngressHarness();
      setBindingSenderFeedback(harness.rows, 'eligibleRefusals');
      const input = observation({
        messageRevision: 'edit:expired',
        messageText: '/new start a separate thread',
        occurredAt: 1_000,
      });

      await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
        .resolves.toBeUndefined();

      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      expect([...harness.rows.values()].some(
        (row) => row.deleted !== true && row.value['record-kind'] === 'session-rotation',
      )).toBe(false);
      expect([...harness.rows.values()].some(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-census',
      )).toBe(false);
      expect([...harness.rows.values()].some(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
      )).toBe(false);
      expect([...harness.rows.values()].some(
        (row) => row.deleted !== true && row.value['record-kind'] === 'outward-delivery',
      )).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('admits a provider occurrence whose timestamp leads this host clock inside the bounded skew allowance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const harness = createIngressHarness();
      const input = observation({
        messageRevision: 'edit:forward-skew',
        occurredAt: Date.now() + MAX_CONVERSATION_OBSERVATION_CLOCK_SKEW_MS,
      });

      await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
        .resolves.toBeUndefined();

      expect(harness.send).toHaveBeenCalledTimes(1);
      expect([...harness.rows.values()].some(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-census',
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a provider occurrence dated beyond the skew allowance so its retained body still reaches a retention horizon', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const harness = createIngressHarness();
      const input = observation({
        messageRevision: 'edit:forward-implausible',
        occurredAt: Date.now() + MAX_CONVERSATION_OBSERVATION_CLOCK_SKEW_MS + 1,
      });

      await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
        .resolves.toBeUndefined();

      expect(harness.send).not.toHaveBeenCalled();
      expect([...harness.rows.values()].some(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-census',
      )).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits a socket /pair only after its census exists, then rejoins and conflicts through that same owner', async () => {
    const manager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const socketConnection = socketChannelConnection();
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
pairingRequestId: 'pairing-request-1',
      executionOrigin: getConversationConnectionExecutionRouting(socketConnection.payload.transportOrigin, socketConnection.payload.providerPluginId),
      destinationLabel: 'Telegram bot',
      endpoint: pairingDestinationEndpoint,
      target: channelBinding().payload.target,
    });
    let challengeWasActiveAtCensusWrite = false;
    const harness = createIngressHarness({
      connection: socketConnection,
      beforeBatch: ({ operations }) => {
        if (operations.some((operation) => (
          isIngressCensusPut(operation) && operation.expectedRevision === 'absent'
        ))) {
          challengeWasActiveAtCensusWrite = manager.readChallenge({
            generationId: challenge.generationId,
            challengeId: challenge.challengeId,
          }).kind === 'active';
        }
      },
    });
    const ingest = createConversationProviderObservationIngestHandler(manager);
    const pair = observation({
      messageRevision: 'edit:1',
      messageText: '/pair 00000001',
      transport: 'socket',
    });

    await expect(ingest(pair, harness.context)).resolves.toBeUndefined();

    expect(challengeWasActiveAtCensusWrite).toBe(true);
    expect(manager.readChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toEqual({ kind: 'consumed' });
    expect(harness.send).not.toHaveBeenCalled();
    const census = [...harness.rows.values()].find(
      (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-census',
    );
    expect(census?.value).toMatchObject({
      attention: false,
      payload: {
        phase: 'prepared',
        conflict: null,
        matchedBindings: [],
      },
    });
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
    )).toBe(false);
    expect(manager.readManagementProjection().proposals).toHaveLength(1);

    await expect(ingest(pair, harness.context)).resolves.toBeUndefined();
    expect(manager.readManagementProjection().proposals).toHaveLength(1);
    await expect(ingest(observation({
      messageRevision: 'edit:2',
      messageText: '/pair 00000001',
      transport: 'socket',
    }), harness.context)).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
    expect(manager.readManagementProjection().proposals).toHaveLength(1);
    expect(harness.rows.get(census?.rowId ?? '')?.value).toMatchObject({
      attention: true,
      payload: { conflict: { kind: 'occurrenceEvidenceMismatch' } },
    });
  });

  it('latches direct ingress after conflicting /pair replays without consuming pairing attempt budget', async () => {
    const manager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const socketConnection = socketChannelConnection();
    manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
pairingRequestId: 'pairing-request-1',
      executionOrigin: getConversationConnectionExecutionRouting(socketConnection.payload.transportOrigin, socketConnection.payload.providerPluginId),
      destinationLabel: 'Telegram bot',
      endpoint: pairingDestinationEndpoint,
      target: channelBinding().payload.target,
    });
    const harness = createIngressHarness({ connection: socketConnection });
    const ingest = createConversationProviderObservationIngestHandler(manager);
    const occurredAt = Date.now();
    const first = observation({
      messageRevision: 'ordinary:1',
      occurrenceId: 'telegram:update:pairing-conflict',
      messageText: 'ordinary message',
      transport: 'socket',
      occurredAt,
    });

    await expect(ingest(first, harness.context)).resolves.toBeUndefined();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(ingest(observation({
        messageRevision: `conflicting-pair:${attempt}`,
        occurrenceId: 'telegram:update:pairing-conflict',
        messageText: '/pair DEADBEEF',
        transport: 'socket',
        occurredAt,
      }), harness.context)).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
    }

    await expect(ingest(observation({
      messageRevision: 'valid-pair:1',
      occurrenceId: 'telegram:update:pairing-valid',
      messageText: '/pair 00000001',
      transport: 'socket',
      occurredAt,
    }), harness.context)).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });

    expect(manager.readManagementProjection().proposals).toHaveLength(0);
  });

  it('rejoins a lost socket /pair census response with one manager proposal', async () => {
    const manager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const socketConnection = socketChannelConnection();
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: 1,
pairingRequestId: 'pairing-request-1',
      executionOrigin: getConversationConnectionExecutionRouting(socketConnection.payload.transportOrigin, socketConnection.payload.providerPluginId),
      destinationLabel: 'Telegram bot',
      endpoint: pairingDestinationEndpoint,
      target: channelBinding().payload.target,
    });
    const harness = createIngressHarness({
      connection: socketConnection,
      loseNextUpdatedBatchResponse: true,
    });
    const ingest = createConversationProviderObservationIngestHandler(manager);
    const pair = observation({
      messageRevision: 'lost-response:1',
      occurrenceId: 'telegram:update:pair-lost-response',
      messageText: '/pair 00000001',
      transport: 'socket',
    });

    await expect(ingest(pair, harness.context)).rejects.toThrow('Simulated Account Collection response loss.');

    expect(manager.readChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toMatchObject({ kind: 'active' });
    expect(manager.readManagementProjection().proposals).toEqual([]);
    expect([...harness.rows.values()].find((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-census'
    ))?.value).toMatchObject({
      attention: false,
      payload: { phase: 'preparing', conflict: null, matchedBindings: [] },
    });

    await expect(ingest(pair, harness.context)).resolves.toBeUndefined();

    expect(manager.readChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toEqual({ kind: 'consumed' });
    expect(manager.readManagementProjection().proposals).toHaveLength(1);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rejects the registered direct provider action for a selected checkpointed-pull connection before census or admission', async () => {
    let batches = 0;
    const harness = createIngressHarness({
      beforeBatch: () => { batches += 1; },
    });
    const manager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const ingest = createConversationProviderObservationIngestHandler(manager);

    await expect(ingest(observation({ messageRevision: 'direct-pull:1' }), harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_checkpointed_pull_direct_unavailable' });

    expect(batches).toBe(0);
    expect(harness.send).not.toHaveBeenCalled();
    expect([...harness.rows.values()].map((row) => row.value['record-kind']).sort())
      .toEqual(['binding', 'connection']);
  });

  it('admits current provider replacements at the retained route and rejects another Home, Machine or plugin before effects', async () => {
    const socketConnection = socketChannelConnection();
    const harness = createIngressHarness({ connection: socketConnection });
    const manager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const ingest = createConversationProviderObservationIngestHandler(manager);
    const current = telegramExecutionOrigin.materializationRef;
    const withCaller = (materialization: typeof current | Record<string, string>, pluginId?: string, serverIdentityId = 'srv_account_one') => ({
      ...harness.context,
      caller: {
        ...(harness.context.caller as Record<string, unknown>),
        ...(pluginId === undefined ? {} : { pluginId }),
        materialization,
        executionOrigin: { serverIdentityId, materializationRef: materialization },
      },
    } as unknown as typeof harness.context);

    // A different provider plugin entirely.
    await expect(ingest(
      observation({ messageRevision: 'authority:1', occurrenceId: 'telegram:update:auth-1', transport: 'socket' }),
      withCaller({ ...current, pluginId: 'happier.channel.other' }, 'happier.channel.other'),
    )).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });

    // A different Machine cannot act for this retained connection.
    await expect(ingest(
      observation({ messageRevision: 'authority:2', occurrenceId: 'telegram:update:auth-2', transport: 'socket' }),
      withCaller({ ...current, machineId: 'machine-other' }),
    )).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });

    await expect(ingest(
      observation({ messageRevision: 'authority:home', occurrenceId: 'telegram:update:auth-home', transport: 'socket' }),
      withCaller(current, undefined, 'srv_other'),
    )).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });

    // A caller whose stamped materialization does not name the calling plugin.
    await expect(ingest(
      observation({ messageRevision: 'authority:3', occurrenceId: 'telegram:update:auth-3', transport: 'socket' }),
      withCaller({ ...current, pluginId: 'happier.channel.other' }),
    )).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });

    expect([...harness.rows.values()].map((row) => row.value['record-kind']).sort())
      .toEqual(['binding', 'connection']);

    expect(harness.send).not.toHaveBeenCalled();
    // The current admitted installation may change while the route stays put.
    await expect(ingest(
      observation({ messageRevision: 'authority:4', occurrenceId: 'telegram:update:auth-4', transport: 'socket' }),
      withCaller({ ...current, materializationId: 'provider-replaced' }),
    )).resolves.toBeUndefined();
  });

  it('admits an Automation occurrence through the canonical action with its frozen actor and reply context', async () => {
    const harness = createIngressHarness({
      execute: async (actionId, input) => {
        expect(actionId).toBe('automation.conversation.admit');
        expect(input).toEqual({
          automationId: 'automation-1',
          bindingId: 'binding-1',
          occurrenceId: 'telegram:update:9001',
          occurredAt: expect.any(Number),
          sender: {
            principalId: 'telegram:user:42',
            kind: 'human',
            isIntegrationSelf: false,
            label: 'Ada',
            contentProvenance: 'original',
          },
          text: 'Hello from Telegram',
          resultDelivery: { kind: 'none' },
        });
        return { kind: 'admitted', runId: 'run-1', checkpointSafe: true };
      },
    });
    setAutomationBindingWithoutFinalResult(harness.rows);
    const input = observation({
      messageRevision: 'edit:1',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .resolves.toBeUndefined();

    expect(harness.execute).toHaveBeenCalledTimes(1);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      target: {
        kind: 'automation',
        automationId: 'automation-1',
        resultDelivery: { kind: 'none' },
      },
      lifecycle: { phase: 'terminal' },
      disposition: 'admitted',
    });
  });

  it('refuses retained author attestation before a trusted /new spawn', async () => {
    const harness = createIngressHarness({ availableSessionIds: ['session-1', 'session-2'], execute: (actionId): JsonValue => {
      if (actionId === 'session.spawn_new') return { type: 'success', disposition: 'created', sessionId: 'session-2',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' }, organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' } };
      if (actionId === 'session.transcript.get') return { ok: true, projection: 'externalShareableV1', sessionId: 'session-2',
        items: [], scannedThroughSeq: 0, hasMore: false };
      throw new Error(`Unexpected Action ${actionId}`);
    } });
    setBindingNewSessionEnabled(harness.rows);
    const row = harness.rows.get('binding-1')!;
    const payload = record(row.value.payload);
    const target = record(payload.target);
    const policy = record(target.policy);
    const newSession = record(policy.newSession);
    const forgedTarget = { ...target, policy: { ...policy,
      newSession: { ...newSession, recipe: { ...record(newSession.recipe), attestedContext: {
        externalPrincipalId: 'forged', sourceMessageId: '<forged>',
      } } },
    } };
    await expect(updateConversationBindingForInvocation(ConversationBindingUpdateInputV1Schema.parse({
      bindingId: row.rowId, expectedRevision: row.revision, target: forgedTarget,
    }), harness.context)).rejects.toMatchObject({ code: 'channels_binding_update_corrupt' });
    expect(harness.rows.get(row.rowId)).toEqual(row);
    // Retained opaque data is never sanitized into trusted caller authority.
    harness.rows.set(row.rowId, stateRow({ ...row.value, payload: { ...payload, target: forgedTarget } }, row.revision));
    await ingestConversationProviderObservationForInvocation(observation({ messageRevision: '1', messageText: '/new' }), harness.context);
    expect(harness.execute.mock.calls.filter(([action]) => action === 'session.spawn_new')).toHaveLength(0);
    expect([...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation')?.value.payload)
      .toMatchObject({ disposition: 'rejected', lifecycle: { phase: 'terminal' } });
  });

  it.each([
    { triggerKind: 'prComment' as const, repositoryWriteAccess: true, isIntegrationSelf: false, admitted: true },
    { triggerKind: 'ciFailed' as const, repositoryWriteAccess: true, isIntegrationSelf: true, admitted: true },
    { triggerKind: 'prComment' as const, repositoryWriteAccess: undefined, isIntegrationSelf: false, admitted: false },
  ])('routes scoped $triggerKind writers with measured permission evidence (known=$repositoryWriteAccess)', async ({ triggerKind, repositoryWriteAccess, isIntegrationSelf, admitted }) => {
    const harness = createIngressHarness({ execute: async (): Promise<JsonValue> => admitted
      ? { kind: 'admitted', runId: 'run-scoped', checkpointSafe: true }
      : { kind: 'refused', reason: 'repositoryWriteAccessUnknown', checkpointSafe: true } });
    setAutomationBindingWithoutFinalResult(harness.rows);
    const row = harness.rows.get('binding-1')!;
    const payload = row.value.payload as Record<string, JsonValue>;
    const target = payload.target as Record<string, JsonValue>;
    target.scopedTrigger = { sessionId: 'session-1', triggerId: 'trigger-1', triggerRevision: 0, triggerKind, principalPolicy: 'repositoryWriters', pullRequest: { repository: 'acme/widgets', number: 5 } };
    const input = observation({ messageRevision: 'edit:scoped' });
    const fullText = fullTextIngress(input);
    const scoped = { connectionId: input.connectionId, entry: { ...input.entry, observation: { kind: 'fullText' as const, observation: { ...fullText, scopedTriggerKind: triggerKind, actor: { ...fullText.actor, principalId: 'github:user:99', ...(repositoryWriteAccess === undefined ? {} : { repositoryWriteAccess }), isIntegrationSelf } } } } };
    await ingestConversationProviderObservationForInvocation(scoped, harness.context);
    expect(harness.execute).toHaveBeenCalledWith('automation.conversation.admit', expect.objectContaining({
      hostEvidence: { bindingId: 'binding-1', sessionId: 'session-1', triggerId: 'trigger-1', triggerRevision: 0, triggerKind, pullRequest: { repository: 'acme/widgets', number: 5 }, observationActorPrincipalId: 'github:user:99', actor: { principalId: 'github:user:99', repositoryWriteAccess: repositoryWriteAccess ?? null } },
    }), expect.anything());
    const obligation = [...harness.rows.values()].find((entry) => entry.value['record-kind'] === 'ingress-obligation');
    expect(obligation?.value.payload).toMatchObject({ lifecycle: { phase: 'terminal' }, disposition: admitted ? 'admitted' : 'rejected' });
  });

  it('admits a final-result binding through the canonical Automation action', async () => {
    const execute = vi.fn(async (actionId, actionInput) => {
      expect(actionId).toBe('automation.conversation.admit');
      expect(actionInput).toMatchObject({
        automationId: 'automation-1',
        bindingId: 'binding-1',
        resultDelivery: {
          kind: 'finalResult',
          actionRef: { pluginId: 'happier.channels', localId: 'automation/result-deliver-v1' },
        },
      });
      return { kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true };
    });
    const harness = createIngressHarness({ execute });
    setAutomationBindingWithFinalResult(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(
      observation({ messageRevision: 'edit:1' }),
      harness.context,
    )).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      target: {
        kind: 'automation',
        resultDelivery: {
          kind: 'finalResult',
          actionRef: { pluginId: 'happier.channels', localId: 'automation/result-deliver-v1' },
        },
      },
      lifecycle: { phase: 'terminal' },
      disposition: 'admitted',
    });
  });

  it('retries a retained final-result Automation obligation through the canonical action', async () => {
    const execute = vi.fn(async () => ({ kind: 'blocked' as const, reason: 'temporarilyUnavailable', checkpointSafe: false }));
    const harness = createIngressHarness({ execute });
    setAutomationBindingWithoutFinalResult(harness.rows);
    const input = observation({ messageRevision: 'legacy-final-result:1' });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

    const binding = harness.rows.get('binding-1');
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    if (binding === undefined || obligation === undefined) throw new Error('Expected retained binding and obligation rows.');
    const bindingValue = record(binding.value);
    const bindingPayload = record(bindingValue.payload);
    const obligationValue = record(obligation.value);
    const obligationPayload = record(obligationValue.payload);
    const obligationLifecycle = record(obligationPayload.lifecycle);
    const dueAt = Date.now();
    const finalResultTarget = {
      kind: 'automation',
      automationId: 'automation-1',
      policy: { resultDelivery: 'finalResult' },
    } as const;
    harness.rows.set(binding.rowId, stateRow({
      ...bindingValue,
      payload: { ...bindingPayload, target: finalResultTarget },
    }, binding.revision));
    harness.rows.set(obligation.rowId, stateRow({
      ...obligationValue,
      'due-at': dueAt,
      payload: {
        ...obligationPayload,
        lifecycle: { ...obligationLifecycle, dueAt },
        target: {
          kind: 'automation',
          automationId: 'automation-1',
          occurrenceKey: 'telegram:update:9001',
          resultDelivery: {
            kind: 'finalResult',
            actionRef: { pluginId: 'happier.channels', localId: 'automation/result-deliver-v1' },
            opaqueContext: { v: 1, kind: 'conversationAutomationResultDelivery' },
          },
        },
      },
    }, obligation.revision));

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      'automation.conversation.admit',
      expect.objectContaining({
        resultDelivery: expect.objectContaining({ kind: 'finalResult' }),
      }),
    );
    expect(harness.rows.get(obligation.rowId)?.value.payload).toMatchObject({
      lifecycle: { phase: 'retryDue', attemptCount: 2 },
      disposition: null,
    });
  });

  it('retries an attempting final-result Automation obligation through the canonical action', async () => {
    const execute = vi.fn(async () => ({ kind: 'blocked' as const, reason: 'temporarilyUnavailable', checkpointSafe: false }));
    const harness = createIngressHarness({ execute });
    setAutomationBindingWithoutFinalResult(harness.rows);
    const input = observation({ messageRevision: 'legacy-final-result-attempting:1' });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    if (obligation === undefined) throw new Error('Expected a retained ingress obligation row.');
    const obligationValue = record(obligation.value);
    const obligationPayload = record(obligationValue.payload);
    harness.rows.set(obligation.rowId, stateRow({
      ...obligationValue,
      payload: {
        ...obligationPayload,
        target: {
          kind: 'automation',
          automationId: 'automation-1',
          occurrenceKey: 'telegram:update:9001',
          resultDelivery: {
            kind: 'finalResult',
            actionRef: { pluginId: 'happier.channels', localId: 'automation/result-deliver-v1' },
            opaqueContext: { v: 1, kind: 'conversationAutomationResultDelivery' },
          },
        },
      },
    }, obligation.revision));
    markIngressObligationAttempting(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(harness.rows.get(obligation.rowId)?.value.payload).toMatchObject({
      lifecycle: { phase: 'retryDue', attemptCount: 2 },
    });
    expect(harness.rows.get(obligation.rowId)?.value).toMatchObject({ attention: false });
  });

  it('keeps no-effect Automation admission retrying beyond five attempts with bounded durable backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({
        execute: async () => ({ kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false }),
      });
      setAutomationBindingWithoutFinalResult(harness.rows);
      const input = observation({ messageRevision: 'automation-no-effect:1' });
      for (let attemptCount = 1; attemptCount <= 8; attemptCount += 1) {
        const attemptedAt = Date.now();
        await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
          .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });
        const obligation = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation');
        if (obligation === undefined) throw new Error('Expected retained ingress custody');
        const dueAt = attemptedAt + Math.min(MAX_CONVERSATION_RECEIVE_WAIT_MS, 1_000 * 2 ** (attemptCount - 1));
        expect(obligation.value).toMatchObject({ terminal: false,
          payload: { lifecycle: { phase: 'retryDue', attemptCount, dueAt } } });
        vi.setSystemTime(dueAt);
      }
      expect(harness.execute).toHaveBeenCalledTimes(8);
    } finally { vi.useRealTimers(); }
  });

  it('manual retry exact-CASes only the blocked obligation back through the shared due-work lifecycle', async () => {
    const harness = createIngressHarness({
      execute: async () => ({ kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false }),
    });
    setAutomationBindingWithoutFinalResult(harness.rows);
    await expect(ingestConversationProviderObservationForInvocation(
      observation({ messageRevision: 'edit:1' }),
      harness.context,
    )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled' });
    const current = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    if (current === undefined) throw new Error('Expected a retained ingress obligation.');
    const { ['due-at']: _dueAt, ...withoutDueAt } = current.value;
    const payload = record(current.value.payload);
    const blocked = stateRow({
      ...withoutDueAt,
      attention: true,
      payload: {
        ...payload,
        lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null },
      },
    }, current.revision + 1);
    harness.rows.set(blocked.rowId, blocked);

    await expect(retryConversationIngressForInvocation({
      obligationId: blocked.rowId,
      expectedRevision: blocked.revision,
    }, harness.context)).resolves.toMatchObject({
      kind: 'retryScheduled',
      obligationId: blocked.rowId,
      revision: blocked.revision + 1,
    });
    expect(harness.rows.get(blocked.rowId)?.value).toMatchObject({
      attention: false,
      'due-at': expect.any(Number),
      payload: { lifecycle: { phase: 'retryDue', attemptCount: 0, dueAt: expect.any(Number) } },
    });
    await expect(retryConversationIngressForInvocation({
      obligationId: blocked.rowId,
      expectedRevision: blocked.revision,
    }, harness.context)).rejects.toMatchObject({ code: 'channels_ingress_retry_conflict', retryable: true });
  });

  it('settles a frozen Automation admission after its first authority-fenced settlement loses and a retry rejoins the same run', async () => {
    const terminalBatches: Array<readonly CollectionMutation[]> = [];
    const admissionInputs: JsonValue[] = [];
    const harness = createIngressHarness({
      execute: async (actionId, input) => {
        expect(actionId).toBe('automation.conversation.admit');
        admissionInputs.push(input);
        return { kind: 'admitted', runId: 'run-1', checkpointSafe: true };
      },
      beforeBatch: ({ rows, operations }) => {
        if (!operations.some((operation) => isIngressObligationPhase(operation, 'terminal'))) return;
        terminalBatches.push(operations);
        if (terminalBatches.length === 1) advanceConnectionAuthorityEpoch(rows);
      },
    });
    setAutomationBindingWithoutFinalResult(harness.rows);
    const input = observation({ messageRevision: 'edit:1' });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_stale_authority', retryable: true });
    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .resolves.toBeUndefined();

    expect(terminalBatches).toHaveLength(2);
    expect(terminalBatches[0]).toEqual(expect.arrayContaining([
      { kind: 'assert', rowId: 'connection-1', expectedRevision: 1 },
      { kind: 'assert', rowId: 'binding-1', expectedRevision: 2 },
    ]));
    expect(terminalBatches[1]).toEqual([
      expect.objectContaining({ kind: 'put', expectedRevision: 3 }),
    ]);
    expect(admissionInputs).toHaveLength(2);
    expect(admissionInputs[1]).toEqual(admissionInputs[0]);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value).toMatchObject({
      terminal: true,
      attention: false,
      payload: { lifecycle: { phase: 'terminal' }, disposition: 'admitted' },
    });
  });

  it('rotates an enabled Session binding only after the new Session baseline is durable', async () => {
    const harness = createIngressHarness({
      availableSessionIds: ['session-1', 'session-2'],
      execute: async (actionId, actionInput): Promise<JsonValue> => {
        if (actionId === 'session.spawn_new') {
          expect(actionInput).toEqual({
            creationKey: 'channel-new:binding-1:telegram:update:9001',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/workspace/channels' },
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
          });
          return {
            type: 'success',
            disposition: 'created',
            sessionId: 'session-2',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' },
          };
        }
        if (actionId === 'session.transcript.get') {
          expect(actionInput).toEqual({
            sessionId: 'session-2',
            projection: 'externalShareableV1',
            cursor: null,
            limit: 100,
          });
          return {
            ok: true,
            projection: 'externalShareableV1',
            sessionId: 'session-2',
            items: [],
            scannedThroughSeq: 0,
            hasMore: false,
          };
        }
        throw new Error(`Unexpected Action ${actionId}.`);
      },
    });
    setBindingNewSessionEnabled(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'edit:1',
      messageText: '/new investigate incident',
    }), harness.context)).resolves.toBeUndefined();

    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({
      text: 'investigate incident',
      source: expect.objectContaining({ sourceRef: 'channels:binding:binding-1' }),
    }), { signal: harness.context.signal });
    const binding = harness.rows.get('binding-1');
    expect(record(record(binding?.value ?? {}).payload).target).toMatchObject({
      kind: 'session',
      sessionId: 'session-2',
    });
    const frontier = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'projection-frontier',
    );
    expect(frontier?.value).toMatchObject({
      'binding-id': 'binding-1',
      payload: {
        targetSessionId: 'session-2',
        transcriptCursor: null,
        lastScannedSeq: 0,
        revision: 1,
      },
    });
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'session-rotation',
    )).toBe(false);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({ lifecycle: { phase: 'terminal' }, disposition: 'rotated' });
    const newSessionCustody = [...harness.rows.values()].find((row) => (
      row.value['record-kind'] === 'outward-delivery'
        && record(record(row.value.payload).source).controlKind === 'newSession'
    ));
    expect(newSessionCustody?.value).toMatchObject({
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      terminal: false,
      attention: false,
      payload: {
        source: {
          kind: 'controlResponse',
          controlId: obligation?.value.id,
          controlKind: 'newSession',
        },
        routeAuthority: {
          connectionAuthorityEpoch: 4,
          bindingRevision: 3,
          bindingAuthorityEpoch: 8,
        },
        content: { text: 'Started a new Session.' },
        deliveryKey: `ingress-new:${obligation?.value.id}`,
        replyContext: { replyToMessageId: 'telegram:message:5' },
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
        state: 'ready',
      },
    });
  });

  it.each([
    { name: 'routed sender', hasAttestedContext: true, principalIds: ['telegram:user:42'], attested: true },
    { name: 'single-member start', hasAttestedContext: false, principalIds: ['telegram:user:42'], attested: false },
    { name: 'shared-audience start', hasAttestedContext: false, principalIds: ['telegram:user:42', 'telegram:user:43'], attested: false },
  ])('rotates $name with host-derived birth facts and rejoins command replay', async ({ hasAttestedContext, principalIds, attested }) => {
    const births: JsonValue[] = [];
    const harness = createIngressHarness({ connection: socketChannelConnection(), availableSessionIds: ['session-1', 'session-2'],
      sessionSummary: id => ({ id, hasAttestedContext, state: 'idle', runtimeAvailability: { status: 'available' },
        storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1 }),
      execute: (actionId, input): JsonValue => {
        if (actionId === 'session.spawn_new') {
          births.push(input);
          return { type: 'success', disposition: 'created', sessionId: 'session-2',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        }
        if (actionId === 'session.transcript.get') {
          const sessionId = record(input).sessionId;
          if (typeof sessionId !== 'string') throw new Error('Expected a transcript request Session id.');
          return { ok: true, projection: 'externalShareableV1', sessionId,
            items: [], scannedThroughSeq: 0, hasMore: false };
        }
        return threadSpawnBoundary(actionId, input);
      },
    });
    routerFixture(harness.rows);
    const endpoint = fullTextIngress(topicObservation('new-birth')).endpoint;
    const created = await createConversationThreadBindingForInvocation({ routerBindingId: 'binding-1', expectedRouterRevision: 1,
      expectedConnectionRevision: 1, endpoint, sessionId: 'session-1', allowedPrincipalIds: principalIds,
      policy: { ...channelBinding().payload.target.policy, newSession: { kind: 'enabled', recipe: {
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' }, directory: { kind: 'path', path: '/workspace/channels' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      } } },
    }, harness.context);
    if (created.kind !== 'created') throw new Error('Expected a child binding');
    const command = topicObservation('new-birth', 'telegram:user:42', '/new investigate');
    await ingestConversationProviderObservationForInvocation(command, harness.context);
    await ingestConversationProviderObservationForInvocation(command, harness.context);
    expect(births).toHaveLength(1);
    if (attested) expect(births[0]).toMatchObject({ attestedContext: {
      externalPrincipalId: 'telegram:user:42', sourceMessageId: 'telegram:message:5',
    } });
    else expect(births[0]).not.toHaveProperty('attestedContext');
    expect(harness.send.mock.calls.map(([request]) => sentUserTextRequest(request).text)).toEqual(['investigate']);
    expect(record(harness.rows.get(created.binding.id)!.value.payload).target).toMatchObject({ sessionId: 'session-2' });
  });

  it('restores an archived Session rejoined by /new before admitting its initial prompt', async () => {
    let archived = true;
    const acceptedTexts: string[] = [];
    const harness = createIngressHarness({
      availableSessionIds: ['session-1', 'session-2'],
      sessionSummary: (id) => ({
        id, state: id === 'session-2' && archived ? 'archived' : 'idle',
        runtimeAvailability: id === 'session-2' && archived
          ? { status: 'unavailable', code: 'session_archived' } : { status: 'available' }, storagePolicy: 'optional',
        encryptionMode: 'plain', updatedAtMs: 1,
      }),
      sessionSend: async (input) => {
        if (archived) return { status: 'rejected', code: 'session_input_archived' };
        if (input !== null && typeof input === 'object' && 'text' in input && typeof input.text === 'string') {
          acceptedTexts.push(input.text);
        }
        return { status: 'accepted', localId: 'rejoined-initial-input' };
      },
      execute: (actionId, input): JsonValue => {
        if (actionId === 'session.spawn_new') return {
          type: 'success', disposition: 'rejoined', sessionId: 'session-2',
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
        };
        if (actionId === 'session.transcript.get') return {
          ok: true, projection: 'externalShareableV1', sessionId: 'session-2',
          items: [], scannedThroughSeq: 0, hasMore: false,
        };
        expect([actionId, input]).toEqual(['session.unarchive', { sessionId: 'session-2' }]);
        archived = false;
        return { ok: true };
      },
    });
    setBindingNewSessionEnabled(harness.rows);
    await ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'archived-new:1', messageText: '/new continue investigation',
    }), harness.context);
    expect(acceptedTexts).toEqual(['continue investigation']);
    expect(record(record(harness.rows.get('binding-1')?.value).payload).target).toMatchObject({
      kind: 'session', sessionId: 'session-2',
    });
  });

  it('writes /new success custody before terminal settlement and rejoins it after a lost claim CAS', async () => {
    let lostTerminalSettlement = false;
    let spawnCount = 0;
    let harness!: ReturnType<typeof createIngressHarness>;
    harness = createIngressHarness({
      availableSessionIds: ['session-1', 'session-2'],
      beforeBatch: ({ rows, operations }) => {
        if (lostTerminalSettlement || !operations.some((operation) => operation.kind === 'delete')) return;
        const claim = [...rows.values()].find(
          (row) => row.deleted !== true && row.value['record-kind'] === 'session-rotation',
        );
        if (claim === undefined) throw new Error('Expected the /new rotation claim before terminal settlement.');
        reviseStateRow(rows, claim.rowId);
        lostTerminalSettlement = true;
      },
      execute: async (actionId): Promise<JsonValue> => {
        if (actionId === 'session.spawn_new') {
          spawnCount += 1;
          return {
            type: 'success',
            disposition: spawnCount === 1 ? 'created' : 'rejoined',
            sessionId: 'session-2',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' },
          };
        }
        if (actionId === 'session.transcript.get') {
          return {
            ok: true,
            projection: 'externalShareableV1',
            sessionId: 'session-2',
            items: [],
            scannedThroughSeq: 0,
            hasMore: false,
          };
        }
        throw new Error(`Unexpected Action ${actionId}.`);
      },
    });
    setBindingNewSessionEnabled(harness.rows);
    const input = observation({
      messageRevision: 'edit:1',
      messageText: '/new',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

    expect(lostTerminalSettlement).toBe(true);
    const custodyBeforeTerminal = [...harness.rows.values()].find((row) => (
      row.value['record-kind'] === 'outward-delivery'
        && record(record(row.value.payload).source).controlKind === 'newSession'
    ));
    expect(custodyBeforeTerminal?.value.payload).toMatchObject({
      source: { kind: 'controlResponse', controlKind: 'newSession' },
      content: { text: 'Started a new Session.' },
      state: 'ready',
    });
    const attempting = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(attempting?.value.payload).toMatchObject({ lifecycle: { phase: 'attempting' }, disposition: null });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context)).resolves.toBeUndefined();

    expect(spawnCount).toBe(2);
    expect([...harness.rows.values()].filter((row) => (
      row.value['record-kind'] === 'outward-delivery'
        && record(record(row.value.payload).source).controlKind === 'newSession'
    ))).toHaveLength(1);
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'session-rotation',
    )).toBe(false);
  });

  it('rejoins an uncertain /new prompt after crash-safe target rotation without a second target write', async () => {
    let spawnCount = 0;
    const harness = createIngressHarness({
      availableSessionIds: ['session-1', 'session-2'],
      sessionSendResults: [
        { status: 'outcomeUnknown', localId: 'pending-new-1', code: 'transport_lost' },
        { status: 'alreadyAccepted', localId: 'pending-new-1' },
      ],
      execute: async (actionId): Promise<JsonValue> => {
        if (actionId === 'session.spawn_new') {
          spawnCount += 1;
          return {
            type: 'success',
            disposition: spawnCount === 1 ? 'created' : 'rejoined',
            sessionId: 'session-2',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' },
          };
        }
        if (actionId === 'session.transcript.get') {
          return {
            ok: true,
            projection: 'externalShareableV1',
            sessionId: 'session-2',
            items: [],
            scannedThroughSeq: 0,
            hasMore: false,
          };
        }
        throw new Error(`Unexpected Action ${actionId}.`);
      },
    });
    setBindingNewSessionEnabled(harness.rows);
    const input = observation({
      messageRevision: 'edit:1',
      messageText: '/new investigate incident',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

    const afterFirstAttempt = harness.rows.get('binding-1');
    expect(record(record(afterFirstAttempt?.value ?? {}).payload).target).toMatchObject({ sessionId: 'session-2' });
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'session-rotation',
    )).toBe(true);

    replaceBindingPermissionCeiling(harness.rows, 'yolo');

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context)).resolves.toBeUndefined();

    expect(spawnCount).toBe(2);
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.send.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
      expect.stringMatching(/^channels:new:v1:[A-Za-z0-9_-]{43}$/),
      expect.stringMatching(/^channels:new:v1:[A-Za-z0-9_-]{43}$/),
    ]);
    const requests = harness.send.mock.calls.map(([request]) => sentUserTextRequest(request));
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
    expect(requests.map((request) => request.source)).toEqual([
      expect.objectContaining({
        sourceRevisionOrEpoch: '4:7',
        requestedPermissionCeiling: 'read-only',
      }),
      expect.objectContaining({
        sourceRevisionOrEpoch: '4:7',
        requestedPermissionCeiling: 'read-only',
      }),
    ]);
    const rotated = harness.rows.get('binding-1');
    expect(record(record(rotated?.value ?? {}).payload).target).toMatchObject({ sessionId: 'session-2' });
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'session-rotation',
    )).toBe(false);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({ lifecycle: { phase: 'terminal' }, disposition: 'rotated' });
  });

  it('rejoins competing /new busy custody after a lost terminal settlement without stealing its claim', async () => {
    let spawnCount = 0;
    let lostBusyTerminalSettlement = false;
    const harness = createIngressHarness({
      beforeBatch: ({ rows, operations }) => {
        if (lostBusyTerminalSettlement) return;
        const terminal = operations.find((operation) => (
          operation.kind === 'put'
            && operation.value['record-kind'] === 'ingress-obligation'
            && record(operation.value.payload).disposition === 'rotationBusy'
        ));
        if (terminal?.kind !== 'put') return;
        reviseStateRow(rows, String(terminal.value.id));
        lostBusyTerminalSettlement = true;
      },
      execute: async (actionId) => {
        if (actionId !== 'session.spawn_new') throw new Error(`Unexpected Action ${actionId}.`);
        spawnCount += 1;
        return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
      },
    });
    setBindingNewSessionEnabled(harness.rows);
    const first = observation({
      messageRevision: 'edit:1',
      occurrenceId: 'telegram:update:9001',
      messageText: '/new first',
    });
    const competing = observation({
      messageRevision: 'edit:2',
      occurrenceId: 'telegram:update:9002',
      messageText: '/new competing',
    });

    await expect(ingestConversationProviderObservationForInvocation(first, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });
    await expect(ingestConversationProviderObservationForInvocation(competing, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_stale_authority', retryable: true });
    await expect(ingestConversationProviderObservationForInvocation(competing, harness.context))
      .resolves.toBeUndefined();

    expect(lostBusyTerminalSettlement).toBe(true);
    expect(spawnCount).toBe(1);
    expect(harness.send).not.toHaveBeenCalled();
    const competingObligation = [...harness.rows.values()].find((row) => (
      row.value['record-kind'] === 'ingress-obligation'
        && obligationOccurrenceId(harness.rows, row) === 'telegram:update:9002'
    ));
    expect(competingObligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'rotationBusy',
    });
    const claim = [...harness.rows.values()].find(
      (row) => row.deleted !== true && row.value['record-kind'] === 'session-rotation',
    );
    expect(claim?.value.payload).toMatchObject({ commandOccurrenceId: 'telegram:update:9001' });
    const busyCustody = [...harness.rows.values()].find((row) => (
      row.value['record-kind'] === 'outward-delivery'
        && record(record(row.value.payload).source).controlKind === 'newSession'
    ));
    expect(busyCustody?.value).toMatchObject({
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      terminal: false,
      attention: false,
      payload: {
        source: {
          kind: 'controlResponse',
          controlId: competingObligation?.value.id,
          controlKind: 'newSession',
        },
        routeAuthority: {
          connectionAuthorityEpoch: 4,
          bindingRevision: 2,
          bindingAuthorityEpoch: 7,
        },
        content: { text: 'Another /new command is already in progress.' },
        deliveryKey: `ingress-new:${competingObligation?.value.id}`,
        replyContext: { replyToMessageId: 'telegram:message:5' },
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
        state: 'ready',
      },
    });
  });

  it('does not overwrite a concurrently superseded target after /new creation and baseline', async () => {
    let superseded = false;
    let harness!: ReturnType<typeof createIngressHarness>;
    harness = createIngressHarness({
      availableSessionIds: ['session-1', 'session-2', 'session-3'],
      execute: async (actionId): Promise<JsonValue> => {
        if (actionId === 'session.spawn_new') {
          return {
            type: 'success',
            disposition: 'created',
            sessionId: 'session-2',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' },
          };
        }
        if (actionId === 'session.transcript.get') {
          if (!superseded) {
            superseded = true;
            supersedeBindingSessionTarget(harness.rows, 'session-3');
          }
          return {
            ok: true,
            projection: 'externalShareableV1',
            sessionId: 'session-2',
            items: [],
            scannedThroughSeq: 0,
            hasMore: false,
          };
        }
        throw new Error(`Unexpected Action ${actionId}.`);
      },
    });
    setBindingNewSessionEnabled(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'edit:1',
      messageText: '/new investigate incident',
    }), harness.context)).resolves.toBeUndefined();

    expect(harness.send).not.toHaveBeenCalled();
    expect(record(record(harness.rows.get('binding-1')?.value ?? {}).payload).target)
      .toMatchObject({ sessionId: 'session-3' });
    const frontier = [...harness.rows.values()].find(
      (row) => row.deleted !== true && row.value['record-kind'] === 'projection-frontier',
    );
    expect(frontier).toBeUndefined();
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'session-rotation',
    )).toBe(false);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'rotationSuperseded',
    });
  });

  it('preserves the first admitted occurrence when changed immutable evidence atomically marks its census conflict', async () => {
    let conflictBatch: readonly CollectionMutation[] | undefined;
    const harness = createIngressHarness({
      beforeBatch: ({ operations }) => {
        if (operations.some((operation) => (
          operation.kind === 'put'
          && operation.value['record-kind'] === 'ingress-census'
          && operation.value.attention === true
        ))) {
          conflictBatch = operations;
        }
      },
    });
    setBindingApprovalEnabled(harness.rows);
    const first = observation({
      messageRevision: 'edit:1',
    });

    await ingestConversationProviderObservationForInvocation(first, harness.context);

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'userText',
      text: fullTextIngress(first).message.text,
      idempotencyKey: expect.stringMatching(/^channels:input:v1:[A-Za-z0-9_-]{43}$/),
      source: expect.objectContaining({
        sourceRef: 'channels:binding:binding-1',
        sourceRevisionOrEpoch: '4:7',
        remoteApprovalMaxScope: 'request',
        requestedPermissionCeiling: 'read-only',
      }),
    }), { signal: harness.context.signal });

    const firstObligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(firstObligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'admitted',
      censusId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const connectionBeforeConflict = harness.rows.get('connection-1');
    if (connectionBeforeConflict === undefined) throw new Error('Expected the original connection fence.');

    const replayWithChangedRevision = observation({
      messageRevision: 'edit:2',
    });
    await expect(ingestConversationProviderObservationForInvocation(replayWithChangedRevision, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict', retryable: false });

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(conflictBatch).toEqual([
      {
        kind: 'put',
        value: connectionBeforeConflict.value,
        expectedRevision: connectionBeforeConflict.revision,
      },
      expect.objectContaining({
        kind: 'put',
        expectedRevision: expect.any(Number),
        value: expect.objectContaining({
          'record-kind': 'ingress-census',
          attention: true,
          payload: expect.objectContaining({
            conflict: { kind: 'occurrenceEvidenceMismatch' },
          }),
        }),
      }),
    ]);
    expect(harness.rows.get('connection-1')).toEqual({
      ...connectionBeforeConflict,
      revision: connectionBeforeConflict.revision + 1,
    });
    const conflictedCensus = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-census',
    );
    expect(conflictedCensus?.value).toMatchObject({
      attention: true,
      payload: { conflict: { kind: 'occurrenceEvidenceMismatch' } },
    });
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'admitted',
    });
  });

  it.each([
    { label: 'socket', connection: socketChannelConnection(), transport: 'socket' as const },
    { label: 'durable-push', connection: durablePushChannelConnection(), transport: 'webhook' as const },
  ])('latches direct $label ingress after the first unresolved connection conflict', async ({
    connection,
    transport,
  }) => {
    const manager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const harness = createIngressHarness({ connection });
    const ingest = createConversationProviderObservationIngestHandler(manager);
    const first = observation({
      occurrenceId: 'discord:message:conflict',
      messageRevision: 'edit:1',
      transport,
    });

    await expect(ingest(first, harness.context)).resolves.toBeUndefined();
    await expect(ingest(observation({
      occurrenceId: 'discord:message:conflict',
      messageRevision: 'edit:2',
      transport,
    }), harness.context)).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });

    const censusCountAfterConflict = [...harness.rows.values()].filter((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-census'
    )).length;
    await expect(ingest(observation({
      occurrenceId: 'discord:message:after-conflict',
      messageRevision: 'ordinary:1',
      transport,
    }), harness.context)).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });

    expect([...harness.rows.values()].filter((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-census'
    ))).toHaveLength(censusCountAfterConflict);
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('rejects a label-only replay because census equality is exact', async () => {
    const harness = createIngressHarness();
    const first = observation({
      messageRevision: 'edit:1',
      actorLabel: 'Ada',
    });

    await ingestConversationProviderObservationForInvocation(first, harness.context);

    const replayWithRenamedActor = observation({
      messageRevision: 'edit:1',
      actorLabel: 'Ada Lovelace',
      occurredAt: fullTextIngress(first).occurredAt,
    });
    await expect(ingestConversationProviderObservationForInvocation(replayWithRenamedActor, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    const census = harness.rows.get(String(record(obligation?.value.payload).censusId));
    expect(record(record(record(census?.value.payload).normalizedIngress).observation).actor)
      .toMatchObject({ label: 'Ada' });
  });

  it.each(['full', 'compacted', 'legacy-compacted'] as const)('rejoins endpoint display label enrichment from a %s census without rewriting its retained evidence', async phase => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      const first = observation({ messageRevision: 'endpoint-display', occurredAt: 1_000 });
      await ingestConversationProviderObservationForInvocation(first, harness.context);
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      if (phase !== 'full') {
        await runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context);
        if (phase === 'legacy-compacted') {
          // The previous shell producer retained these existing optional fields.
          const retained = harness.rows.get(census.rowId);
          if (!retained) throw new Error('Missing compacted census');
          const payload = record(retained.value.payload);
          const compacted = record(payload.compacted);
          const shell = record(compacted.shell);
          harness.rows.set(retained.rowId, stateRow({ ...retained.value, payload: { ...payload,
            compacted: { ...compacted, shell: { ...shell,
              endpoint: { ...record(shell.endpoint), label: 'Legacy display', parentLabel: 'Legacy parent display' },
            } },
          } }, retained.revision));
        }
      }
      const retainedValue = structuredClone(harness.rows.get(census.rowId)?.value);
      const replay = structuredClone(first);
      Object.assign(fullTextIngress(replay).endpoint, { label: 'Current display', parentLabel: 'Current parent display' });
      await expect(ingestConversationProviderObservationForInvocation(replay, harness.context)).resolves.toBeUndefined();
      expect(harness.send).toHaveBeenCalledOnce();
      expect(harness.rows.get(census.rowId)?.value).toEqual(retainedValue);
    } finally { vi.useRealTimers(); }
  });

  it('still conflicts changed endpoint facts beside endpoint display labels', async () => {
    const harness = createIngressHarness();
    const input = observation({ messageRevision: 'endpoint-facts' });
    const endpoint = { kind: 'githubPullRequest', audience: 'shared', id: 'acme/repo:7',
      pullRequest: { repository: 'acme/repo', number: 7 }, pullRequestState: { state: 'open', observedAt: 1 } } as const;
    Object.assign(fullTextIngress(input), { endpoint });
    const binding = channelBinding();
    harness.rows.set(binding.id, stateRow({ ...binding, payload: { ...binding.payload, endpoint, inputMode: 'allAllowedMessages' } }));
    await ingestConversationProviderObservationForInvocation(input, harness.context);
    const replay = structuredClone(input);
    Object.assign(fullTextIngress(replay).endpoint, { label: 'New display', pullRequestState: { state: 'closed', observedAt: 2 } });
    await expect(ingestConversationProviderObservationForInvocation(replay, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
    expect(harness.send).toHaveBeenCalledOnce();
  });

  it('excludes endpoint display labels from a provider-supplied rejected bodyless shell', async () => {
    const harness = createIngressHarness();
    const input = routableNonAdmission({ messageRevision: 'private-subject', reason: 'unsupportedContent' });
    if (input.entry.observation.kind !== 'routableNonAdmission') throw new Error('Expected a non-admission shell');
    Object.assign(input.entry.observation.shell.endpoint, { label: 'Rejected private subject', parentLabel: 'Rejected private mailbox' });
    await ingestConversationProviderObservationForInvocation(input, harness.context);
    const census = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-census');
    expect(census).toBeDefined();
    expect(JSON.stringify(census?.value)).not.toContain('Rejected private');
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rejoins a terminal occurrence after a compatible E→E+1 transport transfer without a second Session admission', async () => {
    const harness = createIngressHarness();
    const first = observation({ messageRevision: 'edit:1' });

    await ingestConversationProviderObservationForInvocation(first, harness.context);
    advanceConnectionAuthorityEpoch(harness.rows);
    const transferred = replaceConnectionTransportOrigin(harness.rows, 'telegram-install-2');
    const payload = record(record(transferred.value).payload);
    const transportOrigin = record(payload.transportOrigin);
    const materialization = { ...telegramExecutionOrigin.materializationRef, machineId: String(transportOrigin.machineId) };
    const transferredContext: PluginInvocationContext = {
      ...harness.context,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channel.telegram',
        contribution: {
          id: 'channel-poller',
          qualifiedId: 'happier.channel.telegram/background/channel-poller',
        },
        occurrenceId: 'channels-ingress-telegram-fixture-occurrence',
        sourceCustody: { kind: 'development', registeredRootId: 'channels-ingress-telegram-root' },
        materialization: {
          pluginId: String(materialization.pluginId),
          machineId: String(materialization.machineId),
          materializationId: String(materialization.materializationId),
        },
        executionOrigin: { serverIdentityId: String(transportOrigin.serverIdentityId), materializationRef: materialization },
      },
    };

    await expect(ingestConversationProviderObservationForInvocation(first, transferredContext))
      .resolves.toBeUndefined();

    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('rejects a replacement observation while destructive incumbent stop custody is unsettled', async () => {
    const harness = createIngressHarness();
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'destructive',
    });
    const transferred = replaceConnectionPayload(harness.rows, { enabled: true });
    const payload = record(record(transferred.value).payload);
    const transportOrigin = record(payload.transportOrigin);
    const materialization = { ...telegramExecutionOrigin.materializationRef, machineId: String(transportOrigin.machineId) };
    const transferredContext: PluginInvocationContext = {
      ...harness.context,
      caller: {
        kind: 'plugin',
        pluginId: String(payload.providerPluginId),
        contribution: {
          id: 'channel-poller',
          qualifiedId: `${String(payload.providerPluginId)}/background/channel-poller`,
        },
        occurrenceId: 'channels-ingress-provider-fixture-occurrence',
        sourceCustody: { kind: 'development', registeredRootId: 'channels-ingress-provider-root' },
        materialization: {
          pluginId: String(materialization.pluginId),
          machineId: String(materialization.machineId),
          materializationId: String(materialization.materializationId),
        },
        executionOrigin: { serverIdentityId: String(transportOrigin.serverIdentityId), materializationRef: materialization },
      },
    };

    await expect(ingestConversationProviderObservationForInvocation(
      observation({ messageRevision: 'edit:destructive-replacement' }),
      transferredContext,
    )).rejects.toMatchObject({ code: 'channels_ingress_connection_unavailable' });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rejects the provider Action when Session admission is outcome-unknown', async () => {
    const harness = createIngressHarness({
      sessionSendResult: {
        status: 'outcomeUnknown',
        localId: 'pending-1',
        code: 'session_admission_outcome_unknown',
      },
    });
    const input = observation({
      messageRevision: 'edit:1',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({ lifecycle: { phase: 'retryDue' }, disposition: null });
    expect([...harness.rows.values()].some(
      (row) => row.value['record-kind'] === 'checkpoint',
    )).toBe(false);
  });

  it('consumes a Session cancellation attempt and schedules its next retry durably', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const controller = new AbortController();
      const harness = createIngressHarness({
        sessionSend: async () => {
          controller.abort();
          return {
            status: 'rejected',
            code: 'session_input_cancelled',
          };
        },
      });

      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'edit:1' }),
        { ...harness.context, signal: controller.signal },
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

      expect(harness.send).toHaveBeenCalledTimes(1);
      const obligation = [...harness.rows.values()].find(
        (row) => row.value['record-kind'] === 'ingress-obligation',
      );
      expect(obligation?.value).toMatchObject({
        terminal: false,
        attention: false,
        payload: { lifecycle: { phase: 'retryDue', attemptCount: 1, dueAt: 2_000 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([750, Number.MAX_SAFE_INTEGER])('persists complete socket debounce custody at %i ms and resumes representable dates without another observation', async (inboundDebounceMs) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({ connection: socketChannelConnection() });
      const binding = record(harness.rows.get('binding-1')?.value);
      harness.rows.set('binding-1', stateRow({
        ...binding,
        payload: { ...record(binding.payload), inboundDebounceMs },
      }));
      const ingress = observation({ messageRevision: 'socket:debounce', occurredAt: 1_000, transport: 'socket' });
      await expect(ingestConversationProviderObservationForInvocation(ingress, harness.context))
        .resolves.toBeUndefined();
      await expect(ingestConversationProviderObservationForInvocation(ingress, harness.context))
        .resolves.toBeUndefined();
      expect(harness.send).not.toHaveBeenCalled();
      const censuses = [...harness.rows.values()].filter((row) => row.value['record-kind'] === 'ingress-census');
      const obligations = [...harness.rows.values()].filter((row) => row.value['record-kind'] === 'ingress-obligation');
      expect(censuses).toHaveLength(1);
      expect(censuses[0]?.value).toMatchObject({ payload: { phase: 'prepared', normalizedIngress: ingress.entry.observation } });
      expect(obligations).toHaveLength(1);
      const dueAt = Math.min(Number.MAX_SAFE_INTEGER, 1_000 + inboundDebounceMs);
      expect(obligations[0]?.value).toMatchObject({
        terminal: false,
        payload: { censusId: censuses[0]?.rowId, lifecycle: { phase: 'debounceDue', dueAt } },
      });
      // The representation-boundary case proves valid retained custody; it
      // deliberately does not fabricate a Date outside the platform's range.
      if (inboundDebounceMs === Number.MAX_SAFE_INTEGER) return;
      vi.setSystemTime(dueAt);
      await expect(runConversationIngressDueWorkForInvocation({ now: dueAt }, harness.context)).resolves.toBe(1);
      expect(harness.send).toHaveBeenCalledTimes(1);
      await expect(ingestConversationProviderObservationForInvocation(ingress, harness.context)).resolves.toBeUndefined();
      expect(harness.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['missingMember', 'changedAuthority', 'cancelled'] as const)(
    'rejects socket debounce custody when completion is invalid: %s',
    async (fault) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      try {
        const controller = new AbortController();
        const harness = createIngressHarness({
          connection: socketChannelConnection(),
          beforeBatch: ({ rows, operations }) => {
            const preparesCensus = operations.some((operation) => operation.kind === 'put'
              && operation.value['record-kind'] === 'ingress-census'
              && record(operation.value.payload).phase === 'prepared');
            if (!preparesCensus) return;
            if (fault === 'missingMember') {
              const member = [...rows.values()].find((row) => row.value['record-kind'] === 'ingress-obligation');
              if (member === undefined) throw new Error('Expected prepared member fixture');
              rows.delete(member.rowId);
            } else if (fault === 'changedAuthority') {
              reviseStateRow(rows, 'connection-1');
            } else {
              controller.abort();
            }
          },
        });
        const binding = record(harness.rows.get('binding-1')?.value);
        harness.rows.set('binding-1', stateRow({
          ...binding,
          payload: { ...record(binding.payload), inboundDebounceMs: 750 },
        }));
        const admission = ingestConversationProviderObservationForInvocation(
          observation({ messageRevision: 'socket:debounce:invalid', occurredAt: 1_000, transport: 'socket' }),
          { ...harness.context, signal: controller.signal },
        );
        if (fault === 'cancelled') await expect(admission).rejects.toBeDefined();
        else await expect(admission).rejects.toMatchObject({
          code: fault === 'missingMember' ? 'channels_ingress_obligation_missing' : 'channels_ingress_stale_authority',
        });
        expect(harness.send).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('restarts a debounced obligation from the persisted due index without another observation', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const harness = createIngressHarness();
      const binding = record(harness.rows.get('binding-1')?.value);
      const payload = record(binding.payload);
      harness.rows.set('binding-1', stateRow({
        ...binding,
        payload: { ...payload, inboundDebounceMs: 500 },
      }));
      const ingress = observation({ messageRevision: 'edit:1', occurredAt: 1_000 });

      await expect(ingestConversationProviderObservationForInvocation(ingress, harness.context))
        .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });
      expect(harness.send).not.toHaveBeenCalled();

      await expect(runConversationIngressDueWorkForInvocation({ now: 1_499 }, harness.context))
        .resolves.toBe(0);
      expect(harness.send).not.toHaveBeenCalled();

      vi.setSystemTime(1_500);
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_500 }, harness.context))
        .resolves.toBe(1);
      expect(harness.send).toHaveBeenCalledTimes(1);
      const obligation = [...harness.rows.values()].find(
        (row) => row.value['record-kind'] === 'ingress-obligation',
      );
      expect(obligation?.value).toMatchObject({
        terminal: true,
        payload: { lifecycle: { phase: 'terminal', attemptCount: 1, dueAt: null } },
      });
      expect(obligation?.value).not.toHaveProperty('due-at');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a due obligation reachable when a full due page holds only null-due retained rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      // Settled obligations persist as retained rows with a null due-at
      // projection until retention reclaims them, and the canonical ordinal
      // index sorts every one of them ahead of all numeric due-at keys.
      for (let index = 0; index < 32; index += 1) {
        await ingestConversationProviderObservationForInvocation(
          observation({
            occurrenceId: `telegram:update:due-null-page-${index}`,
            messageRevision: `due:null-page:${index}`,
            occurredAt: 1_000,
          }),
          harness.context,
        );
      }
      const retained = [...harness.rows.values()].filter(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
      );
      expect(retained).toHaveLength(32);
      expect(retained.every((row) => row.value['due-at'] === undefined)).toBe(true);

      // One live obligation is durably due at 1_500.
      const binding = record(harness.rows.get('binding-1')?.value);
      const bindingPayload = record(binding.payload);
      harness.rows.set('binding-1', stateRow({
        ...binding,
        payload: { ...bindingPayload, inboundDebounceMs: 500 },
      }));
      await expect(ingestConversationProviderObservationForInvocation(
        observation({
          occurrenceId: 'telegram:update:due-null-page-live',
          messageRevision: 'due:null-page:live',
          occurredAt: 1_000,
        }),
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

      vi.setSystemTime(1_500);
      const sendsBeforePump = harness.send.mock.calls.length;
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_500 }, harness.context))
        .resolves.toBe(1);
      expect(harness.send.mock.calls.length).toBe(sendsBeforePump + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reschedules a full page of preparing-census obligations so later valid due work can progress', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let strandPreparation = true;
      const harness = createIngressHarness({
        beforeBatch: ({ operations }) => {
          if (
            strandPreparation
            && operations.some((operation) => (
              operation.kind === 'put'
              && record(record(operation.value).payload).phase === 'prepared'
            ))
          ) {
            throw new Error('Simulated preparation interruption.');
          }
        },
      });

      for (let index = 0; index < 33; index += 1) {
        await expect(ingestConversationProviderObservationForInvocation(
          observation({
            occurrenceId: `telegram:update:preparing-page-${index}`,
            messageRevision: `preparing-page:${index}`,
            occurredAt: 1_000,
          }),
          harness.context,
        )).rejects.toThrow('Simulated preparation interruption.');
      }
      const stranded = [...harness.rows.values()].filter((row) => (
        row.deleted !== true
        && row.value['record-kind'] === 'ingress-obligation'
      ));
      expect(stranded).toHaveLength(33);

      strandPreparation = false;
      const binding = record(harness.rows.get('binding-1')?.value);
      harness.rows.set('binding-1', stateRow({
        ...binding,
        payload: { ...record(binding.payload), inboundDebounceMs: 1 },
      }));
      await expect(ingestConversationProviderObservationForInvocation(
        observation({
          occurrenceId: 'telegram:update:valid-after-preparing-page',
          messageRevision: 'valid-after-preparing-page',
          occurredAt: 1_000,
        }),
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled' });

      vi.setSystemTime(1_001);
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_001, limit: 32 }, harness.context))
        .resolves.toBe(32);
      expect(harness.send).not.toHaveBeenCalled();
      const rescheduled = stranded.filter((row) => {
        const current = harness.rows.get(row.rowId);
        return record(record(current?.value ?? {}).payload).lifecycle !== undefined
          && record(record(record(current?.value ?? {}).payload).lifecycle).dueAt === 2_001;
      });
      expect(rescheduled).toHaveLength(32);
      expect(rescheduled.every((row) => (
        record(record(record(harness.rows.get(row.rowId)?.value ?? {}).payload).lifecycle).attemptCount === 0
      ))).toBe(true);

      await expect(runConversationIngressDueWorkForInvocation({ now: 1_001, limit: 32 }, harness.context))
        .resolves.toBe(2);
      expect(harness.send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves a due obligation with an existing malformed census to durable attention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let strandPreparation = true;
      const harness = createIngressHarness({
        beforeBatch: ({ operations }) => {
          if (
            strandPreparation
            && operations.some((operation) => (
              operation.kind === 'put'
              && record(record(operation.value).payload).phase === 'prepared'
            ))
          ) throw new Error('Simulated preparation interruption.');
        },
      });
      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'malformed-census', occurredAt: 1_000 }),
        harness.context,
      )).rejects.toThrow('Simulated preparation interruption.');
      strandPreparation = false;

      const census = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-census'
      ));
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (census === undefined || obligation === undefined) throw new Error('Expected stranded ingress rows.');
      harness.rows.set(census.rowId, stateRow({
        ...record(census.value),
        payload: { ...record(census.value.payload), normalizedIngress: 'malformed' },
      }, census.revision + 1));

      await expect(runConversationIngressDueWorkForInvocation({ now: 1_000 }, harness.context))
        .resolves.toBe(1);
      expect(harness.rows.get(obligation.rowId)?.value).toMatchObject({
        terminal: false,
        attention: true,
        payload: { lifecycle: { phase: 'blocked', attemptCount: 0, dueAt: null } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles one failed due obligation locally and continues the same due-work page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({
        sessionSend: async (input) => {
          if (record(record(input).source).sourceRef === 'channels:binding:binding-1') {
            throw new Error('first Session boundary failed');
          }
          return { status: 'accepted', localId: 'pending-2' };
        },
      });
      addMatchingBinding(harness.rows);
      for (const bindingId of ['binding-1', 'binding-2']) {
        const binding = record(harness.rows.get(bindingId)?.value);
        const payload = record(binding.payload);
        harness.rows.set(bindingId, stateRow({
          ...binding,
          payload: { ...payload, inboundDebounceMs: 100 },
        }));
      }

      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'edit:1', occurredAt: 1_000 }),
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

      vi.setSystemTime(1_100);
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_100 }, harness.context))
        .resolves.toBe(2);

      expect(harness.send).toHaveBeenCalledTimes(2);
      const obligations = [...harness.rows.values()].filter((row) => (
        row.value['record-kind'] === 'ingress-obligation'
      ));
      expect(obligations.map((row) => record(row.value.payload).lifecycle)).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'retryDue', attemptCount: 1, dueAt: 2_100 }),
        expect.objectContaining({ phase: 'terminal', attemptCount: 1, dueAt: null }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('admits delayed ingress while its exact provider contribution is still admitted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      const binding = record(harness.rows.get('binding-1')?.value);
      harness.rows.set('binding-1', stateRow({
        ...binding,
        payload: { ...record(binding.payload), inboundDebounceMs: 100 },
      }));

      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'delayed:current-provider', occurredAt: 1_000 }),
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });
      expect(harness.send).not.toHaveBeenCalled();

      vi.setSystemTime(1_100);
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_100 }, harness.context))
        .resolves.toBe(1);
      expect(harness.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses delayed ingress whose retained provider contribution retired while it waited', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let admittedContributions: readonly unknown[] = [admittedTelegramProviderContribution];
      const harness = createIngressHarness({
        readAdmittedProviderContributions: () => admittedContributions,
      });
      const binding = record(harness.rows.get('binding-1')?.value);
      harness.rows.set('binding-1', stateRow({
        ...binding,
        payload: { ...record(binding.payload), inboundDebounceMs: 100 },
      }));

      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'delayed:retired-provider', occurredAt: 1_000 }),
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });
      expect(harness.send).not.toHaveBeenCalled();

      // The contributor is retired between admission and the delayed dispatch.
      admittedContributions = [];
      vi.setSystemTime(1_100);
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_100 }, harness.context))
        .resolves.toBe(1);
      expect(harness.send).not.toHaveBeenCalled();
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      expect(record(obligation?.value).payload).toMatchObject({
        lifecycle: { phase: 'terminal' },
        disposition: 'staleAuthority',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-admits delayed ingress through stable contribution identity after its provider occurrence is replaced', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let admittedContributions: readonly unknown[] = [admittedTelegramProviderContribution];
      const harness = createIngressHarness({
        readAdmittedProviderContributions: () => admittedContributions,
      });
      const binding = record(harness.rows.get('binding-1')?.value);
      harness.rows.set('binding-1', stateRow({
        ...binding,
        payload: { ...record(binding.payload), inboundDebounceMs: 100 },
      }));

      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'delayed:replaced-provider', occurredAt: 1_000 }),
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

      admittedContributions = [{
        ...admittedTelegramProviderContribution,
        contributor: {
          ...admittedTelegramProviderContribution.contributor,
          occurrenceId: 'telegram-test-occurrence-2',
          sourceCustody: { kind: 'managed', immutableGenerationId: 'telegram-test-generation-2', installSource: 'npm' },
        },
      }];
      vi.setSystemTime(1_100);
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_100 }, harness.context))
        .resolves.toBe(1);
      expect(harness.send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains checkpoint-covered ingress and its completed member through the frozen replay horizon', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const readIds: string[] = [];
      const harness = createIngressHarness({ beforeCollectionGet: ({ rowId }) => { readIds.push(rowId); } });
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:terminal', occurredAt: 1_000 }),
        harness.context,
      );
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (obligation === undefined) throw new Error('Expected the completed ingress obligation.');

      readIds.length = 0;
      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      // Settlement/compaction still read the unit, but projection custody cannot
      // make it forgettable before its frozen horizon, so do not demand it yet.
      expect(readIds).not.toContain('binding-1');
      expect(harness.rows.get(census.rowId)?.deleted).not.toBe(true);
      // Body compaction does not physically forget the member before the
      // checkpoint/horizon retirement predicate admits the whole unit.
      expect(harness.rows.get(obligation.rowId)).toBeDefined();
      expect(record(record(harness.rows.get(census.rowId)?.value ?? {}).payload).compacted)
        .not.toHaveProperty('prunedObligationTombstones');

      // Horizon/coverage alone cannot retire an input whose reply is still unprojected.
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      await settleAcceptedInputReplyProjection(harness);
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(census.rowId)).toBeUndefined();
      expect(harness.rows.get(obligation.rowId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the retained body of a settled census whose member retirement loses its exact CAS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let failForget = true;
      const harness = createIngressHarness({
        beforeCollectionForget: () => {
          if (failForget) throw new Error('Simulated physical forget conflict.');
        },
      });
      await ingestConversationProviderObservationForInvocation(
        observation({
          messageRevision: 'retention:forget-conflict',
          messageText: 'Retirement conflict body',
          occurredAt: 1_000,
        }),
        harness.context,
      );
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (obligation === undefined) throw new Error('Expected the terminal ingress obligation.');

      // Physical forget is not consulted by body compaction.
      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });
      expect(JSON.stringify(harness.rows.get(census.rowId)?.value)).not.toContain('Retirement conflict body');
      expect(harness.rows.get(obligation.rowId)?.revision).toBe(obligation.revision);

      // The prior Session is no longer this binding's projection target, so
      // reply correlation cannot legitimately prevent physical retirement.
      supersedeBindingSessionTarget(harness.rows, 'session-retargeted');
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0, retryRequired: true });
      expect(harness.rows.get(census.rowId)?.deleted).not.toBe(true);

      failForget = false;
      await expect(runConversationIngressRetentionForInvocation({ now: 61_002, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(census.rowId)).toBeUndefined();
      expect(harness.rows.get(obligation.rowId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes physical member retirement after an interrupted horizon pass from the compact census anchor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let forgetsBeforeInterruption = 2;
      const harness = createIngressHarness({
        beforeCollectionForget: () => {
          if (forgetsBeforeInterruption <= 0) throw new Error('Simulated crash mid-retirement.');
          forgetsBeforeInterruption -= 1;
        },
      });
      addMatchingBinding(harness.rows, 'binding-2');
      addMatchingBinding(harness.rows, 'binding-3');
      await ingestConversationProviderObservationForInvocation(
        observation({
          messageRevision: 'retention:interrupted-retirement',
          messageText: 'Interrupted retirement body',
          occurredAt: 1_000,
        }),
        harness.context,
      );
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      const members = [...harness.rows.values()].filter((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      expect(members).toHaveLength(3);
      expect(harness.send).toHaveBeenCalledTimes(3);

      // Compaction first retains every exact member identity without touching
      // physical rows.
      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });
      expect(members.filter((member) => harness.rows.get(member.rowId) === undefined)).toHaveLength(0);
      const interrupted = record(record(harness.rows.get(census.rowId)?.value ?? {}).payload);
      expect(record(interrupted.compacted).retainedAttentionObligationRowIds).toHaveLength(3);
      expect(interrupted.matchedBindings).toEqual([]);

      // At the horizon, two members retire and the simulated interruption
      // leaves the compact census naming the complete set for recovery.
      for (const bindingId of ['binding-1', 'binding-2', 'binding-3']) {
        await settleAcceptedInputReplyProjection(harness, bindingId);
      }
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 0, deletedCensuses: 0 });
      expect(members.filter((member) => harness.rows.get(member.rowId) === undefined)).toHaveLength(2);
      expect(harness.rows.get(census.rowId)).toBeDefined();

      forgetsBeforeInterruption = Number.MAX_SAFE_INTEGER;
      await expect(runConversationIngressRetentionForInvocation({ now: 61_002, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 0, deletedCensuses: 1 });
      for (const member of members) expect(harness.rows.get(member.rowId)).toBeUndefined();
      expect(harness.rows.get(census.rowId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still refuses a replay whose census does not prove the settled retention-eligible state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      addMatchingBinding(harness.rows, 'binding-2');
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:unproven-absence', occurredAt: 1_000 }),
        harness.context,
      );
      const members = [...harness.rows.values()].filter((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      expect(members).toHaveLength(2);

      // Corrupt shape, never a retention outcome: one member is gone while
      // its census is neither checkpoint-covered nor otherwise proven
      // settled, so absence cannot be trusted as terminally retired.
      harness.rows.delete(members[0]!.rowId);
      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:unproven-absence', occurredAt: 1_000 }),
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_obligation_missing' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes a compacted census the shipped Collection schema accepts with only the canonical replay digest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const validateChannelState = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
      const harness = createIngressHarness();
      await ingestConversationProviderObservationForInvocation(
        withTelegramAutomationEventCandidate(observation({
          messageRevision: 'retention:compaction-schema',
          messageText: 'Schema-checked compaction body',
          occurredAt: 1_000,
        })),
        harness.context,
      );
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1 });

      const compactedRow = harness.rows.get(census.rowId);
      expect(isValidPluginJsonSchemaValue(validateChannelState, compactedRow?.value)).toBe(true);
      const compacted = record(record(record(compactedRow?.value ?? {}).payload).compacted);
      expect(Object.keys(compacted).sort())
        .toEqual(['replayDigest', 'retainedAttentionObligationRowIds', 'shell']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkpoint-covers and compacts one 256-binding plus provider-Event census as one 257-member unit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const admitted = withTelegramAutomationEventCandidate(observation({
        occurrenceId: 'telegram:update:retention-maximum-fanout',
        messageRevision: 'retention:maximum-fanout',
        messageText: 'Maximum fanout body removed after settlement',
        occurredAt: 1_000,
      }));
      const pollResults: JsonValue[] = [
        { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } },
        {
          kind: 'batch',
          observations: [admitted.entry],
          checkpointAfterBatch: { cursor: 'maximum-fanout-covered' },
        },
      ];
      const harness = createIngressHarness({
        getPollResult: () => {
          const result = pollResults.shift();
          if (result === undefined) throw new Error('Expected the scripted maximum-fanout poll result.');
          return result;
        },
      });
      for (let index = 2; index <= 256; index += 1) {
        addMatchingBinding(harness.rows, `binding-${index}`);
      }

      const gap = setConnectionHistoryGap(harness.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(gap.value).payload), 'configurationRevision'),
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      const census = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-census'
      ));
      if (census === undefined) throw new Error('Expected the maximum-fanout census.');
      const obligations = [...harness.rows.values()].filter((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      expect(obligations).toHaveLength(257);
      expect(obligations.filter((row) => record(record(row.value.payload).target).kind === 'event'))
        .toHaveLength(1);
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
        payload: { opaqueToken: { cursor: 'maximum-fanout-covered' } },
      });
      expect(record(census.value.payload).checkpointCoveredAt).toBe(1_000);

      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });

      expect(JSON.stringify(harness.rows.get(census.rowId)?.value))
        .not.toContain('Maximum fanout body removed after settlement');
      expect([...harness.rows.values()].filter((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ))).toHaveLength(257);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { compacted: false, historicalFirst: true, change: null },
    { compacted: false, historicalFirst: false, change: null },
    { compacted: true, historicalFirst: true, change: null },
    { compacted: true, historicalFirst: false, change: null },
    ...[false, true].flatMap(compacted => (['part', 'name', 'length'] as const).map(change => ({ compacted, historicalFirst: true, change }))),
  ])('compares retained native Email attachment evidence across the codec transition: %j', async ({ compacted, historicalFirst, change }) => {
    // Mailparser's stream scheduler uses real process ticks; freeze only the
    // ingress owner's clock after the native-message boundary has completed.
    const mail = await simpleParser(await readFile(new URL('../../channel-email/src/email/fixtures/seed1-forwarded-attachments.eml', import.meta.url)),
      { skipImageLinks: true, skipHtmlToText: true, skipTextToHtml: true });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      // Real retained seed1 message #3. The historical descriptor formula is
      // pinned to dd247000f8adde414c43ff0831ce4fb4e54bfe4f^ parseEmail.
      const native = mail.attachments.map((attachment, index) => ({
        attachmentId: `mime:${attachment.partId ?? index + 1}`, name: attachment.filename ?? `attachment-${index + 1}`,
        mediaType: attachment.contentType, byteLength: attachment.content.length,
      }));
      expect(native).toEqual([{ attachmentId: 'mime:3', name: 'qa-live13-lead.pdf', mediaType: 'application/pdf', byteLength: 619 }]);
      const portable = native.map(attachment => ({ ...attachment,
        attachmentId: createConversationAttachmentIdV1('email', [attachment.attachmentId]),
      }));
      const original = observation({ messageRevision: 'retained-email:1', occurredAt: 1_000 });
      const stored = ConversationProviderObservationIngestInputV1Schema.parse({ ...original, entry: { ...original.entry,
        observation: { kind: 'fullText', observation: { ...fullTextIngress(original), message: {
          ...fullTextIngress(original).message, attachments: historicalFirst ? native : portable,
        } } } } });
      const incomingAttachments = (historicalFirst ? portable : native).map(attachment => ({ ...attachment,
        ...(change === 'part' ? { attachmentId: createConversationAttachmentIdV1('email', ['mime:4']) } : {}),
        ...(change === 'name' ? { name: 'different.pdf' } : {}),
        ...(change === 'length' ? { byteLength: attachment.byteLength + 1 } : {}),
      }));
      const incoming = ConversationProviderObservationIngestInputV1Schema.parse({ ...original, entry: { ...original.entry,
        observation: { kind: 'fullText', observation: { ...fullTextIngress(original), message: {
          ...fullTextIngress(original).message, attachments: incomingAttachments,
        } } } } });
      const harness = createIngressHarness();
      const connection = channelConnection();
      const censusId = await deriveIngressCensusRowId({ routingIdentityKey: connection.payload.routingIdentityKey,
        connectionId: connection.id, occurrenceId: fullTextIngress(original).occurrenceId });
      const value = createIngressCensusValue({ censusId, connectionId: connection.id, ingress: stored.entry.observation,
        connectionAuthorityEpoch: connection.payload.authorityEpoch, maximumObservationAgeMs: 60_000,
        matchedBindings: [], now: 1_000 });
      harness.rows.set(censusId, stateRow({ ...value, payload: { ...record(value.payload), phase: 'prepared' } }));
      if (compacted) {
        await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
          .resolves.toMatchObject({ compactedCensuses: 1 });
        expect(record(harness.rows.get(censusId)?.value.payload).normalizedIngress).toBeNull();
      }
      const replay = ingestConversationProviderObservationForInvocation(incoming, harness.context);
      if (change === null) {
        await expect(replay).resolves.toBeUndefined();
        expect(harness.rows.get(censusId)?.value.attention).toBe(false);
      } else {
        await expect(replay).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
        expect(harness.rows.get(censusId)?.value.attention).toBe(true);
      }
      expect(harness.send).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])('finishes the ingress retention keyset sweep before replaying Collection invalidations from its own compaction (continuation failure: %s)', async (failContinuation) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const generation = new AbortController();
    const changes = new Set<() => void>();
    const harness = createIngressHarness({ connection: socketChannelConnection(), afterBatch: () => {
      // Authenticated Collection publication is the system boundary. Match
      // its level-triggered microtask delivery, including this owner's writes.
      queueMicrotask(() => { for (const notify of changes) notify(); });
    } });
    let running: Promise<void> | undefined;
    const supervisor = createIngressSupervisor();
    try {
      for (let index = 0; index <= PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1; index++) {
        await ingestConversationProviderObservationForInvocation(observation({
          occurrenceId: `telegram:retention-page:${index}`, messageRevision: `retention-page:${index}`,
          occurredAt: 1_000, transport: 'socket',
        }), harness.context);
      }
      const censusRows = [...harness.rows.values()].filter(row => row.value['record-kind'] === 'ingress-census');
      expect(censusRows).toHaveLength(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 + 1);
      const firstPageCursor = censusRows.map(row => row.rowId).sort()[PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 - 1];
      const account = harness.context.services.storage.account;
      if (!account) throw new Error('Missing Account storage boundary');
      const collection = account.collection(CHANNEL_STATE_COLLECTION);
      const retentionCursors: Array<string | undefined> = [];
      let secondPageStarted: (() => void) | undefined;
      const secondPage = new Promise<void>(resolve => { secondPageStarted = resolve; });
      let fourthPageStarted: (() => void) | undefined;
      const fourthPage = new Promise<void>(resolve => { fourthPageStarted = resolve; });
      const watchedCollection = { ...collection,
        async query(...args: Parameters<typeof collection.query>) {
          if (args[0].index === 'by-kind' && args[0].prefix?.[0] === 'ingress-census') {
            retentionCursors.push(args[0].cursor);
            if (retentionCursors.length === 2) {
              secondPageStarted?.();
              if (failContinuation) throw new Error('Simulated Account Collection query failure.');
            }
            if (retentionCursors.length === 4) fourthPageStarted?.();
          }
          return await collection.query(...args);
        },
        watch(_request: unknown, notify: () => void) {
          changes.add(notify);
          return { dispose: () => { changes.delete(notify); } };
        },
      };
      // Only Account storage and Event transport are supplied by the fixture;
      // ingress production, retention and supervision all remain real.
      const context: BackgroundServiceContext = { ...harness.context, surface: 'background', session: undefined, signal: generation.signal,
        services: { ...harness.context.services,
          storage: { account: { collection: () => watchedCollection } },
          events: { plugin: { emit: async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }) } },
        } as unknown as PluginServices,
      };
      running = supervisor.run(context);
      if (failContinuation) {
        await secondPage;
        await vi.advanceTimersByTimeAsync(0);
        expect(retentionCursors).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(999);
        expect(retentionCursors).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
      }
      await fourthPage;
      await vi.advanceTimersByTimeAsync(0);
      expect(retentionCursors).toEqual(failContinuation
        ? [undefined, firstPageCursor, firstPageCursor, undefined, firstPageCursor]
        : [undefined, firstPageCursor, undefined, firstPageCursor]);
      for (const census of censusRows) {
        expect(record(harness.rows.get(census.rowId)?.value.payload).normalizedIngress).toBeNull();
      }
      const parkedCursors = [...retentionCursors];
      await vi.advanceTimersByTimeAsync(59_000);
      expect(retentionCursors).toEqual(parkedCursors);
    } finally {
      generation.abort();
      await running;
      await supervisor.dispose();
      vi.useRealTimers();
    }
  });

  it.each(['recovery', 'paged-recovery', 'change', 'expiry'] as const)('preserves physical-retirement recovery without withholding %s wakes', async (wakeKind) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const generation = new AbortController();
    const changes = new Set<() => void>();
    const forgetTimes: number[] = [];
    let retried: (() => void) | undefined;
    const retryAttempt = new Promise<void>(resolve => { retried = resolve; });
    let blockedMemberId: string | undefined;
    let retirementBlocked = true;
    let compactionTargetId: string | undefined;
    let compactionDone: (() => void) | undefined;
    let changedOutcome: ((outcome: 'compacted' | 'parked') => void) | undefined;
    const harness = createIngressHarness({
      connection: socketChannelConnection(),
      beforeCollectionForget: ({ rowId }) => {
        if (rowId !== blockedMemberId) return;
        forgetTimes.push(Date.now());
        if (forgetTimes.length === 2) retried?.();
        if (retirementBlocked) throw new Error('Simulated physical retirement failure.');
      },
      afterBatch: () => queueMicrotask(() => {
        for (const notify of changes) notify();
        if (compactionTargetId !== undefined
          && record(harness.rows.get(compactionTargetId)?.value.payload).normalizedIngress === null) compactionDone?.();
      }),
    });
    let parked: (() => void) | undefined;
    const recoveryWait = new Promise<void>(resolve => { parked = resolve; });
    const supervisor = createIngressSupervisor({ clock: {
      now: () => Date.now(),
      sleep: (delayMs, signal) => new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const onAbort = () => { globalThis.clearTimeout(timer); reject(signal.reason); };
        const timer = globalThis.setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        signal.addEventListener('abort', onAbort, { once: true });
        if (delayMs === (wakeKind === 'expiry' ? 500 : 1_000)) parked?.();
        if (changedOutcome !== undefined && compactionTargetId !== undefined && Date.now() === 61_251) {
          const payload = record(harness.rows.get(compactionTargetId)?.value.payload);
          if (payload.phase === 'prepared' && payload.normalizedIngress !== null) changedOutcome('parked');
        }
      }),
    } });
    let running: Promise<void> | undefined;
    try {
      const identities = await Promise.all(Array.from({ length: wakeKind === 'paged-recovery'
        ? PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 + 1 : 2 }, async (_, index) => {
        const occurrenceId = `telegram:retention-recovery:${index}`;
        return { occurrenceId, censusId: await deriveIngressCensusRowId({
          routingIdentityKey: socketChannelConnection().payload.routingIdentityKey,
          connectionId: 'connection-1', occurrenceId,
        }) };
      }));
      identities.sort((left, right) => left.censusId < right.censusId ? -1 : left.censusId === right.censusId ? 0 : 1);
      const [expired, ...retained] = identities;
      if (!expired) throw new Error('Missing expired ingress identity');
      await ingestConversationProviderObservationForInvocation(observation({
        occurrenceId: expired.occurrenceId, messageRevision: expired.occurrenceId,
        occurredAt: 1_000, transport: 'socket',
      }), harness.context);
      await settleAcceptedInputReplyProjection(harness);
      blockedMemberId = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation')?.rowId;
      if (blockedMemberId === undefined) throw new Error('Missing expired census member');
      vi.setSystemTime(61_001);
      for (const identity of retained) {
        await ingestConversationProviderObservationForInvocation(observation({
          occurrenceId: identity.occurrenceId, messageRevision: identity.occurrenceId,
          occurredAt: wakeKind === 'expiry' ? 1_500 : 61_001, transport: 'socket',
        }), harness.context);
      }
      compactionTargetId = retained.at(-1)?.censusId;
      const firstCompaction = new Promise<void>(resolve => { compactionDone = resolve; });
      const account = harness.context.services.storage.account;
      if (!account) throw new Error('Missing Account storage boundary');
      const collection = account.collection(CHANNEL_STATE_COLLECTION);
      const retentionTimes: number[] = [];
      const watchedCollection = { ...collection,
        async forget(...args: Parameters<typeof collection.forget>) {
          const result = await collection.forget(...args);
          queueMicrotask(() => { for (const notify of changes) notify(); });
          return result;
        },
        async query(...args: Parameters<typeof collection.query>) {
          if (args[0].index === 'by-kind' && args[0].prefix?.[0] === 'ingress-census') retentionTimes.push(Date.now());
          return await collection.query(...args);
        },
        watch(_request: unknown, notify: () => void) {
          changes.add(notify);
          return { dispose: () => { changes.delete(notify); } };
        },
      };
      // Account storage and Event transport remain the only supplied boundaries.
      const context: BackgroundServiceContext = { ...harness.context, surface: 'background', session: undefined, signal: generation.signal,
        services: { ...harness.context.services,
          storage: { account: { collection: () => watchedCollection } },
          events: { plugin: { emit: async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }) } },
        } as unknown as PluginServices,
      };
      running = supervisor.run(context);
      await firstCompaction;
      await recoveryWait;
      await vi.advanceTimersByTimeAsync(0);
      expect(forgetTimes).toEqual([61_001]);
      if (wakeKind === 'change') {
        await vi.advanceTimersByTimeAsync(250);
        // The completed failed sweep is parked. Repair its transient storage
        // failure before later real producer writes, so another failing sweep
        // does not establish a fresh maintenance recovery deadline.
        retirementBlocked = false;
        const priorAdmissions = harness.send.mock.calls.length;
        const changed = observation({ occurrenceId: 'telegram:retention-recovery:changed',
          messageRevision: 'retention-recovery:changed', occurredAt: Date.now(), transport: 'socket' });
        compactionTargetId = await deriveIngressCensusRowId({ routingIdentityKey: socketChannelConnection().payload.routingIdentityKey,
          connectionId: 'connection-1', occurrenceId: fullTextIngress(changed).occurrenceId });
        const changedCompaction = new Promise<'compacted' | 'parked'>(resolve => {
          changedOutcome = resolve;
          compactionDone = () => { resolve('compacted'); };
        });
        await ingestConversationProviderObservationForInvocation(changed, harness.context);
        expect(harness.send).toHaveBeenCalledTimes(priorAdmissions + 1);
        await vi.advanceTimersByTimeAsync(0);
        expect(retentionTimes).toContain(61_251);
        expect(await changedCompaction).toBe('compacted');
        expect(Date.now()).toBe(61_251);
      } else {
        const delay = wakeKind === 'expiry' ? 500 : 1_000;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(forgetTimes).toEqual([61_001]);
        await vi.advanceTimersByTimeAsync(1);
        await retryAttempt;
        expect(forgetTimes).toEqual([61_001, 61_001 + delay]);
      }
    } finally {
      generation.abort();
      await running;
      await supervisor.dispose();
      vi.useRealTimers();
    }
  });

  it('compacts a settled census in place, then still decides replay equality without its message body', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      const admitted = withTelegramAutomationEventCandidate(observation({
        messageRevision: 'retention:compaction',
        messageText: 'Compaction secret body',
        occurredAt: 1_000,
      }));
      Object.assign(fullTextIngress(admitted).endpoint, { label: 'Compaction private subject', parentLabel: 'Compaction private mailbox' });
      await ingestConversationProviderObservationForInvocation(admitted, harness.context);
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      expect(harness.send).toHaveBeenCalledOnce();
      expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(harness.rows.get(census.rowId)?.value)).toContain('Compaction secret body');

      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });

      const compacted = harness.rows.get(census.rowId);
      expect(JSON.stringify(compacted?.value)).not.toContain('Compaction secret body');
      expect(JSON.stringify(compacted?.value)).not.toContain('Compaction private');
      const compactedPayload = record(record(compacted?.value ?? {}).payload);
      expect(compactedPayload.normalizedIngress).toBeNull();
      expect(record(compactedPayload.compacted)).toMatchObject({
        shell: expect.any(Object),
        replayDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      });
      // Settlement has no remaining consumer for either the binding fanout or
      // the provider Event candidate. The compact replay witness is the sole
      // retained ingress identity, and terminal member rows remain until the
      // separate physical-forgetting predicate is satisfied.
      expect(compactedPayload.eventCandidate).toBeNull();
      expect(compactedPayload.matchedBindings).toEqual([]);
      expect([...harness.rows.values()].filter((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ))).toHaveLength(2);

      // Settlement is proven once; a later pass rewrites nothing.
      await expect(runConversationIngressRetentionForInvocation({ now: 2_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 0, deletedCensuses: 0 });

      // Exact replay still rejoins the same occurrence from the digest: no
      // second Session admission and no contradictory-evidence conflict.
      vi.setSystemTime(2_002);
      await expect(ingestConversationProviderObservationForInvocation(admitted, harness.context))
        .resolves.toBeUndefined();
      expect(harness.send).toHaveBeenCalledOnce();
      expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
      expect(harness.rows.get(census.rowId)?.value.attention).toBe(false);

      // A different body under the same occurrence identity is still
      // contradictory evidence, so the digest is a discriminating fact.
      await expect(ingestConversationProviderObservationForInvocation(
        observation({
          messageRevision: 'retention:compaction',
          messageText: 'A different body entirely',
          occurredAt: 1_000,
        }),
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
      expect(harness.rows.get(census.rowId)?.value.attention).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compacts a prepared terminal poll census before checkpoint coverage but forgets it only after coverage and age', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      await ingestConversationProviderObservationForInvocation(
        observation({
          occurrenceId: 'telegram:update:compact-before-checkpoint',
          messageRevision: 'compact-before-checkpoint',
          messageText: 'Body removed before checkpoint coverage',
          occurredAt: 1_000,
        }),
        harness.context,
      );
      const census = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-census'
      ));
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (census === undefined || obligation === undefined) throw new Error('Expected settled ingress rows.');

      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });
      expect(JSON.stringify(harness.rows.get(census.rowId)?.value))
        .not.toContain('Body removed before checkpoint coverage');
      expect(harness.rows.get(obligation.rowId)).toBeDefined();

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(census.rowId)).toBeDefined();
      expect(harness.rows.get(obligation.rowId)).toBeDefined();

      markIngressCensusCheckpointCovered(harness.rows, 61_002);
      await settleAcceptedInputReplyProjection(harness);
      await expect(runConversationIngressRetentionForInvocation({ now: 61_003, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(census.rowId)).toBeUndefined();
      expect(harness.rows.get(obligation.rowId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('conflicts a compacted census replay whose Event candidate changed or disappeared', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      // The compacted witness digests the first-admission Event candidate
      // beside the text, so a same-occurrence redelivery whose semantic Event
      // evidence changed — or disappeared — is contradictory evidence inside
      // the replay horizon exactly as the uncompacted census decides it.
      const changedCandidate = (
        input: ConversationProviderObservationIngestInputV1,
      ): ConversationProviderObservationIngestInputV1 => {
        const withCandidate = withTelegramAutomationEventCandidate(input);
        const eventCandidate = withCandidate.entry.eventCandidate;
        if (eventCandidate === null) {
          throw new Error('Expected the Telegram fixture to carry an Event candidate');
        }
        return {
          connectionId: withCandidate.connectionId,
          entry: {
            observation: withCandidate.entry.observation,
            eventCandidate: {
              ...eventCandidate,
              payload: { chatId: '100', messageId: 'telegram:message:6' },
            },
          },
        };
      };

      const changedHarness = createIngressHarness();
      const changedAdmitted = withTelegramAutomationEventCandidate(observation({
        messageRevision: 'retention:compaction-changed',
        messageText: 'Compaction candidate body',
        occurredAt: 1_000,
      }));
      await ingestConversationProviderObservationForInvocation(changedAdmitted, changedHarness.context);
      const changedCensus = markIngressCensusCheckpointCovered(changedHarness.rows, 1_000);
      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, changedHarness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });
      const changedCompacted = record(record(changedHarness.rows.get(changedCensus.rowId)?.value ?? {}).payload);
      expect(changedCompacted.normalizedIngress).toBeNull();
      expect(record(changedCompacted.compacted)).toMatchObject({
        replayDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      });

      // The exact replay — body, shell, and candidate — still rejoins.
      vi.setSystemTime(2_001);
      await expect(ingestConversationProviderObservationForInvocation(changedAdmitted, changedHarness.context))
        .resolves.toBeUndefined();
      expect(changedHarness.rows.get(changedCensus.rowId)?.value.attention).toBe(false);

      // A changed semantic candidate under the same occurrence conflicts.
      await expect(ingestConversationProviderObservationForInvocation(
        changedCandidate(observation({
          messageRevision: 'retention:compaction-changed',
          messageText: 'Compaction candidate body',
          occurredAt: 1_000,
        })),
        changedHarness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
      expect(changedHarness.rows.get(changedCensus.rowId)?.value.attention).toBe(true);

      // A disappeared candidate under the same occurrence conflicts too.
      const disappearedHarness = createIngressHarness();
      const disappearedAdmitted = withTelegramAutomationEventCandidate(observation({
        messageRevision: 'retention:compaction-disappeared',
        messageText: 'Compaction candidate body two',
        occurredAt: 1_000,
      }));
      await ingestConversationProviderObservationForInvocation(disappearedAdmitted, disappearedHarness.context);
      const disappearedCensus = markIngressCensusCheckpointCovered(disappearedHarness.rows, 1_000);
      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, disappearedHarness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });
      vi.setSystemTime(2_002);
      await expect(ingestConversationProviderObservationForInvocation(
        observation({
          messageRevision: 'retention:compaction-disappeared',
          messageText: 'Compaction candidate body two',
          occurredAt: 1_000,
        }),
        disappearedHarness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
      expect(disappearedHarness.rows.get(disappearedCensus.rowId)?.value.attention).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a census row that carries neither its admitted ingress nor a replay shell', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:no-occurrence', occurredAt: 1_000 }),
        harness.context,
      );
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      const value = record(census.value);
      // The Collection schema permits both halves to be null; only the census
      // reader knows a row with no occurrence at all has no replay identity,
      // no retention anchor, and no envelope to project.
      harness.rows.set(census.rowId, stateRow({
        ...value,
        payload: { ...record(value.payload), normalizedIngress: null, compacted: null },
      }, census.revision + 1));

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 0, deletedCensuses: 0 });
      expect(harness.rows.get(census.rowId)?.deleted).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains an attended routable non-admission without compacting a body it never held', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      await ingestConversationProviderObservationForInvocation(
        routableNonAdmission({ messageRevision: 'retention:non-admission', occurredAt: 1_000 }),
        harness.context,
      );
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);

      // A refused occurrence persists only its envelope, so the settled sweep
      // has no duplicated body to reclaim and must not fault reaching for the
      // admitted observation a non-admission census does not carry.
      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 0, deletedCensuses: 0 });
      const swept = record(record(harness.rows.get(census.rowId)?.value ?? {}).payload);
      expect(swept.compacted).toBeNull();
      expect(record(swept.normalizedIngress).kind).toBe('routableNonAdmission');

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(census.rowId)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recognizes a later unsupported edit of a compacted occurrence from its retained envelope', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      await ingestConversationProviderObservationForInvocation(
        observation({
          messageRevision: 'retention:compaction-edit',
          messageText: 'Edited away',
          occurredAt: 1_000,
        }),
        harness.context,
      );
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1 });
      expect(JSON.stringify(harness.rows.get(census.rowId)?.value)).not.toContain('Edited away');

      vi.setSystemTime(2_002);
      await expect(ingestConversationProviderObservationForInvocation(
        routableNonAdmission({
          messageRevision: 'retention:compaction-edit:v2',
          occurredAt: 1_000,
          reason: 'unsupportedEdit',
        }),
        harness.context,
      )).resolves.toBeUndefined();
      expect(harness.rows.get(census.rowId)?.value.attention).toBe(false);
      expect(harness.send).toHaveBeenCalledOnce();

      // The compact replay shell still anchors the frozen horizon.
      await settleAcceptedInputReplyProjection(harness);
      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(census.rowId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the retained input while unknown Session admission remains retryable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const occurrenceId = 'telegram:update:blocked-keeps-body';
      const blockedIngress = observation({
        messageRevision: 'retention:blocked-keeps-body',
        messageText: 'Blocked member body',
        occurrenceId,
        occurredAt: 1_000,
      });
      const harness = createIngressHarness({
        sessionSendResults: [
          ...Array.from({ length: 5 }, () => ({
            status: 'outcomeUnknown' as const,
            localId: 'pending-1',
            code: 'transport_unknown',
          })),
          { status: 'accepted' as const, localId: 'pending-2' },
        ],
        getPollResult: (): JsonValue => (currentCheckpoint(harness.rows) === undefined
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [blockedIngress.entry],
            checkpointAfterBatch: { cursor: 'past-blocked-occurrence' },
          }),
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await runConversationCheckpointedPollForInvocation({
          connectionId: 'connection-1',
          waitMs: 0,
        }, harness.context);
        const pending = [...harness.rows.values()].find(
          (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
        );
        if (pending === undefined) throw new Error('Expected a retained ingress obligation row.');
        const dueAt = record(record(record(pending.value).payload).lifecycle).dueAt;
        if (typeof dueAt === 'number') vi.setSystemTime(dueAt);
      }
      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId,
      });
      const blocked = [...harness.rows.values()].find(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
      );
      if (blocked === undefined) throw new Error('Expected the blocked ingress obligation.');
      expect(record(record(blocked.value).payload).lifecycle).toMatchObject({ phase: 'retryDue' });
      expect(record(record(harness.rows.get(censusId)?.value ?? {}).payload).checkpointCoveredAt)
        .toBeNull();

      // The pending page holds the cursor, and due-work needs the exact retained input.
      const retryAt = Date.now();
      vi.setSystemTime(retryAt);
      await expect(runConversationIngressRetentionForInvocation({ now: retryAt, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 0, deletedCensuses: 0 });
      expect(JSON.stringify(harness.rows.get(censusId)?.value)).toContain('Blocked member body');

      await expect(runConversationIngressDueWorkForInvocation({ now: retryAt }, harness.context))
        .resolves.toBe(1);
      expect(harness.rows.get(blocked.rowId)?.value).toMatchObject({
        terminal: true,
        payload: { lifecycle: { phase: 'terminal' }, disposition: 'admitted' },
      });

      // Only now that the last member settled does the body become redundant.
      await expect(runConversationIngressRetentionForInvocation({ now: retryAt + 1, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });
      expect(JSON.stringify(harness.rows.get(censusId)?.value)).not.toContain('Blocked member body');
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes a stranded preparing census on replay after its frozen window closed instead of deleting the captured message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let armed = true;
      const harness = createIngressHarness({
        beforeBatch: ({ operations }) => {
          const preparesCensus = operations.some((operation) => (
            operation.kind === 'put'
            && record(record(operation.value).payload).phase === 'prepared'
          ));
          if (armed && preparesCensus) {
            armed = false;
            throw new Error('Simulated Account Collection failure on the prepared census write.');
          }
        },
      });

      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:preparing', occurredAt: 1_000 }),
        harness.context,
      )).rejects.toThrow();
      const census = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-census'
      ));
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (census === undefined || obligation === undefined) {
        throw new Error('Expected the stranded ingress census and its member.');
      }
      expect(record(census.value.payload).phase).toBe('preparing');
      expect(record(record(obligation.value).payload).lifecycle).toMatchObject({ phase: 'ready' });
      expect(harness.send).not.toHaveBeenCalled();

      // The frozen observation window is a first-sighting admission bound. It
      // may not retire a unit the Account already accepted: the census still
      // holds the only copy of the captured inbound message and its member is
      // still non-terminal.
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(census.rowId)?.deleted).not.toBe(true);
      expect(harness.rows.get(obligation.rowId)?.deleted).not.toBe(true);

      // The same occurrence replays long after the horizon. An existing census
      // is durable proof that first-observation admission already happened, so
      // the replay rejoins it, finishes preparation, and delivers exactly once.
      vi.setSystemTime(61_002);
      await expect(ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:preparing', occurredAt: 1_000 }),
        harness.context,
      )).resolves.toBeUndefined();
      const prepared = harness.rows.get(census.rowId);
      expect(record(record(prepared?.value ?? {}).payload).phase).toBe('prepared');
      expect(harness.send).toHaveBeenCalledOnce();

      // Only once the checkpoint has covered the finished unit may retention
      // reclaim it, after the accepted input's reply has been projected.
      const covered = markIngressCensusCheckpointCovered(harness.rows, 61_002);
      await settleAcceptedInputReplyProjection(harness);
      await expect(runConversationIngressRetentionForInvocation({ now: 121_003, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(covered.rowId)).toBeUndefined();
      await expect(runConversationIngressDueWorkForInvocation({ now: 121_004 }, harness.context))
        .resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires a settled fan-out after the deployment batch-row limit is lowered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const deleteBatchSizes: number[] = [];
      let limits = deploymentLimits({ maxBatchRows: 100, maxBatchBytes: 16 * 1024 * 1024 });
      const harness = createIngressHarness({
        get collectionLimits() { return limits; },
        beforeBatch: ({ operations }) => {
          if (operations.every((operation) => operation.kind === 'delete')) {
            deleteBatchSizes.push(operations.length);
          }
        },
      });
      addBindingForEndpoint({
        rows: harness.rows,
        bindingId: 'binding-2',
        endpointId: 'telegram:chat:100',
        sessionId: 'session-1',
      });
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:batch-limit', occurredAt: 1_000 }),
        harness.context,
      );
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      const obligations = [...harness.rows.values()].filter((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      expect(obligations).toHaveLength(2);

      // An operator lowered the admitted batch below this census's fan-out.
      await settleAcceptedInputReplyProjection(harness);
      await settleAcceptedInputReplyProjection(harness, 'binding-2');
      limits = deploymentLimits({ maxBatchRows: 1, maxBatchBytes: 16 * 1024 * 1024 });
      deleteBatchSizes.length = 0;

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });

      expect(deleteBatchSizes.every((size) => size <= 1)).toBe(true);
      expect(harness.rows.get(census.rowId)).toBeUndefined();
      for (const obligation of obligations) {
        expect(harness.rows.get(obligation.rowId)).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires settled socket ingress at its frozen horizon without a checkpoint fact it can never receive', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({ connection: socketChannelConnection() });
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:socket', occurredAt: 1_000, transport: 'socket' }),
        harness.context,
      );
      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId: 'telegram:update:9001',
      });
      const census = harness.rows.get(censusId);
      if (census === undefined) throw new Error('Expected the socket ingress census.');
      // Socket ingress rides no checkpoint, so nothing ever writes this fact.
      expect(record(record(census.value).payload).checkpointCoveredAt).toBeNull();
      expect(record(record(census.value).payload).normalizedIngress).toMatchObject({
        observation: { message: { text: 'Hello from Telegram' } },
      });
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (obligation === undefined) throw new Error('Expected the completed ingress obligation.');
      expect(record(record(obligation.value).payload).lifecycle).toMatchObject({ phase: 'terminal' });

      await settleAcceptedInputReplyProjection(harness);
      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(censusId)?.deleted).not.toBe(true);

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(censusId)).toBeUndefined();
      expect(harness.rows.get(obligation.rowId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('compacts an actionless mention-gated non-admission before expiring its minimal explanation at the replay horizon', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const validateChannelState = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
      const harness = createIngressHarness({
        connection: socketChannelConnection(),
        beforeBatch: ({ operations }) => {
          for (const operation of operations) {
            if (operation.kind === 'put') {
              expect(isValidPluginJsonSchemaValue(validateChannelState, operation.value)).toBe(true);
            }
          }
        },
      });
      setSharedMentionGatedBinding(harness.rows);
      await ingestConversationProviderObservationForInvocation(
        sharedGroupObservation({
          messageRevision: 'retention:not-addressed',
          occurredAt: 1_000,
          transport: 'socket',
        }),
        harness.context,
      );
      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId: 'telegram:update:9001',
      });
      const census = harness.rows.get(censusId);
      if (census === undefined) throw new Error('Expected the mention-gated ingress census.');
      // The complete inbound body lives exactly once, on this census row.
      expect(record(record(census.value).payload).normalizedIngress).toMatchObject({
        observation: { message: { text: 'Hello from Telegram' } },
      });
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (obligation === undefined) throw new Error('Expected the refused ingress obligation.');
      // Owner-visible, but terminal and actionless: no retry, no acknowledge.
      expect(obligation.value).toMatchObject({
        terminal: true,
        attention: true,
        payload: {
          lifecycle: { phase: 'terminal' },
          disposition: 'rejected',
          nonAdmission: { reason: 'notAddressed' },
        },
      });
      expect(harness.send).not.toHaveBeenCalled();

      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });
      expect(JSON.stringify(harness.rows.get(censusId)?.value)).not.toContain('Hello from Telegram');
      expect(record(record(harness.rows.get(censusId)?.value ?? {}).payload)).toMatchObject({
        eventCandidate: null,
        matchedBindings: [],
        compacted: { retainedAttentionObligationRowIds: [obligation.rowId] },
      });
      expect(harness.rows.get(obligation.rowId)).toMatchObject({
        value: {
          terminal: true,
          attention: true,
          payload: {
            target: null,
            lifecycle: { phase: 'terminal' },
            disposition: 'rejected',
            nonAdmission: { reason: 'notAddressed' },
          },
        },
      });

      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(censusId)?.deleted).not.toBe(true);

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(censusId)).toBeDefined();
      expect(harness.rows.get(obligation.rowId)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retained terminal attention when a compacted occurrence later becomes contradictory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const occurrenceId = 'telegram:update:retention-attention-replay-conflict';
      const harness = createIngressHarness({ connection: socketChannelConnection() });
      setSharedMentionGatedBinding(harness.rows);
      await ingestConversationProviderObservationForInvocation(
        sharedGroupObservation({
          occurrenceId,
          messageRevision: 'retention:attention-replay-conflict',
          messageText: 'Original private body',
          occurredAt: 1_000,
          transport: 'socket',
        }),
        harness.context,
      );
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (obligation === undefined) throw new Error('Expected the terminal attention obligation.');
      const censusId = record(obligation.value.payload).censusId;
      if (typeof censusId !== 'string') throw new Error('Expected the obligation census identity.');

      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });
      expect(record(record(record(harness.rows.get(censusId)?.value ?? {}).payload).compacted))
        .toMatchObject({ retainedAttentionObligationRowIds: [obligation.rowId] });

      vi.setSystemTime(2_001);
      await expect(ingestConversationProviderObservationForInvocation(
        sharedGroupObservation({
          occurrenceId,
          messageRevision: 'retention:attention-replay-conflict',
          messageText: 'Contradictory private body',
          occurredAt: 1_000,
          transport: 'socket',
        }),
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });

      await expect(runConversationIngressRetentionForInvocation({ now: 2_002, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 0, deletedCensuses: 0 });
      expect(harness.rows.get(obligation.rowId)).toBeDefined();
      const retained = record(record(harness.rows.get(censusId)?.value ?? {}).payload);
      expect(retained).toMatchObject({
        conflict: { kind: 'occurrenceEvidenceMismatch' },
        normalizedIngress: null,
        eventCandidate: null,
        matchedBindings: [],
        compacted: { retainedAttentionObligationRowIds: [obligation.rowId] },
      });
      expect(JSON.stringify(retained)).not.toContain('Original private body');
      expect(JSON.stringify(retained)).not.toContain('Contradictory private body');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an uncovered checkpointed-pull census past its horizon because a poll can still replay it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:uncovered-poll', occurredAt: 1_000 }),
        harness.context,
      );
      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId: 'telegram:update:9001',
      });
      expect(record(record(record(harness.rows.get(censusId)?.value).payload)).checkpointCoveredAt).toBeNull();

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(censusId)?.deleted).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers unknown Session admission after restart, then checkpoint-covers and retires it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const occurrenceId = 'telegram:update:blocked-then-retried';
      const blockedIngress = observation({
        messageRevision: 'retention:blocked-then-retried',
        occurrenceId,
        occurredAt: 1_000,
      });
      const harness = createIngressHarness({
        sessionSendResults: [
          ...Array.from({ length: 5 }, () => ({
            status: 'outcomeUnknown' as const,
            localId: 'pending-1',
            code: 'transport_unknown',
          })),
          { status: 'accepted' as const, localId: 'pending-2' },
        ],
        getPollResult: (): JsonValue => (currentCheckpoint(harness.rows) === undefined
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [blockedIngress.entry],
            checkpointAfterBatch: { cursor: 'past-blocked-occurrence' },
          }),
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      // Re-presenting an unknown outcome keeps the cursor pending past the former cutoff.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const poll = await runConversationCheckpointedPollForInvocation({
          connectionId: 'connection-1',
          waitMs: 0,
        }, harness.context);
        expect(poll.kind).toBe('retry');
        const uncovered = [...harness.rows.values()].find(
          (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-census',
        );
        expect(record(record(uncovered?.value).payload).checkpointCoveredAt).toBeNull();
        const pending = [...harness.rows.values()].find(
          (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
        );
        if (pending === undefined) throw new Error('Expected a retained ingress obligation row.');
        const dueAt = record(record(record(pending.value).payload).lifecycle).dueAt;
        if (typeof dueAt === 'number') vi.setSystemTime(dueAt);
      }
      expect(harness.send).toHaveBeenCalledTimes(5);

      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId,
      });
      const blocked = [...harness.rows.values()].find(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
      );
      if (blocked === undefined) throw new Error('Expected the blocked ingress obligation.');
      expect(blocked.value).toMatchObject({
        terminal: false,
        attention: false,
        payload: { lifecycle: { phase: 'retryDue' } },
      });
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
        payload: { opaqueToken: { cursor: 'baseline' } },
      });
      expect(record(record(harness.rows.get(censusId)?.value).payload).checkpointCoveredAt)
        .toBeNull();

      // A fresh invocation context represents the next plugin generation after
      // restart. The retained census and due obligation supply the same recovery owner.
      const restartedContext: PluginInvocationContext = {
        ...harness.context,
        signal: new AbortController().signal,
      };
      const retryAt = Date.now();
      vi.setSystemTime(retryAt);
      await expect(runConversationIngressDueWorkForInvocation({ now: retryAt }, restartedContext))
        .resolves.toBe(1);
      expect(harness.rows.get(blocked.rowId)?.value).toMatchObject({
        terminal: true,
        attention: false,
        payload: { lifecycle: { phase: 'terminal' }, disposition: 'admitted' },
      });

      await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, restartedContext))
        .resolves.toMatchObject({ kind: 'committed' });
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({ payload: { opaqueToken: { cursor: 'past-blocked-occurrence' } } });
      expect(record(record(harness.rows.get(censusId)?.value).payload).checkpointCoveredAt).toEqual(expect.any(Number));
      expect(harness.send).toHaveBeenCalledTimes(6);
      await settleAcceptedInputReplyProjection(harness);
      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, restartedContext))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, restartedContext))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(censusId)).toBeUndefined();
      expect(harness.rows.get(blocked.rowId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkpoint-advances a retention-pruned replay after an observation-age expansion without a second Session admission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const occurrenceId = 'telegram:update:retained-age-expansion';
      const original = observation({
        messageRevision: 'retained-age-expansion:original',
        occurrenceId,
        occurredAt: 1_000,
      });
      const pollResults: JsonValue[] = [
        { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } },
        {
          kind: 'batch',
          observations: [original.entry],
          checkpointAfterBatch: { cursor: 'first-delivery' },
        },
        {
          kind: 'batch',
          observations: [original.entry],
          checkpointAfterBatch: { cursor: 'replay-after-expansion' },
        },
      ];
      const harness = createIngressHarness({
        getPollResult: () => {
          const result = pollResults.shift();
          if (result === undefined) throw new Error('Expected a checkpointed replay result.');
          return result;
        },
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
      expect(harness.send).toHaveBeenCalledTimes(1);

      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId,
      });
      await settleAcceptedInputReplyProjection(harness);
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(censusId)).toBeUndefined();

      vi.setSystemTime(70_000);
      const connection = harness.rows.get('connection-1');
      if (connection === undefined) throw new Error('Expected the current Channel connection.');
      await expect(updateConversationConnectionForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(connection.value).payload), 'configurationRevision'),
        enabled: true,
        maximumObservationAgeMs: 120_000,
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      vi.setSystemTime(90_000);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      expect(harness.send).toHaveBeenCalledTimes(1);
      expect(harness.rows.get(censusId)).toBeUndefined();
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
        payload: { opaqueToken: { cursor: 'replay-after-expansion' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkpoint-advances a retention-pruned replay after an observation-age expansion without a second Automation admission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const occurrenceId = 'telegram:update:retained-age-expansion-automation';
      const original = observation({
        messageRevision: 'retained-age-expansion:automation',
        occurrenceId,
        occurredAt: 1_000,
      });
      const pollResults: JsonValue[] = [
        { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } },
        {
          kind: 'batch',
          observations: [original.entry],
          checkpointAfterBatch: { cursor: 'first-automation' },
        },
        {
          kind: 'batch',
          observations: [original.entry],
          checkpointAfterBatch: { cursor: 'automation-replay-after-expansion' },
        },
      ];
      const harness = createIngressHarness({
        getPollResult: () => {
          const result = pollResults.shift();
          if (result === undefined) throw new Error('Expected a checkpointed Automation replay result.');
          return result;
        },
        execute: async (actionId) => {
          expect(actionId).toBe('automation.conversation.admit');
          return { kind: 'admitted', runId: 'run-1', checkpointSafe: true };
        },
      });
      setAutomationBindingWithoutFinalResult(harness.rows);

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
      expect(harness.execute).toHaveBeenCalledTimes(1);

      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId,
      });
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(censusId)).toBeUndefined();

      vi.setSystemTime(70_000);
      const connection = harness.rows.get('connection-1');
      if (connection === undefined) throw new Error('Expected the current Channel connection.');
      await expect(updateConversationConnectionForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(connection.value).payload), 'configurationRevision'),
        enabled: true,
        maximumObservationAgeMs: 120_000,
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      vi.setSystemTime(90_000);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      expect(harness.execute).toHaveBeenCalledTimes(1);
      expect(harness.rows.get(censusId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkpoint-advances a retention-pruned /pair replay after an observation-age expansion without a second pairing proposal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const occurrenceId = 'telegram:update:retained-age-expansion-pair';
      const pair = observation({
        messageRevision: 'retained-age-expansion:pair',
        occurrenceId,
        occurredAt: 1_000,
        messageText: '/pair 00000001',
      });
      const pollResults: JsonValue[] = [
        { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } },
        {
          kind: 'batch',
          observations: [pair.entry],
          checkpointAfterBatch: { cursor: 'first-pairing' },
        },
        {
          kind: 'batch',
          observations: [pair.entry],
          checkpointAfterBatch: { cursor: 'pairing-replay-after-expansion' },
        },
      ];
      const harness = createIngressHarness({
        getPollResult: () => {
          const result = pollResults.shift();
          if (result === undefined) throw new Error('Expected a checkpointed pairing replay result.');
          return result;
        },
      });
      const firstManager = createConversationPairingManager({
        generationId: 'pairing-generation-1',
        now: () => 1_000,
        randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
        createId: (kind) => `${kind}-1`,
      });
      firstManager.createChallenge({
        connectionId: 'connection-1',
        expectedConnectionRevision: 1,
pairingRequestId: 'pairing-request-1',
        executionOrigin: getPluginMachineExecutionRouting(telegramExecutionOrigin),
        destinationLabel: 'Telegram bot',
        endpoint: pairingDestinationEndpoint,
        target: channelBinding().payload.target,
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context, firstManager)).resolves.toMatchObject({ kind: 'committed' });
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context, firstManager)).resolves.toMatchObject({ kind: 'committed' });
      expect(firstManager.readManagementProjection().proposals).toHaveLength(1);

      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId,
      });
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(censusId)).toBeUndefined();

      vi.setSystemTime(70_000);
      const connection = harness.rows.get('connection-1');
      if (connection === undefined) throw new Error('Expected the current Channel connection.');
      await expect(updateConversationConnectionForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(connection.value).payload), 'configurationRevision'),
        enabled: true,
        maximumObservationAgeMs: 120_000,
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      firstManager.dispose();
      const updatedConnection = harness.rows.get('connection-1');
      if (updatedConnection === undefined) throw new Error('Expected the expanded Channel connection.');
      const restartedManager = createConversationPairingManager({
        generationId: 'pairing-generation-2',
        now: () => 70_000,
        randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
        createId: (kind) => `${kind}-2`,
      });
      const restartedChallenge = restartedManager.createChallenge({
        connectionId: 'connection-1',
        expectedConnectionRevision: payloadNumber(record(record(updatedConnection.value).payload), 'configurationRevision'),
pairingRequestId: 'pairing-request-1',
        executionOrigin: getPluginMachineExecutionRouting(telegramExecutionOrigin),
        destinationLabel: 'Telegram bot',
        endpoint: pairingDestinationEndpoint,
        target: channelBinding().payload.target,
      });

      vi.setSystemTime(90_000);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context, restartedManager)).resolves.toMatchObject({ kind: 'committed' });

      expect(restartedManager.readManagementProjection().proposals).toEqual([]);
      expect(restartedManager.readChallenge({
        generationId: restartedChallenge.generationId,
        challengeId: restartedChallenge.challengeId,
      })).toMatchObject({ kind: 'active' });
      expect(harness.rows.get(censusId)).toBeUndefined();
      restartedManager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never prunes a checkpoint-covered census whose member still owns a retryable admission recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({
        sessionSendResults: Array.from({ length: 5 }, () => ({
          status: 'outcomeUnknown' as const,
          localId: 'pending-1',
          code: 'transport_unknown',
        })),
      });
      const ingress = observation({ messageRevision: 'retention:attention', occurredAt: 1_000 });
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = ingestConversationProviderObservationForInvocation(ingress, harness.context);
        await expect(result).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });
        const pending = [...harness.rows.values()].find(
          (row) => row.value['record-kind'] === 'ingress-obligation',
        );
        if (pending === undefined) throw new Error('Expected a retained ingress obligation row.');
        const dueAt = record(record(record(pending.value).payload).lifecycle).dueAt;
        if (typeof dueAt === 'number') vi.setSystemTime(dueAt);
      }
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      const obligation = [...harness.rows.values()].find(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
      );
      if (obligation === undefined) throw new Error('Expected the blocked ingress obligation.');
      // Blocked attention is the ingress analogue of unresolved outward ambiguity:
      // the owner still has a retry to run, so its census body must survive.
      expect(obligation.value).toMatchObject({
        terminal: false,
        attention: false,
        payload: { lifecycle: { phase: 'retryDue', attemptCount: 5, dueAt: expect.any(Number) } },
      });

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });

      expect(harness.rows.get(census.rowId)?.deleted).not.toBe(true);
      expect(harness.rows.get(obligation.rowId)?.deleted).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compacts settled contradictory evidence before its horizon while retaining its terminal members', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({ connection: socketChannelConnection() });
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:conflict', occurredAt: 1_000, transport: 'socket' }),
        harness.context,
      );
      const obligation = [...harness.rows.values()].find(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
      );
      if (obligation === undefined) throw new Error('Expected the settled ingress obligation.');
      // Every member settled cleanly; only the census carries the ambiguity.
      expect(obligation.value).toMatchObject({ terminal: true, attention: false });
      const conflicted = markIngressCensusOccurrenceConflict(harness.rows);
      expect(record(record(conflicted.value).payload).checkpointCoveredAt).toBeNull();

      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });

      const compacted = harness.rows.get(conflicted.rowId);
      const compactedPayload = record(record(compacted?.value ?? {}).payload);
      expect(compacted?.value).toMatchObject({
        attention: true,
        payload: { conflict: { kind: 'occurrenceEvidenceMismatch' } },
      });
      expect(compactedPayload.normalizedIngress).toBeNull();
      expect(record(compactedPayload.compacted)).toMatchObject({
        shell: expect.any(Object),
        replayDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      });
      expect(compactedPayload.eventCandidate).toBeNull();
      expect(compactedPayload.matchedBindings).toEqual([]);
      expect(harness.rows.get(obligation.rowId)).toBeDefined();

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });

      expect(harness.rows.get(conflicted.rowId)?.deleted).not.toBe(true);
      expect(harness.rows.get(obligation.rowId)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not orphan a terminal attention member when its conflict census becomes the retained explanation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({ connection: socketChannelConnection() });
      setSharedMentionGatedBinding(harness.rows);
      await ingestConversationProviderObservationForInvocation(
        sharedGroupObservation({
          messageRevision: 'retention:conflict-attention',
          occurredAt: 1_000,
          transport: 'socket',
        }),
        harness.context,
      );
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (obligation === undefined) throw new Error('Expected the terminal attention obligation.');
      expect(obligation.value).toMatchObject({
        terminal: true,
        attention: true,
        payload: { nonAdmission: { reason: 'notAddressed' } },
      });
      const conflicted = markIngressCensusOccurrenceConflict(harness.rows);

      await expect(runConversationIngressRetentionForInvocation({ now: 2_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ compactedCensuses: 1, deletedCensuses: 0 });

      expect(harness.rows.get(obligation.rowId)).toBeDefined();
      expect(harness.rows.get(conflicted.rowId)).toMatchObject({
        value: {
          attention: true,
          payload: {
            normalizedIngress: null,
            conflict: { kind: 'occurrenceEvidenceMismatch' },
            matchedBindings: [],
            eventCandidate: null,
            compacted: { retainedAttentionObligationRowIds: [obligation.rowId] },
          },
        },
      });
      expect(JSON.stringify(harness.rows.get(conflicted.rowId)?.value)).not.toContain('Hello from Telegram');

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(conflicted.rowId)?.deleted).not.toBe(true);
      expect(harness.rows.get(obligation.rowId)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes only the invoking Account Collection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const first = createIngressHarness();
      const second = createIngressHarness();
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:account-one', occurredAt: 1_000 }),
        first.context,
      );
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:account-two', occurredAt: 1_000 }),
        second.context,
      );
      const firstCensus = markIngressCensusCheckpointCovered(first.rows, 1_000);
      const secondCensus = markIngressCensusCheckpointCovered(second.rows, 1_000);

      await settleAcceptedInputReplyProjection(first);
      await settleAcceptedInputReplyProjection(second);
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, first.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });

      expect(first.rows.get(firstCensus.rowId)).toBeUndefined();
      expect(second.rows.get(secondCensus.rowId)?.deleted).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps outcome-unknown idempotent Session admission pending past the former attempt budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({
        sessionSendResults: Array.from({ length: 5 }, () => ({
          status: 'outcomeUnknown' as const,
          localId: 'pending-1',
          code: 'transport_unknown',
        })),
      });
      const ingress = observation({ messageRevision: 'edit:1' });

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = ingestConversationProviderObservationForInvocation(ingress, harness.context);
        await expect(result).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });
        const obligation = [...harness.rows.values()].find(
          (row) => row.value['record-kind'] === 'ingress-obligation',
        );
        if (obligation === undefined) throw new Error('Expected a retained ingress obligation row.');
        const lifecycle = record(record(obligation.value).payload).lifecycle;
        if (attempt < 5) {
          const dueAt = record(lifecycle).dueAt;
          if (typeof dueAt !== 'number') throw new Error('Expected a durable ingress retry due time.');
          expect(dueAt).toBeGreaterThan(Date.now());
          vi.setSystemTime(dueAt);
        }
      }

      expect(harness.send).toHaveBeenCalledTimes(5);
      const obligation = [...harness.rows.values()].find(
        (row) => row.value['record-kind'] === 'ingress-obligation',
      );
      expect(obligation?.value).toMatchObject({
        attention: false,
        payload: { lifecycle: { phase: 'retryDue', attemptCount: 5, dueAt: expect.any(Number) } },
      });
      expect(obligation?.value).toHaveProperty('due-at');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a stale connection revision', (rows: Map<string, StoredStateRow>) => reviseStateRow(rows, 'connection-1')],
    ['a missing matched binding', (rows: Map<string, StoredStateRow>) => removeStateRow(rows, 'binding-1')],
    ['a tombstoned matched binding', (rows: Map<string, StoredStateRow>) => tombstoneStateRow(rows, 'binding-1')],
    ['a finalizing binding delete', (rows: Map<string, StoredStateRow>) => {
      const existing = rows.get('binding-1');
      if (existing === undefined) throw new Error('Expected the bound Channel state row.');
      const binding = record(existing.value);
      const payload = record(binding.payload);
      const authorityEpoch = payload.authorityEpoch;
      if (typeof authorityEpoch !== 'number') throw new Error('Expected binding authority.');
      rows.set('binding-1', stateRow({
        ...binding,
        payload: {
          ...payload,
          authorityEpoch: authorityEpoch + 1,
          enabled: false,
          deletionState: 'finalizingDelete',
        },
      }, existing.revision + 1));
    }],
  ])('terminalizes stale authority without Session admission when %s wins the first-dispatch authority fence', async (_description, invalidate) => {
    let attemptingBatch: readonly CollectionMutation[] | undefined;
    const harness = createIngressHarness({
      beforeBatch: ({ rows, operations }) => {
        if (!operations.some((operation) => isIngressObligationPhase(operation, 'attempting'))) return;
        attemptingBatch = operations;
        invalidate(rows);
      },
    });
    const input = observation({
      messageRevision: 'edit:1',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .resolves.toBeUndefined();

    expect(attemptingBatch).toBeDefined();
    expectExactIngressAuthorityAssertions(attemptingBatch!);
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value).toMatchObject({
      terminal: true,
      attention: true,
      payload: {
        lifecycle: { phase: 'terminal' },
        disposition: 'staleAuthority',
        nonAdmission: { reason: 'staleAuthority', senderFeedbackEligible: false },
      },
    });
  });

  it('leaves a concurrently claimed attempting obligation unsettled instead of relabeling it stale', async () => {
    let staleTerminalization: readonly CollectionMutation[] | undefined;
    const harness = createIngressHarness({
      beforeBatch: ({ rows, operations }) => {
        if (operations.some((operation) => isIngressObligationPhase(operation, 'attempting'))) {
          reviseStateRow(rows, 'binding-1');
          return;
        }
        if (isStaleAuthorityTerminalization(operations)) {
          staleTerminalization = operations;
          markIngressObligationAttempting(rows);
        }
      },
    });
    const input = observation({
      messageRevision: 'edit:1',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

    expect(staleTerminalization).toEqual([
      expect.objectContaining({ kind: 'put', expectedRevision: 1 }),
    ]);
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value).toMatchObject({
      terminal: false,
      attention: false,
      payload: { lifecycle: { phase: 'attempting' }, disposition: null, nonAdmission: null },
    });
  });

  it('settles a frozen Session admission after its first authority-fenced settlement loses and retry rejoins the accepted request', async () => {
    const terminalBatches: Array<readonly CollectionMutation[]> = [];
    const harness = createIngressHarness({
      sessionSendResults: [
        { status: 'accepted', localId: 'pending-1' },
        { status: 'alreadyAccepted', localId: 'pending-1' },
      ],
      beforeBatch: ({ rows, operations }) => {
        if (!operations.some((operation) => isIngressObligationPhase(operation, 'terminal'))) return;
        terminalBatches.push(operations);
        if (terminalBatches.length === 1) tombstoneStateRow(rows, 'binding-1');
      },
    });
    const input = observation({
      messageRevision: 'edit:1',
    });

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_stale_authority', retryable: true });
    await expect(ingestConversationProviderObservationForInvocation(input, harness.context))
      .resolves.toBeUndefined();

    expect(terminalBatches).toHaveLength(2);
    expectExactIngressAuthorityAssertions(terminalBatches[0]!);
    expect(terminalBatches[1]).toEqual([
      expect.objectContaining({ kind: 'put', expectedRevision: 3 }),
    ]);
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.send.mock.calls[1]?.[0]).toEqual(harness.send.mock.calls[0]?.[0]);
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value).toMatchObject({
      terminal: true,
      attention: false,
      payload: { lifecycle: { phase: 'terminal' }, disposition: 'admitted' },
    });
  });

  it('retains a forwarded human actor while omitting a provider display label beyond the generic Session bound', async () => {
    const harness = createIngressHarness();
    const input = observation({
      messageRevision: 'edit:1',
      actorLabel: 'x'.repeat(129),
      contentProvenance: 'forwarded',
    });

    await ingestConversationProviderObservationForInvocation(input, harness.context);

    const request = sentUserTextRequest(harness.send.mock.calls[0]?.[0]);
    expect(request).toMatchObject({
      source: {
        externalActor: { kind: 'human' },
        contentProvenance: 'forwarded',
      },
    });
    expect(request.source?.externalActor).not.toHaveProperty('displayNameSnapshot');
  });
});

describe('Conversation checkpointed-poll ingress', () => {
  it('keeps unchanged empty-poll checkpoints stable without publishing another Collection mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    // IMAP's real empty listSince result retains these exact provider progress
    // fields; the host boundary supplies that provider outcome, not poll logic.
    const harness = createIngressHarness({ pollResult: {
      kind: 'checkpointOnly', checkpointAfterBatch: { uidValidity: '12345', lastUid: 12 },
    } });
    try {
      await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context))
        .resolves.toMatchObject({ kind: 'committed' });
      const baseline = structuredClone(currentCheckpoint(harness.rows));
      expect(baseline).toBeDefined();
      for (let index = 0; index < 3; index += 1) {
        vi.setSystemTime(Date.now() + 1_000);
        await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context))
          .resolves.toMatchObject({ kind: 'committed' });
      }
      expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(4);
      expect(currentCheckpoint(harness.rows)).toEqual(baseline);
      expect(harness.send).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(['token', 'deadline', 'authority', 'lastOccurrence'] as const)('persists a real %s change even when the other checkpoint fields are unchanged', async change => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    let poll = 0;
    const event = observation({ messageRevision: 'semantic-checkpoint-change', occurrenceId: 'telegram:update:checkpoint-change' });
    const harness = createIngressHarness({ getPollResult: () => {
      poll += 1;
      return {
        kind: poll > 1 && change === 'lastOccurrence' ? 'batch' : 'checkpointOnly',
        checkpointAfterBatch: { cursor: poll > 1 && change === 'token' ? 'advanced' : 'baseline' },
        ...(poll > 1 && change === 'deadline' ? { retryHint: { retryAfterMs: 2_500 } } : {}),
        ...(poll > 1 && change === 'lastOccurrence' ? { observations: [event.entry] } : {}),
      };
    } });
    try {
      await runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context);
      const baseline = currentCheckpoint(harness.rows);
      if (baseline === undefined) throw new Error('Expected baseline checkpoint.');
      vi.setSystemTime(Date.now() + 1_000);
      if (change === 'authority') advanceConnectionAuthorityEpoch(harness.rows);
      await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context))
        .resolves.toMatchObject({ kind: 'committed' });
      const updated = currentCheckpoint(harness.rows);
      expect(updated?.revision).toBe(baseline.revision + 1);
      expect(updated?.value.payload).toMatchObject({
        opaqueToken: { cursor: change === 'token' ? 'advanced' : 'baseline' },
        authorityEpoch: change === 'authority' ? 5 : 4,
        lastOccurrenceId: change === 'lastOccurrence' ? 'telegram:update:checkpoint-change' : null,
        nextPollNotBeforeMs: change === 'deadline' ? Date.now() + 2_500 : null,
      });
      if (change === 'lastOccurrence') {
        expect(harness.send).toHaveBeenCalledTimes(1);
        const census = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-census');
        expect(census?.value.payload).toMatchObject({ checkpointCoveredAt: Date.now() });
      }
    } finally { vi.useRealTimers(); }
  });

  it('does not wake parked ingress retention from unchanged empty poll checkpoints while keeping fresh poll authority reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const generation = new AbortController();
    const changes = new Set<() => void>();
    const event = observation({ messageRevision: 'parked-retention', occurrenceId: 'telegram:update:parked-retention' });
    let poll = 0;
    let mutationPublications = 0;
    let checkpointId: string | undefined;
    let retainedMemberId: string | undefined;
    let retainedMemberReads = 0;
    let freshConnectionReads = 0;
    const harness = createIngressHarness({
      getPollResult: (): JsonValue => {
        poll += 1;
        return poll === 2
          ? { kind: 'batch', observations: [event.entry], checkpointAfterBatch: { cursor: 'retained' } }
          : { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: poll === 1 ? 'baseline' : 'retained' } };
      },
      beforeCollectionGet: ({ rowId }) => {
        if (rowId === retainedMemberId) retainedMemberReads += 1;
        if (rowId === 'connection-1') freshConnectionReads += 1;
      },
      afterBatch: ({ operations }) => {
        if (operations.some(operation => operation.kind !== 'assert')) {
          // The real Data mutation publisher emits only for changed rows.
          mutationPublications += 1;
          queueMicrotask(() => { for (const notify of changes) notify(); });
        }
      },
    });
    let onPollParked: () => void = () => {};
    const pollParked = new Promise<void>(resolve => { onPollParked = resolve; });
    const supervisor = createIngressSupervisor({ clock: {
      now: () => Date.now(),
      sleep: (delayMs, signal) => {
        const sleeping = new Promise<void>((resolve, reject) => {
          if (signal.aborted) { reject(signal.reason); return; }
          const onAbort = () => { globalThis.clearTimeout(timer); reject(signal.reason); };
          const timer = globalThis.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delayMs);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        if (delayMs === 1_000) onPollParked();
        return sleeping;
      },
    } });
    let running: Promise<void> | undefined;
    try {
      for (let index = 0; index < 3; index += 1) {
        await runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context);
      }
      await runConversationIngressRetentionForInvocation({ now: Date.now() }, harness.context);
      checkpointId = currentCheckpoint(harness.rows)?.rowId;
      retainedMemberId = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation')?.rowId;
      if (checkpointId === undefined || retainedMemberId === undefined) throw new Error('Expected retained ingress fixture.');
      const account = harness.context.services.storage.account;
      if (!account) throw new Error('Missing Account storage boundary.');
      const collection = account.collection(CHANNEL_STATE_COLLECTION);
      const watchedCollection = { ...collection, watch(_request: unknown, notify: () => void) {
        changes.add(notify); return { dispose: () => { changes.delete(notify); } };
      } };
      const context: BackgroundServiceContext = { ...harness.context, surface: 'background', session: undefined, signal: generation.signal,
        // Only persistent Account storage and Event transport are boundaries.
        services: { ...harness.context.services, storage: { account: { collection: () => watchedCollection } },
          events: { plugin: { emit: async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }) } },
        } as unknown as PluginServices,
      };
      running = supervisor.run(context);
      await pollParked;
      await vi.advanceTimersByTimeAsync(0);
      expect(poll).toBeGreaterThan(3);
      expect(retainedMemberReads).toBeGreaterThan(0);
      const parkedMemberReads = retainedMemberReads;
      const parkedPublications = mutationPublications;
      const authorityReads = freshConnectionReads;
      const parkedPolls = poll;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(poll).toBeGreaterThan(parkedPolls), { interval: 0 });
      expect(retainedMemberReads).toBe(parkedMemberReads);
      expect(mutationPublications).toBe(parkedPublications);
      expect(freshConnectionReads).toBeGreaterThan(authorityReads);
    } finally { generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers(); }
  });

  it.each(['connection', 'checkpoint'] as const)('fences checkpoint progress against a concurrent %s change at the final atomic batch', async authority => {
    let race = false;
    let raced = false;
    const harness = createIngressHarness({ getPollResult: () => ({
      kind: 'checkpointOnly', checkpointAfterBatch: { cursor: race ? 'advanced' : 'baseline' },
    }), beforeBatch: ({ rows }) => {
      if (!race || raced) return;
      raced = true;
      const rowId = authority === 'connection' ? 'connection-1' : currentCheckpoint(rows)?.rowId;
      if (rowId === undefined) throw new Error('Expected final checkpoint authority row.');
      reviseStateRow(rows, rowId);
    } });
    await runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context);
    race = true;
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context))
      .rejects.toMatchObject({ code: 'channels_checkpointed_poll_conflict' });
    expect(raced).toBe(true);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it.each(['machine', 'home', 'unavailable'] as const)('keeps a foreign %s poll inert before provider or checkpoint effects', async (foreign) => {
    const harness = createIngressHarness();
    const routing = { ...getPluginMachineExecutionRouting(telegramExecutionOrigin), pluginId: 'happier.channels' };
    const before = structuredClone([...harness.rows]);
    const context: PluginInvocationContext = { ...harness.context, services: { ...harness.context.services,
      actions: { ...harness.context.services.actions, getCurrentExecutionRouting: async () => foreign === 'unavailable' ? null
        : { ...routing, ...(foreign === 'machine' ? { machineId: 'foreign-machine' } : { serverIdentityId: 'srv_foreign' }) } },
    } };
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, context))
      .resolves.toEqual({ kind: 'ineligible' });
    expect([...harness.rows]).toEqual(before);
    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context))
      .resolves.toMatchObject({ kind: 'committed' });
    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
  });
  it('follows updated source custody for a replacement baseline, normal poll and frozen Event retry without an authority change', async () => {
    const sourceOrigin: PluginMachineExecutionOriginV1 = {
      serverIdentityId: telegramExecutionOrigin.serverIdentityId,
      sourceRef: { pluginId: telegramProviderPluginId, machineId: 'machine-1', sourceCustody: {
        kind: 'development', registeredRootId: 'telegram-replacement-root',
      } },
    };
    let runtimeOrigin = sourceOrigin;
    let poll = 0;
    const event = withTelegramAutomationEventCandidate(observation({ messageRevision: 'updated-provider:event' }));
    const harness = createIngressHarness({
      getPollExecutionOrigin: () => runtimeOrigin,
      pollExecution: (): JsonValue => ++poll === 1
        ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'updated-baseline' } }
        : { kind: 'batch', observations: [event.entry], checkpointAfterBatch: { cursor: 'updated-event' } },
      automationEventAdmitResults: [{ kind: 'unsettled' }, { kind: 'checkpointSafe' }],
    });
    const gap = setConnectionHistoryGap(harness.rows);
    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gap.value).payload), 'configurationRevision'),
    }, harness.context))
      .resolves.toMatchObject({ kind: 'updated', authorityEpoch: telegramConnectionAuthority.authorityEpoch });
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1' }, harness.context))
      .resolves.toMatchObject({ kind: 'retry' });
    const eventObligation = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation'
      && record(record(row.value.payload).target).kind === 'event');
    expect(record(record(eventObligation?.value.payload).target).executionOrigin).toEqual(telegramConnectionAuthority.transportOrigin);
    runtimeOrigin = { ...sourceOrigin, sourceRef: { pluginId: telegramProviderPluginId, machineId: 'machine-1',
      sourceCustody: { kind: 'development', registeredRootId: 'telegram-next-root' } } };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(payloadNumber(record(record(eventObligation?.value.payload).lifecycle), 'dueAt'));
    try {
      await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1' }, harness.context))
        .resolves.toMatchObject({ kind: 'committed' });
    } finally { clock.mockRestore(); }
    expect(record(harness.rows.get('connection-1')?.value.payload).authorityEpoch).toBe(telegramConnectionAuthority.authorityEpoch);
    expect(record(currentCheckpoint(harness.rows)?.value.payload).opaqueToken).toEqual({ cursor: 'updated-event' });
  });

  it('preserves a replacement-baseline history gap returned by the current provider source', async () => {
    const harness = createIngressHarness({
      pollExecutionOrigin: {
        serverIdentityId: telegramConnectionAuthority.transportOrigin.serverIdentityId,
        sourceRef: {
          pluginId: telegramProviderPluginId,
          machineId: 'machine-1',
          sourceCustody: { kind: 'development', registeredRootId: 'telegram-root' },
        },
      },
      pollResult: { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);
    const before = [...harness.rows.values()];

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).rejects.toMatchObject({
      code: 'channels_stream_baseline_provider_history_gap',
      retryable: true,
    });
    expect([...harness.rows.values()]).toEqual(before);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('atomically marks only fully terminal ingress census coverage with its successful checkpoint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let pollCalls = 0;
      const requestedLimits: number[] = [];
      const checkpointBatches: Array<readonly CollectionMutation[]> = [];
      const occurrenceId = 'telegram:update:checkpoint-coverage';
      const harness = createIngressHarness({
        pollExecution: async (input): Promise<JsonValue> => {
          const limit = record(input).limit;
          if (typeof limit !== 'number') throw new Error('Expected a numeric provider poll limit.');
          requestedLimits.push(limit);
          pollCalls += 1;
          return pollCalls === 1
            ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
            : {
              kind: 'batch',
              observations: [observation({
                messageRevision: 'checkpoint-coverage',
                occurrenceId,
                occurredAt: 1_000,
              }).entry],
              checkpointAfterBatch: { cursor: 'covered' },
            };
        },
        beforeBatch: ({ rows, operations }) => {
          const commitsOccurrence = operations.some((operation) => {
            const checkpoint = isCheckpointPut(operation) ? operation.value
              : operation.kind === 'assert' ? rows.get(operation.rowId)?.value : undefined;
            if (checkpoint?.['record-kind'] !== 'checkpoint') return false;
            const payload = record(checkpoint.payload);
            return payload.lastOccurrenceId === occurrenceId;
          });
          if (commitsOccurrence) checkpointBatches.push(operations);
        },
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      const coveredCensus = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-census'
      ));
      if (coveredCensus === undefined) throw new Error('Expected a checkpoint-covered census.');
      const coveredCheckpoint = currentCheckpoint(harness.rows);
      if (coveredCheckpoint === undefined) throw new Error('Expected the committed checkpoint.');

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      expect(requestedLimits).toEqual([98, 98, 98]);

      const census = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-census'
      ));
      expect(record(census?.value.payload).checkpointCoveredAt).toBe(1_000);
      expect(checkpointBatches[0]).toHaveLength(3);
      expect(checkpointBatches[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'assert', rowId: 'connection-1' }),
        expect.objectContaining({ kind: 'put', value: expect.objectContaining({
          'record-kind': 'checkpoint',
        }) }),
        expect.objectContaining({ kind: 'put', value: expect.objectContaining({
          'record-kind': 'ingress-census',
          payload: expect.objectContaining({ checkpointCoveredAt: 1_000 }),
        }) }),
      ]));
      expect(checkpointBatches).toHaveLength(1);
      expect(currentCheckpoint(harness.rows)).toEqual(coveredCheckpoint);
      expect(harness.rows.get(coveredCensus.rowId)).toEqual(coveredCensus);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['merged', 'closed'] as const)('settles a retained Session PR once on open → %s through the canonical Actions', async (state) => {
    const endpoint = { kind: 'githubPullRequest', audience: 'shared', id: 'pr-1', parentId: '77',
      pullRequest: { repository: 'acme/widgets', number: 1 }, pullRequestState: { state: 'open', observedAt: 10 } };
    let observedState = 'open';
    const privateSession = { state: 'unread', standing: true };
    const harness = createIngressHarness({
      pollExecution: (input) => {
        expect(record(input).bindings).toMatchObject([{ endpoint: { id: endpoint.id, pullRequest: endpoint.pullRequest } }]);
        return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'pr-state' },
          pullRequestEndpoints: [{ ...endpoint, pullRequestState: { state: observedState, observedAt: observedState === 'open' ? 20 : 30 } }] };
      },
      // The public host Action API is external to this plugin. Its boundary
      // records private outcomes and returns the actual read/standing shapes.
      execute: async (id, input): Promise<JsonValue> => {
        const request = record(input);
        expect(request.sessionId).toBe('session-1');
        if (id === 'session.read_state.set') {
          expect(request.state).toBe('read');
          privateSession.state = 'read';
          return { state: 'read', lastViewedSessionSeq: 1, didChange: true };
        }
        if (id === 'session.attention.set') {
          expect(request.standing).toBe(false);
          privateSession.standing = false;
          return { standing: { sessionId: 'session-1', standing: false, updatedAt: 30 } };
        }
        throw new Error('Unexpected PR settlement Action');
      },
    });
    const original = harness.rows.get('binding-1')!;
    const payload = record(original.value.payload);
    harness.rows.set('binding-1', stateRow({ ...original.value, payload: { ...payload, enabled: false, endpoint,
      target: { ...record(payload.target), pullRequestLink: endpoint.pullRequest } } }));
    const readPublishedLinks = () => resolveSessionPullRequestLinksV1([
      readConversationBindingUpdateRow({ row: jsonStateRow(harness.rows.get('binding-1')), bindingId: 'binding-1' }).binding,
    ], GITHUB_CHANNEL_PULL_REQUESTS).map(projection => SessionPullRequestLinksV1Schema.parse(projection));
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    expect(harness.execute).not.toHaveBeenCalled();
    expect(privateSession).toEqual({ state: 'unread', standing: true });
    expect(readPublishedLinks()).toEqual([{ sessionId: 'session-1', pullRequestLinks: [{ provider: 'github',
      repository: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/pull/1', state: 'open', observedAt: 20 }] }]);
    observedState = state;
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    expect(harness.execute.mock.calls).toEqual([
      ['session.read_state.set', { sessionId: 'session-1', state: 'read' }, { signal: harness.context.signal }],
      ['session.attention.set', { sessionId: 'session-1', standing: false }, { signal: harness.context.signal }],
    ]);
    expect(record(record(harness.rows.get('binding-1')!.value.payload).endpoint).pullRequestState).toEqual({ state, observedAt: 30 });
    expect(privateSession).toEqual({ state: 'read', standing: false });
    expect(readPublishedLinks()).toEqual([{ sessionId: 'session-1', pullRequestLinks: [{ provider: 'github',
      repository: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/pull/1', state, observedAt: 30 }] }]);
    // The next poll sees the persisted endpoint; it must not re-settle the Session.
    harness.execute.mockClear();
    harness.executeAdmittedTargetedOperationWithExecutionOrigin.mockImplementationOnce(async () => ({
      result: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'replay' },
        pullRequestEndpoints: [{ ...endpoint, pullRequestState: { state, observedAt: 40 } }] },
      executionOrigin: telegramExecutionOrigin,
    }));
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    expect(harness.execute).not.toHaveBeenCalled();
    expect(readPublishedLinks()[0].pullRequestLinks[0]).toMatchObject({ state, observedAt: 40 });
  });

  it('retains unknown PRs and ignores foreign or stale PR observations', async () => {
    const endpoint = { kind: 'githubPullRequest', audience: 'shared', id: 'pr-1', parentId: '77',
      pullRequest: { repository: 'acme/widgets', number: 1 }, pullRequestState: { state: 'open', observedAt: 10 } };
    const harness = createIngressHarness({ pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'pr-state' },
      pullRequestEndpoints: [
        { ...endpoint, pullRequestState: { state: 'merged', observedAt: 5 } },
        { ...endpoint, pullRequest: { repository: 'foreign/widgets', number: 1 }, pullRequestState: { state: 'merged', observedAt: 20 } },
        { ...endpoint, pullRequestState: { state: 'unknown', observedAt: 20 } },
      ] } });
    const original = harness.rows.get('binding-1')!;
    const payload = record(original.value.payload);
    harness.rows.set('binding-1', stateRow({ ...original.value, payload: { ...payload, enabled: false, endpoint,
      target: { ...record(payload.target), pullRequestLink: endpoint.pullRequest } } }));
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    expect(harness.execute).not.toHaveBeenCalled();
    expect(record(record(harness.rows.get('binding-1')!.value.payload).endpoint).pullRequestState).toEqual({ state: 'unknown', observedAt: 20 });
    const binding = readConversationBindingUpdateRow({ row: jsonStateRow(harness.rows.get('binding-1')), bindingId: 'binding-1' }).binding;
    expect(resolveSessionPullRequestLinksV1([binding], GITHUB_CHANNEL_PULL_REQUESTS).map(projection => SessionPullRequestLinksV1Schema.parse(projection)))
      .toEqual([{ sessionId: 'session-1', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 1,
        url: 'https://github.com/acme/widgets/pull/1', state: 'unknown', observedAt: 20 }] }]);
  });

  it('keeps a Session standing while another retained PR is open, then settles after the last PR closes', async () => {
    const pr = (number: number, state: string, observedAt: number) => ({ kind: 'githubPullRequest', audience: 'shared',
      id: `pr-${number}`, parentId: '77', pullRequest: { repository: 'acme/widgets', number }, pullRequestState: { state, observedAt } });
    let lastState = 'open';
    const harness = createIngressHarness({ getPollResult: () => ({ kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'pr-state' },
      pullRequestEndpoints: [pr(1, 'merged', 20), pr(2, lastState, lastState === 'open' ? 20 : 30)] }),
      execute: async () => ({ updated: true }) });
    const original = harness.rows.get('binding-1')!;
    const payload = record(original.value.payload);
    for (const number of [1, 2]) {
      const id = `binding-${number}`;
      harness.rows.set(id, stateRow({ ...original.value, id, 'binding-id': id,
        payload: { ...payload, enabled: false, endpoint: pr(number, 'open', 10),
          target: { ...record(payload.target), pullRequestLink: { repository: 'acme/widgets', number } } } }));
    }
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    expect(harness.execute).not.toHaveBeenCalled();
    lastState = 'closed';
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    expect(harness.execute.mock.calls).toEqual([
      ['session.read_state.set', { sessionId: 'session-1', state: 'read' }, { signal: harness.context.signal }],
      ['session.attention.set', { sessionId: 'session-1', standing: false }, { signal: harness.context.signal }],
    ]);
  });

  it('does not consume a terminal PR observation when the attention Action fails', async () => {
    const endpoint = { kind: 'githubPullRequest', audience: 'shared', id: 'pr-1', parentId: '77',
      pullRequest: { repository: 'acme/widgets', number: 1 } };
    let fail = true;
    const harness = createIngressHarness({ pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'pr-state' },
      pullRequestEndpoints: [{ ...endpoint, pullRequestState: { state: 'merged', observedAt: 20 } }] },
      execute: async (id) => {
        if (id === 'session.attention.set' && fail) throw new Error('Account attention transport unavailable');
        return { updated: true };
      } });
    const original = harness.rows.get('binding-1')!;
    const payload = record(original.value.payload);
    harness.rows.set('binding-1', stateRow({ ...original.value, payload: { ...payload, enabled: false, endpoint,
      target: { ...record(payload.target), pullRequestLink: endpoint.pullRequest } } }));
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context)).rejects.toThrow('Account attention transport unavailable');
    expect(record(record(harness.rows.get('binding-1')!.value.payload).endpoint)).not.toHaveProperty('pullRequestState');
    fail = false;
    await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    expect(record(record(harness.rows.get('binding-1')!.value.payload).endpoint).pullRequestState).toEqual({ state: 'merged', observedAt: 20 });
  });

  it('makes a retained ingress evidence conflict ineligible before its next provider call or checkpoint mutation', async () => {
    let providerCalls = 0;
    const harness = createIngressHarness({
      pollExecution: () => {
        providerCalls += 1;
        return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: `provider-${providerCalls}` } };
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

    await ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'retained-conflict:1',
      occurrenceId: 'telegram:update:retained-conflict',
    }), harness.context);
    const conflicted = markIngressCensusOccurrenceConflict(harness.rows);
    const checkpointBefore = currentCheckpoint(harness.rows);
    if (checkpointBefore === undefined) throw new Error('Expected a retained checkpoint.');

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(providerCalls).toBe(1);
    expect(currentCheckpoint(harness.rows)).toEqual(checkpointBefore);
    expect(harness.rows.get(conflicted.rowId)).toEqual(conflicted);
  });

  it.each(['matching', 'changed', 'absent'] as const)('revalidates a latched occurrence through the exact poll retry Action: %s evidence', async (evidence) => {
    const original = observation({ messageRevision: 'revalidate:1', occurrenceId: 'telegram:update:revalidate', messageText: 'private original body' });
    const changed = observation({ messageRevision: 'revalidate:1', occurrenceId: 'telegram:update:revalidate',
      occurredAt: fullTextIngress(original).occurredAt, messageText: 'private changed body' });
    let pollCalls = 0;
    const harness = createIngressHarness({ pollExecution: (): JsonValue => {
      pollCalls += 1;
      return pollCalls === 1 || evidence === 'absent'
        ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
        : { kind: 'batch', observations: [(evidence === 'matching' ? original : changed).entry],
          checkpointAfterBatch: { cursor: 'recovered' } };
    } });
    await runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 }, harness.context);
    await ingestConversationProviderObservationForInvocation(original, harness.context);
    await expect(ingestConversationProviderObservationForInvocation(changed, harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
    const census = [...harness.rows.values()].find(row => row.value['record-kind'] === 'ingress-census');
    if (census === undefined) throw new Error('Expected retained conflicting census.');
    const checkpointBefore = currentCheckpoint(harness.rows);
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: CHANNELS_PLUGIN,
      services: harness.context.services });
    try {
      const retry = kit.invokeAction('connection/poll-retry-v1', { connectionId: 'connection-1', expectedRevision: 1,
        authorityEpoch: channelConnection().payload.authorityEpoch }, { surface: 'agent' });
      if (evidence === 'matching') {
        await expect(retry).resolves.toMatchObject({ kind: 'retryScheduled' });
        expect(harness.rows.get(census.rowId)?.value).toMatchObject({ attention: false, payload: { conflict: null } });
        expect(currentCheckpoint(harness.rows)?.value).toMatchObject({ payload: { opaqueToken: { cursor: 'recovered' } } });
        expect(harness.send).toHaveBeenCalledOnce();
        expect(harness.rows.get('binding-1')).toBeDefined();
      } else {
        await expect(retry).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
        expect(harness.rows.get(census.rowId)).toEqual(census);
        expect(currentCheckpoint(harness.rows)).toEqual(checkpointBefore);
        expect(harness.send).toHaveBeenCalledOnce();
      }
      expect(pollCalls).toBe(2);
    } finally { await kit.dispose(); }
  });

  it('logs only canonical evidence field paths for an occurrence mismatch', async () => {
    const original = observation({ messageRevision: 'diagnostic:1', messageText: 'private original body' });
    const harness = createIngressHarness();
    await ingestConversationProviderObservationForInvocation(original, harness.context);
    await expect(ingestConversationProviderObservationForInvocation(observation({ messageRevision: 'diagnostic:1',
      occurredAt: fullTextIngress(original).occurredAt, messageText: 'private changed body' }), harness.context))
      .rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });
    expect(harness.context.services.logger.warn).toHaveBeenCalledWith('[Channels] ingress occurrence evidence differs', {
      code: 'channels_ingress_occurrence_conflict',
      connectionId: 'connection-1', censusId: expect.any(String),
      differingFields: ['normalizedIngress.observation.message.text'],
    });
    expect(JSON.stringify(vi.mocked(harness.context.services.logger.warn).mock.calls)).not.toContain('private');
  });

  it('lets a conflict fence win before a pending checkpoint commit without moving checkpoint bytes', async () => {
    const occurredAt = Date.now();
    const original = observation({
      messageRevision: 'conflict-first:1',
      occurrenceId: 'telegram:update:conflict-first',
      occurredAt,
    });
    let pollCalls = 0;
    let releaseCheckpointCommit!: () => void;
    const checkpointCommitRelease = new Promise<void>((resolve) => { releaseCheckpointCommit = resolve; });
    let signalCheckpointCommit!: () => void;
    const checkpointCommitReached = new Promise<void>((resolve) => { signalCheckpointCommit = resolve; });
    let heldCheckpointCommit = false;
    const harness = createIngressHarness({
      pollExecution: (): JsonValue => {
        pollCalls += 1;
        return pollCalls === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [original.entry],
            checkpointAfterBatch: { cursor: 'must-not-commit' },
          };
      },
      beforeBatch: async ({ operations }) => {
        if (
          heldCheckpointCommit
          || !operations.some(isCheckpointPut)
          || !operations.some(isIngressCensusPut)
        ) return;
        heldCheckpointCommit = true;
        signalCheckpointCommit();
        await checkpointCommitRelease;
      },
    });

    await ingestConversationProviderObservationForInvocation(original, harness.context);
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    const checkpointBefore = currentCheckpoint(harness.rows);
    if (checkpointBefore === undefined) throw new Error('Expected the durable baseline checkpoint.');

    const pendingCheckpoint = runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context);
    await checkpointCommitReached;

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'conflict-first:changed',
      occurrenceId: 'telegram:update:conflict-first',
      occurredAt,
    }), harness.context)).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });

    releaseCheckpointCommit();
    await expect(pendingCheckpoint).rejects.toMatchObject({ code: 'channels_checkpointed_poll_conflict' });

    expect(pollCalls).toBe(2);
    expect(currentCheckpoint(harness.rows)).toEqual(checkpointBefore);
    expect([...harness.rows.values()].find((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-census'
    ))?.value).toMatchObject({
      attention: true,
      payload: {
        conflict: { kind: 'occurrenceEvidenceMismatch' },
        checkpointCoveredAt: null,
      },
    });
  });

  it('retries the conflict fence after a checkpoint-first coverage commit without rewriting the checkpoint', async () => {
    const occurredAt = Date.now();
    const original = observation({
      messageRevision: 'checkpoint-first:1',
      occurrenceId: 'telegram:update:checkpoint-first',
      occurredAt,
    });
    let pollCalls = 0;
    let releaseConflictFence!: () => void;
    const conflictFenceRelease = new Promise<void>((resolve) => { releaseConflictFence = resolve; });
    let signalConflictFence!: () => void;
    const conflictFenceReached = new Promise<void>((resolve) => { signalConflictFence = resolve; });
    let heldConflictFence = false;
    const harness = createIngressHarness({
      pollExecution: (): JsonValue => {
        pollCalls += 1;
        return pollCalls === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [original.entry],
            checkpointAfterBatch: { cursor: 'checkpoint-first' },
          };
      },
      beforeBatch: async ({ operations }) => {
        if (
          heldConflictFence
          || !operations.some((operation) => (
            operation.kind === 'put'
            && operation.value['record-kind'] === 'ingress-census'
            && operation.value.attention === true
          ))
        ) return;
        heldConflictFence = true;
        signalConflictFence();
        await conflictFenceRelease;
      },
    });

    await ingestConversationProviderObservationForInvocation(original, harness.context);
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

    const pendingConflict = ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'checkpoint-first:changed',
      occurrenceId: 'telegram:update:checkpoint-first',
      occurredAt,
    }), harness.context);
    await conflictFenceReached;

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    const checkpointAfterCoverage = currentCheckpoint(harness.rows);
    if (checkpointAfterCoverage === undefined) throw new Error('Expected the checkpoint-first commit.');

    releaseConflictFence();
    await expect(pendingConflict).rejects.toMatchObject({ code: 'channels_ingress_occurrence_conflict' });

    expect(pollCalls).toBe(2);
    expect(currentCheckpoint(harness.rows)).toEqual(checkpointAfterCoverage);
    expect(record(record(checkpointAfterCoverage.value).payload).opaqueToken).toEqual({ cursor: 'checkpoint-first' });
    expect([...harness.rows.values()].find((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-census'
    ))?.value).toMatchObject({
      attention: true,
      payload: {
        conflict: { kind: 'occurrenceEvidenceMismatch' },
        checkpointCoveredAt: expect.any(Number),
      },
    });
  });

  it('fails closed without routing or checkpointing a provider batch above the 98-entry coverage bound', async () => {
    let pollCalls = 0;
    const requestedLimits: number[] = [];
    const overflow = Array.from({ length: 99 }, (_, index) => observation({
      messageRevision: `overflow:${index}`,
      occurrenceId: `telegram:update:overflow:${index}`,
      occurredAt: 1_000,
    }).entry);
    const harness = createIngressHarness({
      pollExecution: async (input): Promise<JsonValue> => {
        const limit = record(input).limit;
        if (typeof limit !== 'number') throw new Error('Expected a numeric provider poll limit.');
        requestedLimits.push(limit);
        pollCalls += 1;
        return pollCalls === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : { kind: 'batch', observations: overflow, checkpointAfterBatch: { cursor: 'overflow' } };
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    const baseline = currentCheckpoint(harness.rows);
    if (baseline === undefined) throw new Error('Expected the durable baseline checkpoint.');

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'blocked' });

    expect(requestedLimits).toEqual([98, 98]);
    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)).toEqual(baseline);
    expect([...harness.rows.values()].some((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-census'
    ))).toBe(false);
  });

  it.each(['credentialInvalid', 'invalidConfiguration'] as const)(
    'durably blocks a permanent provider poll failure (%s) and does not invoke that provider again', async (reason) => {
    const harness = createIngressHarness({
      pollResult: { kind: 'notReady', reason },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'blocked' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toEqual({
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: { kind: 'provider', reason },
    });
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });
    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
  });

  it('self-heals a Telegram 409 restart overlap through shared retry backoff', async () => {
    let releaseOldPoll!: (response: Readonly<{
      status: number;
      finalUrl: string;
      headers: Readonly<Record<string, string>>;
      body: Uint8Array;
    }>) => void;
    let markOldPollStarted!: () => void;
    const oldPollResponse = new Promise<Readonly<{
      status: number;
      finalUrl: string;
      headers: Readonly<Record<string, string>>;
      body: Uint8Array;
    }>>((resolve) => { releaseOldPoll = resolve; });
    const oldPollStarted = new Promise<void>((resolve) => { markOldPollStarted = resolve; });
    let getUpdatesCalls = 0;
    let providerPollCalls = 0;
    const response = (value: unknown, status = 200) => ({
      status,
      finalUrl: 'https://api.telegram.org/',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(value)),
    });
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => {
        if (request.url.endsWith('/getMe')) {
          return response({
            ok: true,
            result: {
              id: 12345,
              is_bot: true,
              first_name: 'Happier',
              username: 'happier_bot',
              can_read_all_group_messages: false,
            },
          });
        }
        if (!request.url.endsWith('/getUpdates')) throw new Error(`Unexpected Telegram request ${request.url}`);
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          markOldPollStarted();
          return await oldPollResponse;
        }
        if (getUpdatesCalls === 2) {
          return response({
            ok: false,
            error_code: 409,
            description: 'Conflict: terminated by other getUpdates request',
          }, 409);
        }
        return response({ ok: true, result: [] });
      }),
    };
    let rows!: Map<string, StoredStateRow>;
    const harness = createIngressHarness({
      pollExecution: async (input, signal) => {
        providerPollCalls += 1;
        return await pollTelegramObservations(input, {
          plugin: { id: telegramProviderPluginId, version: '0.0.0' },
          contribution: {
            id: 'telegram/poll-updates',
            qualifiedId: 'happier.channel.telegram/actions/telegram/poll-updates',
          },
          surface: 'plugin',
          invokedAtMs: 1_700_000_000_000,
          caller: {
            kind: 'plugin',
            pluginId: 'happier.channels',
            contribution: {
              id: 'ingress-supervisor',
              qualifiedId: 'happier.channels/background/ingress-supervisor',
            },
            occurrenceId: 'channels-ingress-supervisor-fixture-occurrence',
            sourceCustody: { kind: 'development', registeredRootId: 'channels-ingress-supervisor-root' },
            materialization: telegramExecutionOrigin.materializationRef,
          },
          signal,
          services: {
            connectedAccounts: {
              materialize: async () => ({
                kind: 'environment' as const,
                env: { TELEGRAM_BOT_TOKEN: '12345:bot-token' },
              }),
            },
            http,
            // Crosses only the credential-materialization and HTTP boundaries.
          } as unknown as PluginInvocationContext['services'],
        });
      },
      getPollExecutionOrigin: () => {
        const current = rows.get('connection-1');
        if (current === undefined) throw new Error('Expected the replacement Channel connection.');
        const placement = payloadTransportOrigin(record(record(current.value).payload));
        return { ...telegramExecutionOrigin, materializationRef: { ...telegramExecutionOrigin.materializationRef, machineId: placement.machineId } };
      },
    });
    rows = harness.rows;
    const telegramProviderConfig = {
      botUsername: 'happier_bot',
      canReadAllGroupMessages: false,
    } as const;
    replaceConnectionPayload(rows, { providerConfig: telegramProviderConfig });

    const oldPoll = runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context);
    await vi.waitFor(() => expect(providerPollCalls).toBe(1));
    await vi.waitFor(() => expect(getUpdatesCalls).toBe(1));
    await oldPollStarted;
    replaceConnectionDuringCapturedPoll({ rows, replacementOverlapSafety: 'providerExclusive' });
    replaceConnectionPayload(rows, { providerConfig: telegramProviderConfig });
    releaseOldPoll(response({ ok: true, result: [] }));

    await expect(oldPoll).resolves.toEqual({ kind: 'ineligible' });
    expect(record(record(rows.get('connection-1')?.value).payload).pendingOldTransportStop).toBeNull();
    // The replacement poll overlaps the old daemon's exclusive getUpdates
    // slot. The exclusive-consumer conflict follows the shared backoff
    // instead of latching the connection into a blocked manual-retry state.
    const replacementContext: PluginInvocationContext = { ...harness.context, services: { ...harness.context.services,
      actions: { ...harness.context.services.actions, getCurrentExecutionRouting: async () => ({
        serverIdentityId: telegramExecutionOrigin.serverIdentityId, machineId: 'machine-replacement', pluginId: 'happier.channels',
      }) },
    } };
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, replacementContext)).resolves.toEqual({ kind: 'retry' });
    const retried = rows.get('connection-1');
    if (retried === undefined) throw new Error('Expected the retrying replacement Channel connection.');
    const retriedPollFailure = record(record(retried.value).payload).pollFailure;
    expect(retriedPollFailure).toMatchObject({
      phase: 'retryDue',
      attemptCount: 1,
      evidence: {
        kind: 'provider',
        reason: 'providerConflict',
        diagnostic: 'Conflict: terminated by other getUpdates request',
      },
    });
    const retryNotBeforeMs = record(retriedPollFailure).retryNotBeforeMs;
    if (typeof retryNotBeforeMs !== 'number') throw new Error('Expected a bounded retry-due time.');

    // Once the overlapping consumer exits, the next eligible poll recovers
    // without any manual retry: the conflict never becomes blocked custody.
    await new Promise((resolve) => setTimeout(resolve, retryNotBeforeMs - Date.now() + 50));
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed', connectionId: 'connection-1' });
    expect(record(record(rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
    expect(getUpdatesCalls).toBe(3);
    expect(currentCheckpoint(rows)?.value).toMatchObject({
      payload: { opaqueToken: { v: 1, offset: '0' }, lastOccurrenceId: null },
    });
  });

  it('recovers after more than five transient poll failures with bounded growing backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let failuresRemaining = 7;
      const harness = createIngressHarness({
        getPollResult: (): JsonValue => failuresRemaining-- > 0
          ? { kind: 'notReady', reason: 'network' }
          : { kind: 'checkpointOnly', checkpointAfterBatch: { v: 1, offset: '0' } },
      });

      for (let attemptCount = 1; attemptCount <= 7; attemptCount += 1) {
        const retryDelayMs = Math.min(MAX_CONVERSATION_RECEIVE_WAIT_MS, 1_000 * 2 ** (attemptCount - 1));
        await expect(runConversationCheckpointedPollForInvocation({
          connectionId: 'connection-1',
          waitMs: 0,
        }, harness.context)).resolves.toEqual({ kind: 'retry' });
        const pollFailure = record(record(harness.rows.get('connection-1')?.value).payload).pollFailure;
        expect(pollFailure).toEqual({
          phase: 'retryDue',
          attemptCount,
          retryNotBeforeMs: Date.now() + retryDelayMs,
          evidence: { kind: 'provider', reason: 'network' },
        });
        await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 },
          harness.context)).resolves.toEqual({ kind: 'ineligible' });
        vi.setSystemTime(Date.now() + retryDelayMs);
      }
      await expect(runConversationCheckpointedPollForInvocation({ connectionId: 'connection-1', waitMs: 0 },
        harness.context)).resolves.toMatchObject({ kind: 'committed', connectionId: 'connection-1' });
      expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
        payload: { opaqueToken: { v: 1, offset: '0' }, lastOccurrenceId: null },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a growing attempt-aware retry delay when a retryable provider result has no hint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const pollResults: JsonValue[] = [
        { kind: 'notReady', reason: 'network' },
        { kind: 'notReady', reason: 'rateLimited' },
        { kind: 'notReady', reason: 'network', retryAfterMs: 0 },
        { kind: 'notReady', reason: 'rateLimited' },
      ];
      const harness = createIngressHarness({
        getPollResult: () => {
          const result = pollResults.shift();
          if (result === undefined) throw new Error('Expected a scripted retryable poll result.');
          return result;
        },
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toEqual({ kind: 'retry' });
      expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toEqual({
        phase: 'retryDue',
        attemptCount: 1,
        retryNotBeforeMs: 2_000,
        evidence: { kind: 'provider', reason: 'network' },
      });

      vi.setSystemTime(2_000);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toEqual({ kind: 'retry' });
      expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toEqual({
        phase: 'retryDue',
        attemptCount: 2,
        retryNotBeforeMs: 4_000,
        evidence: { kind: 'provider', reason: 'rateLimited' },
      });

      vi.setSystemTime(4_000);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toEqual({ kind: 'retry', retryAfterMs: 0 });
      expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toEqual({
        phase: 'retryDue',
        attemptCount: 3,
        retryNotBeforeMs: 4_000,
        evidence: { kind: 'provider', reason: 'network' },
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toEqual({ kind: 'retry' });
      expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toEqual({
        phase: 'retryDue',
        attemptCount: 4,
        retryNotBeforeMs: 12_000,
        evidence: { kind: 'provider', reason: 'rateLimited' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves provider Retry-After beyond five transient conflict failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({
        pollResult: { kind: 'notReady', reason: 'providerConflict', retryAfterMs: 120_000 },
      });

      // A contributed provider wait stays authoritative beyond the local cap.
      // Telegram's getUpdates 409 adapter separately omits untrusted hints.
      for (let attemptCount = 1; attemptCount <= 7; attemptCount += 1) {
        const retryDelayMs = 120_000;
        await expect(runConversationCheckpointedPollForInvocation({
          connectionId: 'connection-1',
          waitMs: 0,
        }, harness.context)).resolves.toEqual({ kind: 'retry', retryAfterMs: retryDelayMs });
        const pollFailure = record(record(harness.rows.get('connection-1')?.value).payload).pollFailure;
        expect(pollFailure).toEqual({
            phase: 'retryDue',
            attemptCount,
            retryNotBeforeMs: Date.now() + retryDelayMs,
            evidence: { kind: 'provider', reason: 'providerConflict' },
          });
        vi.setSystemTime(Date.now() + retryDelayMs);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('honours contributed poll Action retryability without retaining its cause: %s', async (retryable) => {
    const harness = createIngressHarness({
      pollExecutionError: new PluginError({
        code: 'provider_transport_exploded',
        message: 'The provider transport failed with an internal detail that must not be retained.',
        retryable,
        details: { providerDiagnostic: 'do not retain this' },
      }),
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: retryable ? 'retry' : 'blocked' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toMatchObject({
      phase: retryable ? 'retryDue' : 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: retryable ? expect.any(Number) : null,
      evidence: {
        kind: 'action',
        code: 'provider_transport_exploded',
        message: 'The provider transport failed with an internal detail that must not be retained.',
      },
    });
  });

  it('durably blocks an invalid contributed poll result without checkpointing it', async () => {
    const harness = createIngressHarness({
      pollResult: { kind: 'not-a-channel-poll-result' },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'blocked' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toEqual({
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: {
        kind: 'action',
        code: 'channels_checkpointed_poll_result_invalid',
        message: 'The provider poll did not return the strict Channel poll result.',
      },
    });
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
  });

  it('rejects a cross-variant duplicate occurrence ID on the established checkpointed-poll path', async () => {
    const occurrenceId = 'telegram:update:cross-variant-duplicate';
    const fullText = observation({ messageRevision: 'edit:full', occurrenceId });
    const nonAdmission = routableNonAdmission({ messageRevision: 'edit:shell', occurrenceId });
    let pollCount = 0;
    const harness = createIngressHarness({
      getPollResult: (): JsonValue => {
        pollCount += 1;
        return pollCount === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [fullText.entry, nonAdmission.entry],
            checkpointAfterBatch: { cursor: 'duplicate-batch' },
          };
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).resolves.toMatchObject({ kind: 'updated' });
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'blocked' });

    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)?.value.payload).toMatchObject({
      opaqueToken: { cursor: 'baseline' },
    });
    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toMatchObject({
      evidence: { kind: 'action', code: 'channels_checkpointed_poll_result_invalid' },
    });
  });

  it('checkpoint-advances expired equal and contradictory replays before census matching', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const occurrenceId = 'telegram:update:expired-replay';
      const original = observation({
        messageRevision: 'expired-replay:original',
        occurrenceId,
        occurredAt: 1_000,
      });
      const contradictory = observation({
        messageRevision: 'expired-replay:contradictory',
        messageText: 'Conflicting replay that is outside its replay horizon.',
        occurrenceId,
        occurredAt: 1_000,
      });
      const pollResults: JsonValue[] = [
        { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } },
        {
          kind: 'batch',
          observations: [original.entry],
          checkpointAfterBatch: { cursor: 'fresh' },
        },
        {
          kind: 'batch',
          observations: [original.entry],
          checkpointAfterBatch: { cursor: 'expired-equal' },
        },
        {
          kind: 'batch',
          observations: [contradictory.entry],
          checkpointAfterBatch: { cursor: 'expired-contradictory' },
        },
      ];
      const harness = createIngressHarness({
        getPollResult: () => {
          const result = pollResults.shift();
          if (result === undefined) throw new Error('Expected an expired-replay poll result.');
          return result;
        },
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId,
      });
      const censusBeforeExpiry = harness.rows.get(censusId);
      const ingressRowsBeforeExpiry = [...harness.rows.values()].filter((row) => (
        row.deleted !== true
          && (row.value['record-kind'] === 'ingress-census' || row.value['record-kind'] === 'ingress-obligation')
      ));
      if (censusBeforeExpiry === undefined || ingressRowsBeforeExpiry.length === 0) {
        throw new Error('Expected the fresh replay evidence to be retained before its replay horizon closes.');
      }
      const sendsBeforeExpiry = harness.send.mock.calls.length;

      vi.setSystemTime(61_001);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      expect(harness.rows.get(censusId)).toEqual(censusBeforeExpiry);
      expect([...harness.rows.values()].filter((row) => (
        row.deleted !== true
          && (row.value['record-kind'] === 'ingress-census' || row.value['record-kind'] === 'ingress-obligation')
      ))).toEqual(ingressRowsBeforeExpiry);
      expect(harness.send).toHaveBeenCalledTimes(sendsBeforeExpiry);
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
        payload: { opaqueToken: { cursor: 'expired-contradictory' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('covers an expired prepared census when the replay matches instead of bypassing coverage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const occurrence = observation({
        messageRevision: 'expired-prepared-coverage',
        occurrenceId: 'telegram:update:expired-prepared-coverage',
        occurredAt: 1_000,
      });
      let pollCount = 0;
      const harness = createIngressHarness({
        getPollResult: (): JsonValue => {
          pollCount += 1;
          return pollCount === 1
            ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
            : {
              kind: 'batch',
              observations: [occurrence.entry],
              checkpointAfterBatch: { cursor: 'expired-prepared' },
            };
        },
      });

      await expect(ingestConversationProviderObservationForInvocation(
        occurrence,
        harness.context,
      )).resolves.toBeUndefined();
      const censusId = await deriveIngressCensusRowId({
        routingIdentityKey: telegramConnectionAuthority.routingIdentityKey,
        connectionId: 'connection-1',
        occurrenceId: 'telegram:update:expired-prepared-coverage',
      });
      const prepared = harness.rows.get(censusId);
      if (prepared === undefined) throw new Error('Expected the prepared census.');
      expect(record(record(prepared.value.payload)).checkpointCoveredAt).toBeNull();

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      vi.setSystemTime(61_001);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
      expect(record(record(harness.rows.get(censusId)?.value.payload)).checkpointCoveredAt)
        .toEqual(expect.any(Number));
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
        payload: { opaqueToken: { cursor: 'expired-prepared' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not persist a poll failure when the executor rejects its stale origin before provider invocation', async () => {
    const harness = createIngressHarness({
      pollExecutionError: new PluginError({
        code: 'plugin_action_execution_origin_mismatch',
        message: 'Expected target execution origin does not match the current target.',
      }),
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
  });

  it('does not persist a poll failure when the executor reports origin drift after provider invocation', async () => {
    const harness = createIngressHarness({
      pollExecutionError: new PluginError({
        code: 'plugin_action_execution_origin_changed',
        message: 'Target execution origin changed while the contributed Action was running.',
      }),
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
  });

  it('does not persist a poll failure when cancellation arrives during its settlement reread', async () => {
    const controller = new AbortController();
    let pollCompleted = false;
    let postPollConnectionReads = 0;
    const harness = createIngressHarness({
      getPollResult: () => {
        pollCompleted = true;
        return { kind: 'notReady', reason: 'credentialInvalid' };
      },
      beforeCollectionGet: ({ rowId }) => {
        if (!pollCompleted || rowId !== 'connection-1') return;
        postPollConnectionReads += 1;
        if (postPollConnectionReads === 2) controller.abort();
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, { ...harness.context, signal: controller.signal })).rejects.toMatchObject({
      code: 'channels_ingress_cancelled',
      retryable: true,
    });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
  });

  it('does not apply a poll result whose settled origin the retained row no longer names', async () => {
    const current = channelConnection();
    const harness = createIngressHarness({
      pollExecutionOrigin: {
        ...telegramExecutionOrigin,
        materializationRef: {
          ...telegramExecutionOrigin.materializationRef,
          machineId: 'machine-other',
        },
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
  });

  it('clears a due retry failure in the same checkpoint commit that proves new provider progress', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let commitBatch: readonly CollectionMutation[] | undefined;
      const harness = createIngressHarness({
        beforeBatch: ({ operations }) => {
          if (operations.some(isCheckpointPut)) commitBatch = operations;
        },
      });
      replaceConnectionPayload(harness.rows, {
        pollFailure: {
          phase: 'retryDue',
          attemptCount: 1,
          retryNotBeforeMs: 1_000,
          evidence: { kind: 'provider', reason: 'network' },
        },
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      expect(commitBatch).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'put', value: expect.objectContaining({
          id: 'connection-1',
          payload: expect.objectContaining({ pollFailure: null }),
        }) }),
        expect.objectContaining({ kind: 'put', value: expect.objectContaining({
          'record-kind': 'checkpoint',
        }) }),
      ]));
      expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a due retry failure in the same connection write that records a provider history gap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({
        pollResult: { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
      });
      replaceConnectionPayload(harness.rows, {
        pollFailure: {
          phase: 'retryDue',
          attemptCount: 1,
          retryNotBeforeMs: 1_000,
          evidence: { kind: 'provider', reason: 'network' },
        },
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toEqual({ kind: 'historyGap', disposition: 'recorded' });

      expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
      expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).toEqual({
        reportedAt: 1_000,
        reason: 'providerHistoryUnavailable',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a blocked poll failure across unrelated binding-only edits', async () => {
    const harness = createIngressHarness();
    replaceConnectionPayload(harness.rows, {
      pollFailure: {
        phase: 'blocked',
        attemptCount: 1,
        retryNotBeforeMs: null,
        evidence: { kind: 'provider', reason: 'credentialInvalid' },
      },
    });
    reviseStateRow(harness.rows, 'binding-1');

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toEqual({
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: { kind: 'provider', reason: 'credentialInvalid' },
    });
    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('does not create a checkpoint or admit a batch while the first poll has no durable baseline', async () => {
    const input = observation({ messageRevision: 'edit:1' });
    const harness = createIngressHarness({
      pollResult: {
        kind: 'batch',
        observations: [input.entry],
        checkpointAfterBatch: { cursor: 'first-batch' },
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'blocked' });

    expect(harness.send).not.toHaveBeenCalled();
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
    )).toBe(false);
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toEqual({
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: {
        kind: 'action',
        code: 'channels_checkpointed_poll_baseline_required',
        message: 'A provider batch cannot advance a Channel connection before its checkpoint baseline exists.',
      },
    });
  });

  it('settles a disabled pending checkpointed poll at the core without a provider connection-stop action', async () => {
    const harness = createIngressHarness();
    const current = channelConnection();
    harness.rows.set('connection-1', stateRow({
      ...current,
      'updated-at': 2,
      payload: {
        ...current.payload,
        authorityEpoch: 5,
        enabled: false,
        deletionState: 'pendingStopReconciliation',
        pendingOldTransportStop: createCurrentConversationPendingOldTransportStopFixture({
          connectionId: current.id,
          authority: telegramConnectionAuthority,
          predecessorCheckpointedPollInvocation: {
            connectionRevision: 4,
            authorityEpoch: current.payload.authorityEpoch,
            transportOrigin: current.payload.transportOrigin,
          },
          authorityEpoch: 5,
          reason: 'delete',
          predecessorTransportKind: 'socket',
          overlapSafety: current.payload.overlapSafety,
        }),
      },
    }, 5));

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 6,
      value: {
        payload: {
          authorityEpoch: 5,
          enabled: false,
          deletionState: 'finalizingDelete',
          pendingOldTransportStop: null,
        },
      },
    });
  });

  it('settles only the exact captured old poll after a checkpointed-pull transfer replaces current authority', async () => {
    let rows!: Map<string, StoredStateRow>;
    const harness = createIngressHarness({
      getPollResult: () => {
        replaceConnectionDuringCapturedPoll({ rows });
        return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'stale-result' } };
      },
    });
    rows = harness.rows;

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 3,
      value: {
        payload: {
          authorityEpoch: 5,
          pendingOldTransportStop: null,
        },
      },
    });
  });

  it('settles persisted provider-exclusive transfer custody when a later replacement checkpointed poll succeeds', async () => {
    const incumbent = channelConnection();
    const replacementOrigin: PluginMachineExecutionOriginV1 = {
      ...telegramExecutionOrigin,
      materializationRef: { ...telegramExecutionOrigin.materializationRef, machineId: 'machine-replacement' },
    };
    const harness = createIngressHarness({ pollExecutionOrigin: replacementOrigin });
    // This invocation begins only after the transfer CAS is durable: there is
    // no captured old poll whose completion could settle the retained slot.
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'providerExclusive',
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({
      kind: 'committed',
      connectionId: 'connection-1',
      revision: 3,
      authorityEpoch: 5,
    });

    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 3,
      value: {
        payload: {
          authorityEpoch: 5,
          pendingOldTransportStop: null,
        },
      },
    });
    expect(currentCheckpoint(harness.rows)?.value.payload).toMatchObject({
      opaqueToken: { cursor: 'checkpoint' },
    });

    const settledRow = harness.rows.get('connection-1');
    if (settledRow === undefined) throw new Error('Expected the settled replacement connection.');
    if (!isChannelStateJsonRecord(settledRow.value)) {
      throw new Error('Expected the settled replacement connection to retain a JSON record.');
    }
    const settledConnection = readConversationConnectionUpdateRow({
      row: { rowId: settledRow.rowId, revision: settledRow.revision, value: settledRow.value },
      connectionId: 'connection-1',
    });
    const nextTransfer = startConversationConnectionTransfer({
      current: settledConnection.lifecycle,
      pendingOldTransportStop: createCurrentConversationPendingOldTransportStopFixture({
        connectionId: 'connection-1',
        authority: {
          ...telegramConnectionAuthority,
          transportOrigin: getConversationConnectionTransportOrigin(replacementOrigin),
          authorityEpoch: settledConnection.lifecycle.authorityEpoch,
        },
        predecessorCheckpointedPollInvocation: {
          connectionRevision: settledRow.revision,
          authorityEpoch: settledConnection.lifecycle.authorityEpoch,
          transportOrigin: settledConnection.transportOrigin,
        },
        authorityEpoch: settledConnection.lifecycle.authorityEpoch + 1,
        reason: 'transfer',
        predecessorTransportKind: 'socket',
        overlapSafety: settledConnection.lifecycle.overlapSafety,
      }),
      replacement: {
        enabled: true,
        overlapSafety: 'safe',
        historyGap: null,
      },
    });
    expect(nextTransfer).toMatchObject({
      kind: 'transferPendingOldStop',
      connection: {
        authorityEpoch: 6,
      },
    });
  });

  it('settles persisted provider-exclusive transfer custody from a strict replacement batch', async () => {
    const incumbent = channelConnection();
    const replacementOrigin: PluginMachineExecutionOriginV1 = {
      ...telegramExecutionOrigin,
      materializationRef: { ...telegramExecutionOrigin.materializationRef, machineId: 'machine-replacement' },
    };
    let pollExecutionOrigin: PluginMachineExecutionOriginV1 = telegramExecutionOrigin;
    let pollResult: JsonValue = { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } };
    const harness = createIngressHarness({
      getPollResult: () => pollResult,
      getPollExecutionOrigin: () => pollExecutionOrigin,
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({
      kind: 'committed',
      connectionId: 'connection-1',
      revision: 1,
      authorityEpoch: 4,
    });

    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'providerExclusive',
    });
    pollExecutionOrigin = replacementOrigin;
    pollResult = {
      kind: 'batch',
      observations: [],
      checkpointAfterBatch: { cursor: 'replacement-batch' },
    };

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({
      kind: 'committed',
      connectionId: 'connection-1',
      revision: 3,
      authorityEpoch: 5,
    });

    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 3,
      value: { payload: { pendingOldTransportStop: null } },
    });
    expect(currentCheckpoint(harness.rows)?.value.payload).toMatchObject({
      opaqueToken: { cursor: 'replacement-batch' },
    });
  });

  it('retains provider-exclusive transfer custody when the replacement poll reports a provider conflict', async () => {
    const incumbent = channelConnection();
    const replacementOrigin: PluginMachineExecutionOriginV1 = {
      ...telegramExecutionOrigin,
      materializationRef: { ...telegramExecutionOrigin.materializationRef, machineId: 'machine-replacement' },
    };
    const harness = createIngressHarness({
      pollExecutionOrigin: replacementOrigin,
      pollResult: { kind: 'notReady', reason: 'providerConflict' },
    });
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'providerExclusive',
    });

    // The exclusive-consumer conflict is the provider's restart-overlap arm:
    // it enters shared retry backoff at attempt one and only the
    // provider hint (when Telegram actually supplies one) can override the
    // shared backoff delay.
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'retry' });

    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 3,
      value: {
        payload: {
          pendingOldTransportStop: {
            overlapSafety: 'providerExclusive',
            acceptedPossibleLoss: false,
            stopRequest: { reason: 'transfer', authorityEpoch: 5 },
          },
          pollFailure: {
            phase: 'retryDue',
            attemptCount: 1,
            retryNotBeforeMs: expect.any(Number),
            evidence: { kind: 'provider', reason: 'providerConflict' },
          },
        },
      },
    });
  });

  it('does not infer provider-exclusive transfer settlement from a replacement history-gap result', async () => {
    const incumbent = channelConnection();
    const replacementOrigin: PluginMachineExecutionOriginV1 = {
      ...telegramExecutionOrigin,
      materializationRef: { ...telegramExecutionOrigin.materializationRef, machineId: 'machine-replacement' },
    };
    const harness = createIngressHarness({
      pollExecutionOrigin: replacementOrigin,
      pollResult: { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
    });
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'providerExclusive',
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'historyGap', disposition: 'recorded' });

    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 3,
      value: {
        payload: {
          pendingOldTransportStop: {
            overlapSafety: 'providerExclusive',
            acceptedPossibleLoss: false,
          },
          historyGap: { reason: 'providerHistoryUnavailable' },
        },
      },
    });
  });

  it('does not settle a safe old transport from a successful replacement checkpointed poll', async () => {
    const incumbent = channelConnection();
    const replacementOrigin: PluginMachineExecutionOriginV1 = {
      ...telegramExecutionOrigin,
      materializationRef: { ...telegramExecutionOrigin.materializationRef, machineId: 'machine-replacement' },
    };
    const harness = createIngressHarness({ pollExecutionOrigin: replacementOrigin });
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'safe',
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({
      kind: 'committed',
      connectionId: 'connection-1',
      revision: 2,
      authorityEpoch: 5,
    });

    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 2,
      value: {
        payload: {
          pendingOldTransportStop: {
            overlapSafety: 'safe',
            acceptedPossibleLoss: false,
          },
        },
      },
    });
  });

  it('does not write provider-exclusive transfer settlement when the replacement current row changes before it can CAS', async () => {
    const incumbent = channelConnection();
    const replacementOrigin: PluginMachineExecutionOriginV1 = {
      ...telegramExecutionOrigin,
      materializationRef: { ...telegramExecutionOrigin.materializationRef, machineId: 'machine-replacement' },
    };
    let batchCalls = 0;
    const harness = createIngressHarness({
      pollExecutionOrigin: replacementOrigin,
      beforeBatch: ({ rows }) => {
        batchCalls += 1;
        // Settlement has already re-read exact current authority. Drift at
        // its one CAS must reject the write rather than clear custody.
        if (batchCalls === 1) {
          replaceConnectionPayload(rows, { maximumObservationAgeMs: 120_000 });
        }
      },
    });
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'providerExclusive',
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(batchCalls).toBe(1);
    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 3,
      value: {
        payload: {
          maximumObservationAgeMs: 120_000,
          pendingOldTransportStop: {
            overlapSafety: 'providerExclusive',
            acceptedPossibleLoss: false,
          },
          pollFailure: null,
        },
      },
    });
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
  });

  it('settles a genuine old poll after a provider-exclusive replacement poll conflict advances the retained row', async () => {
    let rows!: Map<string, StoredStateRow>;
    const replacementPollFailure = {
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: { kind: 'provider', reason: 'providerConflict' },
    } as const;
    const harness = createIngressHarness({
      getPollResult: () => {
        replaceConnectionDuringCapturedPoll({
          rows,
          replacementOverlapSafety: 'providerExclusive',
        });
        replaceConnectionPayload(rows, { pollFailure: replacementPollFailure });
        return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'stale-result' } };
      },
    });
    rows = harness.rows;

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 4,
      value: {
        payload: {
          authorityEpoch: 5,
          overlapSafety: 'providerExclusive',
          pendingOldTransportStop: null,
          pollFailure: replacementPollFailure,
        },
      },
    });
  });

  it('settles a genuine old poll after a maximum-observation-age policy write advances the retained row', async () => {
    let rows!: Map<string, StoredStateRow>;
    const harness = createIngressHarness({
      getPollResult: () => {
        replaceConnectionDuringCapturedPoll({ rows });
        replaceConnectionPayload(rows, { maximumObservationAgeMs: 120_000 });
        return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'stale-result' } };
      },
    });
    rows = harness.rows;

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 4,
      value: {
        payload: {
          authorityEpoch: 5,
          maximumObservationAgeMs: 120_000,
          pendingOldTransportStop: null,
        },
      },
    });
  });

  it('settles transfer custody only from the exact captured revision, epoch, origin, and frozen request', async () => {
    const original = channelConnection();
    const capturedInvocation = {
      connectionRevision: 1,
      authorityEpoch: original.payload.authorityEpoch,
      transportOrigin: original.payload.transportOrigin,
    } as const;
    const frozenStopRequest = createCurrentConversationPendingOldTransportStopFixture({
      connectionId: original.id,
      authority: telegramConnectionAuthority,
      predecessorCheckpointedPollInvocation: capturedInvocation,
      authorityEpoch: original.payload.authorityEpoch + 1,
      reason: 'transfer',
      predecessorTransportKind: 'socket',
      overlapSafety: original.payload.overlapSafety,
    }).stopRequest;
    const exact = createIngressHarness();
    replaceConnectionDuringCapturedPoll({ rows: exact.rows });

    await expect(confirmConversationCheckpointedPollStopForInvocation({
      connectionId: original.id,
      capturedInvocation,
      frozenStopRequest,
    }, exact.context)).resolves.toBe('transportStopConfirmed');
    expect(exact.rows.get(original.id)).toMatchObject({
      revision: 3,
      value: { payload: { pendingOldTransportStop: null } },
    });

    const mismatches = [
      {
        name: 'revision',
        capturedInvocation: { ...capturedInvocation, connectionRevision: 2 },
        frozenStopRequest,
      },
      {
        name: 'epoch',
        capturedInvocation: { ...capturedInvocation, authorityEpoch: capturedInvocation.authorityEpoch + 1 },
        frozenStopRequest,
      },
      {
        name: 'origin',
        capturedInvocation: {
          ...capturedInvocation,
          transportOrigin: {
            ...capturedInvocation.transportOrigin,
            machineId: 'machine-not-the-incumbent',
          },
        },
        frozenStopRequest,
      },
      {
        name: 'frozen request',
        capturedInvocation,
        frozenStopRequest: { ...frozenStopRequest, providerConfig: { wrong: true } },
      },
    ] as const;
    for (const mismatch of mismatches) {
      const harness = createIngressHarness();
      replaceConnectionDuringCapturedPoll({ rows: harness.rows });
      const before = harness.rows.get(original.id);

      await expect(confirmConversationCheckpointedPollStopForInvocation({
        connectionId: original.id,
        capturedInvocation: mismatch.capturedInvocation,
        frozenStopRequest: mismatch.frozenStopRequest,
      }, harness.context), mismatch.name).resolves.toBe('ineligible');

      expect(harness.rows.get(original.id), mismatch.name).toEqual(before);
    }
  });

  it('does not let a poll from an earlier connection revision settle later transfer custody', async () => {
    let rows!: Map<string, StoredStateRow>;
    const harness = createIngressHarness({
      getPollResult: () => {
        replaceConnectionDuringCapturedPoll({ rows, reviseBeforeTransfer: true });
        return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'stale-result' } };
      },
    });
    rows = harness.rows;

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pendingOldTransportStop)
      .toMatchObject({
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 2,
          authorityEpoch: 4,
          transportOrigin: telegramConnectionAuthority.transportOrigin,
        },
        overlapSafety: 'providerExclusive',
        acceptedPossibleLoss: false,
      });
  });

  it('does not let a fresh supervisor manufacture stop proof for a safe pending transfer', async () => {
    const harness = createIngressHarness();
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'safe',
    });
    replaceConnectionPayload(harness.rows, { enabled: false });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(record(record(harness.rows.get('connection-1')?.value).payload).pendingOldTransportStop)
      .toMatchObject({
        stopRequest: { reason: 'transfer' },
        overlapSafety: 'safe',
        acceptedPossibleLoss: false,
      });
  });

  it('does not activate a destructive replacement before its old checkpointed poll settles', async () => {
    const harness = createIngressHarness();
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'destructive',
    });
    replaceConnectionPayload(harness.rows, { enabled: true });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(record(record(harness.rows.get('connection-1')?.value).payload)).toMatchObject({
      enabled: true,
      pendingOldTransportStop: {
        overlapSafety: 'destructive',
        acceptedPossibleLoss: false,
      },
    });
  });

  it('routes a matching selected-poll /pair command through the census owner before its checkpoint', async () => {
    const pairingObservation = observation({
      messageRevision: 'edit:pair',
      occurrenceId: 'telegram:update:pair-1',
      messageText: '/pair 00000001',
    });
    let pollCount = 0;
    const harness = createIngressHarness({
      getPollResult: (): JsonValue => {
        pollCount += 1;
        return pollCount === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [pairingObservation.entry],
            checkpointAfterBatch: { cursor: 'after-pair' },
          };
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

    const currentConnection = harness.rows.get('connection-1');
    if (currentConnection === undefined) throw new Error('Expected the baseline-updated Channel connection.');
    const manager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const challenge = manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: payloadNumber(record(record(currentConnection.value).payload), 'configurationRevision'),
pairingRequestId: 'pairing-request-1',
      executionOrigin: getPluginMachineExecutionRouting(telegramExecutionOrigin),
      destinationLabel: 'Telegram bot',
      endpoint: pairingDestinationEndpoint,
      target: channelBinding().payload.target,
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context, manager)).resolves.toMatchObject({ kind: 'committed', connectionId: 'connection-1' });

    expect(manager.readChallenge({
      generationId: challenge.generationId,
      challengeId: challenge.challengeId,
    })).toEqual({ kind: 'consumed' });
    expect(harness.send).not.toHaveBeenCalled();
    const census = [...harness.rows.values()].find(
      (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-census',
    );
    expect(census?.value).toMatchObject({
      attention: false,
      payload: {
        phase: 'prepared',
        conflict: null,
        matchedBindings: [],
        checkpointCoveredAt: expect.any(Number),
      },
    });
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
    )).toBe(false);
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: { opaqueToken: { cursor: 'after-pair' } },
    });

    // The external person gets one durable answer, owned by the connection
    // because no binding exists yet, and addressed to the private conversation
    // the proof arrived in.
    const pairingCustody = [...harness.rows.values()].filter(
      (row) => row.deleted !== true && row.value['record-kind'] === 'outward-delivery',
    );
    expect(pairingCustody).toHaveLength(1);
    expect(pairingCustody[0]?.value).toMatchObject({
      'connection-id': 'connection-1',
      terminal: false,
      payload: {
        source: {
          kind: 'controlResponse',
          controlId: census?.value.id,
          controlKind: 'pairing',
        },
        routeAuthority: {
          connectionAuthorityEpoch: record(currentConnection.value.payload).authorityEpoch,
        },
        endpoint: { kind: 'direct', audience: 'direct', id: 'telegram:chat:100' },
        deliveryKey: `ingress-pairing:${String(census?.value.id)}`,
        replyContext: { replyToMessageId: 'telegram:message:5' },
        state: 'ready',
      },
    });
    expect(pairingCustody[0]?.value['binding-id']).toBeUndefined();

    // An equal replay rejoins that exact row instead of promising a second
    // provider effect.
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context, manager)).resolves.toMatchObject({ kind: 'committed' });
    expect([...harness.rows.values()].filter(
      (row) => row.deleted !== true && row.value['record-kind'] === 'outward-delivery',
    )).toHaveLength(1);
  });

  it('withholds the /pair checkpoint until its answer reaches durable outward custody', async () => {
    const pairingObservation = observation({
      messageRevision: 'edit:pair-custody',
      occurrenceId: 'telegram:update:pair-custody',
      messageText: '/pair 00000001',
    });
    let pollCount = 0;
    let refusePairingCustody = true;
    let lastPairCursor = '';
    const harness = createIngressHarness({
      beforeCollectionPut: ({ value }) => {
        if (refusePairingCustody && value['record-kind'] === 'outward-delivery') {
          throw new Error('Simulated outward custody storage failure.');
        }
      },
      getPollResult: (): JsonValue => {
        pollCount += 1;
        if (pollCount === 1) {
          return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } };
        }
        lastPairCursor = `after-pair-${pollCount}`;
        return {
          kind: 'batch',
          observations: [pairingObservation.entry],
          checkpointAfterBatch: { cursor: lastPairCursor },
        };
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    const currentConnection = harness.rows.get('connection-1');
    if (currentConnection === undefined) throw new Error('Expected the baseline-ready Channel connection.');
    const manager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    manager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: payloadNumber(record(record(currentConnection.value).payload), 'configurationRevision'),
pairingRequestId: 'pairing-request-1',
      executionOrigin: getPluginMachineExecutionRouting(telegramExecutionOrigin),
      destinationLabel: 'Telegram bot',
      endpoint: pairingDestinationEndpoint,
      target: channelBinding().payload.target,
    });

    // The unsettled outward custody is the only reason this poll cannot settle.
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context, manager)).resolves.toMatchObject({ kind: 'retry' });

    // The proposal exists, but the person has not been answered, so the
    // checkpoint stays behind the occurrence that owes them that answer.
    expect(manager.readManagementProjection().proposals).toHaveLength(1);
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'outward-delivery',
    )).toBe(false);
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: { opaqueToken: { cursor: 'baseline' } },
    });

    refusePairingCustody = false;
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context, manager)).resolves.toMatchObject({ kind: 'committed' });

    expect([...harness.rows.values()].filter(
      (row) => row.deleted !== true && row.value['record-kind'] === 'outward-delivery',
    )).toHaveLength(1);
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: { opaqueToken: { cursor: lastPairCursor } },
    });
    expect(lastPairCursor).not.toBe('baseline');
    expect(manager.readManagementProjection().proposals).toHaveLength(1);
  });

  it('answers no one when a losing race consumes the pairing challenge before its census commits', async () => {
    const pairingObservation = observation({
      messageRevision: 'edit:pair-race',
      occurrenceId: 'telegram:update:pair-race',
      messageText: '/pair 00000001',
    });
    let pollCount = 0;
    let racedManager: ReturnType<typeof createConversationPairingManager> | undefined;
    let racedChallenge: Readonly<{ generationId: string; challengeId: string }> | undefined;
    const harness = createIngressHarness({
      // The owner cancels between the reservation and its census commit, so the
      // settlement below is `silent` rather than `matched`.
      beforeBatch: ({ operations }) => {
        if (racedChallenge === undefined || !operations.some(isIngressCensusPut)) return;
        racedManager?.cancelChallenge(racedChallenge);
        racedChallenge = undefined;
      },
      getPollResult: (): JsonValue => {
        pollCount += 1;
        return pollCount === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [pairingObservation.entry],
            checkpointAfterBatch: { cursor: 'after-pair-race' },
          };
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    const currentConnection = harness.rows.get('connection-1');
    if (currentConnection === undefined) throw new Error('Expected the baseline-ready Channel connection.');
    racedManager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const created = racedManager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: payloadNumber(record(record(currentConnection.value).payload), 'configurationRevision'),
pairingRequestId: 'pairing-request-1',
      executionOrigin: getPluginMachineExecutionRouting(telegramExecutionOrigin),
      destinationLabel: 'Telegram bot',
      endpoint: pairingDestinationEndpoint,
      target: channelBinding().payload.target,
    });
    racedChallenge = { generationId: created.generationId, challengeId: created.challengeId };

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context, racedManager)).resolves.toMatchObject({ kind: 'committed' });

    // No proposal exists, so nothing may be promised to the external sender:
    // a durable answer here would tell a stranger a challenge had existed and
    // would announce a pairing that will never appear in the owner's list.
    expect(racedManager.readManagementProjection().proposals).toHaveLength(0);
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'outward-delivery',
    )).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
    // The occurrence is still terminal for pairing: it never falls through to
    // ordinary binding routing, and its checkpoint still advances.
    expect([...harness.rows.values()].some(
      (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
    )).toBe(false);
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: { opaqueToken: { cursor: 'after-pair-race' } },
    });
  });

  it('checkpoint-advances a retained selected-poll /pair census silently after pairing manager restart', async () => {
    const pairingObservation = observation({
      messageRevision: 'edit:pair-restart',
      occurrenceId: 'telegram:update:pair-restart',
      messageText: '/pair 00000001',
    });
    let pollCount = 0;
    const harness = createIngressHarness({
      getPollResult: (): JsonValue => {
        pollCount += 1;
        return pollCount === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [pairingObservation.entry],
            checkpointAfterBatch: { cursor: pollCount === 2 ? 'after-pair' : 'after-restart-replay' },
          };
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    const connection = harness.rows.get('connection-1');
    if (connection === undefined) throw new Error('Expected the baseline-ready Channel connection.');

    const firstManager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    firstManager.createChallenge({
      connectionId: 'connection-1',
      expectedConnectionRevision: payloadNumber(record(record(connection.value).payload), 'configurationRevision'),
pairingRequestId: 'pairing-request-1',
      executionOrigin: getPluginMachineExecutionRouting(telegramExecutionOrigin),
      destinationLabel: 'Telegram bot',
      endpoint: pairingDestinationEndpoint,
      target: channelBinding().payload.target,
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context, firstManager)).resolves.toMatchObject({ kind: 'committed' });
    expect(firstManager.readManagementProjection().proposals).toHaveLength(1);

    firstManager.dispose();
    const restartedManager = createConversationPairingManager({
      generationId: 'pairing-generation-2',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 2]),
      createId: (kind) => `${kind}-2`,
    });
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context, restartedManager)).resolves.toMatchObject({ kind: 'committed' });

    expect(harness.send).not.toHaveBeenCalled();
    expect(restartedManager.readManagementProjection().proposals).toEqual([]);
    expect([...harness.rows.values()].find((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-census'
    ))?.value).toMatchObject({
      attention: false,
      payload: {
        phase: 'prepared',
        conflict: null,
        matchedBindings: [],
        checkpointCoveredAt: expect.any(Number),
      },
    });
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: { opaqueToken: { cursor: 'after-restart-replay' } },
    });
  });

  it('checkpoint-advances an expired selected-poll /pair command before pre-binding or ingress effect', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(61_001);
    try {
      const pairingObservation = observation({
        messageRevision: 'edit:expired-pair',
        occurrenceId: 'telegram:update:expired-pair',
        messageText: '/pair 00000001',
        occurredAt: 1_000,
      });
      let pollCount = 0;
      const harness = createIngressHarness({
        getPollResult: (): JsonValue => {
          pollCount += 1;
          return pollCount === 1
            ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
            : {
              kind: 'batch',
              observations: [pairingObservation.entry],
              checkpointAfterBatch: { cursor: 'after-expired-pair' },
            };
        },
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed', connectionId: 'connection-1' });

      const currentConnection = harness.rows.get('connection-1');
      if (currentConnection === undefined) throw new Error('Expected the baseline-updated Channel connection.');
      const manager = createConversationPairingManager({
        generationId: 'pairing-generation-1',
        now: () => 1_000,
        randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
        createId: (kind) => `${kind}-1`,
      });
      const challenge = manager.createChallenge({
        connectionId: 'connection-1',
        expectedConnectionRevision: payloadNumber(record(record(currentConnection.value).payload), 'configurationRevision'),
pairingRequestId: 'pairing-request-1',
        executionOrigin: getPluginMachineExecutionRouting(telegramExecutionOrigin),
        destinationLabel: 'Telegram bot',
        endpoint: pairingDestinationEndpoint,
        target: channelBinding().payload.target,
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context, manager)).resolves.toMatchObject({ kind: 'committed', connectionId: 'connection-1' });

      expect(manager.readChallenge({
        generationId: challenge.generationId,
        challengeId: challenge.challengeId,
      })).toMatchObject({ kind: 'active' });
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
      expect([...harness.rows.values()].some(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-census',
      )).toBe(false);
      expect([...harness.rows.values()].some(
        (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-obligation',
      )).toBe(false);
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
        payload: { opaqueToken: { cursor: 'after-expired-pair' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('processes one checkpointed batch in provider order before its one checkpoint commit', async () => {
    const firstEndpoint = observation({
      messageRevision: 'edit:1',
      occurrenceId: 'telegram:update:9101',
      endpointId: 'telegram:chat:100',
    });
    const secondEndpoint = observation({
      messageRevision: 'edit:2',
      occurrenceId: 'telegram:update:9102',
      endpointId: 'telegram:chat:200',
      messageText: 'second provider observation',
    });
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondStartedBeforeFirstSettled = false;
    let pollCount = 0;
    const harness = createIngressHarness({
      availableSessionIds: ['session-1', 'session-2'],
      sessionSend: async (input) => {
        const text = record(input).text;
        if (text === 'Hello from Telegram') await firstHeld;
        else if (text === 'second provider observation') secondStartedBeforeFirstSettled = true;
        return { status: 'accepted', localId: 'pending-1' };
      },
      getPollResult: (): JsonValue => {
        pollCount += 1;
        return pollCount === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [firstEndpoint.entry, secondEndpoint.entry],
            checkpointAfterBatch: { cursor: 'after-mixed-batch' },
          };
      },
    });
    addBindingForEndpoint({
      rows: harness.rows,
      bindingId: 'binding-2',
      endpointId: 'telegram:chat:200',
      sessionId: 'session-2',
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).resolves.toMatchObject({ kind: 'updated' });
    const poll = runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context);
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondStartedBeforeFirstSettled).toBe(false);
    releaseFirst();
    await expect(poll).resolves.toMatchObject({ kind: 'committed', connectionId: 'connection-1' });

    expect(harness.send).toHaveBeenCalledTimes(2);
    const terminalObligations = [...harness.rows.values()].filter((row) => (
      row.deleted !== true
        && row.value['record-kind'] === 'ingress-obligation'
        && record(record(row.value.payload).lifecycle).phase === 'terminal'
    ));
    expect(terminalObligations).toHaveLength(2);
    expect(terminalObligations.map((row) => record(row.value.payload).target))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'session', sessionId: 'session-1' }),
        expect.objectContaining({ kind: 'session', sessionId: 'session-2' }),
      ]));
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      'connection-id': 'connection-1',
      payload: {
        opaqueToken: { cursor: 'after-mixed-batch' },
        lastOccurrenceId: 'telegram:update:9102',
      },
    });
  });

  it('settles an unsettled observation locally and continues the same poll page without checkpointing it', async () => {
    const firstObservation = observation({
      messageRevision: 'edit:retrying',
      occurrenceId: 'telegram:update:retrying',
      endpointId: 'telegram:chat:100',
    });
    const secondObservation = observation({
      messageRevision: 'edit:later',
      occurrenceId: 'telegram:update:later',
      endpointId: 'telegram:chat:200',
      messageText: 'later provider observation',
    });
    let pollCount = 0;
    const harness = createIngressHarness({
      availableSessionIds: ['session-1', 'session-2'],
      sessionSend: async (input) => {
        const text = record(input).text;
        return text === 'Hello from Telegram'
          ? { status: 'outcomeUnknown', localId: 'pending-1', code: 'session_admission_outcome_unknown' }
          : { status: 'accepted', localId: 'pending-2' };
      },
      getPollResult: (): JsonValue => {
        pollCount += 1;
        return pollCount === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [firstObservation.entry, secondObservation.entry],
            checkpointAfterBatch: { cursor: 'after-unsettled-page' },
          };
      },
    });
    addBindingForEndpoint({
      rows: harness.rows,
      bindingId: 'binding-2',
      endpointId: 'telegram:chat:200',
      sessionId: 'session-2',
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'retry' });

    expect(harness.send).toHaveBeenCalledTimes(2);
    const obligations = [...harness.rows.values()].filter((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
    ));
    expect(obligations.map((row) => record(row.value.payload).lifecycle)).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'retryDue' }),
      expect.objectContaining({ phase: 'terminal' }),
    ]));
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: { opaqueToken: { cursor: 'baseline' } },
    });
    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
  });

  it.each(['socket', 'webhook'] as const)('retains current %s capacity retry custody without losing the provider occurrence', async (transport) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({
        connection: transport === 'socket' ? socketChannelConnection() : durablePushChannelConnection(),
        automationEventAdmitResults: [{ kind: 'unsettled' }, { kind: 'checkpointSafe' }],
      });
      const ingress = withTelegramAutomationEventCandidate(observation({
        messageRevision: 'event:capacity', occurrenceId: 'event:capacity', transport,
      }));
      const admission = ingestConversationProviderObservationForInvocation(ingress, harness.context);
      if (transport === 'socket') await expect(admission).resolves.toBeUndefined();
      else await expect(admission).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled' });
      const retry = [...harness.rows.values()].find((row) =>
        row.value['record-kind'] === 'ingress-obligation' && record(record(row.value.payload).target).kind === 'event');
      expect(retry?.value).toMatchObject({ payload: { lifecycle: { phase: 'retryDue', attemptCount: 1, dueAt: 2_000 } } });
      const replay = ingestConversationProviderObservationForInvocation(ingress, harness.context);
      if (transport === 'socket') await expect(replay).resolves.toBeUndefined();
      else await expect(replay).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled' });
      vi.setSystemTime(2_000);
      await expect(runConversationIngressDueWorkForInvocation({ now: 2_000 }, harness.context)).resolves.toBe(1);
      expect(harness.rows.get(retry!.rowId)?.value).toMatchObject({ terminal: true });
      await expect(ingestConversationProviderObservationForInvocation(observation({
        messageRevision: 'event:after-capacity', occurrenceId: 'event:after-capacity', transport,
      }), harness.context)).resolves.toBeUndefined();
      expect(harness.send).toHaveBeenCalledTimes(2);
      expect(currentCheckpoint(harness.rows)).toBeUndefined();
      expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['retryWriteFailed', 'authorityChanged'] as const)('refuses socket capacity custody when %s', async (fault) => {
    const harness = createIngressHarness({
      connection: socketChannelConnection(),
      automationEventAdmitResult: { kind: 'unsettled' },
      beforeBatch: ({ rows, operations }) => {
        const writesRetry = operations.some((operation) => operation.kind === 'put'
          && operation.value['record-kind'] === 'ingress-obligation'
          && record(record(operation.value.payload).lifecycle).phase === 'retryDue');
        if (!writesRetry) return;
        if (fault === 'retryWriteFailed') throw new Error('Retry custody storage unavailable');
        reviseStateRow(rows, 'connection-1');
      },
    });
    const admission = ingestConversationProviderObservationForInvocation(withTelegramAutomationEventCandidate(observation({
      messageRevision: 'event:capacity:failure', transport: 'socket',
    })), harness.context);
    if (fault === 'retryWriteFailed') await expect(admission).rejects.toThrow('Retry custody storage unavailable');
    else await expect(admission).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
  });

  it('durably retries one provider Event candidate before checkpointing its replay-safe settlement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const eventIngress = withTelegramAutomationEventCandidate(observation({
        messageRevision: 'event:retry',
        occurrenceId: 'telegram:update:event-retry',
        endpointId: 'telegram:chat:event',
      }));
      const candidate = eventIngress.entry.eventCandidate;
      if (candidate === null) throw new Error('Expected a provider Event candidate.');
      let pollCount = 0;
      const harness = createIngressHarness({
        automationEventAdmitResults: [
          { kind: 'unsettled' },
          { kind: 'checkpointSafe' },
        ],
        getPollResult: (): JsonValue => {
          pollCount += 1;
          return pollCount === 1
            ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
            : {
              kind: 'batch',
              observations: [eventIngress.entry],
              checkpointAfterBatch: { cursor: 'after-event' },
            };
        },
      });
      const gapConnection = setConnectionHistoryGap(harness.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toEqual({ kind: 'retry' });

      const eventObligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true
          && row.value['record-kind'] === 'ingress-obligation'
          && record(record(row.value.payload).target).kind === 'event'
      ));
      if (eventObligation === undefined) throw new Error('Expected a durable Event obligation.');
      expect(eventObligation.value).not.toHaveProperty('binding-id');
      expect(record(eventObligation.value.payload)).toMatchObject({
        censusId: expect.any(String),
        sourceAuthority: {
          connectionAuthorityEpoch: telegramConnectionAuthority.authorityEpoch,
          bindingRevision: null,
          bindingAuthorityEpoch: null,
        },
        lifecycle: { phase: 'retryDue', attemptCount: 1 },
        target: {
          kind: 'event',
          candidate,
          providerPluginId: telegramProviderPluginId,
          providerContributionSelection: telegramConnectionAuthority.providerContributionSelection,
          executionOrigin: telegramConnectionAuthority.transportOrigin,
        },
      });
      const census = [...harness.rows.values()].find((row) => (
        row.deleted !== true
          && row.value['record-kind'] === 'ingress-census'
          && record(record(row.value.payload).eventCandidate).sourceInstanceId === 'telegram:chat:100'
      ));
      expect(census?.value.payload).toMatchObject({ eventCandidate: candidate });
      expect(currentCheckpoint(harness.rows)?.value.payload).toMatchObject({
        opaqueToken: { cursor: 'baseline' },
        lastOccurrenceId: null,
      });
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();

      vi.setSystemTime(2_000);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      const eventCalls = harness.executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls
        .filter(([operation]) => operation === telegramAutomationEventAdmitAction);
      expect(eventCalls).toHaveLength(2);
      expect(eventCalls.map(([, input]) => input)).toEqual([
        {
          connectionId: 'connection-1',
          candidate,
          occurrenceId: 'telegram:update:event-retry',
          occurredAt: 1_000,
          observationReceivedAt: 1_000,
          observedDelta: 1,
        },
        {
          connectionId: 'connection-1',
          candidate,
          occurrenceId: 'telegram:update:event-retry',
          occurredAt: 1_000,
          observationReceivedAt: 1_000,
          observedDelta: 0,
        },
      ]);
      expect(currentCheckpoint(harness.rows)?.value.payload).toMatchObject({
        opaqueToken: { cursor: 'after-event' },
        lastOccurrenceId: 'telegram:update:event-retry',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkpoints a healthy poll page past a retained blocked ingress obligation without clearing attention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const blockedObservation = observation({
        messageRevision: 'edit:blocked-before-poll',
        occurrenceId: 'telegram:update:blocked-before-poll',
      });
      const healthyObservation = observation({
        messageRevision: 'edit:healthy-after-blocked',
        occurrenceId: 'telegram:update:healthy-after-blocked',
        endpointId: 'telegram:chat:200',
        messageText: 'healthy provider observation',
      });
      let pollCount = 0;
      const harness = createIngressHarness({
        availableSessionIds: ['session-1', 'session-2'],
        sessionSend: async (input) => (
          record(input).text === 'healthy provider observation'
            ? { status: 'accepted', localId: 'pending-healthy' }
            : {
              status: 'outcomeUnknown',
              localId: 'pending-blocked',
              code: 'session_admission_outcome_unknown',
            }
        ),
        getPollResult: (): JsonValue => {
          pollCount += 1;
          return pollCount === 1
            ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
            : {
              kind: 'batch',
              observations: [blockedObservation.entry, healthyObservation.entry],
              checkpointAfterBatch: { cursor: 'after-blocked-obligation' },
            };
        },
      });
      addBindingForEndpoint({
        rows: harness.rows,
        bindingId: 'binding-2',
        endpointId: 'telegram:chat:200',
        sessionId: 'session-2',
      });

      await expect(ingestConversationProviderObservationForInvocation(
        blockedObservation,
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

      const retryDue = [...harness.rows.values()].find(
        (row) => row.value['record-kind'] === 'ingress-obligation',
      );
      if (retryDue === undefined) throw new Error('Expected the blocked ingress obligation.');
      const retryDueValue = record(retryDue.value);
      const retryDuePayload = record(retryDueValue.payload);
      const { ['due-at']: _dueAt, ...blockedWithoutDueAt } = retryDueValue;
      const blocked = stateRow({
        ...blockedWithoutDueAt,
        terminal: false,
        attention: true,
        payload: {
          ...retryDuePayload,
          lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null },
          disposition: null,
          nonAdmission: null,
        },
      }, retryDue.revision + 1);
      harness.rows.set(blocked.rowId, blocked);

      const gapConnection = setConnectionHistoryGap(harness.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({
        kind: 'committed',
        connectionId: 'connection-1',
      });

      expect(harness.send).toHaveBeenCalledTimes(2);
      expect(harness.rows.get(blocked.rowId)?.value).toMatchObject({
        terminal: false,
        attention: true,
        payload: { lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null } },
      });
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
        payload: {
          opaqueToken: { cursor: 'after-blocked-obligation' },
          lastOccurrenceId: 'telegram:update:healthy-after-blocked',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets blocked recovery continue independently when it becomes attempting during baseline commit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let raceAttemptingClaim = false;
      const harness = createIngressHarness({
        sessionSend: async () => ({
          status: 'outcomeUnknown',
          localId: 'pending-blocked-baseline-race',
          code: 'session_admission_outcome_unknown',
        }),
        pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline-race' } },
        beforeBatch: ({ rows, operations }) => {
          if (!raceAttemptingClaim || !operations.some(isCheckpointPut)) return;
          raceAttemptingClaim = false;
          markIngressObligationAttempting(rows);
        },
      });
      const blockedObservation = observation({
        messageRevision: 'edit:blocked-baseline-race',
        occurrenceId: 'telegram:update:blocked-baseline-race',
      });

      await expect(ingestConversationProviderObservationForInvocation(
        blockedObservation,
        harness.context,
      )).rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });

      const retryDue = [...harness.rows.values()].find(
        (row) => row.value['record-kind'] === 'ingress-obligation',
      );
      if (retryDue === undefined) throw new Error('Expected the blocked ingress obligation.');
      const retryDueValue = record(retryDue.value);
      const retryDuePayload = record(retryDueValue.payload);
      const { ['due-at']: _dueAt, ...blockedWithoutDueAt } = retryDueValue;
      harness.rows.set(retryDue.rowId, stateRow({
        ...blockedWithoutDueAt,
        terminal: false,
        attention: true,
        payload: {
          ...retryDuePayload,
          lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null },
          disposition: null,
          nonAdmission: null,
        },
      }, retryDue.revision + 1));

      const gapConnection = setConnectionHistoryGap(harness.rows);
      raceAttemptingClaim = true;
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      expect(currentCheckpoint(harness.rows)).toMatchObject({
        value: { payload: { opaqueToken: { cursor: 'baseline-race' } } },
      });
      expect(record(record(harness.rows.get('connection-1')?.value ?? {}).payload).historyGap).toBeNull();
      expect(record(record(harness.rows.get(retryDue.rowId)?.value ?? {}).payload).lifecycle)
        .toMatchObject({ phase: 'attempting' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a thrown obligation boundary failure locally and continues the same poll page without checkpointing it', async () => {
    const firstObservation = observation({
      messageRevision: 'edit:throwing',
      occurrenceId: 'telegram:update:throwing',
      endpointId: 'telegram:chat:100',
    });
    const secondObservation = observation({
      messageRevision: 'edit:later-after-throw',
      occurrenceId: 'telegram:update:later-after-throw',
      endpointId: 'telegram:chat:200',
      messageText: 'later provider observation',
    });
    let pollCount = 0;
    const harness = createIngressHarness({
      availableSessionIds: ['session-1', 'session-2'],
      sessionSend: async (input) => {
        const text = record(input).text;
        if (text === 'Hello from Telegram') {
          throw new Error('first Session boundary failed');
        }
        return { status: 'accepted', localId: 'pending-2' };
      },
      getPollResult: (): JsonValue => {
        pollCount += 1;
        return pollCount === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [firstObservation.entry, secondObservation.entry],
            checkpointAfterBatch: { cursor: 'after-thrown-boundary-page' },
          };
      },
    });
    addBindingForEndpoint({
      rows: harness.rows,
      bindingId: 'binding-2',
      endpointId: 'telegram:chat:200',
      sessionId: 'session-2',
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'retry' });

    expect(harness.send).toHaveBeenCalledTimes(2);
    const obligations = [...harness.rows.values()].filter((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
    ));
    expect(obligations.map((row) => record(row.value.payload).lifecycle)).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'retryDue', attemptCount: 1 }),
      expect.objectContaining({ phase: 'terminal', attemptCount: 1 }),
    ]));
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: { opaqueToken: { cursor: 'baseline' } },
    });
    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
  });

  it('does not relabel a stale obligation settlement as a poll failure', async () => {
    let pollCount = 0;
    const harness = createIngressHarness({
      beforeBatch: ({ rows, operations }) => {
        if (operations.some((operation) => isIngressObligationPhase(operation, 'terminal'))) {
          advanceConnectionAuthorityEpoch(rows);
        }
      },
      getPollResult: (): JsonValue => {
        pollCount += 1;
        return pollCount === 1
          ? { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } }
          : {
            kind: 'batch',
            observations: [observation({
              messageRevision: 'edit:stale-terminal-settlement',
              occurrenceId: 'telegram:update:stale-terminal-settlement',
            }).entry],
            checkpointAfterBatch: { cursor: 'after-stale-terminal-settlement' },
          };
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).rejects.toMatchObject({
      code: 'channels_ingress_stale_authority',
      retryable: true,
    });

    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: { opaqueToken: { cursor: 'baseline' } },
    });
    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
  });

  it('checkpoint-advances a later unsupported edit of the same admitted occurrence without a second admission', async () => {
    const occurredAt = Date.now();
    const admitted = observation({
      messageRevision: 'edit:1',
      occurredAt,
      providerTimestamp: occurredAt,
    });
    const laterUnsupportedEdit = routableNonAdmission({
      messageRevision: 'edit:2',
      occurredAt,
      providerTimestamp: occurredAt + 1_000,
      reason: 'unsupportedEdit',
    });
    let pollCount = 0;
    const harness = createIngressHarness({
      getPollResult: (): JsonValue => {
        pollCount += 1;
        if (pollCount === 1) {
          return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } };
        }
        if (pollCount === 2) {
          return {
            kind: 'batch',
            observations: [admitted.entry],
            checkpointAfterBatch: { cursor: 'after-admission' },
          };
        }
        return {
          kind: 'batch',
          observations: [laterUnsupportedEdit.entry],
          checkpointAfterBatch: { cursor: 'after-edit' },
        };
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: { opaqueToken: { cursor: 'after-admission' } },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
      payload: {
        opaqueToken: { cursor: 'after-edit' },
        lastOccurrenceId: 'telegram:update:9001',
      },
    });
    const obligations = [...harness.rows.values()].filter((row) => (
      row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
    ));
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'admitted',
      censusId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('drops a poll result whose connection changed after provider execution without admitting or checkpointing it', async () => {
    let harness!: ReturnType<typeof createIngressHarness>;
    harness = createIngressHarness({
      getPollResult: () => {
        reviseStateRow(harness.rows, 'connection-1');
        return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'stale-after-poll' } };
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toBeNull();
  });

  it('keeps an in-flight scheduled poll from overwriting a concurrently accepted replacement baseline', async () => {
    let releaseScheduledPoll!: (result: JsonValue) => void;
    let markScheduledPollStarted!: () => void;
    const scheduledPollResult = new Promise<JsonValue>((resolve) => { releaseScheduledPoll = resolve; });
    const scheduledPollStarted = new Promise<void>((resolve) => { markScheduledPollStarted = resolve; });
    let providerPolls = 0;
    const harness = createIngressHarness({
      getPollResult: async () => {
        providerPolls += 1;
        if (providerPolls === 1) {
          markScheduledPollStarted();
          return await scheduledPollResult;
        }
        if (providerPolls === 2) {
          return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'replacement-baseline' } };
        }
        throw new Error('Expected only the scheduled poll and replacement baseline poll.');
      },
    });

    const scheduledPoll = runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context);
    await scheduledPollStarted;
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

    releaseScheduledPoll({ kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'stale-scheduled-poll' } });
    await expect(scheduledPoll).resolves.toEqual({ kind: 'ineligible' });

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(currentCheckpoint(harness.rows)?.value.payload).toMatchObject({
      opaqueToken: { cursor: 'replacement-baseline' },
      lastOccurrenceId: null,
    });
  });

  it('records one provider history gap, then refuses further polling until baseline acceptance', async () => {
    const harness = createIngressHarness({
      pollResult: {
        kind: 'historyGap',
        reason: 'providerHistoryUnavailable',
        diagnostic: 'provider cursor expired',
      },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'historyGap', disposition: 'recorded' });

    expect(record(record(harness.rows.get('connection-1')?.value ?? {}).payload).historyGap).toEqual({
      reportedAt: expect.any(Number),
      reason: 'providerHistoryUnavailable',
      diagnostic: 'provider cursor expired',
    });
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });
    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
  });

});

describe('Conversation history baseline acceptance', () => {
  it('does not invoke a destructive replacement baseline before incumbent stop settlement', async () => {
    const harness = createIngressHarness();
    setConnectionHistoryGap(harness.rows);
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'destructive',
    });
    const current = replaceConnectionPayload(harness.rows, { enabled: true });

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(current.value).payload), 'configurationRevision'),
    }, harness.context)).rejects.toMatchObject({
      code: 'channels_stream_baseline_connection_unavailable',
    });

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('settles the exact captured baseline poll when transfer replaces its current authority', async () => {
    let rows!: Map<string, StoredStateRow>;
    const harness = createIngressHarness({
      getPollResult: () => {
        replaceConnectionDuringCapturedPoll({ rows });
        return { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'stale-baseline' } };
      },
    });
    rows = harness.rows;
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).rejects.toMatchObject({ code: 'channels_stream_baseline_conflict' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pendingOldTransportStop).toBeNull();
  });

  it('settles persisted provider-exclusive transfer custody from a successful replacement baseline poll', async () => {
    const incumbent = channelConnection();
    const replacementOrigin: PluginMachineExecutionOriginV1 = {
      ...telegramExecutionOrigin,
      materializationRef: { ...telegramExecutionOrigin.materializationRef, machineId: 'machine-replacement' },
    };
    const harness = createIngressHarness({ pollExecutionOrigin: replacementOrigin });
    setConnectionHistoryGap(harness.rows);
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'providerExclusive',
    });
    const replacement = harness.rows.get('connection-1');
    if (replacement === undefined) throw new Error('Expected the persisted replacement connection.');

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(replacement.value).payload), 'configurationRevision'),
    }, harness.context)).resolves.toEqual({
      kind: 'updated',
      connectionId: 'connection-1',
      revision: 5,
      authorityEpoch: 5,
    });

    expect(harness.rows.get('connection-1')).toMatchObject({
      revision: 5,
      value: {
        payload: {
          historyGap: null,
          pendingOldTransportStop: null,
        },
      },
    });
  });

  it.each([2_000, Number.MAX_SAFE_INTEGER])('accepts a checkpoint-only baseline and preserves representable retry time (%s)', async retryAfterMs => {
    const pollResult = {
      kind: 'checkpointOnly',
      checkpointAfterBatch: { cursor: 'checkpoint-only' },
      retryHint: { retryAfterMs },
    } as const;
    const harness = createIngressHarness({ pollResult });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)?.value.payload).toMatchObject({
      opaqueToken: pollResult.checkpointAfterBatch,
      lastOccurrenceId: null,
      revision: 1,
      nextPollNotBeforeMs: retryAfterMs === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : expect.any(Number),
    });
    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledWith(
      telegramPollAction,
      expect.objectContaining({ checkpoint: null }),
      expect.any(Object),
    );
    await expect(hasConversationCheckpointedPullBaseline({
      context: harness.context,
      connectionId: 'connection-1',
      routingIdentityKey: 'r'.repeat(43),
    })).resolves.toBe(true);
  });

  it('rejects a cross-variant duplicate occurrence ID at the replacement-baseline result owner', async () => {
    const occurrenceId = 'telegram:update:baseline-cross-variant-duplicate';
    const fullText = observation({ messageRevision: 'edit:full', occurrenceId });
    const nonAdmission = routableNonAdmission({ messageRevision: 'edit:shell', occurrenceId });
    const harness = createIngressHarness({
      pollResult: {
        kind: 'batch',
        observations: [fullText.entry, nonAdmission.entry],
        checkpointAfterBatch: { cursor: 'duplicate-baseline' },
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).rejects.toMatchObject({ code: 'channels_stream_baseline_result_invalid' });

    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
    expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).not.toBeNull();
  });

  it('rejects an ordinary batch for a null-checkpoint baseline without admitting historical messages or changing the gap', async () => {
    const harness = createIngressHarness({
      pollResult: {
        kind: 'batch',
        observations: [observation({ messageRevision: 'edit:1' }).entry],
        checkpointAfterBatch: { cursor: 'historical-batch' },
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).rejects.toMatchObject({
      code: 'channels_stream_baseline_requires_checkpoint_only',
      retryable: true,
    });

    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
    expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).not.toBeNull();
  });

  it('never reuses a retained checkpoint as the replacement baseline poll input', async () => {
    const pollResults: JsonValue[] = [
      { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'prior' } },
      { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'replacement' } },
    ];
    const harness = createIngressHarness({
      getPollResult: () => {
        const result = pollResults.shift();
        if (result === undefined) throw new Error('Expected a scripted provider poll result.');
        return result;
      },
    });
    const firstGap = setConnectionHistoryGap(harness.rows);
    await acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(firstGap.value).payload), 'configurationRevision'),
    }, harness.context);
    const secondGap = setConnectionHistoryGap(harness.rows);

    await acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(secondGap.value).payload), 'configurationRevision'),
    }, harness.context);

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls[1]?.[1]).toMatchObject({ checkpoint: null });
    expect(currentCheckpoint(harness.rows)?.value.payload).toMatchObject({
      opaqueToken: { cursor: 'replacement' },
      lastOccurrenceId: null,
      revision: 2,
    });
  });

  it.each([
    ['history gap', { kind: 'historyGap', reason: 'providerHistoryUnavailable' }, 'channels_stream_baseline_provider_history_gap'],
    ['not-ready', { kind: 'notReady', reason: 'network' }, 'channels_stream_baseline_provider_not_ready'],
  ] as const)('leaves the gap and retained checkpoint unchanged for a %s result', async (_description, failedPollResult, code) => {
    const pollResults: JsonValue[] = [
      { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'prior' } },
      failedPollResult,
    ];
    const harness = createIngressHarness({
      getPollResult: () => {
        const result = pollResults.shift();
        if (result === undefined) throw new Error('Expected a scripted provider poll result.');
        return result;
      },
    });
    const firstGap = setConnectionHistoryGap(harness.rows);
    await acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(firstGap.value).payload), 'configurationRevision'),
    }, harness.context);
    const retainedCheckpoint = currentCheckpoint(harness.rows);
    if (retainedCheckpoint === undefined) throw new Error('Expected the retained checkpoint.');
    const secondGap = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(secondGap.value).payload), 'configurationRevision'),
    }, harness.context)).rejects.toMatchObject({ code, retryable: true });

    expect(harness.rows.get(retainedCheckpoint.rowId)).toEqual(retainedCheckpoint);
    expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).not.toBeNull();
  });

  it.each(['sessionBound', 'none'] as const)(
    'clears a %s continuity gap without polling or fabricating a checkpoint',
    async (replayContinuity) => {
      const harness = createIngressHarness();
      setConnectionHistoryGap(harness.rows);
      const currentConnection = setConnectionReplayContinuity(harness.rows, replayContinuity);

      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(currentConnection.value).payload), 'configurationRevision'),
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
      expect(currentCheckpoint(harness.rows)).toBeUndefined();
      expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).toBeNull();
    },
  );

  it('abandons a stranded preparing census when a socket gap acceptance proves no replay can finish it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let armed = true;
      const harness = createIngressHarness({
        connection: socketChannelConnection(),
        beforeBatch: ({ operations }) => {
          const preparesCensus = operations.some((operation) => (
            operation.kind === 'put'
            && record(record(operation.value).payload).phase === 'prepared'
          ));
          if (armed && preparesCensus) {
            armed = false;
            throw new Error('Simulated Account Collection failure on the prepared census write.');
          }
        },
      });

      await expect(ingestConversationProviderObservationForInvocation(
        observation({
          messageRevision: 'abandon:preparing',
          occurredAt: 1_000,
          transport: 'socket',
        }),
        harness.context,
      )).rejects.toThrow();
      const census = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-census'
      ));
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (census === undefined || obligation === undefined) {
        throw new Error('Expected the stranded ingress census and its member.');
      }
      expect(record(census.value.payload).phase).toBe('preparing');
      expect(record(record(obligation.value).payload).lifecycle).toMatchObject({ phase: 'ready' });

      // The stranded member is durably due and no socket producer can ever
      // re-present the occurrence that would finish its census.
      vi.setSystemTime(1_001);
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_001 }, harness.context))
        .resolves.toBe(1);
      expect(record(record(harness.rows.get(obligation.rowId)?.value ?? {}).payload).lifecycle)
        .toMatchObject({ phase: 'ready' });

      setConnectionHistoryGap(harness.rows);
      const current = harness.rows.get('connection-1');
      if (current === undefined) throw new Error('Expected the Channel connection state row.');
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(current.value).payload), 'configurationRevision'),
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      const abandoned = harness.rows.get(obligation.rowId);
      expect(record(record(abandoned?.value ?? {}).payload)).toMatchObject({
        lifecycle: { phase: 'terminal', dueAt: null },
        disposition: 'staleAuthority',
      });
      expect(record(abandoned?.value ?? {})['due-at']).toBeUndefined();
      expect(record(record(harness.rows.get(census.rowId)?.value ?? {}).payload).phase)
        .toBe('prepared');

      // The abandoned unit no longer refills the first due page. Its durable
      // stale-authority attention still gates physical forgetting.
      vi.setSystemTime(1_002);
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_002 }, harness.context))
        .resolves.toBe(0);
      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(census.rowId)).toBeDefined();
      expect(harness.rows.get(obligation.rowId)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles replayable preparing and prepared census members under the gap before advancing its checkpoint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let armed = true;
      const baselineBatches: Array<readonly CollectionMutation[]> = [];
      const harness = createIngressHarness({
        beforeBatch: ({ operations }) => {
          const preparesCensus = operations.some((operation) => (
            operation.kind === 'put'
            && record(record(operation.value).payload).phase === 'prepared'
          ));
          if (armed && preparesCensus) {
            armed = false;
            throw new Error('Simulated Account Collection failure on the prepared census write.');
          }
          if (operations.some((operation) => (
            operation.kind === 'put'
            && operation.value['record-kind'] === 'ingress-obligation'
            && record(operation.value.payload).disposition === 'staleAuthority'
          )) || operations.some(isIngressCensusPut) || operations.some(isCheckpointPut)) {
            baselineBatches.push(operations);
          }
        },
        pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'baseline' } },
      });

      await expect(ingestConversationProviderObservationForInvocation(
        observation({
          messageRevision: 'baseline:preparing',
          occurrenceId: 'telegram:update:baseline-preparing',
          occurredAt: 1_000,
        }),
        harness.context,
      )).rejects.toThrow();
      const preparingCensus = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-census'
      ));
      const preparingObligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (preparingCensus === undefined || preparingObligation === undefined) {
        throw new Error('Expected the stranded ingress census and its member.');
      }

      // A fully terminal prepared row is already safe to cover, while a
      // ready prepared member still needs the same stale-authority resolution
      // as the stranded preparation before this replacement cursor can pass.
      await ingestConversationProviderObservationForInvocation(
        observation({
          messageRevision: 'baseline:terminal',
          occurrenceId: 'telegram:update:baseline-terminal',
          occurredAt: 1_000,
        }),
        harness.context,
      );
      await ingestConversationProviderObservationForInvocation(
        observation({
          messageRevision: 'baseline:prepared-ready',
          occurrenceId: 'telegram:update:baseline-prepared-ready',
          occurredAt: 1_000,
        }),
        harness.context,
      );
      const preparedReadyObligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true
        && row.value['record-kind'] === 'ingress-obligation'
        && obligationOccurrenceId(harness.rows, row) === 'telegram:update:baseline-prepared-ready'
      ));
      if (preparedReadyObligation === undefined) {
        throw new Error('Expected the prepared ingress obligation.');
      }
      const preparedReadyValue = record(preparedReadyObligation.value);
      const preparedReadyPayload = record(preparedReadyValue.payload);
      harness.rows.set(preparedReadyObligation.rowId, stateRow({
        ...preparedReadyValue,
        terminal: false,
        attention: false,
        'due-at': 1_000,
        payload: {
          ...preparedReadyPayload,
          lifecycle: { phase: 'ready', attemptCount: 0, dueAt: 1_000 },
          disposition: null,
          nonAdmission: null,
        },
      }, preparedReadyObligation.revision + 1));

      // Setup ingress has its own census preparation writes. From this point
      // onward the capture describes only the replacement-baseline stages.
      baselineBatches.length = 0;
      const gapConnection = setConnectionHistoryGap(harness.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      const censuses = [...harness.rows.values()].filter((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-census'
      ));
      expect(censuses).toHaveLength(3);
      for (const census of censuses) {
        expect(record(record(census.value).payload)).toMatchObject({
          phase: 'prepared',
          checkpointCoveredAt: 1_000,
        });
      }
      for (const obligationId of [preparingObligation.rowId, preparedReadyObligation.rowId]) {
        expect(record(record(harness.rows.get(obligationId)?.value ?? {}).payload)).toMatchObject({
          lifecycle: { phase: 'terminal', dueAt: null },
          disposition: 'staleAuthority',
          nonAdmission: { reason: 'staleAuthority', senderFeedbackEligible: false },
        });
        expect(record(harness.rows.get(obligationId)?.value ?? {}).attention).toBe(true);
      }
      expect(currentCheckpoint(harness.rows)).toMatchObject({
        value: { payload: { opaqueToken: { cursor: 'baseline' } } },
      });
      expect(record(record(harness.rows.get('connection-1')?.value ?? {}).payload).historyGap).toBeNull();

      const terminalizations = baselineBatches.flatMap((operations) => operations.filter((operation) => (
        operation.kind === 'put'
        && operation.value['record-kind'] === 'ingress-obligation'
        && record(operation.value.payload).disposition === 'staleAuthority'
      )));
      expect(terminalizations).toHaveLength(2);
      const coverage = baselineBatches.flatMap((operations) => (
        operations.some(isCheckpointPut) ? [] : operations.filter(isIngressCensusPut)
      ));
      expect(coverage).toHaveLength(3);
      const checkpointBatch = baselineBatches.find((operations) => operations.some(isCheckpointPut));
      expect(checkpointBatch?.filter(isIngressCensusPut)).toEqual([]);
      expect(checkpointBatch?.filter((operation) => (
        operation.kind === 'put' && operation.value['record-kind'] === 'ingress-obligation'
      ))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes covered history and stages uncovered coverage under the in-force lower batch limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const retainedCount = PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1 - 1;
      const covered = createIngressHarness({
        pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'replacement' } },
      });
      for (let index = 0; index < retainedCount; index += 1) {
        await ingestConversationProviderObservationForInvocation(
          observation({
            occurrenceId: `telegram:update:covered-history:${index}`,
            messageRevision: `covered-history:${index}`,
            occurredAt: 1_000,
          }),
          covered.context,
        );
      }
      const uncoveredRows = new Map(covered.rows);
      for (const [rowId, row] of covered.rows) {
        if (row.deleted === true || row.value['record-kind'] !== 'ingress-census') continue;
        const value = record(row.value);
        covered.rows.set(rowId, stateRow({
          ...value,
          'updated-at': 1_000,
          payload: { ...record(value.payload), checkpointCoveredAt: 1_000 },
        }, row.revision + 1));
      }
      // Historical attention remains visible to its own owner, but cannot
      // make a later unrelated provider gap globally head-of-line blocked.
      markIngressCensusOccurrenceConflict(covered.rows);

      const coveredGap = setConnectionHistoryGap(covered.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(coveredGap.value).payload), 'configurationRevision'),
      }, covered.context)).resolves.toMatchObject({ kind: 'updated' });
      expect(record(record(covered.rows.get('connection-1')?.value ?? {}).payload).historyGap).toBeNull();
      expect(currentCheckpoint(covered.rows)).toMatchObject({
        value: { payload: { opaqueToken: { cursor: 'replacement' } } },
      });

      const coverageBatches: Array<readonly CollectionMutation[]> = [];
      const baselineTransitions: Array<'checkpoint' | 'coverage' | 'clear'> = [];
      const uncovered = createIngressHarness({
        pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'lowered-limit' } },
        collectionLimits: deploymentLimits({ maxBatchRows: 4, maxBatchBytes: 16 * 1024 * 1024 }),
        beforeBatch: ({ operations }) => {
          if (operations.some(isCheckpointPut)) {
            baselineTransitions.push('checkpoint');
          } else if (operations.some(isIngressCensusPut)) {
            baselineTransitions.push('coverage');
            coverageBatches.push(operations);
          } else if (operations.some((operation) => (
            operation.kind === 'put'
            && operation.value['record-kind'] === 'connection'
            && record(operation.value.payload).historyGap === null
          ))) {
            baselineTransitions.push('clear');
          }
        },
      });
      uncovered.rows.clear();
      for (const [rowId, row] of uncoveredRows) uncovered.rows.set(rowId, row);
      const uncoveredGap = setConnectionHistoryGap(uncovered.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(uncoveredGap.value).payload), 'configurationRevision'),
      }, uncovered.context)).resolves.toMatchObject({ kind: 'updated' });
      expect(coverageBatches.length).toBeGreaterThan(1);
      expect(coverageBatches.every((operations) => operations.length <= 4)).toBe(true);
      expect(baselineTransitions[0]).toBe('checkpoint');
      expect(baselineTransitions.at(-1)).toBe('clear');
      expect(baselineTransitions.slice(1, -1).every((transition) => transition === 'coverage')).toBe(true);
      expect(currentCheckpoint(uncovered.rows)).toMatchObject({
        value: { payload: { opaqueToken: { cursor: 'lowered-limit' } } },
      });
      expect(record(record(uncovered.rows.get('connection-1')?.value ?? {}).payload).historyGap).toBeNull();

      const crashed = createIngressHarness({
        pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'crash-rejoin' } },
        loseNextUpdatedBatchResponse: true,
      });
      crashed.rows.clear();
      for (const [rowId, row] of uncoveredRows) crashed.rows.set(rowId, row);
      const crashedGap = setConnectionHistoryGap(crashed.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(crashedGap.value).payload), 'configurationRevision'),
      }, crashed.context)).rejects.toThrow('Simulated Account Collection response loss.');
      expect(currentCheckpoint(crashed.rows)).toMatchObject({
        value: { payload: { opaqueToken: { cursor: 'crash-rejoin' } } },
      });
      expect([...crashed.rows.values()].filter((row) => (
        row.deleted !== true
        && row.value['record-kind'] === 'ingress-census'
        && record(row.value.payload).checkpointCoveredAt !== null
      ))).toEqual([]);
      expect(record(record(crashed.rows.get('connection-1')?.value ?? {}).payload).historyGap).not.toBeNull();

      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(crashedGap.value).payload), 'configurationRevision'),
      }, crashed.context)).resolves.toMatchObject({ kind: 'updated' });
      expect(record(record(crashed.rows.get('connection-1')?.value ?? {}).payload).historyGap).toBeNull();

      let resetOnCoverage = true;
      const reset = createIngressHarness({
        pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'coverage-reset' } },
        beforeBatch: ({ rows, operations }) => {
          if (!resetOnCoverage || !operations.some(isIngressCensusPut) || operations.some(isCheckpointPut)) return;
          resetOnCoverage = false;
          advanceConnectionAuthorityEpoch(rows);
        },
      });
      reset.rows.clear();
      for (const [rowId, row] of uncoveredRows) reset.rows.set(rowId, row);
      const resetGap = setConnectionHistoryGap(reset.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(resetGap.value).payload), 'configurationRevision'),
      }, reset.context)).rejects.toMatchObject({
        code: 'channels_stream_baseline_conflict',
        retryable: true,
      });
      expect(currentCheckpoint(reset.rows)).toMatchObject({
        value: { payload: { opaqueToken: { cursor: 'coverage-reset' } } },
      });
      expect(record(record(reset.rows.get('connection-1')?.value ?? {}).payload).historyGap).not.toBeNull();
      expect([...reset.rows.values()].filter((row) => (
        row.deleted !== true
        && row.value['record-kind'] === 'ingress-census'
        && record(row.value.payload).checkpointCoveredAt !== null
      ))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stages one maximum-fanout census before the bounded replacement-checkpoint commit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const baselineBatches: Array<readonly CollectionMutation[]> = [];
      const source = createIngressHarness({
        pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'replacement' } },
        beforeBatch: ({ operations }) => {
          if (operations.some((operation) => (
            operation.kind === 'put'
            && operation.value['record-kind'] === 'ingress-obligation'
            && record(operation.value.payload).disposition === 'staleAuthority'
          )) || operations.some(isCheckpointPut)) baselineBatches.push(operations);
        },
      });
      for (let index = 2; index <= 256; index += 1) {
        addMatchingBinding(source.rows, `binding-${index}`);
      }
      await ingestConversationProviderObservationForInvocation(
        observation({
          occurrenceId: 'telegram:update:baseline-maximum-fanout',
          messageRevision: 'baseline:maximum-fanout',
          occurredAt: 1_000,
        }),
        source.context,
      );
      const obligations = [...source.rows.values()].filter((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      expect(obligations).toHaveLength(256);
      for (const obligation of obligations) {
        const value = record(obligation.value);
        source.rows.set(obligation.rowId, stateRow({
          ...value,
          terminal: false,
          attention: false,
          'due-at': 1_000,
          payload: {
            ...record(value.payload),
            lifecycle: { phase: 'ready', attemptCount: 0, dueAt: 1_000 },
            disposition: null,
            nonAdmission: null,
          },
        }, obligation.revision + 1));
      }
      const concurrentRows = new Map(source.rows);

      const gap = setConnectionHistoryGap(source.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(gap.value).payload), 'configurationRevision'),
      }, source.context)).resolves.toMatchObject({ kind: 'updated' });

      const terminalizationBatches = baselineBatches.filter((operations) => operations.some((operation) => (
        operation.kind === 'put' && operation.value['record-kind'] === 'ingress-obligation'
      )));
      expect(terminalizationBatches.length).toBeGreaterThan(1);
      for (const operations of terminalizationBatches) {
        expect(operations.length).toBeLessThanOrEqual(PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1);
        expect(operations[0]).toMatchObject({
          kind: 'assert',
          rowId: 'connection-1',
          expectedRevision: gap.revision,
        });
      }
      expect([...source.rows.values()].filter((row) => (
        row.deleted !== true
        && row.value['record-kind'] === 'ingress-obligation'
        && row.value.terminal !== true
      ))).toEqual([]);
      expect(currentCheckpoint(source.rows)).toMatchObject({
        value: { payload: { opaqueToken: { cursor: 'replacement' } } },
      });
      const finalBatch = baselineBatches.find((operations) => operations.some(isCheckpointPut));
      expect(finalBatch?.filter((operation) => (
        operation.kind === 'put' && operation.value['record-kind'] === 'ingress-obligation'
      ))).toEqual([]);

      let resetOnStaging = true;
      const concurrent = createIngressHarness({
        pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'must-not-commit' } },
        beforeBatch: ({ rows, operations }) => {
          if (!resetOnStaging || !operations.some((operation) => (
            operation.kind === 'put'
            && operation.value['record-kind'] === 'ingress-obligation'
            && record(operation.value.payload).disposition === 'staleAuthority'
          ))) return;
          resetOnStaging = false;
          advanceConnectionAuthorityEpoch(rows);
        },
      });
      concurrent.rows.clear();
      for (const [rowId, row] of concurrentRows) concurrent.rows.set(rowId, row);
      const concurrentGap = setConnectionHistoryGap(concurrent.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(concurrentGap.value).payload), 'configurationRevision'),
      }, concurrent.context)).rejects.toMatchObject({
        code: 'channels_stream_baseline_conflict',
        retryable: true,
      });
      expect(currentCheckpoint(concurrent.rows)).toBeUndefined();
      expect([...concurrent.rows.values()].filter((row) => (
        row.deleted !== true
        && row.value['record-kind'] === 'ingress-obligation'
        && row.value.terminal === true
      ))).toEqual([]);

      const blocked = createIngressHarness({
        pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'blocked-recovery' } },
      });
      blocked.rows.clear();
      for (const [rowId, row] of concurrentRows) blocked.rows.set(rowId, row);
      for (const obligation of [...blocked.rows.values()].filter((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ))) {
        const value = record(obligation.value);
        const { ['due-at']: _dueAt, ...withoutDueAt } = value;
        blocked.rows.set(obligation.rowId, stateRow({
          ...withoutDueAt,
          terminal: false,
          attention: true,
          payload: {
            ...record(value.payload),
            lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null },
            disposition: null,
            nonAdmission: null,
          },
        }, obligation.revision + 1));
      }
      const blockedGap = setConnectionHistoryGap(blocked.rows);
      await expect(acceptConversationStreamBaselineForInvocation({
        connectionId: 'connection-1',
        expectedRevision: payloadNumber(record(record(blockedGap.value).payload), 'configurationRevision'),
      }, blocked.context)).resolves.toMatchObject({ kind: 'updated' });
      const retainedBlocked = [...blocked.rows.values()].filter((row) => (
        row.deleted !== true
        && row.value['record-kind'] === 'ingress-obligation'
        && row.value.attention === true
      ));
      expect(retainedBlocked).toHaveLength(256);
      expect(retainedBlocked.every((row) => (
        record(record(record(row.value).payload).lifecycle).phase === 'blocked'
      ))).toBe(true);
      expect(currentCheckpoint(blocked.rows)).toMatchObject({
        value: { payload: { opaqueToken: { cursor: 'blocked-recovery' } } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a provider result the retained settlement owner cannot correlate without clearing the gap', async () => {
    const expectedOrigin = telegramExecutionOrigin;
    const harness = createIngressHarness({
      pollExecutionOrigin: {
        ...expectedOrigin,
        materializationRef: {
          ...expectedOrigin.materializationRef,
          machineId: 'machine-other',
        },
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).rejects.toMatchObject({
      code: 'plugin_action_execution_origin_mismatch',
    });

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
    expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).not.toBeNull();
  });

  it('honors cancellation before any baseline poll or mutation', async () => {
    const harness = createIngressHarness();
    const gapConnection = setConnectionHistoryGap(harness.rows);
    const controller = new AbortController();
    controller.abort();

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, { ...harness.context, signal: controller.signal })).rejects.toMatchObject({
      code: 'channels_ingress_cancelled',
      retryable: true,
    });

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
    expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).not.toBeNull();
  });

  it('returns unchanged only for an already-clear current baseline', async () => {
    const harness = createIngressHarness();

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: 1,
    }, harness.context)).resolves.toEqual({
      kind: 'unchanged',
      connectionId: 'connection-1',
      revision: 1,
      authorityEpoch: 4,
    });

    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
  });

  it('cannot clear an E+1 history gap or write its checkpoint when the final baseline CAS is stale', async () => {
    let checkpointBatch: readonly CollectionMutation[] | undefined;
    const harness = createIngressHarness({
      pollResult: { kind: 'checkpointOnly', checkpointAfterBatch: { cursor: 'stale' } },
      beforeBatch: ({ rows, operations }) => {
        if (!operations.some(isCheckpointPut)) return;
        checkpointBatch = operations;
        advanceConnectionAuthorityEpoch(rows);
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: payloadNumber(record(record(gapConnection.value).payload), 'configurationRevision'),
    }, harness.context)).rejects.toMatchObject({
      code: 'channels_stream_baseline_conflict',
      retryable: true,
    });

    expect(checkpointBatch).toBeDefined();
    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
    const currentPayload = record(record(harness.rows.get('connection-1')?.value).payload);
    expect(currentPayload).toMatchObject({ authorityEpoch: 5 });
    expect(currentPayload.historyGap).not.toBeNull();
  });
});
