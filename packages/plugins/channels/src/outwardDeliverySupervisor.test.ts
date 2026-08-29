import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginInvocationContext,
  TargetedContributionPointRef,
  TargetedContributionSnapshot,
  TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_DELIVERIES_INDEX_ID,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import {
  createConversationOutwardDeliveryCollectionStore,
  type ConversationOutwardDeliveryObligation,
} from './outwardDelivery.js';
import {
  createConversationOutwardDeliverySupervisor,
  runConversationOutwardDeliveryCycle,
} from './outwardDeliverySupervisor.js';
import { finalizeConversationConnectionDeletesForInvocation } from './management.js';
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
import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';

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
            generation: 'channels-test-generation',
            contributions: [{
              contributor: {
                pluginId: providerTransportOrigin.materializationRef.pluginId,
                contributionId: 'delivery-test-provider',
                immutableGenerationId: 'delivery-test-generation',
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

type StoredRow = Readonly<{
  rowId: string;
  revision: number;
  value: Record<string, unknown>;
  deleted?: boolean;
}>;

function compareCanonicalText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * The exact `by-connection-binding-v2` sort key: `binding-id` with its stable
 * null sentinel first, then `record-kind`, then `attention`, then the row-ID
 * tiebreaker Data appends to every stored index key.
 */
function compareConnectionBindingRows(left: StoredRow, right: StoredRow): number {
  const leftBindingId = typeof left.value['binding-id'] === 'string'
    ? left.value['binding-id']
    : null;
  const rightBindingId = typeof right.value['binding-id'] === 'string'
    ? right.value['binding-id']
    : null;
  if (leftBindingId === null && rightBindingId !== null) return -1;
  if (leftBindingId !== null && rightBindingId === null) return 1;
  return (leftBindingId === null || rightBindingId === null
    ? 0
    : compareCanonicalText(leftBindingId, rightBindingId))
    || compareCanonicalText(String(left.value['record-kind']), String(right.value['record-kind']))
    || (Number(left.value.attention === true) - Number(right.value.attention === true))
    || compareCanonicalText(left.rowId, right.rowId);
}

/**
 * The loaded Account-storage adapter refuses a query naming an index the bound
 * contract does not declare. Mirroring that here is what makes a reader still
 * pointed at a retired index fail instead of quietly reading a fake's rows.
 */
function assertDeclaredCollectionIndex(index: string | undefined): void {
  if (index === undefined) return;
  const declared = [
    ...CHANNEL_STATE_COLLECTION.indexes,
    ...CHANNEL_DELIVERIES_COLLECTION.indexes,
  ].some((candidate) => candidate.id === index);
  if (!declared) {
    throw new Error(`Collection query names an undeclared index '${index}'.`);
  }
}

class MemoryCollection {
  readonly rows = new Map<string, StoredRow>();
  private conflictNextDelete: boolean;

  constructor(private readonly options: Readonly<{
    /** Mirrors the host Collection request invariant for this boundary test. */
    enforceUniqueBatchRows?: boolean;
    conflictNextDelete?: boolean;
  }> = {}) {
    this.conflictNextDelete = options.conflictNextDelete === true;
  }

  async get(rowId: string): Promise<StoredRow | null> {
    const row = this.rows.get(rowId);
    return row?.deleted === true ? null : row ?? null;
  }

  async put(value: Record<string, unknown>, input: Readonly<{
    expectedRevision: number | 'absent';
  }>): Promise<StoredRow> {
    const rowId = value.id;
    if (typeof rowId !== 'string') throw new Error('row id is required');
    const current = this.rows.get(rowId);
    if ((input.expectedRevision === 'absent' && current !== undefined)
      || (typeof input.expectedRevision === 'number'
        && current?.revision !== input.expectedRevision)) {
      throw Object.assign(new Error('compare-and-swap conflict'), {
        code: 'plugin_collection_conflict',
      });
    }
    const row = { rowId, revision: (current?.revision ?? 0) + 1, value, deleted: false };
    this.rows.set(rowId, row);
    return row;
  }

  async delete(rowId: string, input: Readonly<{ expectedRevision: number }>) {
    const current = this.rows.get(rowId);
    if (this.conflictNextDelete) {
      this.conflictNextDelete = false;
      throw Object.assign(new Error('compare-and-swap conflict'), {
        code: 'plugin_collection_conflict',
      });
    }
    if (current === undefined
      || current.deleted === true
      || current.revision !== input.expectedRevision) {
      throw Object.assign(new Error('compare-and-swap conflict'), {
        code: 'plugin_collection_conflict',
      });
    }
    const row = { ...current, revision: current.revision + 1, deleted: true as const };
    this.rows.set(rowId, row);
    return { rowId, revision: row.revision, deleted: true as const };
  }

  async forget(rowId: string, input: Readonly<{ expectedRevision: number }>) {
    const current = this.rows.get(rowId);
    if (current === undefined) return { rowId, forgotten: true as const };
    if (current.deleted !== true || current.revision !== input.expectedRevision) {
      throw Object.assign(new Error('compare-and-swap conflict'), {
        code: 'plugin_collection_conflict',
      });
    }
    this.rows.delete(rowId);
    return { rowId, forgotten: true as const };
  }

  async batch(operations: readonly Readonly<Record<string, unknown>>[]) {
    if (this.options.enforceUniqueBatchRows === true) {
      const rowIds = operations.map((operation) => (
        operation.kind === 'put' && operation.value !== null && typeof operation.value === 'object'
          ? (operation.value as Record<string, unknown>).id
          : operation.rowId
      ));
      if (new Set(rowIds).size !== rowIds.length) {
        throw new Error('A collection mutation batch may contain each row at most once.');
      }
    }
    const next = new Map(this.rows);
    const results: Array<Readonly<{ rowId: string; revision: number; deleted: boolean }>> = [];
    for (const operation of operations) {
      const rowId = operation.kind === 'put' && operation.value !== null && typeof operation.value === 'object'
        ? (operation.value as Record<string, unknown>).id
        : operation.rowId;
      const expectedRevision = operation.expectedRevision;
      const current = typeof rowId === 'string' ? next.get(rowId) : undefined;
      const matches = typeof rowId === 'string'
        && (expectedRevision === 'absent'
          ? current === undefined
          : current !== undefined
            && current.revision === expectedRevision
            && (operation.kind === 'put' || current.deleted !== true));
      if (!matches) {
        return {
          status: 'conflict' as const,
          conflicts: [{
            rowId: typeof rowId === 'string' ? rowId : 'invalid-row',
            revision: current?.revision ?? null,
            deleted: current?.deleted === true,
          }],
        };
      }
      if (operation.kind === 'assert') continue;
      if (operation.kind === 'put') {
        const value = operation.value as Record<string, unknown>;
        const row = { rowId, revision: (current?.revision ?? 0) + 1, value, deleted: false };
        next.set(rowId, row);
        results.push({ rowId, revision: row.revision, deleted: false });
        continue;
      }
      if (current === undefined) throw new Error('delete requires a current row');
      const row = { ...current, revision: current.revision + 1, deleted: true };
      next.set(rowId, row);
      results.push({ rowId, revision: row.revision, deleted: true });
    }
    this.rows.clear();
    for (const [rowId, row] of next) this.rows.set(rowId, row);
    return { status: 'updated' as const, results };
  }

  async query(input: Readonly<{
    index?: string;
    prefix?: readonly unknown[];
    cursor?: string;
    order?: 'asc' | 'desc';
    limit: number;
  }>) {
    assertChannelsTestCollectionQueryLimit(input.limit);
    assertDeclaredCollectionIndex(input.index);
    const prefix = input.prefix?.[0];
    const bindingPrefix = input.prefix?.[1];
    const all = [...this.rows.values()]
      .filter((row) => {
        if (row.deleted === true) return false;
        if (input.index === CHANNEL_STATE_INDEX_ID.byKind) {
          return row.value['record-kind'] === prefix;
        }
        if (input.index === CHANNEL_STATE_INDEX_ID.byConnectionBindingV2
          || input.index === CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention) {
          return row.value['connection-id'] === prefix
            && (bindingPrefix === undefined || row.value['binding-id'] === bindingPrefix);
        }
        if (input.index === CHANNEL_DELIVERIES_INDEX_ID.byRetryDue) {
          return row.value.terminal === prefix;
        }
        if (prefix === CHANNEL_STATE_RECORD_KIND.binding) {
          return row.value['record-kind'] === CHANNEL_STATE_RECORD_KIND.binding;
        }
        return true;
      })
      .sort((left, right) => {
        const comparison = input.index === CHANNEL_STATE_INDEX_ID.byConnectionBindingV2
          ? compareConnectionBindingRows(left, right)
          : left.rowId.localeCompare(right.rowId);
        return input.order === 'desc' ? -comparison : comparison;
      });
    const cursorIndex = input.cursor === undefined
      ? 0
      : Math.max(0, all.findIndex((row) => row.rowId === input.cursor) + 1);
    const rows = all.slice(cursorIndex, cursorIndex + input.limit);
    const final = rows.at(-1);
    return {
      rows,
      changeCursor: 1,
      ...(final !== undefined && cursorIndex + rows.length < all.length ? { nextCursor: final.rowId } : {}),
    };
  }
}

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
      immutableGenerationId: 'delivery-test-generation',
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
    content: 'unattempted direct-delete body',
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
    content: 'unattempted retained body',
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
  logger?: Pick<PluginInvocationContext['services']['logger'], 'warn'>;
  collection?: (definition: Readonly<{ id: string }>) => MemoryCollection | undefined;
  targetedContributions?: TargetedContributionsService;
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
      storage: {
        account: {
          collection: input.collection ?? ((definition: Readonly<{ id: string }>) => collections.get(definition.id)),
        },
      },
      actions: {
        execute: input.execute,
        executeAdmittedTargetedOperationWithExecutionOrigin: input.executeAdmittedTargetedOperationWithExecutionOrigin,
      },
      targetedContributions: input.targetedContributions ?? targetedProviderDeliveryContributions(),
      logger: input.logger ?? { warn: vi.fn() },
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

function outwardObligation(): ConversationOutwardDeliveryObligation {
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
    content: 'retained body',
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

function permissionWaitOutwardObligation(): ConversationOutwardDeliveryObligation {
  return {
    ...outwardObligation(),
    source: {
      kind: 'permissionWait',
      sessionId: 'session-1',
      turnId: 'turn-1',
      requestId: 'permission-request-1',
    },
    content: 'This Session is waiting for an approval in Happier. '
      + 'Reply /allow permission-request-1 or /deny permission-request-1.',
    deliveryKey: 'channels:permission-wait:v1:turn-1:permission-request-1',
  };
}

describe('Channels outward-delivery supervisor', () => {
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
    const context = backgroundContext({
      state,
      deliveries,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(),
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
    const created = await store.ensure(outwardObligation());
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

  it('retains a terminal row after a retention CAS loss and retries it on the next cycle', async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    let persistedAt = 0;
    const state = new MemoryCollection();
    const deliveries = new MemoryCollection({ conflictNextDelete: true });
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
    const created = await store.ensure(outwardObligation());
    if (created.kind !== 'created') throw new Error('Expected retained custody fixture.');
    persistedAt = 100;
    const settled = await store.compareAndSwap({
      custodyId: created.record.custodyId,
      expectedRevision: created.record.revision,
      custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['provider-1'] },
    });
    if (settled.kind !== 'updated') throw new Error('Expected terminal custody fixture.');

    // The runner carries the retention pass between wakes, so a pass that
    // could not retire the row it selected must not also pace the next one.
    const lost = await runConversationOutwardDeliveryCycle({
      context,
      now: () => 100 + THIRTY_DAYS_MS,
    });
    expect(await deliveries.get(settled.record.custodyId)).not.toBeNull();

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 101 + THIRTY_DAYS_MS,
      ...(lost.nextRetentionSweep === undefined ? {} : { retentionSweep: lost.nextRetentionSweep }),
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
      const created = await store.ensure(outwardObligation());
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
            content: 'Run: git status --short\nCommand: git\n'
              + 'Reply /allow permission-request-1 or /deny permission-request-1.',
            state: 'ready',
          }),
        }),
      }),
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
            content: 'This Session needs your input:\n'
              + '1. Choose a release mode (required; select one; custom text allowed)\n'
              + '  1. Safe\n'
              + '  2. Other\n'
              + '2. Any notes? (optional; write text)\n'
              + 'Reply /answer user-action-request-1 [{"questionIndex":0,"values":["<answer>"]}] in one message. '
              + 'Use displayed choice labels, or free text only where allowed; include every required question.',
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
      '[Channels] Session projection cannot advance its transcript frontier',
      { boundary: 'transcript-projection', bindingId: 'binding-1', reason: 'cursorRejected' },
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
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[Channels] Session projection cannot advance its transcript frontier',
      expect.anything(),
    );
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
      expect(retainedObligations.every((row) => row.deleted !== true)).toBe(true);
      expect(state.rows.get(finalObligationId)).toMatchObject({
        deleted: false,
        value: { terminal: false, payload: { lifecycle: { phase } } },
      });
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
      expect.objectContaining({ expectedExecutionOrigin: providerTransportOrigin }),
    );
    expect(state.rows.get('projection-frontier:binding-1')?.value.payload).toMatchObject({
      transcriptCursor: '1',
      lastScannedSeq: 1,
    });
  });

  it('records permanently oversized projected content as terminal attention custody and advances the frontier without provider I/O', async () => {
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
            itemId: 'semantic-oversized',
            localId: 'local-oversized',
            text: '😀'.repeat(60_000),
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
      result: { kind: 'delivered', providerMessageIds: ['must-not-exist'] },
      executionOrigin: providerTransportOrigin,
    }));
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });

    await runConversationOutwardDeliveryCycle({
      context,
      now: () => 100,
      createAttemptId: () => 'oversized-projection-attempt-1',
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect([...deliveries.rows.values()]).toHaveLength(1);
    expect([...deliveries.rows.values()][0]?.value).toMatchObject({
      terminal: true,
      attention: true,
      payload: {
        state: 'notDelivered',
        attemptCount: 0,
        providerMessageIds: [],
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
    const context = backgroundContext({ state, deliveries, execute, executeAdmittedTargetedOperationWithExecutionOrigin });
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
      expect.objectContaining({ expectedExecutionOrigin: providerTransportOrigin }),
    );
    expect([...deliveries.rows.values()][0]?.value.payload).toMatchObject({
      state: 'retryDue',
      attemptCount: 1,
    });
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
      expect.objectContaining({ expectedExecutionOrigin: providerTransportOrigin }),
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
