import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';
import type { SessionSendRequest } from '@happier-dev/plugin-sdk/sessions';
import type {
  JsonValue,
  PluginInvocationContext,
  PluginServices,
  TargetedContributionPointRef,
  TargetedContributionSnapshot,
  TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type {
  PluginCollectionBatchMeasurement,
  PluginCollectionLimits,
  PluginCollectionMutation,
} from '@happier-dev/plugin-sdk/collections';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';
import type {
  ConversationProviderObservationIngestInputV1,
} from '@happier-dev/channels-protocol/v1';
import {
  ConversationProviderObservationIngestInputV1JsonSchema,
  ConversationProviderObservationIngestInputV1Schema,
  MAX_CONVERSATION_OBSERVATION_CLOCK_SKEW_MS,
} from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import {
  createIngressCensusValue,
  deriveIngressCensusRowId,
  acceptConversationStreamBaselineForInvocation,
  createConversationProviderObservationIngestHandler,
  ingestConversationProviderObservationForInvocation,
  hasConversationCheckpointedPullBaseline,
  partitionIngressPreparationValues,
  runConversationCheckpointedPollForInvocation,
  runConversationIngressDueWorkForInvocation,
  runConversationIngressRetentionForInvocation,
  retryConversationIngressForInvocation,
} from './ingress.js';
import {
  confirmConversationCheckpointedPollStopForInvocation,
  retryConversationConnectionPollForInvocation,
  updateConversationConnectionForInvocation,
} from './management.js';
import { MAX_CHANNEL_STATE_ROW_BYTES } from './collections.js';
import { isChannelStateJsonRecord, readConversationConnectionUpdateRow } from './accountLocalBindingPolicy.js';
import { startConversationConnectionTransfer } from './connectionLifecycle.js';
import { pollTelegramObservations } from '../../channel-telegram/src/channelActions.js';
import { createConversationPairingManager } from './pairing.js';

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

function payloadTransportOrigin(
  payload: Readonly<Record<string, unknown>>,
): PluginMachineExecutionOriginV1 {
  const value = payload.transportOrigin;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected the retained connection payload to carry a transport origin.');
  }
  return value as PluginMachineExecutionOriginV1;
}

import {
  createCurrentConversationConnectionFixture,
  createCurrentConversationPendingOldTransportStopFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

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

const telegramConnectionAuthority = {
  providerPluginId: telegramProviderPluginId,
  providerContributionSelection: {
    contributionId: 'telegram-test-provider',
    immutableGenerationId: 'telegram-test-generation',
  },
  providerSetupInput: { source: 'test' },
  credentialRef: {
    service: { pluginId: telegramProviderPluginId, localId: 'telegram-bot' },
    accountId: 'telegram-account-1',
  },
  transportOrigin: {
    serverIdentityId: 'srv_account_one',
    materializationRef: {
      machineId: 'machine-1',
      materializationId: 'telegram-install-1',
      pluginId: telegramProviderPluginId,
    },
  },
  providerConnectionKey: 'telegram-bot:12345',
  providerConfig: { botUsername: 'happier_bot' },
  routingIdentityKey: 'r'.repeat(43),
  integrationPrincipal: { id: 'telegram:bot:12345', label: 'Happier' },
  authorityEpoch: 4,
} as const satisfies ConversationConnectionFixtureAuthority;

const admittedTelegramProviderContribution = Object.freeze({
  contributor: {
    pluginId: telegramProviderPluginId,
    contributionId: 'telegram-test-provider',
    immutableGenerationId: 'telegram-test-generation',
  },
  protocol: { id: 'happier.channels/providers', version: 1 },
  operations: { observationsPoll: telegramPollAction },
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
            generation: 'channels-test-generation',
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

function observation(input: Readonly<{
  messageRevision: string;
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
          id: 'telegram:message:5',
          revision: input.messageRevision,
          text: input.messageText ?? 'Hello from Telegram',
          addressingEvidence: 'none',
          contentProvenance: input.contentProvenance ?? 'original',
          providerTimestamp: input.providerTimestamp ?? now,
        },
      },
    },
  };
}

function fullTextIngress(input: ConversationProviderObservationIngestInputV1) {
  if (input.observation.kind !== 'fullText') throw new Error('Expected full-text test ingress.');
  return input.observation.observation;
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
    observation: {
      kind: 'routableNonAdmission',
      shell: { ...fullObservation, message: { ...message, revision } },
      reason: input.reason ?? 'messageTooLarge',
    },
  };
}

type SessionSendResult =
  | Readonly<{ status: 'accepted'; localId: string }>
  | Readonly<{ status: 'alreadyAccepted'; localId: string }>
  | Readonly<{ status: 'rejected'; code: string }>
  | Readonly<{ status: 'outcomeUnknown'; localId: string; code: string }>;

