import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ConversationProvidersContributionProtocolV1 } from '@happier-dev/channels-protocol/v1';
import { ConversationDeliveryContentV1Schema, ConversationDeliveryInputV1Schema } from '@happier-dev/channels-protocol/v1';
import type { ConversationDeliveryInputV1, ConversationDeliveryResultV1 } from '@happier-dev/channels-protocol/v1';
import type {
  PluginInvocationContext,
  PluginServices,
  TargetedContributionSnapshot,
  TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { TargetedContributionPointRef } from '@happier-dev/plugin-sdk/contributions';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { getPluginMachineExecutionRouting, type PluginMachineExecutionRoutingV1 } from '@happier-dev/plugin-sdk/actions';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_DELIVERIES_INDEX_ID,
  CHANNEL_STATE_COLLECTION,
} from './collections.js';
import {
  createConversationOutwardDeliveryCollectionStore,
  settleConversationOutwardDeliveriesForBindingDeletion,
  settleConversationOutwardDeliveriesForConnectionDeletion,
  type ConversationOutwardDeliveryObligation,
} from './outwardDelivery.js';
import {
  createConversationOutwardDeliverySupervisor,
  runConversationOutwardDeliveryCycle,
} from './outwardDeliverySupervisor.js';
import { deleteConversationBindingForInvocation, finalizeConversationConnectionDeletesForInvocation } from './management.js';
import { startConversationForInvocation } from './conversationStart.js';
import { isChannelStateJsonRecord } from './accountLocalBindingPolicy.js';
import { resolveConversationDeliveryForInvocation } from './management.js';
import {
  importHmacSha256Key,
  signLengthPrefixedUtf8HmacSha256Base64Url,
  tryDecodeBase64Url,
} from './privateRowIdentity.js';
import {
  createConversationSessionProjectionFrontierRow,
  createConversationSessionProjectionFrontierRowId,
} from './sessionProjection.js';
import { deriveConversationSessionRotationRowId } from './ingress.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';
import { createChannelsJourneyFixture } from './testkit/channelsJourney.js';

const endpoint = {
  kind: 'direct' as const,
  audience: 'direct' as const,
  id: 'chat-1',
};

const providerTransportOrigin = {
  serverIdentityId: 'srv_account_one',
  materializationRef: {
    pluginId: 'example.channel.provider',
    machineId: 'machine-1',
    materializationId: 'provider-1',
  },
} as const;

function admittedProviderOperation(role: string) {
  return Object.freeze({
    identity: Object.freeze({
      target: Object.freeze({ pluginId: 'happier.channels' }),
      point: Object.freeze({
        pointId: 'providers',
        protocol: Object.freeze({ id: 'happier.channels/providers', version: 1 }),
      }),
      contributor: Object.freeze({
        pluginId: providerTransportOrigin.materializationRef.pluginId,
        contributionId: 'delivery-test-provider',
        immutableGenerationId: 'delivery-test-generation',
      }),
      role,
    }),
  });
}

const providerDeliveryAction = admittedProviderOperation('messageDeliver');
const providerDeliveryReconcileAction = admittedProviderOperation('deliveryReconcile');

/** The generic host has already admitted this provider contribution. */
function targetedProviderDeliveryContributions(): TargetedContributionsService {
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
            contributions: [{
              contributor: {
                pluginId: providerTransportOrigin.materializationRef.pluginId,
                contributionId: 'delivery-test-provider',
                occurrenceId: 'delivery-test-occurrence',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'delivery-test-generation', installSource: 'npm' },
              },
              protocol: { id: 'happier.channels/providers', version: 1 },
              operations: {
                messageDeliver: providerDeliveryAction,
                deliveryReconcile: providerDeliveryReconcileAction,
              },
            }] as unknown as readonly TContribution[],
          };
        },
      });
    },
  });
}

const sessionTarget = {
  kind: 'session' as const,
  sessionId: 'session-1',
  policy: {
    deliveryMode: 'mirrorSession' as const,
    permissionCeiling: 'read-only' as const,
    approvals: { kind: 'off' as const },
    newSession: { kind: 'off' as const },
  },
};

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

function emptyPendingPermissionPage() {
  return { requests: [], truncated: false, nextCursor: null } as const;
}

import { MemoryCollection, type StoredRow } from './testkit/memoryCollection.js';
function deliveryConnectionAuthority(input: Readonly<{
  providerConnectionKey: string;
  providerConfig: Readonly<{ account: string }>;
  routingIdentityKey: string;
  integrationPrincipal: Readonly<{ id: string }>;
  authorityEpoch: number;
}>): ConversationConnectionFixtureAuthority {
  return {
    providerPluginId: providerTransportOrigin.materializationRef.pluginId,
    providerContributionSelection: {
      contributionId: 'delivery-test-provider',
    },
    providerSetupInput: { source: 'test' },
    credentialRef: null,
    transportOrigin: providerTransportOrigin,
    providerConnectionKey: input.providerConnectionKey,
    providerConfig: input.providerConfig,
    routingIdentityKey: input.routingIdentityKey,
    integrationPrincipal: input.integrationPrincipal,
    authorityEpoch: input.authorityEpoch,
  };
}

function connectionRow() {
  return createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: deliveryConnectionAuthority({
      providerConnectionKey: 'provider-connection-1',
      providerConfig: { account: 'account-1' },
      routingIdentityKey: 'a'.repeat(43),
      integrationPrincipal: { id: 'provider:principal-1' },
      authorityEpoch: 4,
    }),
    transport: { kind: 'checkpointedPull' },
    overlapSafety: 'safe',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
  });
}

function bindingRow() {
  return {
    id: 'binding-1',
    'record-kind': 'binding',
    v: 1,
    'connection-id': 'connection-1',
    'binding-id': 'binding-1',
    'created-at': 0,
    'updated-at': 0,
    payload: {
      authorityEpoch: 7,
      enabled: true,
      deletionState: 'none',
      endpoint,
      target: sessionTarget,
      allowedPrincipalIds: ['principal-1'],
      allowBotSenders: false,
      inputMode: 'allAllowedMessages',
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress',
      senderFeedback: 'off',
    },
  };
}

function approvalBindingRow() {
  const binding = bindingRow();
  return {
    ...binding,
    payload: {
      ...binding.payload,
      target: {
        ...sessionTarget,
        policy: {
          ...sessionTarget.policy,
          approvals: {
            kind: 'enabled' as const,
            maximumScope: 'session' as const,
            principalIds: ['principal-1'],
          },
        },
      },
    },
  };
}

const FINALIZING_CONNECTION_ID = 'connection-finalizing';
const FINALIZING_BINDING_ID = 'binding-finalizing';
const FINALIZING_ROUTING_IDENTITY_KEY = 'a'.repeat(43);
const FINALIZING_CONNECTION_IDENTITY_KEY = 'b'.repeat(43);
const BINDING_DELETE_CONNECTION_ID = 'connection-binding-delete';
const BINDING_DELETE_BINDING_ID = 'binding-binding-delete';

function finalizingConnectionRow() {
  return createCurrentConversationConnectionFixture({
    connectionId: FINALIZING_CONNECTION_ID,
    authority: deliveryConnectionAuthority({
      providerConnectionKey: 'provider-connection-finalizing',
      providerConfig: { account: 'account-finalizing' },
      routingIdentityKey: FINALIZING_ROUTING_IDENTITY_KEY,
      integrationPrincipal: { id: 'provider:principal-finalizing' },
      authorityEpoch: 5,
    }),
    createdAt: 0,
    updatedAt: 0,
    transport: { kind: 'checkpointedPull' },
    overlapSafety: 'safe',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
    enabled: false,
    deletionState: 'finalizingDelete',
  });
}

function finalizingBindingRow(bindingId = FINALIZING_BINDING_ID) {
  return {
    id: bindingId,
    'record-kind': 'binding',
    v: 1,
    'connection-id': FINALIZING_CONNECTION_ID,
    'binding-id': bindingId,
    'created-at': 0,
    'updated-at': 0,
    payload: {
      authorityEpoch: 7,
      enabled: true,
      deletionState: 'none',
      endpoint,
      target: sessionTarget,
      allowedPrincipalIds: ['principal-1'],
      allowBotSenders: false,
      inputMode: 'allAllowedMessages',
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress',
      senderFeedback: 'off',
    },
  };
}

function bindingDeleteConnectionRow() {
  return createCurrentConversationConnectionFixture({
    connectionId: BINDING_DELETE_CONNECTION_ID,
    authority: deliveryConnectionAuthority({
      providerConnectionKey: 'provider-connection-binding-delete',
      providerConfig: { account: 'account-binding-delete' },
      routingIdentityKey: 'c'.repeat(43),
      integrationPrincipal: { id: 'provider:principal-binding-delete' },
      authorityEpoch: 4,
    }),
    createdAt: 0,
    updatedAt: 0,
    transport: { kind: 'checkpointedPull' },
    overlapSafety: 'safe',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
  });
}

function finalizingBindingDeleteRow() {
  const binding = finalizingBindingRow(BINDING_DELETE_BINDING_ID);
  return {
    ...binding,
    'connection-id': BINDING_DELETE_CONNECTION_ID,
    payload: {
      ...binding.payload,
      enabled: false,
      deletionState: 'finalizingDelete',
    },
  };
}

function bindingDeleteIngressObligationRow() {
  return {
    id: 'binding-delete-ingress-obligation',
    'record-kind': 'ingress-obligation',
    v: 1,
    'connection-id': BINDING_DELETE_CONNECTION_ID,
    'binding-id': BINDING_DELETE_BINDING_ID,
    terminal: false,
    attention: false,
    'due-at': 0,
    'created-at': 0,
    'updated-at': 0,
    payload: {
      occurrenceIds: ['poll:binding-delete-ingress'],
      censusId: 'd'.repeat(43),
      target: null,
      sourceAuthority: {
        connectionAuthorityEpoch: 4,
        bindingRevision: 1,
        bindingAuthorityEpoch: 7,
      },
      lifecycle: { phase: 'ready', attemptCount: 0, dueAt: 0 },
      disposition: null,
      nonAdmission: null,
    },
  };
}

