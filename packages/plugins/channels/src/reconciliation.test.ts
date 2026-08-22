import type { PluginInvocationCaller } from '@happier-dev/plugin-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ConversationProviderConnectionsSnapshotV1Schema,
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
} from '@happier-dev/channels-protocol/v1';

import {
  listConversationProviderConnectionsForCaller,
  readConversationProviderConnectionForCaller,
  type ConversationReconciliationConnectionStateV1,
} from './reconciliation.js';

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
    materialization: {
      machineId: 'machine-1',
      materializationId: input.materializationId,
      pluginId: input.pluginId,
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
      materializationRef: {
        machineId: 'machine-1',
        materializationId: 'discord-install-1',
        pluginId: 'happier.channel.discord',
      },
    },
  } as const;
}

describe('Conversation provider reconciliation', () => {
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

  it('returns only socket connection state for the exact host-stamped caller materialization', () => {
    const exact = reconciliationConnectionState();
    const samePluginDifferentMaterialization = reconciliationConnectionState({
      connectionId: 'connection-other-install',
      transportOrigin: {
        materializationRef: {
          machineId: 'machine-1',
          materializationId: 'discord-install-2',
          pluginId: 'happier.channel.discord',
        },
      },
    });
    const otherMaterialization = reconciliationConnectionState({
      connectionId: 'connection-telegram',
      transportOrigin: {
        materializationRef: {
          machineId: 'machine-1',
          materializationId: 'telegram-install-1',
          pluginId: 'happier.channel.telegram',
        },
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
      connections: [exact, samePluginDifferentMaterialization, otherMaterialization],
      bindingPolicies: [],
    });

    expect(result).toEqual({ [exact.connectionId]: expectedSnapshot });
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
  });

  it('withholds only an unaccepted destructive transfer replacement until old-stop custody settles or is explicitly accepted', () => {
    const unacceptedDestructive = reconciliationConnectionState({
      connectionId: 'destructive-transfer-pending',
      overlapSafety: 'safe',
      pendingOldTransportStop: {
        overlapSafety: 'destructive',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      },
    });
    const safeTransfer = reconciliationConnectionState({
      connectionId: 'safe-transfer-pending',
      overlapSafety: 'destructive',
      pendingOldTransportStop: {
        overlapSafety: 'safe',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      },
    });
    const providerExclusiveTransfer = reconciliationConnectionState({
      connectionId: 'exclusive-transfer-pending',
      overlapSafety: 'safe',
      pendingOldTransportStop: {
        overlapSafety: 'providerExclusive',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      },
    });
    const acceptedDestructive = reconciliationConnectionState({
      connectionId: 'destructive-transfer-accepted',
      overlapSafety: 'safe',
      pendingOldTransportStop: {
        overlapSafety: 'destructive',
        acceptedPossibleLoss: true,
        stopRequest: { reason: 'transfer', authorityEpoch: 3 },
      },
    });
    const incoherentAcceptedTransfer = reconciliationConnectionState({
      connectionId: 'destructive-transfer-incoherent-accepted',
      overlapSafety: 'safe',
      pendingOldTransportStop: {
        overlapSafety: 'destructive',
        acceptedPossibleLoss: true,
        // A settled marker must be past the frozen stop epoch. This one never
        // completed the authority-advancing abandon transition.
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      },
    });
    const stoppedDestructive = reconciliationConnectionState({
      connectionId: 'destructive-transfer-stopped',
      overlapSafety: 'destructive',
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
      safeTransfer.connectionId,
      providerExclusiveTransfer.connectionId,
      acceptedDestructive.connectionId,
      stoppedDestructive.connectionId,
    ]);
    expect(readConversationProviderConnectionForCaller({
      ...invocation,
      connectionId: unacceptedDestructive.connectionId,
    })).toEqual({});
  });

  it('withholds a history-gapped replacement from ordinary reconciliation', () => {
    const historyGapFreeReplacement = reconciliationConnectionState({
      connectionId: 'history-gap-free-transfer',
      pendingOldTransportStop: {
        overlapSafety: 'safe',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      },
    });
    const incompatibleReplacement = reconciliationConnectionState({
      connectionId: 'history-gapped-transfer',
      pendingOldTransportStop: {
        overlapSafety: 'safe',
        acceptedPossibleLoss: false,
        stopRequest: { reason: 'transfer', authorityEpoch: 4 },
      },
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
    ]);
    expect(readConversationProviderConnectionForCaller({
      ...invocation,
      connectionId: historyGapFreeReplacement.connectionId,
    })).toHaveProperty(historyGapFreeReplacement.connectionId);
    expect(readConversationProviderConnectionForCaller({
      ...invocation,
      connectionId: incompatibleReplacement.connectionId,
    })).toEqual({});
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
        pluginId: 'happier.channel.discord',
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

  it('fails closed when an older host has not stamped materialization provenance', () => {
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
  });

  it('admits only 0/1/32 exact-keyed reconciliation snapshots and rejects the 33rd or a duplicate child ID', () => {
    expect(MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT).toBe(32);
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
      connections: matchingStates(MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT),
    });
    expect(Object.entries(atLimit).every(([connectionId, snapshot]) => (
      connectionId === snapshot.connectionId
    ))).toBe(true);
    expect(Object.keys(atLimit)).toHaveLength(MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT);

    expect(() => listConversationProviderConnectionsForCaller({
      ...invocation,
      connections: matchingStates(MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT + 1),
    })).toThrow('connection limit');

    const duplicate = reconciliationConnectionState({
      connectionId: 'connection-duplicate',
      providerConnectionKey: 'discord:application-duplicate',
    });
    expect(() => listConversationProviderConnectionsForCaller({
      ...invocation,
      connections: [duplicate, { ...duplicate, providerConfig: { duplicate: true } }],
    })).toThrow('one exact key per connection ID');
  });
});