type IngressHarnessOptions = Readonly<{
  connection?: ReturnType<typeof channelConnection>;
  sessionSendResult?: SessionSendResult;
  sessionSendResults?: readonly SessionSendResult[];
  sessionSend?: (input: unknown) => Promise<SessionSendResult>;
  availableSessionIds?: readonly string[];
  execute?: (actionId: string, input: JsonValue) => Promise<JsonValue> | JsonValue;
  beforeBatch?: (input: Readonly<{
    rows: Map<string, StoredStateRow>;
    operations: readonly CollectionMutation[];
  }>) => void | Promise<void>;
  loseNextUpdatedBatchResponse?: boolean;
  pollResult?: JsonValue;
  getPollResult?: () => JsonValue | Promise<JsonValue>;
  pollExecution?: (input: JsonValue, signal: AbortSignal) => JsonValue | Promise<JsonValue>;
  pollExecutionError?: unknown;
  pollExecutionOrigin?: ReturnType<typeof channelConnection>['payload']['transportOrigin'];
  getPollExecutionOrigin?: () => ReturnType<typeof channelConnection>['payload']['transportOrigin'];
  beforeCollectionGet?: (input: Readonly<{ rowId: string }>) => void;
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
  const next = stateRow({
    ...connection,
    payload: { ...payload, ...patch },
  }, existing.revision + 1);
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
  materializationId: string,
): StoredStateRow {
  const existing = rows.get('connection-1');
  if (existing === undefined) throw new Error('Expected the Channel connection state row.');
  const payload = record(record(existing.value).payload);
  const transportOrigin = record(payload.transportOrigin);
  const materializationRef = record(transportOrigin.materializationRef);
  return replaceConnectionPayload(rows, {
    transportOrigin: {
      ...transportOrigin,
      materializationRef: {
        ...materializationRef,
        materializationId,
      },
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
      materializationRef: {
        ...current.payload.transportOrigin.materializationRef,
        materializationId: 'telegram-install-replacement',
      },
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
    observation: {
      kind: 'fullText',
      observation: {
        ...fullText,
        endpoint: { kind: 'shared', audience: 'shared', id: 'telegram:chat:200' },
      },
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
        templateVersion: 3,
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
        templateVersion: 3,
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
              directory: '/workspace/channels',
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

function setBindingApprovalEnabled(rows: Map<string, StoredStateRow>): void {
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
          approvals: { kind: 'enabled', maximumScope: 'request' },
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
    _operation: unknown,
    input: JsonValue,
    executionOptions: Readonly<{ signal: AbortSignal }>,
  ) => {
    const executionOrigin = options.getPollExecutionOrigin?.()
      ?? options.pollExecutionOrigin
      ?? initialConnection.payload.transportOrigin;
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
    options: Readonly<{ expectedRevision: number | 'absent' }>,
  ): Promise<StoredStateRow> => {
    const id = value.id;
    if (typeof id !== 'string') throw new Error('State writes require a canonical id.');
    const existing = rows.get(id);
    if (
      (options.expectedRevision === 'absent' && existing !== undefined)
      || (typeof options.expectedRevision === 'number'
        && (existing === undefined || existing.revision !== options.expectedRevision))
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
      range?: Readonly<{ upper?: number }>;
      order?: 'asc' | 'desc';
      cursor?: string;
      limit: number;
    }>) {
      const prefix = request.prefix ?? [];
      const matched = [...rows.values()].filter((row) => {
        if (row.deleted === true) return false;
        if (request.index === 'by-kind') return row.value['record-kind'] === prefix[0];
        if (request.index === 'by-connection') return row.value['connection-id'] === prefix[0];
        if (request.index === 'by-binding') return row.value['binding-id'] === prefix[0];
        if (request.index === 'by-connection-binding-v2') {
          return row.value['connection-id'] === prefix[0]
            && (row.value['binding-id'] ?? null) === prefix[1]
            && row.value['record-kind'] === prefix[2]
            && row.value.attention === prefix[3];
        }
        if (request.index === 'by-ingress-due') {
          const dueAt = row.value['due-at'];
          return row.value['record-kind'] === prefix[0]
            && typeof dueAt === 'number'
            && (request.range?.upper === undefined || dueAt <= request.range.upper);
        }
        return false;
      }).sort((left, right) => {
        if (request.index !== 'by-ingress-due') return 0;
        const leftDueAt = Number(left.value['due-at']);
        const rightDueAt = Number(right.value['due-at']);
        return (leftDueAt - rightDueAt) * (request.order === 'desc' ? -1 : 1);
      });
      return {
        rows: matched.slice(0, request.limit),
        changeCursor: 1,
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
      if (loseNextUpdatedBatchResponse) {
        loseNextUpdatedBatchResponse = false;
        throw new Error('Simulated Account Collection response loss.');
      }
      return { status: 'updated' as const, results, changeCursor: 1 };
    },
  };

  // The fixture supplies only genuine host boundaries: Account collection and Session admission.
  const services = {
    storage: { account: { collection: () => collection } },
    actions: { execute, executeAdmittedTargetedOperationWithExecutionOrigin },
    targetedContributions: targetedTelegramPollContribution(options.readAdmittedProviderContributions),
    sessions: {
      get: async (sessionId: string) => (options.availableSessionIds ?? ['session-1']).includes(sessionId)
        ? { send }
        : null,
    },
  } as unknown as PluginServices;
  const context: PluginInvocationContext = {
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
      materialization: channelConnection().payload.transportOrigin.materializationRef,
    },
    signal: new AbortController().signal,
    services,
  };
  return { rows, send, execute, executeAdmittedTargetedOperationWithExecutionOrigin, context };
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
  it('keeps the canonical parser fail closed before Account access when Action JSON Schema also rejects a UTF-8 overflow', async () => {
    const input = observation({
      messageRevision: 'utf8-overflow:1',
      messageText: '😀'.repeat(20_000),
    });
    const manifestValidator = compilePluginJsonSchema(ConversationProviderObservationIngestInputV1JsonSchema);
    const collectionReads = vi.fn();
    const harness = createIngressHarness({
      beforeCollectionGet: collectionReads,
    });

    expect(isValidPluginJsonSchemaValue(manifestValidator, input)).toBe(false);
    expect(ConversationProviderObservationIngestInputV1Schema.safeParse(input).success).toBe(false);

    await expect(ingestConversationProviderObservationForInvocation(input, harness.context)).rejects.toThrow();
    expect(collectionReads).not.toHaveBeenCalled();
    expect(harness.rows).toHaveLength(2);
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
      }).observation,
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
      phase: 'preparing',
      connectionAuthorityEpoch: 4,
      maximumObservationAgeMs: 120_000,
      checkpointCoveredAt: null,
      conflict: null,
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
      phase: 'preparing',
      connectionAuthorityEpoch: 4,
      maximumObservationAgeMs: 120_000,
      checkpointCoveredAt: null,
      conflict: null,
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

  it('keeps the largest checkpointed-poll settlement request below the ingress 8 MiB batch budget', () => {
    const encodedJsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const maximumConnectionBase = {
      id: 'connection-1',
      'record-kind': 'connection',
      payload: { padding: '' },
    };
    const maximumConnectionValue = {
      ...maximumConnectionBase,
      payload: { padding: 'x'.repeat(MAX_CHANNEL_STATE_ROW_BYTES - encodedJsonBytes(maximumConnectionBase)) },
    };
    const checkpointToken = 'x'.repeat(48 * 1024);
    const censusAssertionIds = Array.from({ length: 98 }, (_, index) => (
      `census-${String(index).padStart(3, '0')}-${'x'.repeat(245)}`
    ));

    expect(encodedJsonBytes(maximumConnectionValue)).toBe(MAX_CHANNEL_STATE_ROW_BYTES);
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

    expect(request.operations).toHaveLength(100);
    expect(encodedJsonBytes(request)).toBeLessThan(8 * 1024 * 1024);
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
      ingress: winner.observation,
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
        content: 'This message could not be admitted.',
      },
    });
  });

  it('keeps an existing enabled approval policy non-authorizing until generic mediation is source-green', async () => {
    const harness = createIngressHarness();
    setBindingApprovalEnabled(harness.rows);

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

  it('keeps the binding approval ceiling off in ordinary Session admission while C5 is hard-off', async () => {
    const harness = createIngressHarness();
    setBindingApprovalEnabled(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-source:1',
    }), harness.context)).resolves.toBeUndefined();

    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        sourceRef: 'channels:binding:binding-1',
        sourceRevisionOrEpoch: '4:7',
        remoteApprovalMaxScope: 'off',
        requestedPermissionCeiling: 'read-only',
      }),
    }), { signal: harness.context.signal });
  });

  it('keeps C5 approval commands hard-off without invoking remote Permission Actions', async () => {
    const actionCalls: Array<Readonly<{ actionId: string; input: JsonValue }>> = [];
    const harness = createIngressHarness({
      execute: async (actionId, input) => {
        actionCalls.push({ actionId, input });
        throw new Error(`C5 hard-off must not invoke ${actionId}.`);
      },
    });
    setBindingApprovalEnabled(harness.rows);

    await expect(ingestConversationProviderObservationForInvocation(observation({
      messageRevision: 'approval-command:1',
      messageText: '/allow permission-request-1 request',
    }), harness.context)).resolves.toBeUndefined();

    expect(actionCalls).toEqual([]);
    expect(harness.send).not.toHaveBeenCalled();
    const obligation = [...harness.rows.values()].find(
      (row) => row.value['record-kind'] === 'ingress-obligation',
    );
    expect(obligation?.value.payload).toMatchObject({
      lifecycle: { phase: 'terminal' },
      disposition: 'rejected',
      nonAdmission: { reason: 'commandNotAuthorized', senderFeedbackEligible: false },
    });
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
      materialization: socketConnection.payload.transportOrigin.materializationRef,
      destinationLabel: 'Telegram bot',
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

  it('does not let conflicting /pair replays consume pairing attempt budget before a fresh valid occurrence', async () => {
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
      materialization: socketConnection.payload.transportOrigin.materializationRef,
      destinationLabel: 'Telegram bot',
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
    }), harness.context)).resolves.toBeUndefined();

    expect(manager.readManagementProjection().proposals).toHaveLength(1);
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
      materialization: socketConnection.payload.transportOrigin.materializationRef,
      destinationLabel: 'Telegram bot',
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

  it('admits a provider observation only from the exact current transport materialization', async () => {
    const socketConnection = socketChannelConnection();
    const harness = createIngressHarness({ connection: socketConnection });
    const manager = createConversationPairingManager({
      generationId: 'pairing-generation-1',
      now: () => 1_000,
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]),
      createId: (kind) => `${kind}-1`,
    });
    const ingest = createConversationProviderObservationIngestHandler(manager);
    const current = socketConnection.payload.transportOrigin.materializationRef;
    const withCaller = (materialization: Record<string, string>, pluginId?: string) => ({
      ...harness.context,
      caller: {
        ...(harness.context.caller as Record<string, unknown>),
        ...(pluginId === undefined ? {} : { pluginId }),
        materialization,
      },
    } as unknown as typeof harness.context);

    // A different provider plugin entirely.
    await expect(ingest(
      observation({ messageRevision: 'authority:1', occurrenceId: 'telegram:update:auth-1', transport: 'socket' }),
      withCaller({ ...current, pluginId: 'happier.channel.other' }, 'happier.channel.other'),
    )).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });

    // The same plugin from a replaced materialization of the same machine.
    await expect(ingest(
      observation({ messageRevision: 'authority:2', occurrenceId: 'telegram:update:auth-2', transport: 'socket' }),
      withCaller({ ...current, materializationId: 'provider-replaced' }),
    )).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });

    // A caller whose stamped materialization does not name the calling plugin.
    await expect(ingest(
      observation({ messageRevision: 'authority:3', occurrenceId: 'telegram:update:auth-3', transport: 'socket' }),
      withCaller({ ...current, pluginId: 'happier.channel.other' }),
    )).rejects.toMatchObject({ code: 'channels_ingress_stale_authority' });

    expect([...harness.rows.values()].map((row) => row.value['record-kind']).sort())
      .toEqual(['binding', 'connection']);

    // The exact current materialization still admits the same observation.
    await expect(ingest(
      observation({ messageRevision: 'authority:4', occurrenceId: 'telegram:update:auth-4', transport: 'socket' }),
      harness.context,
    )).resolves.toBeUndefined();
  });

  it('admits an Automation occurrence through the canonical action with its frozen actor and reply context', async () => {
    const harness = createIngressHarness({
      execute: async (actionId, input) => {
        expect(actionId).toBe('automation.conversation.admit');
        expect(input).toEqual({
          automationId: 'automation-1',
          bindingId: 'binding-1',
          templateVersion: 3,
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
        templateVersion: 3,
        resultDelivery: { kind: 'none' },
      },
      lifecycle: { phase: 'terminal' },
      disposition: 'admitted',
    });
  });

  it('admits a final-result binding through the canonical Automation action', async () => {
    const execute = vi.fn(async (actionId, actionInput) => {
      expect(actionId).toBe('automation.conversation.admit');
      expect(actionInput).toMatchObject({
        automationId: 'automation-1',
        bindingId: 'binding-1',
        templateVersion: 3,
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
      templateVersion: 3,
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
          templateVersion: 3,
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
          templateVersion: 3,
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

  it('spends bounded no-effect Automation retries with positive durable backoff before retaining attention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({
        execute: async (actionId) => {
          expect(actionId).toBe('automation.conversation.admit');
          return { kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false };
        },
      });
      setAutomationBindingWithoutFinalResult(harness.rows);
      const input = observation({ messageRevision: 'automation-no-effect:1' });

      for (let attemptCount = 1; attemptCount <= 5; attemptCount += 1) {
        const attemptedAt = Date.now();
        const invocation = ingestConversationProviderObservationForInvocation(input, harness.context);
        if (attemptCount < 5) {
          await expect(invocation).rejects.toMatchObject({
            code: 'channels_ingress_admission_unsettled',
            retryable: true,
          });
        } else {
          await expect(invocation).resolves.toBeUndefined();
        }

        const obligation = [...harness.rows.values()].find(
          (row) => row.value['record-kind'] === 'ingress-obligation',
        );
        if (obligation === undefined) throw new Error('Expected a retained ingress obligation.');
        const lifecycle = record(record(obligation.value).payload).lifecycle;
        if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) {
          throw new Error('Expected an ingress lifecycle.');
        }
        if (attemptCount < 5) {
          const dueAt = [2_000, 4_000, 8_000, 16_000][attemptCount - 1];
          if (dueAt === undefined) throw new Error('Expected a bounded ingress retry due time.');
          expect(obligation.value).toMatchObject({
            terminal: false,
            attention: false,
            payload: {
              lifecycle: {
                phase: 'retryDue',
                attemptCount,
                dueAt,
              },
              disposition: null,
            },
          });
          expect(record(lifecycle).dueAt).toBe(dueAt);
          expect(dueAt).toBeGreaterThan(attemptedAt);
          vi.setSystemTime(dueAt);
        } else {
          expect(obligation.value).toMatchObject({
            terminal: false,
            attention: true,
            payload: {
              lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null },
              disposition: null,
            },
          });
          expect(obligation.value).not.toHaveProperty('due-at');
        }
      }

      expect(harness.execute).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
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
            directory: '/workspace/channels',
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
        content: 'Started a new Session.',
        deliveryKey: `ingress-new:${obligation?.value.id}`,
        replyContext: { replyToMessageId: 'telegram:message:5' },
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
        state: 'ready',
      },
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
      content: 'Started a new Session.',
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
    expect(harness.send.mock.calls[1]?.[0].idempotencyKey)
      .toBe(harness.send.mock.calls[0]?.[0].idempotencyKey);
    expect(harness.send.mock.calls.map(([request]) => request.source)).toEqual([
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
        content: 'Another /new command is already in progress.',
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
        remoteApprovalMaxScope: 'off',
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

  it('rejoins a terminal occurrence after a compatible E→E+1 transport transfer without a second Session admission', async () => {
    const harness = createIngressHarness();
    const first = observation({ messageRevision: 'edit:1' });

    await ingestConversationProviderObservationForInvocation(first, harness.context);
    advanceConnectionAuthorityEpoch(harness.rows);
    const transferred = replaceConnectionTransportOrigin(harness.rows, 'telegram-install-2');
    const payload = record(record(transferred.value).payload);
    const transportOrigin = record(payload.transportOrigin);
    const materialization = record(transportOrigin.materializationRef);
    const transferredContext: PluginInvocationContext = {
      ...harness.context,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channel.telegram',
        contribution: {
          id: 'channel-poller',
          qualifiedId: 'happier.channel.telegram/background/channel-poller',
        },
        materialization: {
          pluginId: String(materialization.pluginId),
          machineId: String(materialization.machineId),
          materializationId: String(materialization.materializationId),
        },
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
    const materialization = record(transportOrigin.materializationRef);
    const transferredContext: PluginInvocationContext = {
      ...harness.context,
      caller: {
        kind: 'plugin',
        pluginId: String(payload.providerPluginId),
        contribution: {
          id: 'channel-poller',
          qualifiedId: `${String(payload.providerPluginId)}/background/channel-poller`,
        },
        materialization: {
          pluginId: String(materialization.pluginId),
          machineId: String(materialization.machineId),
          materializationId: String(materialization.materializationId),
        },
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

  it('refuses delayed ingress whose retained contribution generation was replaced while it waited', async () => {
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
          immutableGenerationId: 'telegram-test-generation-2',
        },
      }];
      vi.setSystemTime(1_100);
      await expect(runConversationIngressDueWorkForInvocation({ now: 1_100 }, harness.context))
        .resolves.toBe(1);
      expect(harness.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains checkpoint-covered ingress through its frozen replay horizon, then deletes its completed census and obligations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness();
      await ingestConversationProviderObservationForInvocation(
        observation({ messageRevision: 'retention:terminal', occurredAt: 1_000 }),
        harness.context,
      );
      const census = markIngressCensusCheckpointCovered(harness.rows, 1_000);
      const obligation = [...harness.rows.values()].find((row) => (
        row.deleted !== true && row.value['record-kind'] === 'ingress-obligation'
      ));
      if (obligation === undefined) throw new Error('Expected the completed ingress obligation.');

      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(census.rowId)?.deleted).not.toBe(true);
      expect(harness.rows.get(obligation.rowId)?.deleted).not.toBe(true);

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(census.rowId)?.deleted).toBe(true);
      expect(harness.rows.get(obligation.rowId)?.deleted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sizes the retention delete to the deployment batch-row limit in force, not the protocol ceiling', async () => {
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
      limits = deploymentLimits({ maxBatchRows: 1, maxBatchBytes: 16 * 1024 * 1024 });
      deleteBatchSizes.length = 0;

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });

      expect(Math.max(...deleteBatchSizes)).toBe(1);
      expect(harness.rows.get(census.rowId)?.deleted).toBe(true);
      for (const obligation of obligations) {
        expect(harness.rows.get(obligation.rowId)?.deleted).toBe(true);
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

      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(censusId)?.deleted).not.toBe(true);

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(censusId)?.deleted).toBe(true);
      expect(harness.rows.get(obligation.rowId)?.deleted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires an actionless mention-gated non-admission with its full-text census at the frozen replay horizon', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({ connection: socketChannelConnection() });
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

      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      expect(harness.rows.get(censusId)?.deleted).not.toBe(true);

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(censusId)?.deleted).toBe(true);
      expect(harness.rows.get(obligation.rowId)?.deleted).toBe(true);
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

  it('covers a census whose checkpoint committed while a member was blocked, so a manual retry can retire it', async () => {
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
            observations: [blockedIngress.observation],
            checkpointAfterBatch: { cursor: 'past-blocked-occurrence' },
          }),
      });

      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      // The provider keeps re-presenting the occurrence while the cursor is held
      // back by an unsettled admission, until the fifth attempt blocks it.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const poll = await runConversationCheckpointedPollForInvocation({
          connectionId: 'connection-1',
          waitMs: 0,
        }, harness.context);
        expect(poll.kind).toBe(attempt < 5 ? 'retry' : 'committed');
        if (attempt < 5) {
          // An unsettled page holds the cursor back, so it earns no coverage.
          const uncovered = [...harness.rows.values()].find(
            (row) => row.deleted !== true && row.value['record-kind'] === 'ingress-census',
          );
          expect(record(record(uncovered?.value).payload).checkpointCoveredAt).toBeNull();
        }
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
        attention: true,
        payload: { lifecycle: { phase: 'blocked' } },
      });
      // The committed checkpoint advanced past this occurrence, so the provider
      // can never re-present it. That is the coverage fact, independent of any
      // member still owing recovery work.
      expect(currentCheckpoint(harness.rows)?.value).toMatchObject({
        payload: { opaqueToken: { cursor: 'past-blocked-occurrence' } },
      });
      expect(record(record(harness.rows.get(censusId)?.value).payload).checkpointCoveredAt)
        .toEqual(expect.any(Number));

      // The owner runs the only recovery the surface offers; the occurrence is
      // never presented by a poll again.
      const retryAt = 30_000;
      vi.setSystemTime(retryAt);
      await expect(retryConversationIngressForInvocation({
        obligationId: blocked.rowId,
        expectedRevision: blocked.revision,
      }, harness.context)).resolves.toMatchObject({ kind: 'retryScheduled' });
      await expect(runConversationIngressDueWorkForInvocation({ now: retryAt }, harness.context))
        .resolves.toBe(1);
      expect(harness.rows.get(blocked.rowId)?.value).toMatchObject({
        terminal: true,
        attention: false,
        payload: { lifecycle: { phase: 'terminal' }, disposition: 'admitted' },
      });

      await expect(runConversationIngressRetentionForInvocation({ now: 61_000, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(censusId)?.deleted).toBe(true);
      expect(harness.rows.get(blocked.rowId)?.deleted).toBe(true);
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
          observations: [original.observation],
          checkpointAfterBatch: { cursor: 'first-delivery' },
        },
        {
          kind: 'batch',
          observations: [original.observation],
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
      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });
      expect(harness.rows.get(censusId)?.deleted).toBe(true);

      vi.setSystemTime(70_000);
      const connection = harness.rows.get('connection-1');
      if (connection === undefined) throw new Error('Expected the current Channel connection.');
      await expect(updateConversationConnectionForInvocation({
        connectionId: 'connection-1',
        expectedRevision: connection.revision,
        enabled: true,
        maximumObservationAgeMs: 120_000,
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      vi.setSystemTime(90_000);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      expect(harness.send).toHaveBeenCalledTimes(1);
      expect(harness.rows.get(censusId)?.deleted).toBe(true);
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
          observations: [original.observation],
          checkpointAfterBatch: { cursor: 'first-automation' },
        },
        {
          kind: 'batch',
          observations: [original.observation],
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
      expect(harness.rows.get(censusId)?.deleted).toBe(true);

      vi.setSystemTime(70_000);
      const connection = harness.rows.get('connection-1');
      if (connection === undefined) throw new Error('Expected the current Channel connection.');
      await expect(updateConversationConnectionForInvocation({
        connectionId: 'connection-1',
        expectedRevision: connection.revision,
        enabled: true,
        maximumObservationAgeMs: 120_000,
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      vi.setSystemTime(90_000);
      await expect(runConversationCheckpointedPollForInvocation({
        connectionId: 'connection-1',
        waitMs: 0,
      }, harness.context)).resolves.toMatchObject({ kind: 'committed' });

      expect(harness.execute).toHaveBeenCalledTimes(1);
      expect(harness.rows.get(censusId)?.deleted).toBe(true);
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
          observations: [pair.observation],
          checkpointAfterBatch: { cursor: 'first-pairing' },
        },
        {
          kind: 'batch',
          observations: [pair.observation],
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
        materialization: channelConnection().payload.transportOrigin.materializationRef,
        destinationLabel: 'Telegram bot',
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
      expect(harness.rows.get(censusId)?.deleted).toBe(true);

      vi.setSystemTime(70_000);
      const connection = harness.rows.get('connection-1');
      if (connection === undefined) throw new Error('Expected the current Channel connection.');
      await expect(updateConversationConnectionForInvocation({
        connectionId: 'connection-1',
        expectedRevision: connection.revision,
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
        expectedConnectionRevision: updatedConnection.revision,
        materialization: channelConnection().payload.transportOrigin.materializationRef,
        destinationLabel: 'Telegram bot',
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
      expect(harness.rows.get(censusId)?.deleted).toBe(true);
      restartedManager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never prunes a checkpoint-covered census whose member still owns a retryable blocked recovery', async () => {
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
        if (attempt < 5) {
          await expect(result)
            .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });
        } else {
          await expect(result).resolves.toBeUndefined();
        }
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
        attention: true,
        payload: { lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null } },
      });

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });

      expect(harness.rows.get(census.rowId)?.deleted).not.toBe(true);
      expect(harness.rows.get(obligation.rowId)?.deleted).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never prunes a census whose occurrence evidence is contradictory, even past its horizon', async () => {
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

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, harness.context))
        .resolves.toMatchObject({ deletedCensuses: 0 });

      expect(harness.rows.get(conflicted.rowId)?.deleted).not.toBe(true);
      expect(harness.rows.get(obligation.rowId)?.deleted).not.toBe(true);
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

      await expect(runConversationIngressRetentionForInvocation({ now: 61_001, limit: 1 }, first.context))
        .resolves.toMatchObject({ deletedCensuses: 1 });

      expect(first.rows.get(firstCensus.rowId)?.deleted).toBe(true);
      expect(second.rows.get(secondCensus.rowId)?.deleted).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks for owner attention on the fifth real outcome-unknown Session admission attempt', async () => {
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
        if (attempt < 5) {
          await expect(result)
            .rejects.toMatchObject({ code: 'channels_ingress_admission_unsettled', retryable: true });
        } else {
          await expect(result).resolves.toBeUndefined();
        }
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
        attention: true,
        payload: { lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null } },
      });
      expect(obligation?.value).not.toHaveProperty('due-at');
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

    const request = harness.send.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      source: {
        externalActor: { kind: 'human' },
        contentProvenance: 'forwarded',
      },
    });
    expect(request?.source?.externalActor).not.toHaveProperty('displayNameSnapshot');
  });
});