function bindingDeleteOutwardObligation(bindingId: string, deliveryKey: string): ConversationOutwardDeliveryObligation {
  return {
    connectionId: BINDING_DELETE_CONNECTION_ID,
    bindingId,
    routeAuthority: {
      connectionAuthorityEpoch: 4,
      bindingRevision: 1,
      bindingAuthorityEpoch: 7,
    },
    source: {
      kind: 'sessionProjection',
      sessionId: 'session-1',
      semanticItemId: deliveryKey,
    },
    endpoint,
    content: { text: 'unattempted direct-delete body' },
    deliveryKey,
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
}

const FINALIZING_INGRESS_CENSUS_ID = 'a'.repeat(43);
// 17 relation pairs plus connection/reservation/census forces a second 32-row page.
const FINALIZING_INGRESS_RELATION_COUNT = 17;

function finalizingIngressCensusRow(bindingIds: readonly string[]) {
  return {
    id: FINALIZING_INGRESS_CENSUS_ID,
    'record-kind': 'ingress-census',
    v: 1,
    'connection-id': FINALIZING_CONNECTION_ID,
    'created-at': 0,
    'updated-at': 0,
    payload: {
      normalizedIngress: {
        kind: 'fullText',
        observation: {
          v: 1,
          occurrenceId: 'poll:finalizing-census',
          occurredAt: 0,
          transport: { kind: 'poll' },
          endpoint,
          actor: {
            principalId: 'principal-finalizing',
            kind: 'human',
            isIntegrationSelf: false,
          },
          message: {
            id: 'message-finalizing-census',
            revision: '1',
            text: 'Retained ingress evidence.',
            addressingEvidence: 'none',
            contentProvenance: 'original',
            providerTimestamp: 0,
          },
        },
      },
      phase: 'prepared',
      connectionAuthorityEpoch: 5,
      maximumObservationAgeMs: 60_000,
      matchedBindings: bindingIds.map((bindingId) => ({
        bindingId,
        bindingRevision: 1,
        bindingAuthorityEpoch: 7,
      })),
    },
  };
}

function finalizingIngressObligationRow(input: Readonly<{
  bindingId: string;
  ordinal: number;
  phase: 'blocked' | 'attempting' | 'terminal';
}>) {
  const terminal = input.phase === 'terminal';
  const dueAt = input.phase === 'attempting' ? 10 : null;
  return {
    id: `z${String(input.ordinal).padStart(42, '0')}`,
    'record-kind': 'ingress-obligation',
    v: 1,
    'connection-id': FINALIZING_CONNECTION_ID,
    'binding-id': input.bindingId,
    terminal,
    attention: input.phase === 'blocked',
    ...(dueAt === null ? {} : { 'due-at': dueAt }),
    'created-at': 0,
    'updated-at': 0,
    payload: {
      occurrenceIds: [`poll:finalizing:${input.ordinal}`],
      censusId: FINALIZING_INGRESS_CENSUS_ID,
      target: null,
      sourceAuthority: {
        connectionAuthorityEpoch: 5,
        bindingRevision: 1,
        bindingAuthorityEpoch: 7,
      },
      lifecycle: { phase: input.phase, attemptCount: 1, dueAt },
      disposition: terminal ? 'connectionDeleted' : null,
      nonAdmission: null,
    },
  };
}

async function finalizingReservationRow() {
  const subtle = globalThis.crypto?.subtle;
  const bytes = tryDecodeBase64Url(FINALIZING_CONNECTION_IDENTITY_KEY);
  if (subtle === undefined || bytes === null) throw new Error('Expected test HMAC support.');
  const key = await importHmacSha256Key(subtle, bytes);
  const id = await signLengthPrefixedUtf8HmacSha256Base64Url({
    subtle,
    key,
    parts: [
      'channels:connection-reservation:v1',
      'example.channel.provider',
      'provider-connection-finalizing',
    ],
  });
  return {
    id,
    'record-kind': 'connection-reservation',
    v: 1,
    'connection-id': FINALIZING_CONNECTION_ID,
    'created-at': 0,
    'updated-at': 0,
    payload: {
      providerPluginId: 'example.channel.provider',
      providerConnectionKey: 'provider-connection-finalizing',
      integrationPrincipalId: 'provider:principal-finalizing',
    },
  };
}

function finalizingOutwardObligation(): ConversationOutwardDeliveryObligation {
  return {
    connectionId: FINALIZING_CONNECTION_ID,
    bindingId: FINALIZING_BINDING_ID,
    routeAuthority: {
      connectionAuthorityEpoch: 5,
      bindingRevision: 1,
      bindingAuthorityEpoch: 7,
    },
    source: {
      kind: 'sessionProjection',
      sessionId: 'session-1',
      semanticItemId: 'semantic-finalizing',
    },
    endpoint,
    content: { text: 'unattempted retained body' },
    deliveryKey: 'channels:delivery:v1:finalizing-custody',
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
}

function backgroundContext(input: Readonly<{
  state: MemoryCollection;
  deliveries: MemoryCollection;
  execute: ReturnType<typeof vi.fn>;
  executeAdmittedTargetedOperationWithExecutionOrigin: ReturnType<typeof vi.fn>;
  logger?: Pick<PluginInvocationContext['services']['logger'], 'warn'> & Partial<Pick<PluginInvocationContext['services']['logger'], 'info'>>;
  collection?: (definition: Readonly<{ id: string }>) => MemoryCollection | undefined;
  targetedContributions?: TargetedContributionsService;
  watchSession?: (listener: () => void) => { dispose(): void };
  executionRouting?: PluginMachineExecutionRoutingV1 | null;
}>): BackgroundServiceContext {
  const collections = new Map<string, MemoryCollection>([
    [CHANNEL_STATE_COLLECTION.id, input.state],
    [CHANNEL_DELIVERIES_COLLECTION.id, input.deliveries],
  ]);
  return {
    plugin: { id: 'happier.channels', version: '0.0.0' },
    contribution: {
      id: 'outward-delivery-supervisor',
      qualifiedId: 'happier.channels/backgroundServices/outward-delivery-supervisor',
    },
    surface: 'background',
    invokedAtMs: 1_700_000_000_000,
    signal: new AbortController().signal,
    services: {
      sessions: { get: async () => ({ watch: input.watchSession ?? (() => ({ dispose() {} })) }) },
      storage: {
        account: {
          collection: input.collection ?? ((definition: Readonly<{ id: string }>) => collections.get(definition.id)),
        },
      },
      actions: {
        getCurrentExecutionRouting: async () => input.executionRouting === undefined
          ? { ...getPluginMachineExecutionRouting(providerTransportOrigin), pluginId: 'happier.channels' }
          : input.executionRouting,
        execute: input.execute,
        executeAdmittedTargetedOperationWithExecutionOrigin: input.executeAdmittedTargetedOperationWithExecutionOrigin,
      },
      targetedContributions: input.targetedContributions ?? targetedProviderDeliveryContributions(),
      logger: { info: vi.fn(), ...input.logger, warn: input.logger?.warn ?? vi.fn() },
    } as unknown as PluginInvocationContext['services'],
  };
}

async function seedProjectionState(state: MemoryCollection): Promise<void> {
  await state.put(connectionRow(), { expectedRevision: 'absent' });
  await state.put(bindingRow(), { expectedRevision: 'absent' });
  await state.put(createConversationSessionProjectionFrontierRow({
    bindingId: 'binding-1',
    targetSessionId: 'session-1',
    transcriptCursor: null,
    lastScannedSeq: 0,
    revision: 1,
    now: 0,
  }), { expectedRevision: 'absent' });
}

async function seedFinalizingIngressRelations(input: Readonly<{
  state: MemoryCollection;
  finalObligationPhase: 'blocked' | 'attempting' | 'terminal';
}>): Promise<Readonly<{
  bindingIds: readonly string[];
  finalObligationId: string;
  reservationId: string;
}>> {
  const bindingIds = Array.from(
    { length: FINALIZING_INGRESS_RELATION_COUNT },
    (_unused, ordinal) => `binding-finalizing-${String(ordinal).padStart(2, '0')}`,
  );
  const reservation = await finalizingReservationRow();
  await input.state.put({
    id: 'connection-identity-key',
    'record-kind': 'connection-identity-key',
    v: 1,
    'created-at': 0,
    'updated-at': 0,
    payload: { connectionIdentityKey: FINALIZING_CONNECTION_IDENTITY_KEY },
  }, { expectedRevision: 'absent' });
  await input.state.put(finalizingConnectionRow(), { expectedRevision: 'absent' });
  await input.state.put(reservation, { expectedRevision: 'absent' });
  await input.state.put(finalizingIngressCensusRow(bindingIds), { expectedRevision: 'absent' });
  let finalObligationId = '';
  for (const [ordinal, bindingId] of bindingIds.entries()) {
    await input.state.put(finalizingBindingRow(bindingId), { expectedRevision: 'absent' });
    const obligation = finalizingIngressObligationRow({
      bindingId,
      ordinal,
      phase: ordinal === bindingIds.length - 1 ? input.finalObligationPhase : 'terminal',
    });
    if (ordinal === bindingIds.length - 1) finalObligationId = obligation.id;
    await input.state.put(obligation, {
      expectedRevision: 'absent',
    });
  }
  return { bindingIds, finalObligationId, reservationId: reservation.id };
}

function outwardObligation(): Extract<ConversationOutwardDeliveryObligation, Readonly<{ bindingId: string }>> {
  return {
    connectionId: 'connection-1',
    bindingId: 'binding-1',
    routeAuthority: {
      connectionAuthorityEpoch: 4,
      bindingRevision: 1,
      bindingAuthorityEpoch: 7,
    },
    source: {
      kind: 'sessionProjection',
      sessionId: 'session-1',
      semanticItemId: 'semantic-stale',
    },
    endpoint,
    content: { text: 'retained body' },
    deliveryKey: 'channels:delivery:v1:stale-custody',
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
}

function heldAutomationOutwardObligation(): ConversationOutwardDeliveryObligation {
  return {
    ...outwardObligation(),
    source: {
      kind: 'automationResult',
      automationRunId: 'run-1',
      resultId: 'handoff-1',
      automationId: 'automation-1',
      resultDelivery: 'finalResult',
    },
  };
}

function retireableControlOutwardObligation(controlId: string): ConversationOutwardDeliveryObligation {
  return {
    ...outwardObligation(),
    source: { kind: 'controlResponse', controlId, controlKind: 'recovery' },
    deliveryKey: `channels:control-response:v1:${controlId}`,
  };
}

function permissionWaitOutwardObligation(): ConversationOutwardDeliveryObligation {
  return {
    ...outwardObligation(),
    source: {
      kind: 'permissionWait',
      sessionId: 'session-1',
      turnId: 'turn-1',
      requestId: 'permission-request-1',
    },
    content: { text: 'This Session is waiting for an approval in Happier. '
      + 'Reply /allow permission-request-1 or /deny permission-request-1.' },
    deliveryKey: 'channels:permission-wait:v1:turn-1:permission-request-1',
  };
}

describe('Channels outward-delivery supervisor', () => {
  it.each(['relink', 'presentation edit'] as const)('admits a captured Session page only from its original frontier after %s during the transcript read', async change => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    let changed = false;
    const execute = vi.fn(async (action: string, input: unknown) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (!changed) {
        changed = true;
        if (change === 'relink') {
          await deleteConversationBindingForInvocation({ bindingId: 'binding-1', expectedRevision: 1 }, context as never);
          await finalizeConversationConnectionDeletesForInvocation(context);
          const binding = state.rows.get('binding-1');
          const frontierId = createConversationSessionProjectionFrontierRowId('binding-1');
          const frontier = state.rows.get(frontierId);
          if (binding?.deleted !== true || frontier?.deleted !== true) throw new Error('Expected finalized binding artifacts.');
          // Data retains both tombstone revisions when the same binding is reattached.
          await state.batch([
            { kind: 'put', expectedRevision: binding.revision, value: {
              ...bindingRow(), payload: { ...bindingRow().payload, authorityEpoch: 1 },
            } },
            { kind: 'put', expectedRevision: frontier.revision, value: createConversationSessionProjectionFrontierRow({
              bindingId: 'binding-1', targetSessionId: 'session-1', transcriptCursor: '1', lastScannedSeq: 1, revision: 1, now: 100,
            }) },
          ]);
        } else {
          await state.put({ ...bindingRow(), payload: { ...bindingRow().payload, linkPreviewPolicy: 'providerDefault' } }, { expectedRevision: 1 });
        }
      }
      const caughtUp = isChannelStateJsonRecord(input) && input.cursor === '1';
      return { ok: true, projection: 'externalShareableV1', sessionId: 'session-1', scannedThroughSeq: 1, nextCursor: '1', hasMore: false,
        items: caughtUp ? [] : [{ kind: 'assistantText', sessionId: 'session-1', seq: 1, itemId: 'captured-before-change', turnId: 'turn-1',
          final: 'completed', text: 'Captured before binding change', consumedInputs: [] }] };
    });
    const deliver = vi.fn(async () => ({ result: { kind: 'delivered', providerMessageIds: ['captured-page'] }, executionOrigin: providerTransportOrigin }));
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin: deliver });
    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    expect(deliver).toHaveBeenCalledTimes(change === 'relink' ? 0 : 1);
    expect(deliveries.rows.size).toBe(change === 'relink' ? 0 : 1);
    // A harmless edit may lose the progress CAS; its next wake rejoins custody
    // and advances the preserved frontier without another provider delivery.
    await runConversationOutwardDeliveryCycle({ context, now: () => 101 });
    expect(deliver).toHaveBeenCalledTimes(change === 'relink' ? 0 : 1);
    expect(state.rows.get(createConversationSessionProjectionFrontierRowId('binding-1'))?.value.payload).toMatchObject({ lastScannedSeq: 1 });
  });

  it('leaves a final unclaimed when the connection moves during the transcript read', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      const connection = connectionRow();
      await state.put({ ...connection, payload: { ...connection.payload, authorityEpoch: 5,
        transportOrigin: { serverIdentityId: providerTransportOrigin.serverIdentityId, machineId: 'replacement-machine' },
      } }, { expectedRevision: 1 });
      return { ok: true, projection: 'externalShareableV1', sessionId: 'session-1', scannedThroughSeq: 1, nextCursor: '1', hasMore: false,
        items: [{ kind: 'assistantText', sessionId: 'session-1', seq: 1, itemId: 'moving-final', turnId: 'moving-turn',
          final: 'completed', text: 'Final after transfer', consumedInputs: [] }] };
    });
    const deliver = vi.fn(async () => ({ result: { kind: 'delivered', providerMessageIds: ['wrong-runtime'] }, executionOrigin: providerTransportOrigin }));
    await runConversationOutwardDeliveryCycle({ context: backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: deliver }), now: () => 100 });
    expect(deliveries.rows.size).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(state.rows.get(createConversationSessionProjectionFrontierRowId('binding-1'))?.value.payload).toMatchObject({ lastScannedSeq: 0 });
  });
  it('refuses foreign manual resolution and terminal retention without mutating custody', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state as never,
      deliveriesCollection: deliveries as never, signal: new AbortController().signal, now: () => 1 });
    const created = await store.ensure(outwardObligation());
    if (created.kind !== 'created') throw new Error('Expected custody');
    const unknown = await store.compareAndSwap({ custodyId: created.record.custodyId, expectedRevision: created.record.revision,
      custody: { state: 'outcomeUnknown', attemptCount: 1, providerMessageIds: [] } });
    if (unknown.kind !== 'updated') throw new Error('Expected ambiguous custody');
    const foreign = backgroundContext({ state, deliveries, execute: vi.fn(), executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      executionRouting: { ...getPluginMachineExecutionRouting(providerTransportOrigin), pluginId: 'happier.channels', machineId: 'foreign-machine' } });
    const request = { custodyId: unknown.record.custodyId, expectedRevision: unknown.record.revision, resolution: 'discarded' };
    const before = structuredClone([...deliveries.rows]);
    await expect(resolveConversationDeliveryForInvocation(request, foreign)).rejects.toMatchObject({ code: 'channels_delivery_resolve_unavailable' });
    expect([...deliveries.rows]).toEqual(before);
    const placed = backgroundContext({ state, deliveries, execute: vi.fn(), executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn() });
    await expect(resolveConversationDeliveryForInvocation(request, placed)).resolves.toMatchObject({ kind: 'resolved' });
    const settled = structuredClone([...deliveries.rows]);
    const expiry = Date.now() + 30 * 24 * 60 * 60 * 1_000;
    await runConversationOutwardDeliveryCycle({ context: foreign, now: () => expiry });
    expect([...deliveries.rows]).toEqual(settled);
    await runConversationOutwardDeliveryCycle({ context: placed, now: () => expiry });
    expect(await deliveries.get(created.record.custodyId)).toBeNull();
  });
  it('routes an external plugin final through the public host stamp and real Channels journey exactly once', async () => {
    const pluginId = 'acme.installed.conversation';
    const origin = { serverIdentityId: 'srv_plugin_testkit', materializationRef: {
      pluginId, machineId: 'external-machine', materializationId: 'installed-external-provider',
    } } as const;
    const operations = ConversationProvidersContributionProtocolV1.operations;
    const send = vi.fn(async () => ({ status: 200, finalUrl: 'https://external.example/send', headers: {}, body: new Uint8Array() }));
    const plugin = definePlugin({ id: pluginId, version: '1.0.0', actions: {
      setup: { title: 'Setup', surfaces: ['plugin'], dangerLevel: 'safe', run() { throw new Error('Existing connection needs no setup'); } },
      test: { title: 'Test', surfaces: ['plugin'], dangerLevel: 'safe', run() { throw new Error('Existing connection needs no retest'); } },
      send: { title: 'Send', surfaces: ['plugin'], dangerLevel: 'writesRemote',
        inputSchema: operations.messageDeliver.declaration.input.schema.jsonSchema,
        resultSchema: operations.messageDeliver.declaration.resultSchema.jsonSchema,
        async run(_input, context) {
          await context.services.http.request({ method: 'POST', url: 'https://external.example/send', redirect: 'error' });
          return { kind: 'delivered', providerMessageIds: ['external-receipt'] };
        } },
    }, contributesTo: { 'happier.channels': { providers: { external: ConversationProvidersContributionProtocolV1.contribute({ descriptor: { v: 1, displayName: 'External test' }, operations: {
      setup: operations.setup.bind('setup'), connectionTest: operations.connectionTest.bind('test'), messageDeliver: operations.messageDeliver.bind('send'),
    } }) } } } });
    const provider = await createPluginTestkit({ manifest: plugin.manifest, module: plugin,
      resolveCurrentPluginMaterializationRef: () => origin.materializationRef,
      services: { http: { request: send, async openWebSocket() { throw new Error('No socket'); } } } });
    const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-1', authority: {
      ...deliveryConnectionAuthority({ providerConnectionKey: 'external-connection', providerConfig: { account: 'external' },
        routingIdentityKey: 'a'.repeat(43), integrationPrincipal: { id: 'external-principal' }, authorityEpoch: 4 }),
      providerPluginId: pluginId, providerContributionSelection: { contributionId: 'external' }, transportOrigin: origin,
    } });
    const actions = { execute: async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage() : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        scannedThroughSeq: 1, nextCursor: '1', hasMore: false, items: [{ kind: 'assistantText', sessionId: 'session-1', seq: 1,
          itemId: 'external-final', turnId: 'external-turn', final: 'completed', text: 'Final answer', consumedInputs: [] }] },
    } as unknown as PluginServices['actions'];
    const sessions = { get: async () => ({ watch: () => ({ dispose() {} }) }) } as unknown as PluginServices['sessions'];
    const common = { provider, connection, binding: bindingRow(), actions, sessions, resolveCurrentProviderExecutionOrigin: () => origin };
    const placed = await createChannelsJourneyFixture(common);
    const foreign = await createChannelsJourneyFixture({ ...common, state: placed.state, deliveries: placed.deliveries,
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: 'happier.channels', machineId: 'foreign-machine', materializationId: 'foreign-core' }) });
    try {
      await placed.state.put(createConversationSessionProjectionFrontierRow({ bindingId: 'binding-1', targetSessionId: 'session-1',
        transcriptCursor: null, lastScannedSeq: 0, revision: 1, now: 0 }), { expectedRevision: 'absent' });
      const before = structuredClone([...placed.state.rows]);
      await foreign.outward();
      expect([...placed.state.rows]).toEqual(before);
      expect(placed.deliveries.rows.size).toBe(0);
      expect(send).not.toHaveBeenCalled();
      await placed.outward();
      await foreign.outward();
      await placed.outward();
      expect(send).toHaveBeenCalledOnce();
      expect([...placed.deliveries.rows.values()]).toMatchObject([{ value: { payload: { state: 'delivered', attemptCount: 1 } } }]);
    } finally { await foreign.dispose(); await placed.dispose(); await provider.dispose(); }
  });
  it.each(['machine', 'home', 'unavailable', 'unsupported'] as const)('leaves foreign %s custody and projection untouched until the placed runtime runs', async (foreign) => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state as never,
      deliveriesCollection: deliveries as never, signal: new AbortController().signal, now: () => 1 });
    const ready = await store.ensure(outwardObligation());
    const attempting = await store.ensure({ ...outwardObligation(), source: {
      kind: 'sessionProjection', sessionId: 'session-1', semanticItemId: 'stale-attempt',
    }, deliveryKey: 'stale-attempt' });
    if (ready.kind !== 'created' || attempting.kind !== 'created') throw new Error('Expected retained custody');
    const started = await store.compareAndSwap({ custodyId: attempting.record.custodyId, expectedRevision: attempting.record.revision,
      custody: { ...attempting.record.custody, state: 'attempting', attemptCount: 1, attemptId: 'original-attempt', startedAt: 1 } });
    expect(started.kind).toBe('updated');
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage() : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        scannedThroughSeq: 1, nextCursor: '1', hasMore: false, items: [{ kind: 'assistantText', sessionId: 'session-1',
          seq: 1, itemId: 'projected-final', turnId: 'turn-final', final: 'completed', text: 'Fresh final', consumedInputs: [] }] });
    const deliver = vi.fn(async (operation: typeof providerDeliveryAction) => ({
      result: { kind: 'delivered', providerMessageIds: [operation === providerDeliveryReconcileAction ? 'reconciled' : 'sent'] },
      executionOrigin: providerTransportOrigin,
    }));
    const routing = { ...getPluginMachineExecutionRouting(providerTransportOrigin), pluginId: 'happier.channels' };
    const foreignContext = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin: deliver,
      executionRouting: foreign === 'unavailable' ? null : { ...routing,
        ...(foreign === 'machine' ? { machineId: 'another-machine' } : { serverIdentityId: 'srv_another_home' }) } });
    if (foreign === 'unsupported') Reflect.deleteProperty(foreignContext.services.actions, 'getCurrentExecutionRouting');
    const originalCustody = structuredClone([...deliveries.rows]);
    const originalState = structuredClone([...state.rows]);
    await runConversationOutwardDeliveryCycle({ context: foreignContext, now: () => 40_000 });
    expect([...deliveries.rows]).toEqual(originalCustody);
    expect([...state.rows]).toEqual(originalState);
    expect(execute).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(foreignContext.services.logger.warn).not.toHaveBeenCalled();
    expect(foreignContext.services.logger.info).not.toHaveBeenCalled();
    const placed = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin: deliver });
    await runConversationOutwardDeliveryCycle({ context: placed, now: () => 40_001 });
    await runConversationOutwardDeliveryCycle({ context: placed, now: () => 40_002 });
    expect(deliver.mock.calls.filter(([operation]) => operation === providerDeliveryAction)).toHaveLength(2);
    expect(deliver.mock.calls.filter(([operation]) => operation === providerDeliveryReconcileAction)).toHaveLength(1);
    expect([...deliveries.rows.values()]).toHaveLength(3);
    expect([...deliveries.rows.values()].every(row => isChannelStateJsonRecord(row.value.payload)
      && row.value.payload.state === 'delivered')).toBe(true);
  });
  it('stops queued child delivery and holds new projection while its router is disabled', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const base = bindingRow();
    const childEndpoint = { kind: 'thread', audience: 'shared', id: 'thread-child', parentId: endpoint.id } as const;
    await state.put({ ...base, payload: { ...base.payload, parentBindingId: 'router-parent', endpoint: childEndpoint,
      target: { ...sessionTarget, policy: { ...sessionTarget.policy, deliveryMode: 'mirrorSession' } },
    } }, { expectedRevision: 1 });
    const parent = { ...base, id: 'router-parent', 'binding-id': 'router-parent', payload: { ...base.payload,
      target: { kind: 'threadRouter', principalGroups: [{ id: 'allowed', principalIds: ['principal-1'] }], routes: [] },
    } };
    await state.put(parent, { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never, deliveriesCollection: deliveries as never, signal, now: () => 1,
    });
    const queued = await store.ensure({ ...outwardObligation(), endpoint: childEndpoint,
      routeAuthority: { connectionAuthorityEpoch: 4, bindingRevision: 2, bindingAuthorityEpoch: 7 },
    });
    if (queued.kind !== 'created') throw new Error('Expected ordinary queued child custody');
    await state.put({ ...parent, payload: { ...parent.payload, enabled: false } }, { expectedRevision: 1 });
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage() : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        scannedThroughSeq: 1, nextCursor: '1', hasMore: false,
        items: [{ kind: 'assistantText', sessionId: 'session-1', seq: 1, itemId: 'new-after-stop',
          turnId: 'turn-after-stop', final: 'completed', text: 'New answer', consumedInputs: [] }],
      });
    const deliver = vi.fn(async (_operation: unknown, _input: ConversationDeliveryInputV1) => ({
      result: { kind: 'delivered', providerMessageIds: ['message'] }, executionOrigin: providerTransportOrigin,
    }));
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin: deliver });
    const paused = await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    expect(paused.nextWakeAt).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
    expect(deliveries.rows.size).toBe(1);
    expect(deliveries.rows.get(queued.record.custodyId)?.value.payload).toMatchObject({ state: 'suppressed' });
    expect(state.rows.get(createConversationSessionProjectionFrontierRowId('binding-1'))?.value.payload).toMatchObject({ lastScannedSeq: 0 });
    // Stop did not change the child or its frontier. A later enable uses the same normal path.
    await state.put(parent, { expectedRevision: 2 });
    await runConversationOutwardDeliveryCycle({ context, now: () => 101 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ endpoint: childEndpoint, content: { text: 'New answer' } });
    expect(state.rows.get(createConversationSessionProjectionFrontierRowId('binding-1'))?.value.payload).toMatchObject({ lastScannedSeq: 1 });
  });
  it.each(['binding', 'connection'] as const)('clears only completed start routing intent during %s deletion', async (scope) => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never, deliveriesCollection: deliveries as never, signal, now: () => 1,
    });
    const created = await store.ensure({ ...permissionWaitOutwardObligation(),
      source: { kind: 'conversationStart', sessionId: 'session-1', requestId: 'deleted-start' },
      newThread: { recipients: ['principal-1'], subject: 'Brief' },
    });
    if (created.kind !== 'created') throw new Error('Expected start custody');
    const endpoint = { kind: 'thread', audience: 'shared', id: 'created-thread', parentId: 'mailbox' } as const;
    const updated = await store.compareAndSwap({ custodyId: created.record.custodyId, expectedRevision: created.record.revision,
      custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['delivered-message'], endpoint, threadBindingPending: true },
    });
    if (updated.kind !== 'updated') throw new Error('Expected delivered custody');
    const settle = () => scope === 'binding'
      ? settleConversationOutwardDeliveriesForBindingDeletion({ stateCollection: state as never, deliveriesCollection: deliveries as never,
        connectionId: 'connection-1', bindingId: 'binding-1', signal, now: () => 2 })
      : settleConversationOutwardDeliveriesForConnectionDeletion({ stateCollection: state as never, deliveriesCollection: deliveries as never,
        connectionId: 'connection-1', signal, now: () => 2 });
    await settle();
    await expect(settle()).resolves.toEqual({ kind: 'settled' });
    expect(deliveries.rows.get(created.record.custodyId)?.value).toMatchObject({ terminal: true, payload: {
      state: 'delivered', providerMessageIds: ['delivered-message'], deliveryEndpoint: endpoint, threadBindingPending: false,
    } });
  });
  it.each(['delivered', 'outcomeUnknown'] as const)('recovers a %s started thread into one ordinary child without another external send', async (outcome) => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const binding = bindingRow();
    await state.put({ ...binding, id: 'router-1', 'binding-id': 'router-1', payload: {
      ...binding.payload,
      target: { kind: 'threadRouter', principalGroups: [{ id: 'brief', principalIds: ['principal-1', 'principal-2'] }], routes: [] },
      allowedPrincipalIds: ['principal-1', 'principal-2'],
    } }, { expectedRevision: 'absent' });
    const createdEndpoint = { kind: 'thread', audience: 'shared', id: 'brief-thread', parentId: endpoint.id } as const;
    let sessionDeleted = false;
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage() : ({ ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        scannedThroughSeq: sessionDeleted ? undefined : 0, nextCursor: '0', hasMore: false, items: [] }));
    const deliver = vi.fn(async (_operation: unknown, _input: ConversationDeliveryInputV1) => ({ result: outcome === 'delivered'
      ? { kind: 'delivered', providerMessageIds: ['brief-message'], endpoint: createdEndpoint }
      : { kind: 'outcomeUnknown' }, executionOrigin: providerTransportOrigin }));
    const baseContext = backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: deliver });
    const context = { ...baseContext, services: { ...baseContext.services,
      sessions: { get: async () => sessionDeleted ? null : ({ summary: async () => ({ hasAttestedContext: false }) }) } as unknown as PluginServices['sessions'],
    }, invocationId: 'workflow-start-1' };
    const content = { text: 'Brief', html: '<p>' + 'a'.repeat(120 * 1024) + '</p>' };
    const request = { routerBindingId: 'router-1', audienceGroupId: 'brief', subject: 'Brief', content, sessionId: 'session-1' };
    const accepted = await startConversationForInvocation(request, context);
    expect(await startConversationForInvocation(request, context)).toEqual(accepted);
    expect(deliveries.rows.size).toBe(1);
    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ content,
      newThread: { recipients: ['principal-1', 'principal-2'], subject: 'Brief' } });
    if (outcome === 'outcomeUnknown') {
      await runConversationOutwardDeliveryCycle({ context, now: () => 101 });
      expect([...state.rows.values()].filter(row => (row.value.payload as Record<string, unknown>)?.parentBindingId === 'router-1')).toHaveLength(0);
      const row = deliveries.rows.get(accepted.custodyId)!;
      await expect(resolveConversationDeliveryForInvocation({ custodyId: row.rowId, expectedRevision: row.revision, resolution: 'accepted' }, context))
        .rejects.toMatchObject({ code: 'channels_delivery_resolve_endpoint_required' });
      await resolveConversationDeliveryForInvocation({ custodyId: row.rowId, expectedRevision: row.revision, resolution: 'accepted', endpoint: createdEndpoint }, context);
    }
    // Simulate loss of the first child write. Persisted delivery remains the recovery source.
    const batch = state.batch.bind(state);
    let failChildWrite = true;
    state.batch = async operations => {
      if (failChildWrite && operations.some(operation => operation.kind === 'put'
        && (operation.value as Record<string, unknown>)?.['record-kind'] === 'binding')) {
        failChildWrite = false;
        throw new Error('simulated child persistence unavailability');
      }
      return await batch(operations);
    };
    await runConversationOutwardDeliveryCycle({ context, now: () => 102 });
    expect(deliveries.rows.get(accepted.custodyId)?.value.terminal).toBe(false);
    await runConversationOutwardDeliveryCycle({ context, now: () => 103 });
    await runConversationOutwardDeliveryCycle({ context, now: () => 104 });
    const children = [...state.rows.values()].filter(row => (row.value.payload as Record<string, unknown>)?.parentBindingId === 'router-1');
    expect(children).toHaveLength(1);
    expect(children[0]?.value.payload).toMatchObject({ endpoint: createdEndpoint,
      target: { kind: 'session', sessionId: 'session-1', policy: { deliveryMode: 'repliesOnly', approvals: { kind: 'off' } } },
      allowedPrincipalIds: ['principal-1', 'principal-2'],
    });
    expect(deliveries.rows.get(accepted.custodyId)?.value.terminal).toBe(true);
    expect(deliveries.rows.size).toBe(1);
    expect(deliver).toHaveBeenCalledOnce();
    sessionDeleted = true;
    expect(await startConversationForInvocation(request, context)).toEqual(accepted);
    expect(deliver).toHaveBeenCalledOnce();
  });
  it('delivers M1 and M2 replies with their exact retained input relation across a retry and a new supervisor cycle', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const threadEndpoint = { kind: 'thread', audience: 'shared', id: 'thread-1' } as const;
    const retainedBinding = bindingRow();
    await state.put({ ...retainedBinding, payload: { ...retainedBinding.payload, endpoint: threadEndpoint } }, { expectedRevision: 1 });
    for (const ordinal of [1, 2]) {
      const censusId = String(ordinal).repeat(43);
      await state.put({
        ...finalizingIngressCensusRow([]), id: censusId, 'connection-id': 'connection-1',
        attention: false,
        payload: {
          ...finalizingIngressCensusRow([]).payload, conflict: null, compacted: null,
          normalizedIngress: { kind: 'fullText', observation: {
            ...finalizingIngressCensusRow([]).payload.normalizedIngress.observation,
            endpoint: threadEndpoint, message: {
              ...finalizingIngressCensusRow([]).payload.normalizedIngress.observation.message, id: `M${ordinal}`,
            },
          } },
        },
      }, { expectedRevision: 'absent' });
      await state.put({
        ...finalizingIngressObligationRow({ bindingId: 'binding-1', ordinal, phase: 'terminal' }),
        'connection-id': 'connection-1',
        payload: {
          ...finalizingIngressObligationRow({ bindingId: 'binding-1', ordinal, phase: 'terminal' }).payload,
          censusId, disposition: 'admitted',
          sessionInput: { sessionId: 'session-1', localId: `L${ordinal}`, projectedReplySeq: null },
        },
      }, { expectedRevision: 'absent' });
    }
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      return {
        ok: true, projection: 'externalShareableV1', sessionId: 'session-1', scannedThroughSeq: 3,
        nextCursor: '3', hasMore: false,
        items: [1, 2, 3].map(ordinal => ({
          kind: 'assistantText', sessionId: 'session-1', seq: ordinal, itemId: `A${ordinal}`,
          turnId: `T${ordinal}`, final: 'completed', text: `Answer ${ordinal}`,
          consumedInputs: ordinal === 3 ? [] : [{ localId: `L${ordinal}`, origin: {
            v: 1, producer: 'pluginSession', actor: 'collaborator',
            sourceAuthority: { mediatorPluginId: 'happier.channels', sourceRef: 'channels:binding:binding-1' },
          } }],
        })),
      };
    });
    let failFirst = true;
    const deliver = vi.fn(async (_operation: unknown, _input: ConversationDeliveryInputV1) => {
      if (failFirst) {
        failFirst = false;
        return { result: { kind: 'notDelivered', retry: 'after', retryAfterMs: 10 }, executionOrigin: providerTransportOrigin };
      }
      return { result: { kind: 'delivered', providerMessageIds: ['provider-reply'] }, executionOrigin: providerTransportOrigin };
    });
    await runConversationOutwardDeliveryCycle({ context: backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin: deliver }), now: () => 100 });
    await runConversationOutwardDeliveryCycle({ context: backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin: deliver }), now: () => 111 });
    expect(deliver.mock.calls.map(([, input]) => [input.content.text, input.replyContext])).toEqual([
      ['Answer 1', { replyToMessageId: 'M1', threadId: 'thread-1' }],
      ['Answer 1', { replyToMessageId: 'M1', threadId: 'thread-1' }],
      ['Answer 2', { replyToMessageId: 'M2', threadId: 'thread-1' }],
      ['Answer 3', undefined],
    ]);
    const persisted = [...deliveries.rows.values()].map(row => row.value.payload);
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ replyContext: { replyToMessageId: 'M1', threadId: 'thread-1' } }),
      expect.objectContaining({ replyContext: { replyToMessageId: 'M2', threadId: 'thread-1' } }),
    ]));
  });
  it.each([0, 1])('parks after an empty durable cycle with %i connections and resumes on collection changes', async (count) => {
    vi.useFakeTimers();
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    if (count > 0) await state.put(connectionRow(), { expectedRevision: 'absent' });
    const listeners: Array<() => void> = [];
    const dispose = vi.fn();
    const collection = (source: MemoryCollection) => Object.assign(source, {
      watch: (_request: unknown, listener: () => void) => {
        listeners.push(listener);
        return { dispose };
      },
    });
    const reads = vi.spyOn(state, 'query');
    const generation = new AbortController();
    const context = {
      ...backgroundContext({
        state: collection(state),
        deliveries: collection(deliveries),
        execute: vi.fn(),
        executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      }),
      signal: generation.signal,
    } satisfies BackgroundServiceContext;
    const supervisor = createConversationOutwardDeliverySupervisor();
    const run = supervisor.run(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const initialReads = reads.mock.calls.length;
      expect(initialReads).toBeGreaterThan(0);
      const deliveryReads = vi.spyOn(deliveries, 'query');
      await vi.advanceTimersByTimeAsync(60_000);
      console.info('FIX-WAKE outward measurement', {
        enabledConnections: count,
        startupStateReads: initialReads,
        stateReadsPerMinute: reads.mock.calls.length - initialReads,
        deliveryReadsPerMinute: deliveryReads.mock.calls.length,
      });
      expect(reads).toHaveBeenCalledTimes(initialReads);
      expect(deliveryReads).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1_000);
      expect(reads).toHaveBeenCalledTimes(initialReads);
      expect(deliveryReads).not.toHaveBeenCalled();
      for (const notify of listeners) notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads.mock.calls.length).toBeGreaterThan(initialReads);
    } finally {
      generation.abort();
      await run;
      await supervisor.dispose();
      vi.useRealTimers();
    }
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('wakes retained work at the next deadline without an intervening periodic cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const generation = new AbortController();
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const deliveryTimes: number[] = [];
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage() : ({
      ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
      scannedThroughSeq: 0, nextCursor: '0', hasMore: false, items: [],
    }));
    const deliver = vi.fn(async () => {
      deliveryTimes.push(Date.now());
      return {
        result: deliveryTimes.length === 1
          ? { kind: 'notDelivered', retry: 'after', retryAfterMs: 2_500 }
          : { kind: 'delivered', providerMessageIds: ['retry-message'] },
        executionOrigin: providerTransportOrigin,
      };
    });
    const supervisor = createConversationOutwardDeliverySupervisor();
    const context = {
      ...backgroundContext({ state, deliveries, execute,
        executeAdmittedTargetedOperationWithExecutionOrigin: deliver }),
      signal: generation.signal,
    } satisfies BackgroundServiceContext;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never, deliveriesCollection: deliveries as never,
      signal: generation.signal,
    });
    expect((await store.ensure(outwardObligation())).kind).toBe('created');
    const reads = vi.spyOn(deliveries, 'query');
    const running = supervisor.run(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(deliveryTimes).toEqual([0]), { interval: 0 });
      await vi.waitFor(() => expect([...deliveries.rows.values()].map(row => row.value.payload))
        .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'retryDue' })])), { interval: 0 });
      await vi.advanceTimersByTimeAsync(0);
      const startupReads = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_499);
      expect(deliveryTimes).toEqual([0]);
      expect(reads).toHaveBeenCalledTimes(startupReads);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(deliveryTimes).toEqual([0, 2_500]), { interval: 0 });
      expect(deliveryTimes).toEqual([0, 2_500]);
      generation.abort();
    } finally {
      generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers();
    }
  });

  it('parks non-retryable owner unavailability without dropping custody and resumes on Session or binding change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const generation = new AbortController();
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    let sessionChanged: (() => void) | undefined;
    let bindingChanged: (() => void) | undefined;
    let deliveryChanged: (() => void) | undefined;
    Object.assign(state, { watch: (_query: unknown, listener: () => void) => {
      bindingChanged = listener; return { dispose() {} };
    } });
    Object.assign(deliveries, { watch: (_query: unknown, listener: () => void) => {
      deliveryChanged = listener; return { dispose() {} };
    } });
    let available = false;
    let retryable = false;
    const permissionReads: number[] = [];
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        permissionReads.push(Date.now());
        if (!available) throw new PluginError({ code: 'ownerMachineUnavailable', message: 'Owner unavailable', retryable });
        return emptyPendingPermissionPage();
      }
      return { ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        scannedThroughSeq: 0, nextCursor: '0', hasMore: false, items: [] };
    });
    const context = { ...backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      watchSession: listener => { sessionChanged = listener; return { dispose() {} }; },
    }), signal: generation.signal };
    const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state as never,
      deliveriesCollection: deliveries as never, signal: generation.signal });
    const retained = await store.ensure(permissionWaitOutwardObligation());
    if (retained.kind !== 'created') throw new Error('Expected retained permission custody');
    const supervisor = createConversationOutwardDeliverySupervisor();
    const running = supervisor.run(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(permissionReads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(permissionReads).toHaveLength(1);
      expect(deliveries.rows.get(retained.record.custodyId)?.value.payload).toMatchObject({ state: 'ready', attemptCount: 0 });
      // Another delivery's activity cannot change this Session's owner.
      deliveryChanged?.(); await vi.advanceTimersByTimeAsync(0);
      expect(permissionReads).toHaveLength(1);
      sessionChanged?.(); await vi.advanceTimersByTimeAsync(0);
      expect(permissionReads).toHaveLength(2);
      available = true;
      bindingChanged?.(); await vi.advanceTimersByTimeAsync(0);
      expect(permissionReads).toHaveLength(3);
      // The successful complete negative read, not the prior failure, permits
      // suppression of this never-attempted permission wait.
      await vi.waitFor(() => expect(deliveries.rows.get(retained.record.custodyId)?.value.payload)
        .toMatchObject({ state: 'suppressed' }), { interval: 0 });
      available = false;
      retryable = true;
      bindingChanged?.(); await vi.advanceTimersByTimeAsync(0);
      expect(permissionReads).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(permissionReads).toHaveLength(5);
    } finally { generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers(); }
  });

  it('rechecks a held publication page and projects its finalized answer through custody exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const generation = new AbortController();
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const binding = state.rows.get('binding-1');
    if (binding === undefined || !isChannelStateJsonRecord(binding.value.payload)) throw new Error('Expected binding');
    await state.put({ ...binding.value, payload: { ...binding.value.payload,
      target: { ...sessionTarget, policy: { ...sessionTarget.policy, deliveryMode: 'repliesOnly' } },
    } }, { expectedRevision: binding.revision });
    let published = false;
    const execute = vi.fn(async (action: string, input: Readonly<{ cursor?: string | null }>) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      return {
        ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        scannedThroughSeq: published ? 5 : 0, nextCursor: published ? '5' : '0', hasMore: !published,
        items: published && input.cursor !== '5' ? [{
          kind: 'assistantText', sessionId: 'session-1', seq: 5, itemId: 'held-final-answer',
          turnId: 'turn-1', final: 'completed', text: 'Retained answer',
          consumedInputs: [{ localId: 'retained-input', origin: {
            v: 1, producer: 'pluginSession', actor: 'owner',
            sourceAuthority: { mediatorPluginId: 'happier.channels', sourceRef: 'channels:binding:binding-1' },
          } }],
        }] : [],
      };
    });
    const deliver = vi.fn(async () => ({
      result: { kind: 'delivered', providerMessageIds: ['held-answer-receipt'] }, executionOrigin: providerTransportOrigin,
    }));
    const context = { ...backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: deliver }), signal: generation.signal };
    const supervisor = createConversationOutwardDeliverySupervisor();
    const running = supervisor.run(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(
        'session.transcript.get',
        expect.objectContaining({ sessionId: 'session-1', cursor: null }),
        expect.anything(),
      ), { interval: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(deliveries.rows.size).toBe(0);
      expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({ lastScannedSeq: 0 });
      // Publication metadata can recover after the transcript write. No new
      // Session/Collection invalidation accompanies release of this page.
      published = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect([...deliveries.rows.values()].map(row => row.value.payload)).toEqual([
          expect.objectContaining({ state: 'delivered', providerMessageIds: ['held-answer-receipt'] }),
        ]);
        expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({
          transcriptCursor: '5', lastScannedSeq: 5,
        });
      }, { interval: 0 });
      await runConversationOutwardDeliveryCycle({ context, now: () => Date.now() });
      expect(deliveries.rows.size).toBe(1);
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally { generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers(); }
  });

  it('does not fan foreign-placement invalidations into binding reads and parks without changes', async () => {
    vi.useFakeTimers();
    const generation = new AbortController();
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    for (let index = 0; index < 100; index += 1) {
      const id = `foreign-binding-${index}`;
      await state.put({ ...bindingRow(), id, 'binding-id': id }, { expectedRevision: 'absent' });
    }
    const changes = new Set<() => void>();
    // Collection observation and Machine placement are host boundaries. The
    // actual scanner, binding selection, mediation and projection stay real.
    state.watch = (_query?: unknown, listener?: () => void) => {
      if (listener) changes.add(listener);
      return { dispose() { if (listener) changes.delete(listener); } };
    };
    const reads = vi.spyOn(state, 'get');
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage()
      : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1', scannedThroughSeq: 0,
        nextCursor: '0', hasMore: false, items: [] });
    let placed = false;
    const base = backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn() });
    const context = { ...base, signal: generation.signal, services: { ...base.services,
      actions: { ...base.services.actions, getCurrentExecutionRouting: async () => placed
        ? { ...getPluginMachineExecutionRouting(providerTransportOrigin), pluginId: 'happier.channels' }
        : null } } } satisfies BackgroundServiceContext;
    const supervisor = createConversationOutwardDeliverySupervisor();
    const running = supervisor.run(context);
    const bindingReads = () => reads.mock.calls.filter(([id]) => id.startsWith('foreign-binding-')).length;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(bindingReads()).toBe(0);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 50; index += 1) for (const changed of changes) changed();
      await vi.advanceTimersByTimeAsync(0);
      expect(bindingReads()).toBe(0);
      expect(reads).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toHaveBeenCalledTimes(2);

      // Real placement recovery still discovers all admitted local work.
      placed = true;
      for (const changed of changes) changed();
      await vi.advanceTimersByTimeAsync(0);
      expect(bindingReads()).toBeGreaterThan(0);
      expect(execute).toHaveBeenCalled();
    } finally { generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers(); }
    expect(changes.size).toBe(0);
  });

  it('subscribes before the bound transcript read and wakes on Session changes without a timer', async () => {
    vi.useFakeTimers();
    const generation = new AbortController();
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const stateReads = vi.spyOn(state, 'get');
    const deliveryReads = vi.spyOn(deliveries, 'get');
    let changed: (() => void) | undefined;
    let answer = false;
    const dispose = vi.fn();
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      expect(changed).toBeTypeOf('function');
      return { ok: true, projection: 'externalShareableV1', sessionId: 'session-1', scannedThroughSeq: answer ? 1 : 0,
        nextCursor: answer ? '1' : '0', hasMore: false, items: answer ? [{ kind: 'assistantText', sessionId: 'session-1',
          seq: 1, itemId: 'answer-1', turnId: 'turn-1', final: 'completed', text: 'New answer', consumedInputs: [] }] : [] };
    });
    const deliver = vi.fn(async () => ({ result: { kind: 'delivered', providerMessageIds: ['answer'] }, executionOrigin: providerTransportOrigin }));
    const supervisor = createConversationOutwardDeliverySupervisor();
    const running = supervisor.run({ ...backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: deliver, watchSession: listener => { changed = listener; return { dispose }; } }),
      signal: generation.signal });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(changed).toBeTypeOf('function');
      const initialReads = execute.mock.calls.length;
      const initialStateReads = stateReads.mock.calls.length;
      const initialDeliveryReads = deliveryReads.mock.calls.length;
      expect(initialStateReads).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(execute).toHaveBeenCalledTimes(initialReads);
      expect(stateReads).toHaveBeenCalledTimes(initialStateReads);
      expect(deliveryReads).toHaveBeenCalledTimes(initialDeliveryReads);
      answer = true; changed?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), { interval: 0 });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(stateReads.mock.calls.length).toBeGreaterThan(initialStateReads);
    } finally { generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers(); }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('finishes the retention keyset pass before replaying invalidations from its own retirement writes (failed continuation: %s)', async failContinuation => {
    const pageSize = PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1;
    const now = 31 * 24 * 60 * 60 * 1_000;
    let persistedAt = 0;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const generation = new AbortController();
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: generation.signal,
      now: () => persistedAt,
    });
    const created = [];
    for (let index = 0; index < pageSize * 3; index += 1) {
      const result = await store.ensure({ ...outwardObligation(),
        source: { kind: 'sessionProjection', sessionId: 'session-1', semanticItemId: `retention-${index}` },
        deliveryKey: `retention-page:${index}` });
      if (result.kind !== 'created') throw new Error('Expected retention custody fixture.');
      created.push(result.record);
    }
    created.sort((left, right) => left.custodyId.localeCompare(right.custodyId));
    for (const [index, record] of created.entries()) {
      // The first page cannot age yet. Every later page is eligible now.
      persistedAt = index < pageSize ? now - 1 : 100;
      const settled = await store.compareAndSwap({ custodyId: record.custodyId,
        expectedRevision: record.revision,
        custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['receipt'] } });
      if (settled.kind !== 'updated') throw new Error('Expected terminal retention fixture.');
    }
    let changed: (() => void) | undefined;
    Object.assign(deliveries, { watch: (_request: unknown, listener: () => void) => {
      changed = listener;
      return { dispose() {} };
    } });
    // Persistent Collection writes deliver the same level-triggered hint as
    // foreign writes. Keep the real retirement store and page scanner beneath it.
    const batch = deliveries.batch.bind(deliveries);
    vi.spyOn(deliveries, 'batch').mockImplementation(async operations => {
      const result = await batch(operations);
      if (result.status === 'updated') changed?.();
      return result;
    });
    const readPage = deliveries.query.bind(deliveries);
    let continuationFailed = false;
    const query = vi.spyOn(deliveries, 'query').mockImplementation(async input => {
      if (failContinuation && !continuationFailed && input.prefix?.[0] === true && input.cursor !== undefined) {
        continuationFailed = true;
        changed?.();
        throw new Error('Collection temporarily unavailable during continuation.');
      }
      return readPage(input);
    });
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const supervisor = createConversationOutwardDeliverySupervisor();
    const running = supervisor.run({ ...backgroundContext({ state, deliveries,
      execute: vi.fn(), executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn() }), signal: generation.signal });
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (failContinuation) {
        expect(continuationFailed).toBe(true);
        expect([...deliveries.rows.values()].filter(row => row.deleted)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(999);
        expect([...deliveries.rows.values()].filter(row => row.deleted)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.waitFor(() => expect([...deliveries.rows.values()].filter(row => row.deleted)).toHaveLength(pageSize * 2), { interval: 0 });
      await vi.advanceTimersByTimeAsync(0);
      const retentionStarts = () => query.mock.calls.filter(([input]) => input.prefix?.[0] === true && input.cursor === undefined).length;
      // One original sweep and one coalesced fresh sweep, not a restart after
      // every retired page that repeatedly reads the retained first page.
      expect(retentionStarts()).toBe(2);
      const exhaustedReads = query.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(query).toHaveBeenCalledTimes(exhaustedReads);
    } finally { generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers(); }
  });

  it('discovers ready custody arriving behind an exhausted scan without waiting for an unrelated future retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const generation = new AbortController();
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state as never,
      deliveriesCollection: deliveries as never, signal: generation.signal, now: () => Date.now() });
    const old = await store.ensure(outwardObligation());
    if (old.kind !== 'created') throw new Error('Expected future retry fixture.');
    const retryAt = Date.now() + 50_000;
    const deferred = await store.compareAndSwap({ custodyId: old.record.custodyId,
      expectedRevision: old.record.revision,
      custody: { state: 'retryDue', attemptCount: 1, providerMessageIds: [], retryNotBefore: retryAt } });
    if (deferred.kind !== 'updated') throw new Error('Expected deferred custody fixture.');
    let changed: (() => void) | undefined;
    Object.assign(deliveries, { watch: (_request: unknown, listener: () => void) => {
      changed = listener; return { dispose() {} };
    } });
    const readPage = deliveries.query.bind(deliveries);
    let newCustodyId: string | undefined;
    vi.spyOn(deliveries, 'query').mockImplementation(async input => {
      if (input.prefix?.[0] === true && newCustodyId === undefined) {
        const added = await store.ensure({ ...outwardObligation(), deliveryKey: 'new-ready-during-scan',
          source: { kind: 'sessionProjection', sessionId: 'session-1', semanticItemId: 'new-ready' } });
        if (added.kind !== 'created') throw new Error('Expected concurrently admitted ready custody.');
        newCustodyId = added.record.custodyId;
        changed?.();
      }
      return readPage(input);
    });
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage()
      : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1', scannedThroughSeq: 0,
        nextCursor: '0', hasMore: false, items: [] });
    const deliver = vi.fn(async () => ({ result: { kind: 'delivered', providerMessageIds: ['new-ready-receipt'] },
      executionOrigin: providerTransportOrigin }));
    const supervisor = createConversationOutwardDeliverySupervisor();
    const running = supervisor.run({ ...backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: deliver }), signal: generation.signal });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(newCustodyId).toBeTypeOf('string'), { interval: 0 });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1), { interval: 0 });
      if (newCustodyId === undefined) throw new Error('Expected newly admitted custody.');
      const admittedCustodyId = newCustodyId;
      await vi.waitFor(() => expect(deliveries.rows.get(admittedCustodyId)?.value.payload).toMatchObject({ state: 'delivered' }), { interval: 0 });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliveries.rows.get(old.record.custodyId)?.value).toMatchObject({ 'retry-not-before': retryAt, payload: { state: 'retryDue' } });
      await vi.advanceTimersByTimeAsync(49_999);
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally { generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers(); }
  });

  it('retires known terminal custody at the exact thirty-day cutoff while preserving ambiguity', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    const terminalAt = 100;
    const resolvedAt = 200;
    let persistedAt = 0;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => persistedAt,
    });
    const createTerminal = async (
      controlId: string,
      custody: Readonly<Record<string, unknown>>,
    ) => {
      const created = await store.ensure({
        ...outwardObligation(),
        source: { kind: 'controlResponse', controlId, controlKind: 'recovery' },
        deliveryKey: `retention:${controlId}`,
      });
      if (created.kind !== 'created') throw new Error(`Expected ${controlId} custody creation.`);
      persistedAt = terminalAt;
      const settled = await store.compareAndSwap({
        custodyId: created.record.custodyId,
        expectedRevision: created.record.revision,
        custody: custody as never,
      });
      if (settled.kind !== 'updated') throw new Error(`Expected ${controlId} custody settlement.`);
      return settled.record;
    };
    const delivered = await createTerminal('retention-delivered', {
      state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'],
    });
    const transitionedCandidate = await createTerminal('retention-transitioned', {
      state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-transition'],
    });
    persistedAt = resolvedAt;
    const transitioned = await store.compareAndSwap({
      custodyId: transitionedCandidate.custodyId,
      expectedRevision: transitionedCandidate.revision,
      custody: { state: 'connectionDeleted', attemptCount: 1, providerMessageIds: [] },
    });
    if (transitioned.kind !== 'updated') throw new Error('Expected terminal-state transition.');
    const notDelivered = await createTerminal('retention-not-delivered', {
      state: 'notDelivered', attemptCount: 1, providerMessageIds: [],
    });
    await createTerminal('retention-partial', {
      state: 'partial', attemptCount: 1, providerMessageIds: ['provider-2'], failedChunk: 1,
    });
    await createTerminal('retention-unknown', {
      state: 'outcomeUnknown', attemptCount: 1, providerMessageIds: [],
    });
    const resolvedCandidate = await createTerminal('retention-resolved', {
      state: 'partial', attemptCount: 1, providerMessageIds: ['provider-3'], failedChunk: 1,
    });
    persistedAt = resolvedAt;
    const resolved = await store.compareAndSwap({
      custodyId: resolvedCandidate.custodyId,
      expectedRevision: resolvedCandidate.revision,
      custody: {
        state: 'resolvedAccepted',
        attemptCount: 1,
        providerMessageIds: ['provider-3'],
        failedChunk: 1,
      },
    });
    if (resolved.kind !== 'updated') throw new Error('Expected ambiguity resolution.');

    const execute = vi.fn(async (action: string) => {
      if (action === 'session.transcript.get') throw new Error('No binding should be projected.');
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => terminalAt + THIRTY_DAYS_MS - 1,
    });
    expect(await deliveries.get(delivered.custodyId)).not.toBeNull();
    expect(await deliveries.get(notDelivered.custodyId)).not.toBeNull();

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => terminalAt + THIRTY_DAYS_MS,
    });
    expect(await deliveries.get(delivered.custodyId)).toBeNull();
    expect(deliveries.rows.get(delivered.custodyId)).toBeUndefined();
    expect(await deliveries.get(transitioned.record.custodyId)).toBeNull();
    expect(deliveries.rows.get(transitioned.record.custodyId)).toBeUndefined();
    expect(await deliveries.get(notDelivered.custodyId)).toBeNull();
    expect(deliveries.rows.get(notDelivered.custodyId)).toBeUndefined();
    expect(await deliveries.get(resolved.record.custodyId)).not.toBeNull();
    expect([...deliveries.rows.values()].filter((row) => row.deleted !== true).map((row) => (
      (row.value.payload as Readonly<Record<string, unknown>>).state
    ))).toEqual(expect.arrayContaining(['partial', 'outcomeUnknown', 'resolvedAccepted']));

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => resolvedAt + THIRTY_DAYS_MS,
    });
    expect(await deliveries.get(resolved.record.custodyId)).toBeNull();
    expect(deliveries.rows.get(resolved.record.custodyId)).toBeUndefined();
    expect([...deliveries.rows.values()].filter((row) => row.deleted !== true).map((row) => (
      (row.value.payload as Readonly<Record<string, unknown>>).state
    ))).toEqual(expect.arrayContaining(['partial', 'outcomeUnknown']));
  });

  it('retires deleted-connection terminal custody at thirty days without mutating non-terminal custody on an unplaced runtime', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    const terminalAt = 100;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const connection = await state.put(connectionRow(), { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => terminalAt,
    });
    const created = await store.ensure(outwardObligation());
    if (created.kind !== 'created') throw new Error('Expected terminal custody fixture.');
    const terminal = await store.compareAndSwap({
      custodyId: created.record.custodyId,
      expectedRevision: created.record.revision,
      custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
    });
    if (terminal.kind !== 'updated') throw new Error('Expected terminal custody settlement.');
    const unsettled = [];
    for (const custody of [
      { state: 'ready', attemptCount: 0, providerMessageIds: [] },
      { state: 'attempting', attemptId: 'stale-attempt', startedAt: terminalAt, attemptCount: 1, providerMessageIds: [] },
      { state: 'outcomeUnknown', attemptCount: 1, providerMessageIds: [] },
    ] as const) {
      const admitted = await store.ensure(retireableControlOutwardObligation(`deleted-connection-${custody.state}`));
      if (admitted.kind !== 'created') throw new Error('Expected non-terminal custody fixture.');
      const updated = await store.compareAndSwap({
        custodyId: admitted.record.custodyId,
        expectedRevision: admitted.record.revision,
        custody,
      });
      if (updated.kind !== 'updated') throw new Error('Expected non-terminal custody state.');
      expect(updated.record.custody).toEqual(custody);
      unsettled.push(structuredClone(await deliveries.get(updated.record.custodyId)));
    }
    await state.delete(connection.rowId, { expectedRevision: connection.revision });
    expect(await state.get(connection.rowId)).toBeNull();
    const execute = vi.fn();
    const providerOperation = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: providerOperation,
      executionRouting: { ...getPluginMachineExecutionRouting(providerTransportOrigin), pluginId: 'happier.channels', machineId: 'foreign-machine' },
    });
    const before = structuredClone([...deliveries.rows]);
    await runConversationOutwardDeliveryCycle({ context, now: () => terminalAt + THIRTY_DAYS_MS - 1 });
    expect([...deliveries.rows]).toEqual(before);
    await runConversationOutwardDeliveryCycle({ context, now: () => terminalAt + THIRTY_DAYS_MS });
    for (const row of unsettled) {
      if (row === null) throw new Error('Expected retained non-terminal row.');
      expect(await deliveries.get(row.rowId)).toEqual(row);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(providerOperation).not.toHaveBeenCalled();
    expect(await deliveries.get(terminal.record.custodyId)).toBeNull();
    // Session projection remains replayable, so the existing retirement owner
    // preserves its content-free dedupe tombstone rather than forgetting it.
    expect(deliveries.rows.get(terminal.record.custodyId)).toMatchObject({
      deleted: true,
      revision: terminal.record.revision + 1,
    });
  });

  it('keeps a content-free control-response tombstone until its ingress source row is gone', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    let persistedAt = 100;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    // The control response's identity is the durable ingress row that produced
    // it. While that row is still addressable the same provider occurrence can
    // replay inside its horizon, so only a logical tombstone may remain.
    await state.put({
      id: 'ingress-census-1',
      'record-kind': 'ingress-census',
      v: 1,
      'connection-id': 'connection-1',
      'created-at': 0,
      'updated-at': 0,
      payload: {},
    }, { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => persistedAt,
    });
    const settleTerminal = async (controlId: string) => {
      const created = await store.ensure(retireableControlOutwardObligation(controlId));
      if (created.kind !== 'created') throw new Error('Expected retained custody fixture.');
      const settled = await store.compareAndSwap({
        custodyId: created.record.custodyId,
        expectedRevision: created.record.revision,
        custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
      });
      if (settled.kind !== 'updated') throw new Error('Expected terminal custody fixture.');
      return settled.record;
    };
    const retained = await settleTerminal('ingress-census-1');
    const unreachable = await settleTerminal('ingress-census-gone');

    persistedAt += THIRTY_DAYS_MS;
    await runConversationOutwardDeliveryCycle({
      context: backgroundContext({
        state,
        deliveries,
        execute: vi.fn(async () => { throw new Error('Unexpected Action.'); }),
        executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      }),
      now: () => persistedAt,
    });

    expect(await deliveries.get(retained.custodyId)).toBeNull();
    expect(deliveries.rows.get(retained.custodyId)?.deleted).toBe(true);
    expect(await deliveries.get(unreachable.custodyId)).toBeNull();
    expect(deliveries.rows.get(unreachable.custodyId)).toBeUndefined();
  });

  it('forgets already-selected outward retention rows directly at their exact live revisions', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    let persistedAt = 100;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection({ maxBatchRows: 2 });
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => persistedAt,
    });
    const records = await Promise.all(['batch-1', 'batch-2', 'batch-3'].map(async (controlId) => {
      const created = await store.ensure({
        ...outwardObligation(),
        source: { kind: 'controlResponse', controlId, controlKind: 'recovery' },
        deliveryKey: `retention:${controlId}`,
      });
      if (created.kind !== 'created') throw new Error('Expected retained custody fixture.');
      const settled = await store.compareAndSwap({
        custodyId: created.record.custodyId,
        expectedRevision: created.record.revision,
        custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
      });
      if (settled.kind !== 'updated') throw new Error('Expected terminal custody fixture.');
      return settled.record;
    }));
    const forget = deliveries.forget.bind(deliveries);
    const forgotten: Array<Readonly<{ rowId: string; expectedRevision: number }>> = [];
    deliveries.forget = async (rowId, input) => {
      forgotten.push({ rowId, expectedRevision: input.expectedRevision });
      return await forget(rowId, input);
    };

    persistedAt += THIRTY_DAYS_MS;
    await runConversationOutwardDeliveryCycle({
      context: backgroundContext({
        state,
        deliveries,
        execute: vi.fn(async () => { throw new Error('Unexpected Action.'); }),
        executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      }),
      now: () => persistedAt,
    });

    expect(forgotten).toEqual(expect.arrayContaining(records.map((record) => ({
      rowId: record.custodyId,
      expectedRevision: record.revision,
    }))));
    expect(records.every((record) => !deliveries.rows.has(record.custodyId))).toBe(true);
  });

  it('does not physically forget a terminal permission wait while its exact request is still pending', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    let persistedAt = 0;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(approvalBindingRow(), { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        return {
          requests: [pendingPermissionRequest({
            requestId: 'permission-request-1',
            turnId: 'turn-1',
            createdAtMs: 100,
            allowedScopes: ['request'],
          })],
          truncated: false,
          nextCursor: null,
        };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => persistedAt,
    });
    const admitted = await store.ensure(permissionWaitOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('Expected permission-wait custody fixture.');
    const terminal = await store.compareAndSwap({
      custodyId: admitted.record.custodyId,
      expectedRevision: admitted.record.revision,
      custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
    });
    if (terminal.kind !== 'updated') throw new Error('Expected terminal permission-wait custody.');

    persistedAt = THIRTY_DAYS_MS;
    await runConversationOutwardDeliveryCycle({ context, now: () => persistedAt });

    // A complete positive pending projection means the next wake could ensure
    // this deterministic custody again. The recovery window still removes the
    // live row and its content, but the producer-proof guard keeps the exact
    // logical tombstone as dedupe rather than physically forgetting it.
    expect(await deliveries.get(terminal.record.custodyId)).toBeNull();
    expect(deliveries.rows.get(terminal.record.custodyId)?.deleted).toBe(true);

    // A second/third wake distinguishes retained terminal custody from a
    // delete→fresh-ensure recreation: the latter would reach provider I/O.
    await runConversationOutwardDeliveryCycle({ context, now: () => persistedAt + 1 });
    await runConversationOutwardDeliveryCycle({ context, now: () => persistedAt + 2 });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('logically retires Session and Automation custody but preserves its tombstone until producer release', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    let persistedAt = 0;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const context = backgroundContext({
      state,
      deliveries,
      execute: vi.fn(async (action: string) => {
        if (action === 'session.transcript.get') throw new Error('projection remains unavailable');
        throw new Error(`Unexpected Action ${action}`);
      }),
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => persistedAt,
    });
    const obligations = [outwardObligation(), heldAutomationOutwardObligation()];
    const records = [];
    for (const obligation of obligations) {
      const admitted = await store.ensure(obligation);
      if (admitted.kind !== 'created') throw new Error('Expected retained custody fixture.');
      const terminal = await store.compareAndSwap({
        custodyId: admitted.record.custodyId,
        expectedRevision: admitted.record.revision,
        custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
      });
      if (terminal.kind !== 'updated') throw new Error('Expected terminal retained custody.');
      records.push(terminal.record);
    }

    persistedAt = THIRTY_DAYS_MS;
    await runConversationOutwardDeliveryCycle({ context, now: () => persistedAt });

    for (const record of records) {
      expect(await deliveries.get(record.custodyId)).toBeNull();
      const tombstone = deliveries.rows.get(record.custodyId);
      expect(tombstone?.deleted).toBe(true);
      expect((tombstone?.value.payload as Readonly<Record<string, unknown>>).content).toBeNull();
    }
  });

  it('rediscovers remaining live retention rows after a crash between direct forgets', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    let persistedAt = 0;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection({ failForgetAt: 2 });
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const context = backgroundContext({
      state,
      deliveries,
      execute: vi.fn(),
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => persistedAt,
    });
    const records = [];
    for (const controlId of ['crash-a', 'crash-b', 'crash-c']) {
      const admitted = await store.ensure(retireableControlOutwardObligation(controlId));
      if (admitted.kind !== 'created') throw new Error('Expected retained control custody.');
      const terminal = await store.compareAndSwap({
        custodyId: admitted.record.custodyId,
        expectedRevision: admitted.record.revision,
        custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
      });
      if (terminal.kind !== 'updated') throw new Error('Expected terminal control custody.');
      records.push(terminal.record);
    }

    persistedAt = THIRTY_DAYS_MS;
    await runConversationOutwardDeliveryCycle({ context, now: () => persistedAt });
    expect(records.filter((record) => deliveries.rows.has(record.custodyId))).toHaveLength(2);

    // The failed and not-yet-attempted rows remain live in the canonical due
    // index. A fresh supervisor pass needs no tombstone receipt or sweep log to
    // find and retire them.
    await runConversationOutwardDeliveryCycle({ context, now: () => persistedAt });
    for (const record of records) expect(deliveries.rows.has(record.custodyId)).toBe(false);
  });

  it('does not restart an exhausted retention sweep before the earliest retained row can age out', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    // A wall clock already past one whole window: the scanner answers a cutoff
    // before the epoch with an empty page and never reaches the index at all.
    const terminalAt = THIRTY_DAYS_MS + 100;
    let persistedAt = THIRTY_DAYS_MS;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const context = backgroundContext({
      state,
      deliveries,
      execute: vi.fn(async () => { throw new Error('Unexpected Action.'); }),
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => persistedAt,
    });
    const created = await store.ensure(retireableControlOutwardObligation('paced-retention'));
    if (created.kind !== 'created') throw new Error('Expected retained custody fixture.');
    persistedAt = terminalAt;
    const settled = await store.compareAndSwap({
      custodyId: created.record.custodyId,
      expectedRevision: created.record.revision,
      custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
    });
    if (settled.kind !== 'updated') throw new Error('Expected terminal custody fixture.');

    // Only the retention arm of the shared terminal index is counted; live
    // redrive scans the same index under the non-terminal prefix every wake.
    const query = deliveries.query.bind(deliveries);
    let retentionScans = 0;
    deliveries.query = (async (request: Parameters<typeof query>[0]) => {
      if (request.index === CHANNEL_DELIVERIES_INDEX_ID.byRetryDue && request.prefix?.[0] === true) {
        retentionScans += 1;
      }
      return await query(request);
    }) as typeof query;

    const exhausted = await runConversationOutwardDeliveryCycle({
      context,
      now: () => terminalAt + 1,
    });
    expect(retentionScans).toBe(1);
    expect(await deliveries.get(settled.record.custodyId)).not.toBeNull();

    // Nothing in the Account can have crossed the window one wake later, so the
    // exhausted pass must not walk the whole terminal index again.
    const paced = await runConversationOutwardDeliveryCycle({
      context,
      now: () => terminalAt + 1_000,
      ...(exhausted.nextRetentionSweep === undefined
        ? {}
        : { retentionSweep: exhausted.nextRetentionSweep }),
    });
    expect(retentionScans).toBe(1);

    // Positive twin: the deadline is the retained row's own eligibility, so
    // reclamation still happens on the first wake at that exact cutoff.
    await runConversationOutwardDeliveryCycle({
      context,
      now: () => terminalAt + THIRTY_DAYS_MS,
      ...(paced.nextRetentionSweep === undefined
        ? {}
        : { retentionSweep: paced.nextRetentionSweep }),
    });
    expect(retentionScans).toBe(2);
    expect(await deliveries.get(settled.record.custodyId)).toBeNull();
  });

  it('retains a terminal row after a direct-forget failure and retries at the recovery deadline', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    let persistedAt = 0;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection({ failForgetAt: 1 });
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const context = backgroundContext({
      state,
      deliveries,
      execute: vi.fn(async () => { throw new Error('Unexpected Action.'); }),
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => persistedAt,
    });
    const created = await store.ensure(retireableControlOutwardObligation('cas-loss-retention'));
    if (created.kind !== 'created') throw new Error('Expected retained custody fixture.');
    persistedAt = 100;
    const settled = await store.compareAndSwap({
      custodyId: created.record.custodyId,
      expectedRevision: created.record.revision,
      custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
    });
    if (settled.kind !== 'updated') throw new Error('Expected terminal custody fixture.');

    // A failed forget retains the row and uses the existing recovery deadline,
    // rather than the normal retention horizon or an immediate hot loop.
    const lost = await runConversationOutwardDeliveryCycle({
      context,
      now: () => 100 + THIRTY_DAYS_MS,
    });
    expect(await deliveries.get(settled.record.custodyId)).not.toBeNull();

    const early = await runConversationOutwardDeliveryCycle({
      context,
      now: () => 101 + THIRTY_DAYS_MS,
      ...(lost.nextRetentionSweep === undefined ? {} : { retentionSweep: lost.nextRetentionSweep }),
    });
    expect(await deliveries.get(settled.record.custodyId)).not.toBeNull();
    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 1_100 + THIRTY_DAYS_MS,
      ...(early.nextRetentionSweep === undefined ? {} : { retentionSweep: early.nextRetentionSweep }),
    });
    expect(await deliveries.get(settled.record.custodyId)).toBeNull();
  });

  it('retires only the Account-scoped Collection handle owned by the running supervisor', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    const seedAccount = async () => {
      let persistedAt = 0;
      const state = new MemoryCollection();
      const deliveries = new MemoryCollection();
      await state.put(connectionRow(), { expectedRevision: 'absent' });
      const context = backgroundContext({
        state,
        deliveries,
        execute: vi.fn(async () => { throw new Error('Unexpected Action.'); }),
        executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      });
      const store = createConversationOutwardDeliveryCollectionStore({
        stateCollection: state as never,
        deliveriesCollection: deliveries as never,
        signal: context.signal,
        now: () => persistedAt,
      });
      const created = await store.ensure(retireableControlOutwardObligation('account-scope-retention'));
      if (created.kind !== 'created') throw new Error('Expected Account custody fixture.');
      persistedAt = 100;
      const settled = await store.compareAndSwap({
        custodyId: created.record.custodyId,
        expectedRevision: created.record.revision,
        custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
      });
      if (settled.kind !== 'updated') throw new Error('Expected terminal Account custody fixture.');
      return { context, deliveries, custodyId: settled.record.custodyId };
    };
    const accountA = await seedAccount();
    const accountB = await seedAccount();

    await runConversationOutwardDeliveryCycle({
      context: accountA.context,
      now: () => 100 + THIRTY_DAYS_MS,
    });

    expect(await accountA.deliveries.get(accountA.custodyId)).toBeNull();
    expect(await accountB.deliveries.get(accountB.custodyId)).not.toBeNull();
  });

  it('renders the canonical bounded permission summary before writing custody or provider I/O', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(approvalBindingRow(), { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        return {
          requests: [{
            kind: 'permission',
            requestId: 'permission-request-1',
            turnId: 'turn-1',
            createdAtMs: 100,
            allowedScopes: ['request', 'session'],
            agentRequestSummary: {
              kind: 'permission',
              toolLabel: 'Bash',
              title: 'Run: git status --short',
              detail: 'Command: git',
            },
          }],
          truncated: false,
          nextCursor: null,
        };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(execute).toHaveBeenCalledWith(
      'session.permission.remote.pending.list',
      {
        sessionId: 'session-1',
        sourceRef: 'channels:binding:binding-1',
        sourceRevisionOrEpoch: '4:7',
      },
      { signal: context.signal },
    );
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect([...deliveries.rows.values()]).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          'connection-id': 'connection-1',
          'binding-id': 'binding-1',
          terminal: false,
          attention: false,
          payload: expect.objectContaining({
            source: {
              kind: 'permissionWait',
              sessionId: 'session-1',
              turnId: 'turn-1',
              requestId: 'permission-request-1',
            },
            routeAuthority: {
              connectionAuthorityEpoch: 4,
              bindingRevision: 1,
              bindingAuthorityEpoch: 7,
            },
            // The summary came from the canonical Session owner; Channels
            // renders it but does not parse raw tool input or decide scope.
            content: { text: 'Run: git status --short\nCommand: git\n'
              + 'Reply /allow permission-request-1 or /deny permission-request-1.' },
            state: 'ready',
          }),
        }),
      }),
    ]);
  });

  it('renders an above-cap question request as a full-form link without inline answers', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(bindingRow(), { expectedRevision: 'absent' });
    const url = 'https://app.example.test/session/session-1?serverId=home-one';
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return {
        requests: [{
          kind: 'user_action', requestId: 'question-five', turnId: 'turn-five', createdAtMs: 100,
          agentRequestSummary: { kind: 'user_action', questions: [], fullForm: { questionCount: 5, url } },
        }],
        truncated: false, nextCursor: null,
      };
      if (action === 'session.transcript.get') return {
        ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        scannedThroughSeq: 0, hasMore: false, items: [],
      };
      throw new Error(`Unexpected Action ${action}`);
    });
    const context = backgroundContext({
      state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
    });
    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    expect([...deliveries.rows.values()]).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ payload: expect.objectContaining({
        source: { kind: 'permissionWait', sessionId: 'session-1', requestId: 'question-five', turnId: 'turn-five' },
        content: { text: `Answer all 5 in Happier\n${url}` },
      }) }) }),
    ]);
  });

  it('renders every bounded AskUserQuestion semantic fact and one atomic answer syntax', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    // Questions use the canonical user-action owner and remain reachable even
    // when this binding does not grant remote permission-approval authority.
    await state.put(bindingRow(), { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        return {
          requests: [{
            kind: 'user_action',
            requestId: 'user-action-request-1',
            turnId: 'turn-user-action-1',
            createdAtMs: 100,
            agentRequestSummary: {
              kind: 'user_action',
              questions: [{
                question: 'Choose a release mode',
                selection: 'single',
                required: true,
                allowCustom: true,
                choices: ['Safe', 'Other'],
              }, {
                question: 'Any notes?',
                selection: 'text',
                required: false,
                allowCustom: true,
                choices: [],
              }],
            },
          }, {
            kind: 'permission',
            requestId: 'permission-request-1',
            turnId: 'turn-1',
            createdAtMs: 100,
            allowedScopes: ['request'],
            agentRequestSummary: {
              kind: 'permission',
              toolLabel: 'Bash',
              title: 'Run a private command',
              detail: 'Permission details must not be projected while approvals are off.',
            },
          }],
          truncated: false,
          nextCursor: null,
        };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const retainedPermission = await store.ensure(permissionWaitOutwardObligation());
    if (retainedPermission.kind !== 'created') {
      throw new Error('Expected retained permission custody fixture.');
    }

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect([...deliveries.rows.values()]).toHaveLength(2);
    expect([...deliveries.rows.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: expect.objectContaining({
          payload: expect.objectContaining({
            source: {
              kind: 'permissionWait',
              sessionId: 'session-1',
              turnId: 'turn-user-action-1',
              requestId: 'user-action-request-1',
            },
            content: { text: 'This Session needs your input:\n'
              + '1. Choose a release mode (required; select one; custom text allowed)\n'
              + '  1. Safe\n'
              + '  2. Other\n'
              + '2. Any notes? (optional; write text)\n'
              + 'Reply /answer user-action-request-1 [{"questionIndex":0,"values":["<answer>"]}] in one message. '
              + 'Use displayed choice labels, or free text only where allowed; include every required question.' },
          }),
        }),
      }),
      expect.objectContaining({
        value: expect.objectContaining({
          payload: expect.objectContaining({
            source: {
              kind: 'permissionWait',
              sessionId: 'session-1',
              turnId: 'turn-1',
              requestId: 'permission-request-1',
            },
            state: 'suppressed',
          }),
        }),
      }),
    ]));
  });

  it('C5 RED suppresses unattempted permission-wait custody when the exact request is no longer pending', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const logger = { warn: vi.fn() };
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(approvalBindingRow(), { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        return { requests: [], truncated: false, nextCursor: null };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: { kind: 'delivered', providerMessageIds: ['must-not-send'] },
      executionOrigin: providerTransportOrigin,
    }));
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
      logger,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(permissionWaitOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected permission-wait custody fixture');

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 100,
      createAttemptId: () => 'permission-wait-attempt-1',
    });

    expect(logger.warn).toHaveBeenCalledWith('[Channels] outward delivery supervisor work failed', {
      boundary: 'delivery-operation', connectionId: 'connection-1', bindingId: 'binding-1',
      code: 'channels_delivery_permissionNoLongerPending', retryable: false,
    });
    expect(execute).toHaveBeenCalledWith(
      'session.permission.remote.pending.list',
      {
        sessionId: 'session-1',
        sourceRef: 'channels:binding:binding-1',
        sourceRevisionOrEpoch: '4:7',
      },
      { signal: context.signal },
    );
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect([...deliveries.rows.values()][0]?.value.payload).toMatchObject({
      source: {
        kind: 'permissionWait',
        sessionId: 'session-1',
        turnId: 'turn-1',
        requestId: 'permission-request-1',
      },
      state: 'suppressed',
    });
  });

  it('does not recreate a retired permission notification from a still-pending complete list', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(approvalBindingRow(), { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        return {
          requests: [pendingPermissionRequest({
            requestId: 'permission-request-1',
            turnId: 'turn-1',
            createdAtMs: 100,
            allowedScopes: ['request', 'session'],
          })],
          truncated: false,
          nextCursor: null,
        };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(permissionWaitOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('Expected permission-wait custody fixture.');
    await deliveries.delete(admitted.record.custodyId, {
      expectedRevision: admitted.record.revision,
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(await deliveries.get(admitted.record.custodyId)).toBeNull();
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('retains unattempted permission-wait custody when the generic pending list is truncated', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(approvalBindingRow(), { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        return { requests: [], truncated: true };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(permissionWaitOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected permission-wait custody fixture');

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(deliveries.rows.get(admitted.record.custodyId)?.value).toMatchObject({
      terminal: false,
      payload: { state: 'ready', attemptCount: 0 },
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('does not suppress an unattempted permission wait that the pending projection reaches on a later page', async () => {
    // The canonical projection answers in bounded keyset pages. Reading only
    // the first page and calling the wait absent would retract a prompt the
    // person still has to answer.
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(approvalBindingRow(), { expectedRevision: 'absent' });
    const cursors: Array<string | null> = [];
    const execute = vi.fn(async (action: string, input: unknown) => {
      if (action === 'session.permission.remote.pending.list') {
        const cursor = (input as Readonly<{ cursor?: unknown }>).cursor;
        cursors.push(typeof cursor === 'string' ? cursor : null);
        if (cursor === undefined) {
          return {
            requests: [pendingPermissionRequest({
              requestId: 'older-request',
              turnId: 'turn-0',
              createdAtMs: 1,
              allowedScopes: ['request'],
            })],
            truncated: false,
            nextCursor: 'page-2',
          };
        }
        return {
          requests: [pendingPermissionRequest({
            requestId: 'permission-request-1',
            turnId: 'turn-1',
            createdAtMs: 2,
            allowedScopes: ['request'],
          })],
          truncated: false,
          nextCursor: null,
        };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(permissionWaitOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected permission-wait custody fixture');

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(cursors).toEqual([null, 'page-2']);
    // The wait is still pending, so it is redriven rather than suppressed. A
    // first-page-only read would find no match, read the complete-looking
    // negative as absence, and retire the prompt without a provider attempt.
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
    expect(deliveries.rows.get(admitted.record.custodyId)?.value).toMatchObject({
      payload: { state: 'outcomeUnknown' },
    });
  });

  it('retains attempted permission-wait custody after a complete exact negative pending list', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(approvalBindingRow(), { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        return { requests: [], truncated: false, nextCursor: null };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(permissionWaitOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected permission-wait custody fixture');
    const claimed = await store.compareAndSwap({
      custodyId: admitted.record.custodyId,
      expectedRevision: admitted.record.revision,
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'permission-wait-attempt-1',
        startedAt: 1,
        providerMessageIds: [],
      },
    });
    if (claimed.kind !== 'updated') throw new Error('expected attempted permission-wait custody fixture');

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(deliveries.rows.get(admitted.record.custodyId)?.value).toMatchObject({
      terminal: false,
      payload: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'permission-wait-attempt-1',
      },
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('retains permission-wait custody when the generic pending list is unavailable', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(approvalBindingRow(), { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        throw new Error('permission service unavailable');
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(permissionWaitOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected permission-wait custody fixture');

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(deliveries.rows.get(admitted.record.custodyId)?.value).toMatchObject({
      terminal: false,
      payload: { state: 'ready', attemptCount: 0 },
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('retains permission-wait custody when the current binding source has advanced', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    const currentBinding = approvalBindingRow();
    await state.put({
      ...currentBinding,
      payload: {
        ...currentBinding.payload,
        authorityEpoch: 8,
      },
    }, { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        return { requests: [], truncated: false, nextCursor: null };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(permissionWaitOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected permission-wait custody fixture');

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(deliveries.rows.get(admitted.record.custodyId)?.value).toMatchObject({
      terminal: false,
      payload: { state: 'ready', attemptCount: 0 },
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('uses the complete request tuple when the same request ID is pending under a different turn', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(connectionRow(), { expectedRevision: 'absent' });
    await state.put(approvalBindingRow(), { expectedRevision: 'absent' });
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') {
        return {
          requests: [pendingPermissionRequest({
            requestId: 'permission-request-1',
            turnId: 'turn-2',
            createdAtMs: 100,
            allowedScopes: ['request'],
          })],
          truncated: false,
          nextCursor: null,
        };
      }
      if (action === 'session.transcript.get') {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 0,
          hasMore: false,
          items: [],
        };
      }
      throw new Error(`Unexpected Action ${action}`);
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(permissionWaitOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected permission-wait custody fixture');

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect([...deliveries.rows.values()].map((row) => row.value.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: {
          kind: 'permissionWait',
          sessionId: 'session-1',
          turnId: 'turn-1',
          requestId: 'permission-request-1',
        },
        state: 'suppressed',
      }),
      expect.objectContaining({
        source: {
          kind: 'permissionWait',
          sessionId: 'session-1',
          turnId: 'turn-2',
          requestId: 'permission-request-1',
        },
        state: 'ready',
      }),
    ]));
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('settles only the finalizing binding’s ready custody before direct-delete cleanup', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(bindingDeleteConnectionRow(), { expectedRevision: 'absent' });
    await state.put(finalizingBindingDeleteRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const custodyStore = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 1,
    });
    const finalizingCustody = await custodyStore.ensure(bindingDeleteOutwardObligation(
      BINDING_DELETE_BINDING_ID,
      'channels:delivery:v1:binding-delete-target',
    ));
    const unrelatedCustody = await custodyStore.ensure(bindingDeleteOutwardObligation(
      'binding-unrelated',
      'channels:delivery:v1:binding-delete-unrelated',
    ));
    if (finalizingCustody.kind !== 'created' || unrelatedCustody.kind !== 'created') {
      throw new Error('Expected ready custody for direct binding deletion.');
    }
    const execute = vi.fn();
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });

    await finalizeConversationConnectionDeletesForInvocation(context as never);

    expect(deliveries.rows.get(finalizingCustody.record.custodyId)?.value).toMatchObject({
      payload: { state: 'suppressed', providerMessageIds: [] },
      terminal: true,
      attention: false,
    });
    expect(deliveries.rows.get(unrelatedCustody.record.custodyId)?.value).toMatchObject({
      payload: { state: 'ready' },
      terminal: false,
    });
    expect(state.rows.get(BINDING_DELETE_BINDING_ID)?.deleted).not.toBe(true);
  });

  it('retains a direct-delete binding while its outward custody may have reached the provider', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await state.put(bindingDeleteConnectionRow(), { expectedRevision: 'absent' });
    await state.put(finalizingBindingDeleteRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const custodyStore = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 1,
    });
    const custody = await custodyStore.ensure(bindingDeleteOutwardObligation(
      BINDING_DELETE_BINDING_ID,
      'channels:delivery:v1:binding-delete-attempting',
    ));
    if (custody.kind !== 'created') throw new Error('Expected retained direct-delete custody.');
    const claimed = await custodyStore.compareAndSwap({
      custodyId: custody.record.custodyId,
      expectedRevision: custody.record.revision,
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'binding-delete-attempt-1',
        startedAt: 1,
        providerMessageIds: [],
      },
    });
    if (claimed.kind !== 'updated') throw new Error('Expected direct-delete custody claim.');
    const context = backgroundContext({
      state,
      deliveries,
      execute: vi.fn(),
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
    });

    await finalizeConversationConnectionDeletesForInvocation(context as never);

    expect(state.rows.get(BINDING_DELETE_BINDING_ID)?.deleted).not.toBe(true);
    expect(deliveries.rows.get(custody.record.custodyId)?.value).toMatchObject({
      payload: { state: 'attempting', attemptId: 'binding-delete-attempt-1' },
      terminal: false,
    });
  });

  it('terminalizes direct-delete ingress as stale authority before removing the finalizing binding', async () => {
    const state = new MemoryCollection({ enforceUniqueBatchRows: true });
    const deliveries = new MemoryCollection();
    const obligation = bindingDeleteIngressObligationRow();
    await state.put(bindingDeleteConnectionRow(), { expectedRevision: 'absent' });
    await state.put(finalizingBindingDeleteRow(), { expectedRevision: 'absent' });
    await state.put(obligation, { expectedRevision: 'absent' });
    const context = backgroundContext({
      state,
      deliveries,
      execute: vi.fn(),
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
    });

    await finalizeConversationConnectionDeletesForInvocation(context as never);

    expect(state.rows.get(obligation.id)?.value).toMatchObject({
      terminal: true,
      attention: true,
      payload: {
        lifecycle: { phase: 'terminal', attemptCount: 0, dueAt: null },
        disposition: 'staleAuthority',
        nonAdmission: { reason: 'staleAuthority', senderFeedbackEligible: false },
      },
    });
    expect(state.rows.get(BINDING_DELETE_BINDING_ID)?.deleted).not.toBe(true);

    await finalizeConversationConnectionDeletesForInvocation(context as never);

    expect(state.rows.get(obligation.id)?.deleted).toBe(true);
    expect(state.rows.get(BINDING_DELETE_BINDING_ID)?.deleted).not.toBe(true);

    await finalizeConversationConnectionDeletesForInvocation(context as never);

    expect(state.rows.get(BINDING_DELETE_BINDING_ID)?.deleted).toBe(true);
  });

  it('removes deterministic binding artifacts only with the settled finalizing binding', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const connection = bindingDeleteConnectionRow();
    await state.put(connection, { expectedRevision: 'absent' });
    await state.put(finalizingBindingDeleteRow(), { expectedRevision: 'absent' });
    const frontier = createConversationSessionProjectionFrontierRow({
      bindingId: BINDING_DELETE_BINDING_ID,
      targetSessionId: 'session-1',
      transcriptCursor: null,
      lastScannedSeq: 0,
      revision: 1,
      now: 0,
    });
    await state.put(frontier, { expectedRevision: 'absent' });
    const rotationId = await deriveConversationSessionRotationRowId({
      routingIdentityKey: connection.payload.routingIdentityKey,
      connectionId: BINDING_DELETE_CONNECTION_ID,
      bindingId: BINDING_DELETE_BINDING_ID,
    });
    await state.put({
      id: rotationId,
      'record-kind': 'session-rotation',
      v: 1,
      'binding-id': BINDING_DELETE_BINDING_ID,
      'created-at': 0,
      'updated-at': 0,
      payload: {
        commandOccurrenceId: 'occurrence-binding-delete',
        expectedOldSessionId: 'session-1',
        creationKey: 'channels:new-session:v1:binding-delete',
        initialPromptIdempotencyKey: null,
        revision: 1,
      },
    }, { expectedRevision: 'absent' });
    const context = backgroundContext({
      state,
      deliveries,
      execute: vi.fn(),
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
    });

    await finalizeConversationConnectionDeletesForInvocation(context as never);

    expect(state.rows.get(frontier.id)?.deleted).toBe(true);
    expect(state.rows.get(rotationId)?.deleted).toBe(true);
    expect(state.rows.get(BINDING_DELETE_BINDING_ID)?.deleted).toBe(true);
    expect(state.rows.get(BINDING_DELETE_CONNECTION_ID)?.deleted).not.toBe(true);
  });

  it('settles safe custody before tombstoning finalizing connection state and its exact reservation', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const reservation = await finalizingReservationRow();
    await state.put({
      id: 'connection-identity-key',
      'record-kind': 'connection-identity-key',
      v: 1,
      'created-at': 0,
      'updated-at': 0,
      payload: { connectionIdentityKey: FINALIZING_CONNECTION_IDENTITY_KEY },
    }, { expectedRevision: 'absent' });
    await state.put(finalizingConnectionRow(), { expectedRevision: 'absent' });
    await state.put(reservation, { expectedRevision: 'absent' });
    await state.put(finalizingBindingRow(), { expectedRevision: 'absent' });
    await state.put(createConversationSessionProjectionFrontierRow({
      bindingId: FINALIZING_BINDING_ID,
      targetSessionId: 'session-1',
      transcriptCursor: null,
      lastScannedSeq: 0,
      revision: 1,
      now: 0,
    }), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const custodyStore = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 1,
    });
    const custody = await custodyStore.ensure(finalizingOutwardObligation());
    if (custody.kind !== 'created') throw new Error('Expected safe finalization custody.');
    const delivered = await custodyStore.ensure({
      ...finalizingOutwardObligation(),
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-1',
        semanticItemId: 'semantic-finalizing-delivered',
      },
      deliveryKey: 'channels:delivery:v1:finalizing-delivered',
    });
    if (delivered.kind !== 'created') throw new Error('Expected retained delivered custody.');
    const deliveredSettlement = await custodyStore.compareAndSwap({
      custodyId: delivered.record.custodyId,
      expectedRevision: delivered.record.revision,
      custody: {
        state: 'delivered',
        attemptCount: 1,
        providerMessageIds: ['provider-message-finalizing'],
      },
    });
    if (deliveredSettlement.kind !== 'updated') throw new Error('Expected retained delivered custody settlement.');
    const execute = vi.fn(async () => {
      throw new Error('Finalizing rows must not project a transcript.');
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => {
      throw new Error('Finalizing rows must not issue a provider delivery.');
    });
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });

    const foreignContext = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin,
      executionRouting: { ...getPluginMachineExecutionRouting(providerTransportOrigin), pluginId: 'happier.channels', machineId: 'foreign-machine' } });
    const beforeState = structuredClone([...state.rows]);
    const beforeCustody = structuredClone([...deliveries.rows]);
    await runConversationOutwardDeliveryCycle({ context: foreignContext, now: () => 10 });
    expect([...state.rows]).toEqual(beforeState);
    expect([...deliveries.rows]).toEqual(beforeCustody);

    await runConversationOutwardDeliveryCycle({ context, now: () => 10 });
    expect(deliveries.rows.get(custody.record.custodyId)?.value).toMatchObject({
      payload: { state: 'connectionDeleted', providerMessageIds: [] },
      terminal: true,
      attention: false,
    });
    expect(state.rows.get(FINALIZING_CONNECTION_ID)?.deleted).not.toBe(true);
    expect(state.rows.get(FINALIZING_BINDING_ID)?.deleted).not.toBe(true);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();

    await runConversationOutwardDeliveryCycle({ context, now: () => 11 });
    expect(state.rows.get(FINALIZING_BINDING_ID)?.deleted).toBe(true);
    expect(state.rows.get(createConversationSessionProjectionFrontierRowId(FINALIZING_BINDING_ID))?.deleted).toBe(true);
    expect(state.rows.get(FINALIZING_CONNECTION_ID)?.deleted).not.toBe(true);
    expect(state.rows.get(reservation.id)?.deleted).not.toBe(true);

    await runConversationOutwardDeliveryCycle({ context, now: () => 12 });
    expect(state.rows.get(FINALIZING_CONNECTION_ID)?.deleted).toBe(true);
    expect(state.rows.get(reservation.id)?.deleted).toBe(true);
    expect(deliveries.rows.get(delivered.record.custodyId)?.value).toMatchObject({
      payload: { state: 'delivered', providerMessageIds: ['provider-message-finalizing'] },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('retains finalizing state when custody may already have caused a provider effect', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const reservation = await finalizingReservationRow();
    await state.put({
      id: 'connection-identity-key',
      'record-kind': 'connection-identity-key',
      v: 1,
      'created-at': 0,
      'updated-at': 0,
      payload: { connectionIdentityKey: FINALIZING_CONNECTION_IDENTITY_KEY },
    }, { expectedRevision: 'absent' });
    await state.put(finalizingConnectionRow(), { expectedRevision: 'absent' });
    await state.put(reservation, { expectedRevision: 'absent' });
    await state.put(finalizingBindingRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const custodyStore = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 1,
    });
    const custody = await custodyStore.ensure(finalizingOutwardObligation());
    if (custody.kind !== 'created') throw new Error('Expected ambiguous finalization custody.');
    const claimed = await custodyStore.compareAndSwap({
      custodyId: custody.record.custodyId,
      expectedRevision: custody.record.revision,
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'attempt-finalizing',
        startedAt: 1,
        providerMessageIds: [],
      },
    });
    if (claimed.kind !== 'updated') throw new Error('Expected ambiguous finalization custody claim.');
    const execute = vi.fn(async () => {
      throw new Error('Finalizing rows must not project a transcript.');
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => {
      throw new Error('Finalizing rows must not issue a provider delivery.');
    });
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });

    await runConversationOutwardDeliveryCycle({ context, now: () => 10 });

    expect(state.rows.get(FINALIZING_CONNECTION_ID)?.deleted).not.toBe(true);
    expect(state.rows.get(reservation.id)?.deleted).not.toBe(true);
    expect(state.rows.get(FINALIZING_BINDING_ID)?.deleted).not.toBe(true);
    expect(deliveries.rows.get(custody.record.custodyId)?.value).toMatchObject({
      payload: { state: 'attempting', attemptId: 'attempt-finalizing' },
      terminal: false,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('surfaces a rejected transcript cursor instead of retrying it invisibly forever', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async (action: string) => {
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      throw new PluginError({
        code: 'invalid_cursor',
        message: 'secret transcript cursor detail',
      });
    });
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      logger,
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    // A typed history gap never throws, so the cycle looks healthy: this is the
    // only signal that the binding can no longer advance.
    expect(logger.warn).toHaveBeenCalledWith(
      '[Channels] outward delivery supervisor work failed',
      { boundary: 'transcript-projection', bindingId: 'binding-1', code: 'channels_projection_cursorRejected', retryable: false },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');

    const frontier = state.rows.get('projection-frontier:binding-1');
    expect(frontier?.value).toMatchObject({
      payload: {
        transcriptCursor: { kind: 'historyGap', reason: 'cursorRejected', reportedAt: 100 },
      },
    });
    execute.mockClear();
    logger.warn.mockClear();
    await runConversationOutwardDeliveryCycle({ context, now: () => 101 });
    expect(execute).not.toHaveBeenCalledWith(
      'session.transcript.get',
      expect.anything(),
      expect.anything(),
    );
    expect(logger.warn).toHaveBeenCalledWith('[Channels] outward delivery supervisor work failed', {
      boundary: 'transcript-projection', bindingId: 'binding-1', code: 'channels_projection_historyGap', retryable: false,
    });
  });

  it('stays quiet while the transcript frontier advances normally', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-1',
        scannedThroughSeq: 0,
        hasMore: false,
        items: [],
      };
    });
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      logger,
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('C3 RED logs a production delete-finalization failure without retaining error text', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-1',
        scannedThroughSeq: 0,
        hasMore: false,
        items: [],
      };
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const collections = new Map<string, MemoryCollection>([
      [CHANNEL_STATE_COLLECTION.id, state],
      [CHANNEL_DELIVERIES_COLLECTION.id, deliveries],
    ]);
    let stateCollectionLookups = 0;
    const collection = (definition: Readonly<{ id: string }>): MemoryCollection | undefined => {
      if (definition.id === CHANNEL_STATE_COLLECTION.id) {
        stateCollectionLookups += 1;
        // The first lookup is the cycle's store, the second is the
        // delete-finalization owner. The next wake must re-read normally.
        if (stateCollectionLookups === 2) {
          throw new Error('secret delete-finalization detail');
        }
      }
      return collections.get(definition.id);
    };
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
      logger,
      collection,
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(logger.warn).toHaveBeenCalledWith(
      '[Channels] outward delivery supervisor work failed',
      { boundary: 'delete-finalization' },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    expect(execute).toHaveBeenCalled();

    await runConversationOutwardDeliveryCycle({ context, now: () => 101 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('treats unavailable fresh-Account collections as inactive across the whole outward cycle', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async () => ({ items: [] }));
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const refusal = new PluginError({
      code: 'collection_unavailable',
      message: 'secret Account Collection rejection detail',
      retryable: false,
    });
    vi.spyOn(state, 'query').mockRejectedValue(refusal);
    vi.spyOn(deliveries, 'query').mockRejectedValue(refusal);
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
      logger,
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  });

  it('C3 RED logs an internal delete-finalization census query failure once and retries it next wake', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-1',
        scannedThroughSeq: 0,
        hasMore: false,
        items: [],
      };
    });
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      logger,
    });
    const originalQuery = state.query.bind(state);
    let queryCalls = 0;
    vi.spyOn(state, 'query').mockImplementation(async (input) => {
      queryCalls += 1;
      if (queryCalls === 1) throw new Error('secret internal finalization query detail');
      return await originalQuery(input);
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(logger.warn).toHaveBeenCalledWith(
      '[Channels] outward delivery supervisor work failed',
      { boundary: 'delete-finalization' },
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');

    await runConversationOutwardDeliveryCycle({ context, now: () => 101 });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalled();
  });

  it('C3 RED logs an internal per-connection finalizer failure once and retries the retained row next wake', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const reservation = await finalizingReservationRow();
    await state.put({
      id: 'connection-identity-key',
      'record-kind': 'connection-identity-key',
      v: 1,
      'created-at': 0,
      'updated-at': 0,
      payload: { connectionIdentityKey: FINALIZING_CONNECTION_IDENTITY_KEY },
    }, { expectedRevision: 'absent' });
    await state.put(finalizingConnectionRow(), { expectedRevision: 'absent' });
    await state.put(reservation, { expectedRevision: 'absent' });
    const logger = { warn: vi.fn() };
    const context = backgroundContext({
      state,
      deliveries,
      execute: vi.fn(),
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
      logger,
    });
    const originalBatch = state.batch.bind(state);
    let batchCalls = 0;
    vi.spyOn(state, 'batch').mockImplementation(async (operations) => {
      batchCalls += 1;
      if (batchCalls === 1) throw new Error('secret per-connection finalizer detail');
      return await originalBatch(operations);
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(logger.warn).toHaveBeenCalledWith(
      '[Channels] outward delivery supervisor work failed',
      { boundary: 'delete-finalization' },
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    expect(state.rows.get(FINALIZING_CONNECTION_ID)?.deleted).not.toBe(true);
    expect(state.rows.get(reservation.id)?.deleted).not.toBe(true);

    await runConversationOutwardDeliveryCycle({ context, now: () => 101 });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(state.rows.get(FINALIZING_CONNECTION_ID)?.deleted).toBe(true);
    expect(state.rows.get(reservation.id)?.deleted).toBe(true);
  });

  it('C3 RED logs a production delivery scan failure once and redrives retained custody on the next wake', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-1',
        scannedThroughSeq: 0,
        hasMore: false,
        items: [],
      };
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: { kind: 'delivered', providerMessageIds: ['provider-message-scan-retry'] },
      executionOrigin: providerTransportOrigin,
    }));
    const logger = { warn: vi.fn() };
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
      logger,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(outwardObligation());
    if (admitted.kind !== 'created') throw new Error('Expected retained outward custody.');
    const originalQuery = deliveries.query.bind(deliveries);
    let queryCalls = 0;
    vi.spyOn(deliveries, 'query').mockImplementation(async (input) => {
      queryCalls += 1;
      if (queryCalls === 1) throw new Error('secret delivery scan detail');
      return await originalQuery(input);
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100, createAttemptId: () => 'scan-retry-1' });

    expect(logger.warn).toHaveBeenCalledWith(
      '[Channels] outward delivery supervisor work failed',
      { boundary: 'delivery-scan' },
    );
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();

    await runConversationOutwardDeliveryCycle({ context, now: () => 101, createAttemptId: () => 'scan-retry-2' });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
    expect(deliveries.rows.get(admitted.record.custodyId)?.value).toMatchObject({
      payload: { state: 'delivered', providerMessageIds: ['provider-message-scan-retry'] },
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  });

  it('C3 RED logs a production redrive failure with bounded route identity and retries it next wake', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-1',
        scannedThroughSeq: 0,
        hasMore: false,
        items: [],
      };
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: { kind: 'delivered', providerMessageIds: ['provider-message-redrive-retry'] },
      executionOrigin: providerTransportOrigin,
    }));
    const logger = { warn: vi.fn() };
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
      logger,
    });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(outwardObligation());
    if (admitted.kind !== 'created') throw new Error('Expected retained outward custody.');
    let attemptIdCalls = 0;
    const createAttemptId = (): string => {
      attemptIdCalls += 1;
      if (attemptIdCalls === 1) throw new Error('secret redrive detail');
      return `redrive-retry-${attemptIdCalls}`;
    };

    await runConversationOutwardDeliveryCycle({ context, now: () => 100, createAttemptId });

    expect(logger.warn).toHaveBeenCalledWith(
      '[Channels] outward delivery supervisor work failed',
      {
        boundary: 'delivery-operation',
        connectionId: 'connection-1',
        bindingId: 'binding-1',
      },
    );
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();

    await runConversationOutwardDeliveryCycle({ context, now: () => 101, createAttemptId });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
    expect(deliveries.rows.get(admitted.record.custodyId)?.value).toMatchObject({
      payload: { state: 'delivered', providerMessageIds: ['provider-message-redrive-retry'] },
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  });

  it('observes a typed frontier read failure once and recovers on the existing cadence', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { warn: vi.fn() };
    const get = state.get.bind(state);
    let unavailable = true;
    vi.spyOn(state, 'get').mockImplementation(async (id) => {
      if (unavailable && id === 'projection-frontier:binding-1') throw new Error('secret storage detail');
      return await get(id);
    });
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage()
      : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        items: [], scannedThroughSeq: 0, hasMore: false });
    const context = backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(), logger });
    expect((await runConversationOutwardDeliveryCycle({ context, now: () => 100 })).nextWakeAt).toBe(1_100);
    expect(logger.warn.mock.calls).toEqual([['[Channels] outward delivery supervisor work failed', {
      boundary: 'transcript-projection', bindingId: 'binding-1',
      code: 'channels_projection_frontierUnavailable', retryable: true,
    }]]);
    expect(deliveries.rows.size).toBe(0);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    unavailable = false;
    logger.warn.mockClear();
    await runConversationOutwardDeliveryCycle({ context, now: () => 1_100 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('observes an approval-deferred transcript read without treating it as an empty page or retrying the approval', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage()
      : { kind: 'approval_request_created', artifactId: 'private-approval', actionId: 'session.transcript.get' });
    const context = backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(), logger });
    const result = await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    expect(result.nextWakeAt).toBeUndefined();
    expect(logger.warn.mock.calls).toEqual([['[Channels] outward delivery supervisor work failed', {
      boundary: 'transcript-projection', bindingId: 'binding-1',
      code: 'channels_projection_transcriptUnavailable', retryable: false,
    }]]);
    expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({ lastScannedSeq: 0 });
    expect(deliveries.rows.size).toBe(0);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-approval');
  });

  it('records a page with no eligible reply once without warning or scheduling another empty read', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage()
      : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        items: [], scannedThroughSeq: 0, hasMore: false });
    const context = backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(), logger });
    expect((await runConversationOutwardDeliveryCycle({ context, now: () => 100 })).nextWakeAt).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info.mock.calls).toEqual([['[Channels] outward delivery supervisor work completed', {
      boundary: 'transcript-projection', bindingId: 'binding-1', code: 'channels_projection_idle', retryable: false,
    }]]);
  });

  it.each([{ consumedInputs: [] }, { consumedInputs: [{ localId: 'other-input', origin: { v: 1, producer: 'pluginSession', actor: 'machine',
    sourceAuthority: { mediatorPluginId: 'happier.channels', sourceRef: 'channels:binding:other-binding' } } }] }])(
    'records an ineligible repliesOnly answer before advancing its frontier (%j)', async ({ consumedInputs }) => {
      const state = new MemoryCollection();
      const deliveries = new MemoryCollection();
      await seedProjectionState(state);
      const binding = state.rows.get('binding-1');
      if (!binding || !isChannelStateJsonRecord(binding.value.payload)) throw new Error('Expected binding');
      await state.put({ ...binding.value, payload: { ...binding.value.payload,
        target: { ...sessionTarget, policy: { ...sessionTarget.policy, deliveryMode: 'repliesOnly' } },
      } }, { expectedRevision: binding.revision });
      const logger = { warn: vi.fn(), info: vi.fn() };
      const execute = vi.fn(async (action: string, input: Readonly<{ cursor?: string | null }>) => action === 'session.permission.remote.pending.list'
        ? emptyPendingPermissionPage()
        : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
          items: input.cursor === '5' ? [] : [{ kind: 'assistantText', sessionId: 'session-1', seq: 5,
            itemId: 'ineligible-final', turnId: 'ineligible-turn', final: 'completed', text: 'private answer', consumedInputs }],
          scannedThroughSeq: 5, nextCursor: '5', hasMore: false });
      const context = backgroundContext({ state, deliveries, execute, logger,
        executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn() });
      expect((await runConversationOutwardDeliveryCycle({ context, now: () => 100 })).nextWakeAt).toBeUndefined();
      expect(logger.info.mock.calls).toContainEqual(['[Channels] outward delivery supervisor work completed', {
        boundary: 'transcript-projection', bindingId: 'binding-1',
        code: 'channels_projection_repliesOnlyInputNotConsumed', retryable: false,
        semanticItemId: 'ineligible-final', turnId: 'ineligible-turn', seq: 5, consumedInputCount: consumedInputs.length,
      }]);
      expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({ lastScannedSeq: 5 });
      expect(deliveries.rows.size).toBe(0);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain('private answer');
      logger.info.mockClear();
      await runConversationOutwardDeliveryCycle({ context, now: () => 101 });
      expect(logger.info.mock.calls).toEqual([['[Channels] outward delivery supervisor work completed', {
        boundary: 'transcript-projection', bindingId: 'binding-1', code: 'channels_projection_idle', retryable: false,
      }]]);
    },
  );

  it.each([
    { name: 'second answer after a delivered frontier', firstSeq: 5, finalSeq: 9 },
    { name: 'answer to an attachment-backed shareable user item', firstSeq: 0, finalSeq: 5 },
  ])('delivers $name exactly once through the real projection and custody owners', async ({ firstSeq, finalSeq }) => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const binding = state.rows.get('binding-1');
    if (binding === undefined || !isChannelStateJsonRecord(binding.value.payload)) throw new Error('Expected binding');
    await state.put({ ...binding.value, payload: { ...binding.value.payload,
      target: { ...sessionTarget, policy: { ...sessionTarget.policy, deliveryMode: 'repliesOnly' } },
    } }, { expectedRevision: binding.revision });
    // Reduced public page shapes: user3/final5, then user7/final9. Files do
    // not cross this closed boundary; only their shareable user text does.
    // Source authority is the plugin-scoped contract, absent from CLI reads.
    let publishedSeq = firstSeq || finalSeq;
    const execute = vi.fn(async (action: string, input: Readonly<{ cursor?: string | null }>) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      return {
        ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        scannedThroughSeq: publishedSeq, nextCursor: String(publishedSeq), hasMore: false,
        items: input.cursor === String(publishedSeq) ? [] : [{
          kind: 'userText', sessionId: 'session-1', seq: publishedSeq - 2,
          itemId: `input-${publishedSeq}`, localId: `input-${publishedSeq}`, text: 'Question',
          origin: { v: 1, producer: 'pluginSession', actor: 'machine',
            sourceAuthority: { mediatorPluginId: 'happier.channels', sourceRef: 'channels:binding:binding-1' } },
        }, {
          kind: 'assistantText', sessionId: 'session-1', seq: publishedSeq, itemId: `final-${publishedSeq}`,
          turnId: `turn-${publishedSeq}`, final: 'completed', text: 'Answer',
          consumedInputs: [{ localId: `input-${publishedSeq}`, origin: {
            v: 1, producer: 'pluginSession', actor: 'machine',
            sourceAuthority: { mediatorPluginId: 'happier.channels', sourceRef: 'channels:binding:binding-1' },
          } }],
        }],
      };
    });
    const deliver = vi.fn(async () => ({ result: { kind: 'delivered', providerMessageIds: [`receipt-${publishedSeq}`] },
      executionOrigin: providerTransportOrigin }));
    const context = backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: deliver });
    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    if (firstSeq > 0) {
      expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({ lastScannedSeq: firstSeq });
      publishedSeq = finalSeq;
      await runConversationOutwardDeliveryCycle({ context, now: () => 101 });
    }
    await runConversationOutwardDeliveryCycle({ context, now: () => 102 });
    expect(deliver).toHaveBeenCalledTimes(firstSeq > 0 ? 2 : 1);
    expect([...deliveries.rows.values()].map(row => row.value.payload)).toEqual(
      (firstSeq > 0 ? [firstSeq, finalSeq] : [finalSeq]).map(seq => expect.objectContaining({
        state: 'delivered', providerMessageIds: [`receipt-${seq}`],
      })),
    );
    expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({ lastScannedSeq: finalSeq });
  });

  it.each([
    { state: 'delivered', result: { kind: 'delivered', providerMessageIds: ['private-receipt'] } },
    { state: 'notDelivered', result: { kind: 'notDelivered', retry: 'never', code: 'senderUntrusted' } },
    { state: 'retryDue', result: { kind: 'notDelivered', retry: 'after', retryAfterMs: 5_000 } },
    { state: 'outcomeUnknown', result: { kind: 'outcomeUnknown', providerMessageIds: ['private-receipt'], code: 'sentCopyUnconfirmed' } },
    { state: 'partial', result: { kind: 'partial', providerMessageIds: ['private-receipt'], failedChunk: 1, retrySafe: false } },
    { state: 'retryDue', result: { kind: 'notReady', reason: 'network', diagnostic: 'private provider error and address' } },
  ] satisfies readonly { state: string; result: ConversationDeliveryResultV1 }[])(
    'records a $state attempt settlement once with content-free provider evidence', async ({ state: settledState, result }) => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage()
      : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        items: [{ kind: 'assistantText', sessionId: 'session-1', seq: 5, itemId: 'final-5',
          turnId: 'turn-5', final: 'completed', text: 'private answer', consumedInputs: [] }],
        scannedThroughSeq: 5, nextCursor: '5', hasMore: false });
    const deliver = vi.fn(async () => ({ result, executionOrigin: providerTransportOrigin }));
    const context = backgroundContext({ state, deliveries, execute, logger,
      executeAdmittedTargetedOperationWithExecutionOrigin: deliver });
    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    const row = [...deliveries.rows.values()][0];
    const records = () => [...logger.info.mock.calls, ...logger.warn.mock.calls]
      .map(call => call[1]).filter(detail => detail.custodyId !== undefined);
    expect(records()).toEqual([{
      boundary: 'transcript-projection', bindingId: 'binding-1',
      code: `channels_projection_${settledState}`, retryable: settledState === 'retryDue',
      custodyId: row?.rowId, attemptCount: 1, settledState,
      settlementStatus: 'settled', providerOperation: 'deliver', providerResultKind: result.kind,
      ...('retry' in result ? { providerRetry: result.retry } : {}),
      ...('reason' in result ? { providerResultCode: result.reason } : {}),
      ...('code' in result ? { providerResultCode: result.code } : {}),
      ...(settledState === 'retryDue' ? { retryNotBefore: result.kind === 'notReady' ? 1_100 : 5_100 } : {}),
    }]);
    expect(row?.value.payload).toMatchObject({ state: settledState, attemptCount: 1 });
    // A blocked projection can rejoin this same row before retry is due;
    // terminal rows can also be revisited if their frontier write was lost.
    const frontier = state.rows.get('projection-frontier:binding-1');
    if (frontier === undefined) throw new Error('Expected projection frontier');
    await state.put(createConversationSessionProjectionFrontierRow({
      bindingId: 'binding-1', targetSessionId: 'session-1', transcriptCursor: null,
      lastScannedSeq: 0, revision: 1, now: 0,
    }), { expectedRevision: frontier.revision });
    await runConversationOutwardDeliveryCycle({ context, now: () => 101 });
    expect(records()).toHaveLength(1);
    expect(deliver).toHaveBeenCalledOnce();
    const serialized = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
    for (const secret of ['private answer', 'private-receipt', 'private provider error and address']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('records provider acceptance even when cancellation prevents durable settlement', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const controller = new AbortController();
    const logger = { warn: vi.fn() };
    const context = { ...backgroundContext({ state, deliveries, execute: vi.fn(), logger,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(async () => {
        controller.abort();
        return { result: { kind: 'delivered', providerMessageIds: ['private-receipt'] }, executionOrigin: providerTransportOrigin };
      }),
    }), signal: controller.signal };
    const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state as never,
      deliveriesCollection: deliveries as never, signal: context.signal, now: () => 0 });
    const admitted = await store.ensure(outwardObligation());
    if (admitted.kind !== 'created') throw new Error('Expected retained custody');
    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    expect(logger.warn.mock.calls.map(call => call[1])).toEqual([{
      boundary: 'delivery-operation', connectionId: 'connection-1', bindingId: 'binding-1',
      code: 'channels_delivery_delivered', retryable: true,
      custodyId: admitted.record.custodyId, attemptCount: 1, settledState: 'delivered',
      settlementStatus: 'settlementPending', providerOperation: 'deliver', providerResultKind: 'delivered',
    }]);
    expect(deliveries.rows.get(admitted.record.custodyId)?.value.payload).toMatchObject({ state: 'attempting' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-receipt');
  });

  it('records a retained delivery terminal refusal through the same work record without needing a projection item', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async (action: string) => action === 'session.permission.remote.pending.list'
      ? emptyPendingPermissionPage()
      : { ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        items: [], scannedThroughSeq: 0, hasMore: false });
    const context = backgroundContext({ state, deliveries, execute, logger,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(async () => ({
        result: { kind: 'notDelivered', retry: 'never' }, executionOrigin: providerTransportOrigin,
      })) });
    const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state as never,
      deliveriesCollection: deliveries as never, signal: context.signal, now: () => 0 });
    const admitted = await store.ensure(outwardObligation());
    if (admitted.kind !== 'created') throw new Error('Expected retained custody');
    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    expect(logger.warn.mock.calls).toEqual([['[Channels] outward delivery supervisor work failed', {
      boundary: 'delivery-operation', connectionId: 'connection-1', bindingId: 'binding-1',
      code: 'channels_delivery_notDelivered', retryable: false,
      custodyId: admitted.record.custodyId, attemptCount: 1, settledState: 'notDelivered',
      settlementStatus: 'settled', providerOperation: 'deliver', providerResultKind: 'notDelivered', providerRetry: 'never',
    }]]);
    expect(deliveries.rows.get(admitted.record.custodyId)?.value).toMatchObject({
      attention: true, payload: { state: 'notDelivered' },
    });
  });

  it.each(['transcript', 'custody'] as const)('recovers a failed %s read through projection and custody without a new invalidation or duplicate reply', async (boundary) => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const binding = state.rows.get('binding-1');
    if (binding === undefined || !isChannelStateJsonRecord(binding.value.payload)) throw new Error('Expected binding');
    await state.put({ ...binding.value, payload: { ...binding.value.payload,
      target: { ...sessionTarget, policy: { ...sessionTarget.policy, deliveryMode: 'repliesOnly' } },
    } }, { expectedRevision: binding.revision });
    const logger = { warn: vi.fn() };
    let available = false;
    const execute = vi.fn(async (action: string, input: Readonly<{ cursor?: string | null }>) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      if (!available && boundary === 'transcript') throw new PluginError({ code: 'service_unavailable', retryable: true, message: 'secret transcript read detail' });
      return {
        ok: true, projection: 'externalShareableV1', sessionId: 'session-1',
        scannedThroughSeq: 5, nextCursor: '5', hasMore: false,
        items: input.cursor === '5' ? [] : [{
          kind: 'assistantText', sessionId: 'session-1', seq: 5, itemId: 'recovered-final',
          turnId: 'turn-1', final: 'completed', text: 'Recovered answer',
          consumedInputs: [{ localId: 'input-1', origin: {
            v: 1, producer: 'pluginSession', actor: 'machine',
            sourceAuthority: { mediatorPluginId: 'happier.channels', sourceRef: 'channels:binding:binding-1' },
          } }],
        }],
      };
    });
    const deliver = vi.fn(async () => ({ result: { kind: 'delivered', providerMessageIds: ['recovered-receipt'] },
      executionOrigin: providerTransportOrigin }));
    const getDelivery = deliveries.get.bind(deliveries);
    vi.spyOn(deliveries, 'get').mockImplementation(async (id) => {
      if (!available && boundary === 'custody') throw new Error('secret custody read detail');
      return await getDelivery(id);
    });
    const context = backgroundContext({ state, deliveries, execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: deliver, logger });

    const failed = await runConversationOutwardDeliveryCycle({ context, now: () => 100 });
    expect(failed.nextWakeAt).toBe(1_100);
    expect(logger.warn).toHaveBeenCalledWith('[Channels] outward delivery supervisor work failed', {
      boundary: 'transcript-projection', bindingId: 'binding-1',
      code: boundary === 'transcript' ? 'service_unavailable' : 'channels_projection_custodyUnavailable', retryable: true,
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    expect(deliveries.rows.size).toBe(0);
    expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({ lastScannedSeq: 0 });

    available = true;
    await runConversationOutwardDeliveryCycle({ context, now: () => 1_100 });
    expect([...deliveries.rows.values()].map(row => row.value.payload)).toEqual([
      expect.objectContaining({ state: 'delivered', providerMessageIds: ['recovered-receipt'] }),
    ]);
    expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({
      transcriptCursor: '5', lastScannedSeq: 5,
    });
    await runConversationOutwardDeliveryCycle({ context, now: () => 1_101 });
    expect(deliveries.rows.size).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('C3 RED logs binding discovery and transcript projection failures, then stays silent for abort', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const logger = { warn: vi.fn() };
    const execute = vi.fn(async (action: string) => {
      if (action === 'session.permission.remote.pending.list') return emptyPendingPermissionPage();
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-1',
        scannedThroughSeq: 1,
        hasMore: false,
        items: [{
          kind: 'userText',
          sessionId: 'session-1',
          seq: 1,
          itemId: 'semantic-projection-retry',
          localId: 'local-projection-retry',
          text: 'Projection retry body.',
          origin: { v: 1, producer: 'pluginSession', actor: 'collaborator' },
        }],
      };
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: { kind: 'delivered', providerMessageIds: ['provider-message-projection-retry'] },
      executionOrigin: providerTransportOrigin,
    }));
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
      logger,
    });
    const originalQuery = state.query.bind(state);
    let queryCalls = 0;
    vi.spyOn(state, 'query').mockImplementation(async (input) => {
      queryCalls += 1;
      // Finalization reads connections then bindings before the supervisor's
      // canonical binding-discovery reread on the same wake.
      if (queryCalls === 3) throw new Error('secret binding discovery detail');
      return await originalQuery(input);
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 100 });

    expect(logger.warn).toHaveBeenCalledWith(
      '[Channels] outward delivery supervisor work failed',
      { boundary: 'binding-discovery' },
    );
    expect(execute).not.toHaveBeenCalled();

    let attemptIdCalls = 0;
    const createAttemptId = (): string => {
      attemptIdCalls += 1;
      if (attemptIdCalls === 1) throw new Error('secret transcript projection detail');
      return `projection-retry-${attemptIdCalls}`;
    };
    await runConversationOutwardDeliveryCycle({ context, now: () => 101, createAttemptId });

    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      '[Channels] outward delivery supervisor work failed',
      { boundary: 'transcript-projection', bindingId: 'binding-1' },
    );
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();

    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    const abortedContext = {
      ...context,
      signal: abort.signal,
    } satisfies BackgroundServiceContext;
    await runConversationOutwardDeliveryCycle({ context: abortedContext, now: () => 102 });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  });

  it.each(['blocked', 'attempting'] as const)(
    'retains the ingress census while a %s obligation remains beyond one finalization page',
    async (phase) => {
      const state = new MemoryCollection();
      const deliveries = new MemoryCollection();
      const { finalObligationId } = await seedFinalizingIngressRelations({
        state,
        finalObligationPhase: phase,
      });
      const execute = vi.fn(async () => {
        throw new Error('Finalizing rows must not project a transcript.');
      });
      const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => {
        throw new Error('Finalizing rows must not issue a provider delivery.');
      });
      const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });

      await runConversationOutwardDeliveryCycle({ context, now: () => 10 });

      expect(state.rows.get(FINALIZING_INGRESS_CENSUS_ID)?.deleted).not.toBe(true);
      expect(state.rows.get(FINALIZING_CONNECTION_ID)?.deleted).not.toBe(true);
      const retainedObligations = [...state.rows.values()].filter((row) => (
        row.value['record-kind'] === 'ingress-obligation'
      ));
      expect(retainedObligations).toHaveLength(FINALIZING_INGRESS_RELATION_COUNT);
      if (phase === 'blocked') {
        // A blocked row has no effect in flight and no due-time owner. The
        // deletion owner must make it terminal so cleanup cannot wedge.
        expect(state.rows.get(finalObligationId)).toMatchObject({
          deleted: false,
          value: {
            terminal: true,
            payload: {
              lifecycle: { phase: 'terminal' },
              disposition: 'connectionDeleted',
            },
          },
        });
      } else {
        // An attempting row may already have crossed provider I/O and remains
        // with its incumbent reconciliation owner.
        expect(state.rows.get(finalObligationId)).toMatchObject({
          deleted: false,
          value: { terminal: false, payload: { lifecycle: { phase: 'attempting' } } },
        });
      }
      expect(execute).not.toHaveBeenCalled();
      expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    },
  );

  it('progresses all-terminal ingress cleanup before deleting the shared census and connection', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const { bindingIds, reservationId } = await seedFinalizingIngressRelations({
      state,
      finalObligationPhase: 'terminal',
    });
    const execute = vi.fn(async () => {
      throw new Error('Finalizing rows must not project a transcript.');
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => {
      throw new Error('Finalizing rows must not issue a provider delivery.');
    });
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });

    await runConversationOutwardDeliveryCycle({ context, now: () => 10 });

    expect(state.rows.get(FINALIZING_INGRESS_CENSUS_ID)?.deleted).not.toBe(true);
    expect({
      bindingDeleted: bindingIds.filter((bindingId) => state.rows.get(bindingId)?.deleted === true).length,
      obligationDeleted: [...state.rows.values()]
        .filter((row) => row.value['record-kind'] === 'ingress-obligation' && row.deleted === true).length,
    }).toEqual({
      bindingDeleted: FINALIZING_INGRESS_RELATION_COUNT - 1,
      obligationDeleted: FINALIZING_INGRESS_RELATION_COUNT - 1,
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 11 });
    expect(state.rows.get(FINALIZING_INGRESS_CENSUS_ID)?.deleted).toBe(true);
    expect(state.rows.get(FINALIZING_CONNECTION_ID)?.deleted).not.toBe(true);

    await runConversationOutwardDeliveryCycle({ context, now: () => 12 });
    expect(state.rows.get(FINALIZING_CONNECTION_ID)?.deleted).toBe(true);
    expect(state.rows.get(reservationId)?.deleted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('projects the public Session transcript through custody once and retains the advanced frontier across a later wake', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const execute = vi.fn(async (action: string, input: Readonly<{ cursor?: string | null }>) => {
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      if (input.cursor === null) {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 1,
          nextCursor: '1',
          hasMore: false,
          items: [{
            kind: 'userText',
            sessionId: 'session-1',
            seq: 1,
            itemId: 'semantic-1',
            localId: 'local-1',
            text: 'A collaborator message.',
            origin: { v: 1, producer: 'pluginSession', actor: 'collaborator' },
          }],
        };
      }
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-1',
        scannedThroughSeq: 1,
        nextCursor: '1',
        hasMore: false,
        items: [],
      };
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: { kind: 'delivered', providerMessageIds: ['provider-message-1'] },
      executionOrigin: providerTransportOrigin,
    }));
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 100,
      createAttemptId: () => 'projection-attempt-1',
    });
    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 101,
      createAttemptId: () => 'projection-attempt-2',
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledWith(
      providerDeliveryAction,
      expect.objectContaining({ deliveryKey: expect.stringMatching(/^channels:delivery:v1:/u) }),
      expect.objectContaining({ expectedExecutionRouting: getPluginMachineExecutionRouting(providerTransportOrigin) }),
    );
    expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({
      transcriptCursor: '1',
      lastScannedSeq: 1,
    });
  });

  it('delivers projected text beyond the former byte ceiling before advancing its frontier', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const body = '😀'.repeat(60_000);
    const execute = vi.fn(async (action: string, input: Readonly<{ cursor?: string | null }>) => {
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      if (input.cursor === null) {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 1,
          nextCursor: '1',
          hasMore: false,
          items: [{
            kind: 'userText',
            sessionId: 'session-1',
            seq: 1,
            itemId: 'semantic-oversized',
            localId: 'local-oversized',
            text: body,
            origin: { v: 1, producer: 'pluginSession', actor: 'collaborator' },
          }],
        };
      }
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-1',
        scannedThroughSeq: 1,
        nextCursor: '1',
        hasMore: false,
        items: [],
      };
    });
    const deliveredTexts: string[] = [];
    const providerMessageIds: string[] = [];
    let retainedContent: unknown;
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _operation: unknown, input: ConversationDeliveryInputV1,
    ) => {
      // Consume the real core-produced request at the exact provider boundary.
      const request = ConversationDeliveryInputV1Schema.parse(JSON.parse(JSON.stringify(input)));
      if (deliveredTexts.length === 0) {
        const payload = [...deliveries.rows.values()][0]?.value.payload;
        if (!isChannelStateJsonRecord(payload)) throw new Error('Expected retained outward-delivery payload.');
        retainedContent = payload.content;
      }
      deliveredTexts.push(request.content.text);
      const messageId = `projected-message-${deliveredTexts.length}`;
      providerMessageIds.push(messageId);
      return { result: { kind: 'delivered', providerMessageIds: [messageId] }, executionOrigin: providerTransportOrigin };
    });
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 100,
      createAttemptId: () => 'oversized-projection-attempt-1',
    });

    expect(deliveredTexts.join('')).toBe(body);
    expect(deliveredTexts.length).toBeGreaterThan(1);
    expect(deliveredTexts.every(text => Array.from(text).length <= 4_096)).toBe(true);
    expect([...deliveries.rows.values()]).toHaveLength(1);
    expect(ConversationDeliveryContentV1Schema.parse(retainedContent))
      .toEqual({ text: body });
    const settledPayload = [...deliveries.rows.values()][0]?.value.payload;
    if (!isChannelStateJsonRecord(settledPayload)) throw new Error('Expected settled outward-delivery payload.');
    expect(settledPayload.content).toBeNull();
    expect([...deliveries.rows.values()][0]?.value).toMatchObject({
      terminal: true,
      attention: false,
      payload: {
        state: 'delivered',
        attemptCount: 1,
        providerMessageIds,
      },
    });
    expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({
      transcriptCursor: '1',
      lastScannedSeq: 1,
    });
  });

  it('does not let scanner cadence redrive a hintless safe provider failure before its durable fallback due time', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 0,
      nextCursor: '0',
      hasMore: false,
      items: [],
    }));
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: { kind: 'notDelivered', retry: 'safe' },
      executionOrigin: providerTransportOrigin,
    }));
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(outwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected retained custody fixture');
    let attempt = 0;
    const createAttemptId = () => `fallback-retry-attempt-${++attempt}`;

    await runConversationOutwardDeliveryCycle({ context, now: () => 1_000, createAttemptId });
    await runConversationOutwardDeliveryCycle({ context, now: () => 2_000, createAttemptId });
    await runConversationOutwardDeliveryCycle({ context, now: () => 3_000, createAttemptId });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect([...deliveries.rows.values()][0]?.value).toMatchObject({
      'retry-not-before': 4_000,
      payload: {
        state: 'retryDue',
        attemptCount: 2,
      },
    });

    await runConversationOutwardDeliveryCycle({ context, now: () => 4_000, createAttemptId });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(3);
    expect([...deliveries.rows.values()][0]?.value).toMatchObject({
      'retry-not-before': 8_000,
      payload: {
        state: 'retryDue',
        attemptCount: 3,
      },
    });
  });

  it('advances a failed frontier CAS from the rejoined terminal custody without a second provider delivery', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const originalBatch = state.batch.bind(state);
    let rejectNextFrontierAdvance = true;
    state.batch = async (operations) => {
      const advancesFrontier = operations.some((operation) => (
        operation.kind === 'put'
        && operation.value !== null
        && typeof operation.value === 'object'
        && (operation.value as Record<string, unknown>)['record-kind'] === 'projection-frontier'
      ));
      if (rejectNextFrontierAdvance && advancesFrontier) {
        rejectNextFrontierAdvance = false;
        return { status: 'conflict' as const, conflicts: [] };
      }
      return await originalBatch(operations);
    };
    const execute = vi.fn(async (action: string, input: Readonly<{ cursor?: string | null }>) => {
      if (action !== 'session.transcript.get') throw new Error(`Unexpected Action ${action}`);
      if (input.cursor === null) {
        return {
          ok: true,
          projection: 'externalShareableV1',
          sessionId: 'session-1',
          scannedThroughSeq: 1,
          nextCursor: '1',
          hasMore: false,
          items: [{
            kind: 'userText',
            sessionId: 'session-1',
            seq: 1,
            itemId: 'semantic-1',
            localId: 'local-1',
            text: 'A collaborator message.',
            origin: { v: 1, producer: 'pluginSession', actor: 'collaborator' },
          }],
        };
      }
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-1',
        scannedThroughSeq: 1,
        nextCursor: '1',
        hasMore: false,
        items: [],
      };
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: { kind: 'delivered', providerMessageIds: ['provider-message-1'] },
      executionOrigin: providerTransportOrigin,
    }));
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 100,
      createAttemptId: () => 'projection-attempt-1',
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({
      transcriptCursor: null,
      lastScannedSeq: 0,
    });

    const currentBinding = state.rows.get('binding-1');
    if (currentBinding === undefined) throw new Error('Expected current projection binding.');
    state.rows.set('binding-1', {
      ...currentBinding,
      revision: currentBinding.revision + 1,
      value: {
        ...currentBinding.value,
        payload: {
          ...currentBinding.value.payload as Record<string, unknown>,
          endpoint: { ...endpoint, id: 'retargeted-provider-destination' },
          linkPreviewPolicy: 'providerDefault',
        },
      },
    });

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 101,
      createAttemptId: () => 'projection-attempt-2',
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({
      transcriptCursor: '1',
      lastScannedSeq: 1,
    });
  });

  it('reconciles a stale retained attempt through the optional provider Action instead of re-sending it after restart', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 0,
      nextCursor: '0',
      hasMore: false,
      items: [],
    }));
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: { kind: 'notDelivered', retry: 'safe' },
      executionOrigin: providerTransportOrigin,
    }));
    const logger = { warn: vi.fn() };
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin, logger });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(outwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected retained custody fixture');
    await store.compareAndSwap({
      custodyId: admitted.record.custodyId,
      expectedRevision: admitted.record.revision,
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'lost-attempt-1',
        startedAt: 0,
        providerMessageIds: [],
      },
    });

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 100,
      staleAttemptAfterMs: 30,
      createAttemptId: () => 'recovery-attempt-1',
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(1);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledWith(
      providerDeliveryReconcileAction,
      expect.objectContaining({ deliveryKey: 'channels:delivery:v1:stale-custody' }),
      expect.objectContaining({ expectedExecutionRouting: getPluginMachineExecutionRouting(providerTransportOrigin) }),
    );
    expect([...deliveries.rows.values()][0]?.value.payload).toMatchObject({
      state: 'retryDue',
      attemptCount: 1,
    });
    expect(logger.warn.mock.calls.map(call => call[1]).filter(detail => detail.custodyId !== undefined)).toEqual([{
      boundary: 'delivery-operation', connectionId: 'connection-1', bindingId: 'binding-1',
      code: 'channels_delivery_retryDue', retryable: true,
      custodyId: admitted.record.custodyId, attemptCount: 1, settledState: 'retryDue',
      settlementStatus: 'settled', providerOperation: 'reconcile', providerResultKind: 'notDelivered', providerRetry: 'safe',
      retryNotBefore: 1_100,
    }]);
  });

  it('redrives retained Automation result custody through the same generic provider path', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    await seedProjectionState(state);
    const currentBinding = state.rows.get('binding-1');
    if (currentBinding === undefined) throw new Error('expected binding fixture');
    await state.put({
      ...currentBinding.value,
      payload: {
        ...currentBinding.value.payload as Record<string, unknown>,
        target: {
          kind: 'automation',
          automationId: 'automation-1',
          policy: { resultDelivery: 'finalResult' },
        },
      },
    }, { expectedRevision: currentBinding.revision });
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 0,
      nextCursor: '0',
      hasMore: false,
      items: [],
    }));
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: { kind: 'delivered', providerMessageIds: ['provider-message-1'] },
      executionOrigin: providerTransportOrigin,
    }));
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: context.signal,
      now: () => 0,
    });
    const admitted = await store.ensure(heldAutomationOutwardObligation());
    if (admitted.kind !== 'created') throw new Error('expected Automation custody fixture');

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 100,
      createAttemptId: () => 'held-automation-attempt-1',
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledWith(
      providerDeliveryAction,
      expect.objectContaining({ deliveryKey: 'channels:delivery:v1:stale-custody' }),
      expect.objectContaining({ expectedExecutionRouting: getPluginMachineExecutionRouting(providerTransportOrigin) }),
    );
    expect([...deliveries.rows.values()][0]?.value.payload).toMatchObject({
      state: 'delivered',
      attemptCount: 1,
      providerMessageIds: ['provider-message-1'],
    });
  });

  it('permits exactly one generation runner and fully retires it before a later restart', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const execute = vi.fn();
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const firstGeneration = new AbortController();
    const replacementGeneration = new AbortController();
    const runCycle = vi.fn(async () => ({}));
    const supervisor = createConversationOutwardDeliverySupervisor({
      reconciliationIntervalMs: 1,
      clock: {
        now: () => 0,
        sleep: async (_delay, signal) => await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve(); }, { once: true });
        }),
      },
      runCycle,
    });
    const firstContext = {
      ...backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin }),
      signal: firstGeneration.signal,
    } satisfies BackgroundServiceContext;
    const firstRun = supervisor.run(firstContext);
    await vi.waitFor(() => expect(runCycle).toHaveBeenCalledTimes(1));
    await expect(supervisor.run(firstContext)).rejects.toThrow('already running');

    firstGeneration.abort(new Error('first generation retired'));
    await firstRun;
    const replacementContext = {
      ...backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin }),
      signal: replacementGeneration.signal,
    } satisfies BackgroundServiceContext;
    const replacementRun = supervisor.run(replacementContext);
    await vi.waitFor(() => expect(runCycle).toHaveBeenCalledTimes(2));
    replacementGeneration.abort(new Error('replacement generation retired'));
    await replacementRun;
    await supervisor.dispose();
  });

  it('logs a redacted non-abort cycle failure while leaving an abort failure silent', async () => {
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection();
    const execute = vi.fn();
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const generation = new AbortController();
    const logger = { warn: vi.fn() };
    let now = 4_000_000;
    let cycleCalls = 0;
    const runCycle = vi.fn(async () => {
      cycleCalls += 1;
      if (cycleCalls === 1) throw new Error('secret outward cycle detail');
      generation.abort(new Error('test complete'));
      throw new Error('secret abort detail');
    });
    const supervisor = createConversationOutwardDeliverySupervisor({
      reconciliationIntervalMs: 1_000,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
      runCycle,
    });
    const context = {
      ...backgroundContext({
        state,
        deliveries,
        execute,
        executeAdmittedTargetedOperationWithExecutionOrigin,
        logger,
      }),
      signal: generation.signal,
    } satisfies BackgroundServiceContext;

    await supervisor.run(context);

    expect(cycleCalls).toBe(2);
    expect(now).toBe(4_001_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[Channels] outward delivery supervisor cycle failed',
      { boundary: 'cycle' },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    await supervisor.dispose();
  });
});
