import type { PluginInvocationCaller, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/plugin-sdk/actions';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ConversationProviderConnectionsSnapshotV1Schema,
} from '@happier-dev/channels-protocol/v1';

import {
  listConversationProviderConnectionsForCaller,
  listConversationProviderConnectionsForInvocation,
  readConversationBindingInputModesNoLongerDeliverable,
  readConversationProviderConnectionForCaller,
  readConversationProviderConnectionForInvocation,
  type ConversationReconciliationConnectionStateV1,
} from './reconciliation.js';
import { createCurrentConversationConnectionFixture, createCurrentConversationPendingOldTransportStopFixture } from './testkit/currentConnectionFixture.js';
import { MemoryCollection } from './testkit/memoryCollection.js';

function pendingTransferStop(input: Readonly<{
  overlapSafety: 'safe' | 'providerExclusive' | 'destructive';
  acceptedPossibleLoss: boolean;
  stopRequest: Readonly<{ reason: 'transfer'; authorityEpoch: number }>;
}>) {
  return createCurrentConversationPendingOldTransportStopFixture({
    connectionId: 'connection-1',
    authority: { providerPluginId: 'happier.channel.discord', providerContributionSelection: { contributionId: 'discord-provider' },
      providerSetupInput: {}, credentialRef: null, transportOrigin: { serverIdentityId: 'srv_reconciliation', machineId: 'machine-1' },
      providerConnectionKey: 'discord:application-1', providerConfig: { applicationId: 'application-1' }, routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'discord:application-1' }, authorityEpoch: 3 },
    predecessorCheckpointedPollInvocation: { connectionRevision: 1, authorityEpoch: 3,
      transportOrigin: { serverIdentityId: 'srv_reconciliation', machineId: 'machine-1' } },
    authorityEpoch: input.stopRequest.authorityEpoch,
    reason: input.stopRequest.reason, predecessorTransportKind: 'socket', overlapSafety: input.overlapSafety,
    acceptedPossibleLoss: input.acceptedPossibleLoss,
  });
}

type PluginCaller = Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>>;

function caller(input: Readonly<{
  pluginId: string;
  materializationId: string;
}>): PluginCaller {
  return {
    kind: 'plugin',
    pluginId: input.pluginId,
    contribution: {
      id: 'channel-background',
      qualifiedId: `${input.pluginId}/background/channel-background`,
    },
    occurrenceId: `${input.pluginId}-fixture-occurrence`,
    sourceCustody: { kind: 'development', registeredRootId: `${input.pluginId}-fixture-root` },
    materialization: {
      machineId: 'machine-1',
      materializationId: input.materializationId,
      pluginId: input.pluginId,
    },
    executionOrigin: {
      serverIdentityId: 'srv_reconciliation',
      materializationRef: { machineId: 'machine-1', materializationId: input.materializationId, pluginId: input.pluginId },
    },
  };
}

/**
 * The pure caller projection receives the post-Collection, schema-validated
 * reconciliation state. Invocation-level tests use the canonical full-row
 * fixture in `testkit/currentConnectionFixture.ts` instead.
 */
function reconciliationConnectionState(
  overrides: Partial<ConversationReconciliationConnectionStateV1> = {},
): ConversationReconciliationConnectionStateV1 {
  const { deletionState = 'none', enabled = true, ...rest } = {
    ...reconciliationConnectionStateBase(),
    ...overrides,
  };
  // The retained snapshot correlates deletion state with enablement: only a
  // connection with no deletion in flight may be enabled. Rebuilding the pair
  // here keeps the fixture on a real union member. The case that proves an
  // enabled deleting snapshot is rejected builds its own literal instead.
  return deletionState === 'none'
    ? { ...rest, deletionState, enabled }
    : { ...rest, deletionState, enabled: false };
}

function reconciliationConnectionStateBase() {
  return {
    v: 1,
    connectionId: 'connection-1',
    transport: { kind: 'socket' },
    providerConnectionKey: 'discord:application-1',
    providerConfigVersion: 1,
    providerConfig: { applicationId: 'application-1' },
    credentialRef: null,
    providerPluginId: 'happier.channel.discord',
    overlapSafety: 'safe',
    authorityEpoch: 4,
    enabled: true,
    deletionState: 'none',
    pendingOldTransportStop: null,
    historyGap: null,
    transportOrigin: {
      serverIdentityId: 'srv_reconciliation',
      machineId: 'machine-1',
    },
  } as const;
}