describe('Conversation checkpointed-poll ingress', () => {
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
              }).observation],
              checkpointAfterBatch: { cursor: 'covered' },
            };
        },
        beforeBatch: ({ operations }) => {
          const writesOccurrence = operations.some((operation) => {
            if (!isCheckpointPut(operation)) return false;
            const payload = record(operation.value.payload);
            return payload.lastOccurrenceId === occurrenceId;
          });
          if (writesOccurrence) checkpointBatches.push(operations);
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
      expect(checkpointBatches[1]).toEqual(expect.arrayContaining([
        {
          kind: 'assert',
          rowId: coveredCensus.rowId,
          expectedRevision: coveredCensus.revision,
        },
      ]));
      expect(checkpointBatches[1]?.some(isIngressCensusPut)).toBe(false);
      expect(harness.rows.get(coveredCensus.rowId)).toEqual(coveredCensus);
    } finally {
      vi.useRealTimers();
    }
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
            observations: [original.observation],
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
            observations: [original.observation],
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
    }).observation);
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

  it('durably blocks a permanent provider poll failure and does not invoke that provider again', async () => {
    const harness = createIngressHarness({
      pollResult: { kind: 'notReady', reason: 'credentialInvalid' },
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'blocked' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pollFailure).toEqual({
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: { kind: 'provider', reason: 'credentialInvalid' },
    });
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'ineligible' });
    expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
  });

  it('keeps a Telegram 409 blocked after a controlled provider-exclusive poll replacement until exact manual retry', async () => {
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
          caller: {
            kind: 'plugin',
            pluginId: 'happier.channels',
            contribution: {
              id: 'ingress-supervisor',
              qualifiedId: 'happier.channels/background/ingress-supervisor',
            },
            materialization: channelConnection().payload.transportOrigin.materializationRef,
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
        return payloadTransportOrigin(record(record(current.value).payload));
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
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'blocked' });
    const blocked = rows.get('connection-1');
    if (blocked === undefined) throw new Error('Expected the blocked replacement Channel connection.');
    expect(record(record(blocked.value).payload).pollFailure).toMatchObject({
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: {
        kind: 'provider',
        reason: 'providerConflict',
        diagnostic: 'Conflict: terminated by other getUpdates request',
      },
    });

    await expect(retryConversationConnectionPollForInvocation({
      connectionId: 'connection-1',
      expectedRevision: blocked.revision,
      authorityEpoch: 5,
    }, harness.context)).resolves.toMatchObject({
      kind: 'retryScheduled',
      connectionId: 'connection-1',
      authorityEpoch: 5,
    });
    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toMatchObject({ kind: 'committed', connectionId: 'connection-1' });
    expect(getUpdatesCalls).toBe(3);
    expect(currentCheckpoint(rows)?.value).toMatchObject({
      payload: { opaqueToken: { v: 1, offset: '0' }, lastOccurrenceId: null },
    });
  });

  it('persists bounded retry due states before blocking the fifth retryable provider failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createIngressHarness({
        pollResult: { kind: 'notReady', reason: 'network', retryAfterMs: 2_000 },
      });

      for (let attemptCount = 1; attemptCount <= 5; attemptCount += 1) {
        await expect(runConversationCheckpointedPollForInvocation({
          connectionId: 'connection-1',
          waitMs: 0,
        }, harness.context)).resolves.toEqual(
          attemptCount === 5
            ? { kind: 'blocked' }
            : { kind: 'retry', retryAfterMs: 2_000 },
        );
        const pollFailure = record(record(harness.rows.get('connection-1')?.value).payload).pollFailure;
        if (attemptCount === 5) {
          expect(pollFailure).toEqual({
            phase: 'blocked',
            attemptCount,
            retryNotBeforeMs: null,
            evidence: { kind: 'provider', reason: 'network' },
          });
        } else {
          expect(pollFailure).toEqual({
            phase: 'retryDue',
            attemptCount,
            retryNotBeforeMs: Date.now() + 2_000,
            evidence: { kind: 'provider', reason: 'network' },
          });
          vi.setSystemTime(Date.now() + 2_000);
        }
      }

      expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a bounded attempt-aware retry delay when a retryable provider result has no hint', async () => {
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

  it('durably blocks a generic contributed poll Action failure without retaining its cause', async () => {
    const harness = createIngressHarness({
      pollExecutionError: new PluginError({
        code: 'provider_transport_exploded',
        message: 'The provider transport failed with an internal detail that must not be retained.',
        retryable: true,
        details: { providerDiagnostic: 'do not retain this' },
      }),
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
            observations: [fullText.observation, nonAdmission.observation],
            checkpointAfterBatch: { cursor: 'duplicate-batch' },
          };
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: gapConnection.revision,
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
          observations: [original.observation],
          checkpointAfterBatch: { cursor: 'fresh' },
        },
        {
          kind: 'batch',
          observations: [original.observation],
          checkpointAfterBatch: { cursor: 'expired-equal' },
        },
        {
          kind: 'batch',
          observations: [contradictory.observation],
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

  it('durably blocks a provider poll result from a mismatched execution origin', async () => {
    const current = channelConnection();
    const harness = createIngressHarness({
      pollExecutionOrigin: {
        ...current.payload.transportOrigin,
        materializationRef: {
          ...current.payload.transportOrigin.materializationRef,
          materializationId: 'other-telegram-install',
        },
      },
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
        code: 'channels_checkpointed_poll_execution_origin_mismatch',
        message: 'The provider poll settled from an origin that is no longer current for the Channel connection.',
      },
    });
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
        observations: [input.observation],
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
    const replacementOrigin = {
      ...incumbent.payload.transportOrigin,
      materializationRef: {
        ...incumbent.payload.transportOrigin.materializationRef,
        materializationId: 'telegram-install-replacement',
      },
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
          transportOrigin: replacementOrigin,
          authorityEpoch: settledConnection.lifecycle.authorityEpoch,
        },
        predecessorCheckpointedPollInvocation: {
          connectionRevision: settledRow.revision,
          authorityEpoch: settledConnection.lifecycle.authorityEpoch,
          transportOrigin: settledConnection.transportOrigin,
        },
        authorityEpoch: settledConnection.lifecycle.authorityEpoch + 1,
        reason: 'transfer',
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
    const replacementOrigin = {
      ...incumbent.payload.transportOrigin,
      materializationRef: {
        ...incumbent.payload.transportOrigin.materializationRef,
        materializationId: 'telegram-install-replacement',
      },
    };
    let pollExecutionOrigin: ReturnType<typeof channelConnection>['payload']['transportOrigin']
      = incumbent.payload.transportOrigin;
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
    const replacementOrigin = {
      ...incumbent.payload.transportOrigin,
      materializationRef: {
        ...incumbent.payload.transportOrigin.materializationRef,
        materializationId: 'telegram-install-replacement',
      },
    };
    const harness = createIngressHarness({
      pollExecutionOrigin: replacementOrigin,
      pollResult: { kind: 'notReady', reason: 'providerConflict' },
    });
    replaceConnectionDuringCapturedPoll({
      rows: harness.rows,
      incumbentOverlapSafety: 'providerExclusive',
    });

    await expect(runConversationCheckpointedPollForInvocation({
      connectionId: 'connection-1',
      waitMs: 0,
    }, harness.context)).resolves.toEqual({ kind: 'blocked' });

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
            phase: 'blocked',
            evidence: { kind: 'provider', reason: 'providerConflict' },
          },
        },
      },
    });
  });

  it('does not infer provider-exclusive transfer settlement from a replacement history-gap result', async () => {
    const incumbent = channelConnection();
    const replacementOrigin = {
      ...incumbent.payload.transportOrigin,
      materializationRef: {
        ...incumbent.payload.transportOrigin.materializationRef,
        materializationId: 'telegram-install-replacement',
      },
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
    const replacementOrigin = {
      ...incumbent.payload.transportOrigin,
      materializationRef: {
        ...incumbent.payload.transportOrigin.materializationRef,
        materializationId: 'telegram-install-replacement',
      },
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
    const replacementOrigin = {
      ...incumbent.payload.transportOrigin,
      materializationRef: {
        ...incumbent.payload.transportOrigin.materializationRef,
        materializationId: 'telegram-install-replacement',
      },
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
            materializationRef: {
              ...capturedInvocation.transportOrigin.materializationRef,
              materializationId: 'telegram-install-not-the-incumbent',
            },
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
            observations: [pairingObservation.observation],
            checkpointAfterBatch: { cursor: 'after-pair' },
          };
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: gapConnection.revision,
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
      expectedConnectionRevision: currentConnection.revision,
      materialization: channelConnection().payload.transportOrigin.materializationRef,
      destinationLabel: 'Telegram bot',
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
            observations: [pairingObservation.observation],
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
      expectedConnectionRevision: connection.revision,
      materialization: channelConnection().payload.transportOrigin.materializationRef,
      destinationLabel: 'Telegram bot',
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
              observations: [pairingObservation.observation],
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
        expectedConnectionRevision: currentConnection.revision,
        materialization: channelConnection().payload.transportOrigin.materializationRef,
        destinationLabel: 'Telegram bot',
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
            observations: [firstEndpoint.observation, secondEndpoint.observation],
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
      expectedRevision: gapConnection.revision,
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
            observations: [firstObservation.observation, secondObservation.observation],
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
      expectedRevision: gapConnection.revision,
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
              observations: [blockedObservation.observation, healthyObservation.observation],
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
        expectedRevision: gapConnection.revision,
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
            observations: [firstObservation.observation, secondObservation.observation],
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
      expectedRevision: gapConnection.revision,
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
            }).observation],
            checkpointAfterBatch: { cursor: 'after-stale-terminal-settlement' },
          };
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: gapConnection.revision,
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
            observations: [admitted.observation],
            checkpointAfterBatch: { cursor: 'after-admission' },
          };
        }
        return {
          kind: 'batch',
          observations: [laterUnsupportedEdit.observation],
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
      expectedRevision: gapConnection.revision,
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
      expectedRevision: current.revision,
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
      expectedRevision: gapConnection.revision,
    }, harness.context)).rejects.toMatchObject({ code: 'channels_stream_baseline_conflict' });

    expect(record(record(harness.rows.get('connection-1')?.value).payload).pendingOldTransportStop).toBeNull();
  });

  it('settles persisted provider-exclusive transfer custody from a successful replacement baseline poll', async () => {
    const incumbent = channelConnection();
    const replacementOrigin = {
      ...incumbent.payload.transportOrigin,
      materializationRef: {
        ...incumbent.payload.transportOrigin.materializationRef,
        materializationId: 'telegram-install-replacement',
      },
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
      expectedRevision: replacement.revision,
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

  it('accepts a checkpoint-only baseline without fabricating an occurrence', async () => {
    const pollResult = {
      kind: 'checkpointOnly',
      checkpointAfterBatch: { cursor: 'checkpoint-only' },
      retryHint: { retryAfterMs: 2_000 },
    } as const;
    const harness = createIngressHarness({ pollResult });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: gapConnection.revision,
    }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)?.value.payload).toMatchObject({
      opaqueToken: pollResult.checkpointAfterBatch,
      lastOccurrenceId: null,
      revision: 1,
      nextPollNotBeforeMs: expect.any(Number),
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
        observations: [fullText.observation, nonAdmission.observation],
        checkpointAfterBatch: { cursor: 'duplicate-baseline' },
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: gapConnection.revision,
    }, harness.context)).rejects.toMatchObject({ code: 'channels_stream_baseline_result_invalid' });

    expect(harness.send).not.toHaveBeenCalled();
    expect(currentCheckpoint(harness.rows)).toBeUndefined();
    expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).not.toBeNull();
  });

  it('rejects an ordinary batch for a null-checkpoint baseline without admitting historical messages or changing the gap', async () => {
    const harness = createIngressHarness({
      pollResult: {
        kind: 'batch',
        observations: [observation({ messageRevision: 'edit:1' }).observation],
        checkpointAfterBatch: { cursor: 'historical-batch' },
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: gapConnection.revision,
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
      expectedRevision: firstGap.revision,
    }, harness.context);
    const secondGap = setConnectionHistoryGap(harness.rows);

    await acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: secondGap.revision,
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
      expectedRevision: firstGap.revision,
    }, harness.context);
    const retainedCheckpoint = currentCheckpoint(harness.rows);
    if (retainedCheckpoint === undefined) throw new Error('Expected the retained checkpoint.');
    const secondGap = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: secondGap.revision,
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
        expectedRevision: currentConnection.revision,
      }, harness.context)).resolves.toMatchObject({ kind: 'updated' });

      expect(harness.executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
      expect(currentCheckpoint(harness.rows)).toBeUndefined();
      expect(record(record(harness.rows.get('connection-1')?.value).payload).historyGap).toBeNull();
    },
  );

  it('rejects a provider result from a different execution origin without clearing the gap', async () => {
    const expectedOrigin = channelConnection().payload.transportOrigin;
    const harness = createIngressHarness({
      pollExecutionOrigin: {
        ...expectedOrigin,
        materializationRef: {
          ...expectedOrigin.materializationRef,
          materializationId: 'telegram-install-replaced',
        },
      },
    });
    const gapConnection = setConnectionHistoryGap(harness.rows);

    await expect(acceptConversationStreamBaselineForInvocation({
      connectionId: 'connection-1',
      expectedRevision: gapConnection.revision,
    }, harness.context)).rejects.toMatchObject({
      code: 'channels_stream_baseline_stale_authority',
      retryable: true,
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
      expectedRevision: gapConnection.revision,
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
      expectedRevision: gapConnection.revision,
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