describe('Conversation provider reconciliation', () => {
  it('reads only one connection scope and keeps a provider reconciliation linear at 50 connections / 500 bindings', async () => {
    const collection = new MemoryCollection();
    const authority = {
      ...reconciliationConnectionStateBase(),
      providerContributionSelection: { contributionId: 'discord-provider' },
      providerSetupInput: {},
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'discord:application-1' },
    };
    for (let index = 0; index < 50; index += 1) {
      const connectionId = `connection-${index}`;
      const connection = createCurrentConversationConnectionFixture({
        connectionId,
        authority,
        transport: { kind: 'socket' },
      });
      collection.rows.set(connectionId, { rowId: connectionId, revision: 1, value: connection });
      for (let binding = 0; binding < 10; binding += 1) {
        const bindingId = `binding-${index}-${binding}`;
        // The Collection is the admission boundary; reconciliation consumes
        // only these already-admitted binding policy fields.
        collection.rows.set(bindingId, { rowId: bindingId, revision: 1, value: {
          id: bindingId, 'record-kind': 'binding', 'connection-id': connectionId, 'binding-id': bindingId,
          payload: { enabled: true, endpoint: { audience: 'shared' }, inputMode: 'allAllowedMessages' },
        } });
      }
    }
    let pages = 0;
    let rows = 0;
    let forceCursorDrift = false;
    const context = {
      caller: caller({ pluginId: 'happier.channel.discord', materializationId: 'discord-install-1' }),
      signal: new AbortController().signal,
      services: { storage: { account: { collection: () => ({
        async query(request: Parameters<MemoryCollection['query']>[0]) {
          const page = await collection.query(request);
          pages += 1;
          rows += page.rows.length;
          return { ...page, changeCursor: forceCursorDrift ? pages : page.changeCursor };
        },
      }) } } },
    } as unknown as PluginInvocationContext;

    await expect(readConversationProviderConnectionForInvocation({ connectionId: 'connection-0' }, context))
      .resolves.toMatchObject({ 'connection-0': { authorityEpoch: 4, requiresFullSharedMessageContent: true } });
    const exactReadCost = { pages, rows };

    pages = 0;
    rows = 0;
    const listed = await listConversationProviderConnectionsForInvocation({}, context);
    expect(Object.keys(listed)).toHaveLength(50);
    for (const connectionId of Object.keys(listed)) {
      await expect(readConversationProviderConnectionForInvocation({ connectionId }, context))
        .resolves.toMatchObject({ [connectionId]: { requiresFullSharedMessageContent: true } });
    }
    expect({ exactReadCost, reconciliationCost: { pages, rows } }).toEqual({
      // Two family-prefix queries avoid paying for any census or obligation
      // history without requiring unrelated Account writes to stop.
      exactReadCost: { pages: 2, rows: 11 },
      reconciliationCost: { pages: 104, rows: 1_100 },
    });

    // An exact read must still observe revocation after discovery rather than
    // reusing the previously admitted provider snapshot or demand projection.
    const stored = collection.rows.get('connection-0')!;
    collection.rows.set(stored.rowId, { ...stored, revision: 2, value: createCurrentConversationConnectionFixture({
      connectionId: stored.rowId, authority: { ...authority, authorityEpoch: 5 }, enabled: false, transport: { kind: 'socket' },
    }) });
    await expect(readConversationProviderConnectionForInvocation({ connectionId: 'connection-0' }, context))
      .resolves.toMatchObject({ 'connection-0': { enabled: false, authorityEpoch: 5 } });
    await expect(readConversationProviderConnectionForInvocation({ connectionId: 'missing-connection' }, context))
      .resolves.toEqual({});

    // Unrelated Account activity between families and pages does not invalidate
    // current connection authority or prevent the demand projection.
    const binding = collection.rows.get('binding-0-0')!;
    for (let index = 0; index < 200; index += 1) {
      const bindingId = `binding-0-extra-${index}`;
      collection.rows.set(bindingId, { ...binding, rowId: bindingId,
        value: { ...binding.value, id: bindingId, 'binding-id': bindingId } });
    }
    forceCursorDrift = true;
    await expect(readConversationProviderConnectionForInvocation({ connectionId: 'connection-0' }, context))
      .resolves.toMatchObject({ 'connection-0': { enabled: false, authorityEpoch: 5 } });
  });

  it('follows current host-stamped source custody at the same route and refuses another Home, Machine or plugin', () => {
    const sourceCustody = { kind: 'development', registeredRootId: '/runtime-1/discord' } as const;
    const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_reconciliation', sourceRef: {
      pluginId: 'happier.channel.discord', machineId: 'machine-1', sourceCustody,
    } });
    // Source invocations retain the host's auxiliary release-less materialization.
    const base = caller({ pluginId: 'happier.channel.discord', materializationId: 'auxiliary' });
    const currentCaller = { ...base, sourceCustody, executionOrigin };
    const connection = reconciliationConnectionState();
    const snapshot = listConversationProviderConnectionsForCaller({ caller: currentCaller, connections: [connection], bindingPolicies: [] });
    expect(Object.keys(snapshot)).toEqual(['connection-1']);
    expect(ConversationProviderConnectionsSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(snapshot['connection-1']).not.toHaveProperty('transportOrigin');
    const changedOrigins = [
      { ...executionOrigin, serverIdentityId: 'srv_other' },
      { serverIdentityId: 'srv_reconciliation', sourceRef: { pluginId: 'happier.channel.discord', machineId: 'machine-2', sourceCustody } },
    ];
    for (const origin of changedOrigins) {
      const changedOrigin = PluginMachineExecutionOriginV1Schema.parse(origin);
      expect(listConversationProviderConnectionsForCaller({
        caller: { ...currentCaller, executionOrigin: changedOrigin,
          sourceCustody: 'sourceRef' in changedOrigin ? changedOrigin.sourceRef.sourceCustody : sourceCustody },
        connections: [connection], bindingPolicies: [],
      })).toEqual({});
    }
    const replacementCustody = { kind: 'development', registeredRootId: '/runtime-2/discord' } as const;
    expect(Object.keys(listConversationProviderConnectionsForCaller({
      caller: { ...currentCaller, sourceCustody: replacementCustody, executionOrigin: {
        serverIdentityId: 'srv_reconciliation', sourceRef: { pluginId: 'happier.channel.discord', machineId: 'machine-1', sourceCustody: replacementCustody },
      } }, connections: [connection], bindingPolicies: [],
    }))).toEqual(['connection-1']);
    expect(listConversationProviderConnectionsForCaller({ caller: { ...currentCaller, pluginId: 'happier.channel.other' }, connections: [connection], bindingPolicies: [] })).toEqual({});
    expect(listConversationProviderConnectionsForCaller({ caller: { ...currentCaller, sourceCustody: { kind: 'development', registeredRootId: '/different-root' } }, connections: [connection], bindingPolicies: [] })).toEqual({});
  });

  it('uses a stamped materialized origin including Home identity and refuses malformed stamps without legacy fallback', () => {
    const legacyCaller = caller({ pluginId: 'happier.channel.discord', materializationId: 'discord-install-1' });
    const connection = reconciliationConnectionState();
    const executionOrigin = PluginMachineExecutionOriginV1Schema.parse(legacyCaller.executionOrigin);
    expect(Object.keys(listConversationProviderConnectionsForCaller({ caller: { ...legacyCaller, executionOrigin }, connections: [connection], bindingPolicies: [] }))).toEqual(['connection-1']);
    expect(listConversationProviderConnectionsForCaller({ caller: { ...legacyCaller, executionOrigin: { ...executionOrigin, serverIdentityId: 'srv_other' } }, connections: [connection], bindingPolicies: [] })).toEqual({});
    // Direct JavaScript callers can supply malformed data despite the SDK type.
    const malformed = JSON.parse(JSON.stringify({ ...legacyCaller, executionOrigin: { ...executionOrigin, claimedAuthority: true } }));
    expect(listConversationProviderConnectionsForCaller({ caller: malformed, connections: [connection], bindingPolicies: [] })).toEqual({});
  });

  it('retains deleting-state enabled:false correlation and rejects enabled deleting snapshots', () => {
    const assertDeletingState = (state: ConversationReconciliationConnectionStateV1): void => {
      if (state.deletionState === 'pendingStopReconciliation') {
        expectTypeOf(state.enabled).toEqualTypeOf<false>();
      }
      if (state.deletionState === 'finalizingDelete') {
        expectTypeOf(state.enabled).toEqualTypeOf<false>();
      }
    };
    void assertDeletingState;

    const deletingSnapshot = {
      v: 1,
      connectionId: 'connection-deleting',
      providerConnectionKey: 'discord:application-1',
      providerConfigVersion: 1,
      providerConfig: { applicationId: 'application-1' },
      credentialRef: null,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'pendingStopReconciliation',
      requiresFullSharedMessageContent: false,
    };
    expect(ConversationProviderConnectionsSnapshotV1Schema.safeParse({
      [deletingSnapshot.connectionId]: deletingSnapshot,
    }).success).toBe(false);
  });

  it('returns only the caller route across truthful transport kinds while following installation replacement', () => {
    const exact = reconciliationConnectionState();
    const samePluginDifferentMaterialization = reconciliationConnectionState({
      connectionId: 'connection-other-install',
      transportOrigin: {
        serverIdentityId: 'srv_reconciliation',
        machineId: 'machine-1',
      },
    });
    const otherMaterialization = reconciliationConnectionState({
      connectionId: 'connection-telegram',
      providerPluginId: 'happier.channel.telegram',
      transportOrigin: {
        serverIdentityId: 'srv_reconciliation',
        machineId: 'machine-1',
      },
    });
    const telegramCheckpointedPull = reconciliationConnectionState({
      connectionId: 'connection-telegram-checkpointed',
      transport: { kind: 'checkpointedPull' },
      providerPluginId: 'happier.channel.telegram',
      providerConnectionKey: 'telegram-bot:123',
      providerConfig: { botUsername: 'HappierBot', canReadAllGroupMessages: false },
      transportOrigin: {
        serverIdentityId: 'srv_reconciliation',
        machineId: 'machine-1',
      },
    });
    const expectedSnapshot = {
      v: exact.v,
      connectionId: exact.connectionId,
      providerConnectionKey: exact.providerConnectionKey,
      providerConfigVersion: exact.providerConfigVersion,
      providerConfig: exact.providerConfig,
      credentialRef: exact.credentialRef,
      authorityEpoch: exact.authorityEpoch,
      enabled: exact.enabled,
      deletionState: exact.deletionState,
      requiresFullSharedMessageContent: false,
    };

    const result = listConversationProviderConnectionsForCaller({
      caller: caller({
        pluginId: 'happier.channel.discord',
        materializationId: 'discord-install-1',
      }),
      connections: [exact, samePluginDifferentMaterialization, otherMaterialization, telegramCheckpointedPull],
      bindingPolicies: [],
    });

    expect(result).toEqual({ [exact.connectionId]: expectedSnapshot,
      [samePluginDifferentMaterialization.connectionId]: { ...expectedSnapshot, connectionId: samePluginDifferentMaterialization.connectionId } });
    expect(ConversationProviderConnectionsSnapshotV1Schema.parse(result)).toEqual(result);
    expect(Object.keys(result[exact.connectionId]).sort()).toEqual([
      'authorityEpoch',
      'connectionId',
      'credentialRef',
      'deletionState',
      'enabled',
      'providerConfig',
      'providerConfigVersion',
      'providerConnectionKey',
      'requiresFullSharedMessageContent',
      'v',
    ]);
    expect(result[exact.connectionId]).not.toHaveProperty('transportOrigin');
    expect(result[exact.connectionId]).not.toHaveProperty('transport');
    expect(result[exact.connectionId]).not.toHaveProperty('providerPluginId');
    expect(result[exact.connectionId]).not.toHaveProperty('historyGap');
    expect(result[exact.connectionId]).not.toHaveProperty('checkpoint');

    // A checkpointedPull connection is listable through the same caller gate:
    // its owning provider install sees it, while every other materialization
    // and plugin stays excluded exactly as before.
    const telegramResult = listConversationProviderConnectionsForCaller({
      caller: caller({
        pluginId: 'happier.channel.telegram',
        materializationId: 'telegram-install-1',
      }),
      connections: [exact, samePluginDifferentMaterialization, otherMaterialization, telegramCheckpointedPull],
      bindingPolicies: [],
    });
    expect(Object.keys(telegramResult)).toEqual([
      otherMaterialization.connectionId,
      telegramCheckpointedPull.connectionId,
    ]);
  });

  it('keeps retained stop and loss disclosures inert when projecting the current placement', () => {
    const unacceptedDestructive = reconciliationConnectionState({
      connectionId: 'destructive-transfer-pending',
      overlapSafety: 'safe',
pendingOldTransportStop: pendingTransferStop({
        overlapSafety: 'destructive',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      }),
    });
    const safeTransfer = reconciliationConnectionState({
      connectionId: 'safe-transfer-pending',
      overlapSafety: 'safe',
pendingOldTransportStop: pendingTransferStop({
        overlapSafety: 'safe',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      }),
    });
    const providerExclusiveTransfer = reconciliationConnectionState({
      connectionId: 'exclusive-transfer-pending',
      overlapSafety: 'safe',
pendingOldTransportStop: pendingTransferStop({
        overlapSafety: 'providerExclusive',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      }),
    });
    const acceptedDestructive = reconciliationConnectionState({
      connectionId: 'destructive-transfer-accepted',
      overlapSafety: 'safe',
pendingOldTransportStop: pendingTransferStop({
        overlapSafety: 'destructive',
        acceptedPossibleLoss: true,
        stopRequest: { reason: 'transfer', authorityEpoch: 3 },
      }),
    });
    const incoherentAcceptedTransfer = reconciliationConnectionState({
      connectionId: 'destructive-transfer-incoherent-accepted',
      overlapSafety: 'safe',
pendingOldTransportStop: pendingTransferStop({
        overlapSafety: 'destructive',
        acceptedPossibleLoss: true,
        // A settled marker must be past the frozen stop epoch. This one never
        // completed the authority-advancing abandon transition.
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      }),
    });
    const stoppedDestructive = reconciliationConnectionState({
      connectionId: 'destructive-transfer-stopped',
      overlapSafety: 'safe',
      pendingOldTransportStop: null,
    });
    const invocation = {
      caller: caller({
        pluginId: 'happier.channel.discord',
        materializationId: 'discord-install-1',
      }),
      connections: [
        unacceptedDestructive,
        safeTransfer,
        providerExclusiveTransfer,
        acceptedDestructive,
        incoherentAcceptedTransfer,
        stoppedDestructive,
      ],
      bindingPolicies: [],
    };

    expect(Object.keys(listConversationProviderConnectionsForCaller(invocation))).toEqual([
      unacceptedDestructive.connectionId,
      safeTransfer.connectionId,
      providerExclusiveTransfer.connectionId,
      acceptedDestructive.connectionId,
      incoherentAcceptedTransfer.connectionId,
      stoppedDestructive.connectionId,
    ]);
    expect(readConversationProviderConnectionForCaller({
      ...invocation,
      connectionId: unacceptedDestructive.connectionId,
    })).toMatchObject({ [unacceptedDestructive.connectionId]: { authorityEpoch: 4 } });
  });

  it('projects endpoint-retarget custody without treating it as an old physical transport stop', () => {
    const connection = reconciliationConnectionState({ pendingOldTransportStop: {
      kind: 'endpointRetarget', webhookEndpointId: 'endpoint-1',
      webhookContributionRef: { pluginId: 'happier.channel.discord', localId: 'observations' },
      webhookSourceInstanceId: 'source-1', transferAuthorityEpoch: 4,
      targetMaterialization: { pluginId: 'happier.channel.discord', machineId: 'machine-1', materializationId: 'discord-install-2' },
    } });
    expect(Object.keys(listConversationProviderConnectionsForCaller({
      caller: caller({ pluginId: 'happier.channel.discord', materializationId: 'discord-install-2' }),
      connections: [connection], bindingPolicies: [],
    }))).toEqual(['connection-1']);
  });

  it('reconciles a history-gap notice without hiding an eligible replacement', () => {
    const historyGapFreeReplacement = reconciliationConnectionState({
      connectionId: 'history-gap-free-transfer',
pendingOldTransportStop: pendingTransferStop({
        overlapSafety: 'safe',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      }),
    });
    const incompatibleReplacement = reconciliationConnectionState({
      connectionId: 'history-gapped-transfer',
pendingOldTransportStop: pendingTransferStop({
        overlapSafety: 'safe',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      }),
      historyGap: {
        reportedAt: 1_725_000_000_000,
        reason: 'providerHistoryUnavailable',
        diagnostic: 'replacement cannot resume the retained checkpoint',
      },
    });
    const invocation = {
      caller: caller({
        pluginId: 'happier.channel.discord',
        materializationId: 'discord-install-1',
      }),
      connections: [historyGapFreeReplacement, incompatibleReplacement],
      bindingPolicies: [],
    };

    expect(Object.keys(listConversationProviderConnectionsForCaller(invocation))).toEqual([
      historyGapFreeReplacement.connectionId,
      incompatibleReplacement.connectionId,
    ]);
    expect(readConversationProviderConnectionForCaller({
      ...invocation,
      connectionId: historyGapFreeReplacement.connectionId,
    })).toHaveProperty(historyGapFreeReplacement.connectionId);
    expect(readConversationProviderConnectionForCaller({
      ...invocation,
      connectionId: incompatibleReplacement.connectionId,
    })).toHaveProperty(incompatibleReplacement.connectionId);
  });

  it('derives only the full-shared-content demand from current enabled binding policy', () => {
    const sharedAddressed = reconciliationConnectionState({ connectionId: 'shared-addressed' });
    const sharedAll = reconciliationConnectionState({ connectionId: 'shared-all' });
    const sharedDirectOnly = reconciliationConnectionState({ connectionId: 'shared-direct-only' });
    const sharedThreadAddressed = reconciliationConnectionState({ connectionId: 'shared-thread-addressed' });
    const directThreadAddressed = reconciliationConnectionState({ connectionId: 'direct-thread-addressed' });
    const directAddressed = reconciliationConnectionState({ connectionId: 'direct-addressed' });
    const disabledSharedAll = reconciliationConnectionState({ connectionId: 'disabled-shared-all' });
    const invocation = {
      caller: caller({
        pluginId: 'happier.channel.discord',
        materializationId: 'discord-install-1',
      }),
      connections: [
        sharedAddressed,
        sharedAll,
        sharedDirectOnly,
        sharedThreadAddressed,
        directThreadAddressed,
        directAddressed,
        disabledSharedAll,
      ],
      bindingPolicies: [
        { connectionId: 'shared-addressed', enabled: true, endpointAudience: 'direct', inputMode: 'directMentionsOnly' },
        { connectionId: 'shared-addressed', enabled: true, endpointAudience: 'shared', inputMode: 'addressedMessages' },
        { connectionId: 'shared-all', enabled: true, endpointAudience: 'shared', inputMode: 'allAllowedMessages' },
        { connectionId: 'shared-direct-only', enabled: true, endpointAudience: 'shared', inputMode: 'directMentionsOnly' },
        { connectionId: 'shared-thread-addressed', enabled: true, endpointAudience: 'shared', inputMode: 'addressedMessages' },
        { connectionId: 'direct-thread-addressed', enabled: true, endpointAudience: 'direct', inputMode: 'addressedMessages' },
        { connectionId: 'direct-addressed', enabled: true, endpointAudience: 'direct', inputMode: 'addressedMessages' },
        { connectionId: 'disabled-shared-all', enabled: false, endpointAudience: 'shared', inputMode: 'allAllowedMessages' },
        { connectionId: 'other-connection', enabled: true, endpointAudience: 'shared', inputMode: 'allAllowedMessages' },
      ] as const,
    };

    const result = listConversationProviderConnectionsForCaller(invocation);
    expect(Object.values(result).map((snapshot) => ({
      connectionId: snapshot.connectionId,
      requiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent,
    }))).toEqual([
      { connectionId: 'shared-addressed', requiresFullSharedMessageContent: true },
      { connectionId: 'shared-all', requiresFullSharedMessageContent: true },
      { connectionId: 'shared-direct-only', requiresFullSharedMessageContent: false },
      { connectionId: 'shared-thread-addressed', requiresFullSharedMessageContent: true },
      { connectionId: 'direct-thread-addressed', requiresFullSharedMessageContent: false },
      { connectionId: 'direct-addressed', requiresFullSharedMessageContent: false },
      { connectionId: 'disabled-shared-all', requiresFullSharedMessageContent: false },
    ]);
    for (const snapshot of Object.values(result)) {
      expect(snapshot).not.toHaveProperty('bindingPolicies');
      expect(snapshot).not.toHaveProperty('allowedPrincipalIds');
    }

    expect(readConversationProviderConnectionForCaller({
      ...invocation,
      connectionId: 'shared-addressed',
    })).toMatchObject({
      'shared-addressed': { requiresFullSharedMessageContent: true },
    });
  });

  it('returns an oracle-safe empty map rather than falling back to a plugin-id match', () => {
    const state = reconciliationConnectionState();

    expect(readConversationProviderConnectionForCaller({
      caller: caller({
        pluginId: 'happier.channel.other',
        materializationId: 'discord-install-2',
      }),
      connections: [state],
      bindingPolicies: [],
      connectionId: state.connectionId,
    })).toEqual({});
    expect(readConversationProviderConnectionForCaller({
      caller: undefined,
      connections: [state],
      bindingPolicies: [],
      connectionId: state.connectionId,
    })).toEqual({});
  });

  it('fails closed when a caller has no complete host-stamped Home routing provenance', () => {
    const legacyCaller = {
      kind: 'plugin',
      pluginId: 'happier.channel.discord',
      contribution: {
        id: 'channel-background',
        qualifiedId: 'happier.channel.discord/background/channel-background',
      },
    } as unknown as PluginInvocationCaller;

    expect(listConversationProviderConnectionsForCaller({
      caller: legacyCaller,
      connections: [reconciliationConnectionState()],
      bindingPolicies: [],
    })).toEqual({});
    const { executionOrigin: _missingHomeProof, ...materializedCaller } = caller({
      pluginId: 'happier.channel.discord', materializationId: 'discord-install-1',
    });
    expect(listConversationProviderConnectionsForCaller({ caller: materializedCaller,
      connections: [reconciliationConnectionState()], bindingPolicies: [] })).toEqual({});
  });

  it('admits the 33rd exact-keyed reconciliation snapshot and still rejects duplicate child IDs', () => {
    const invocation = {
      caller: caller({
        pluginId: 'happier.channel.discord',
        materializationId: 'discord-install-1',
      }),
      bindingPolicies: [],
    };
    const matchingStates = (count: number) => Array.from({ length: count }, (_unused, index) => (
      reconciliationConnectionState({ connectionId: `connection-${index + 1}` })
    ));

    expect(listConversationProviderConnectionsForCaller({
      ...invocation,
      connections: [],
    })).toEqual({});

    const one = matchingStates(1);
    expect(listConversationProviderConnectionsForCaller({
      ...invocation,
      connections: one,
    })).toMatchObject({
      [one[0]!.connectionId]: { connectionId: one[0]!.connectionId },
    });

    const atLimit = listConversationProviderConnectionsForCaller({
      ...invocation,
      connections: matchingStates(32),
    });
    expect(Object.entries(atLimit).every(([connectionId, snapshot]) => (
      connectionId === snapshot.connectionId
    ))).toBe(true);
    expect(Object.keys(atLimit)).toHaveLength(32);

    expect(Object.keys(listConversationProviderConnectionsForCaller({
      ...invocation,
      connections: matchingStates(32 + 1),
    }))).toHaveLength(33);

    const duplicate = reconciliationConnectionState({
      connectionId: 'connection-duplicate',
      providerConnectionKey: 'discord:application-duplicate',
    });
    expect(() => listConversationProviderConnectionsForCaller({
      ...invocation,
      connections: [duplicate, { ...duplicate, providerConfig: { duplicate: true } }],
    })).toThrow('one exact key per connection ID');
  });

  it('keeps shared-input restrictions when an unrelated Account cursor moves between binding pages', async () => {
    const bindingRow = {
      rowId: 'binding-1',
      revision: 1,
      value: {
        id: 'binding-1',
        'record-kind': 'binding',
        'connection-id': 'connection-1',
        'binding-id': 'binding-1',
        payload: { enabled: true, endpoint: { audience: 'shared' }, inputMode: 'allAllowedMessages' },
      },
    };
    let queryCount = 0;
    const collection = {
      async query(_request: unknown, _options?: unknown) {
        queryCount += 1;
        return queryCount === 1
          ? {
            rows: Array.from({ length: 200 }, () => bindingRow),
            nextCursor: 'binding-200',
            changeCursor: 11,
          }
          : { rows: [], nextCursor: undefined, changeCursor: 12 };
      },
    };
    const context = {
      signal: new AbortController().signal,
      services: { storage: { account: { collection: () => collection } } },
    } as unknown as PluginInvocationContext;

    await expect(readConversationBindingInputModesNoLongerDeliverable({
      context,
      connectionId: 'connection-1',
      sharedEndpointInputModes: ['directMentionsOnly'],
    })).resolves.toEqual(['allAllowedMessages']);
    expect(queryCount).toBe(2);
  });
});
