import { describe, expect, it } from 'vitest';
import {
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
} from '@happier-dev/channels-protocol/v1';

import {
  abandonConversationConnectionStop,
  confirmConversationConnectionStop,
  recordConversationConnectionHistoryGap,
  recordConversationConnectionProviderReadiness,
  setConversationConnectionEnabled,
  startConversationConnectionDelete,
  startConversationConnectionTransfer,
  transitionConversationConnection,
  type ConversationConnectionLifecycleStateV1,
} from './connectionLifecycle.js';

function connection(
  overrides: Partial<ConversationConnectionLifecycleStateV1> = {},
): ConversationConnectionLifecycleStateV1 {
  return {
    authorityEpoch: 7,
    enabled: true,
    deletionState: 'none',
    overlapSafety: 'safe',
    pendingOldTransportStop: null,
    historyGap: null,
    providerReadiness: null,
    pollFailure: null,
    maximumObservationAgeMs: 60_000,
    observationAgeExpansionFloorOccurredAt: null,
    ...overrides,
  };
}

describe('Conversation connection lifecycle', () => {
  it('commits one frozen old-stop request before delete and clears it only after exact stop proof', () => {
    const transportOrigin = {
      serverIdentityId: 'srv_connection_lifecycle',
      materializationRef: {
        pluginId: 'happier.channel.lifecycle',
        machineId: 'machine-lifecycle',
        materializationId: 'materialization-lifecycle',
      },
    } as const;
    const stopRequest = {
      v: 1,
      connectionId: 'connection-lifecycle',
      providerConnectionKey: 'provider:connection-lifecycle',
      providerConfigVersion: 1,
      providerConfig: { socket: { shard: 1 } },
      credentialRef: null,
      authorityEpoch: 8,
      reason: 'delete',
    } as const;
    const providerContributionSelection = {
      contributionId: 'old-delete-contribution',
      immutableGenerationId: 'old-delete-generation',
    } as const;
    const deleting = startConversationConnectionDelete({
      current: connection({
        historyGap: { reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable' },
      }),
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 1,
          authorityEpoch: 7,
          transportOrigin,
        },
        transportOrigin,
        providerContributionSelection,
        stopRequest,
      },
    });

    expect(deleting).toEqual({
      kind: 'deletePending',
      connection: {
        authorityEpoch: 8,
        enabled: false,
        deletionState: 'pendingStopReconciliation',
        overlapSafety: 'safe',
        historyGap: null,
        providerReadiness: null,
        pollFailure: null,
        maximumObservationAgeMs: 60_000,
        observationAgeExpansionFloorOccurredAt: null,
        pendingOldTransportStop: {
          predecessorCheckpointedPollInvocation: {
            connectionRevision: 1,
            authorityEpoch: 7,
            transportOrigin,
          },
          transportOrigin,
          providerContributionSelection,
          stopRequest,
          overlapSafety: 'safe',
          acceptedPossibleLoss: false,
        },
      },
    });

    if (deleting.kind !== 'deletePending') throw new Error('Expected pending delete state');
    expect(deleting.connection.pendingOldTransportStop).not.toBeNull();
    if (deleting.connection.pendingOldTransportStop === null) throw new Error('Expected frozen stop custody');
    expect(deleting.connection.pendingOldTransportStop.providerContributionSelection)
      .not.toBe(providerContributionSelection);
    expect(deleting.connection.pendingOldTransportStop.stopRequest).not.toBe(stopRequest);
    expect(deleting.connection.pendingOldTransportStop.stopRequest.providerConfig).not.toBe(stopRequest.providerConfig);
    expect(Object.isFrozen(deleting.connection.pendingOldTransportStop)).toBe(true);
    expect(Object.isFrozen(deleting.connection.pendingOldTransportStop.transportOrigin)).toBe(true);
    expect(Object.isFrozen(deleting.connection.pendingOldTransportStop.providerContributionSelection)).toBe(true);
    expect(Object.isFrozen(deleting.connection.pendingOldTransportStop.stopRequest)).toBe(true);
    expect(Object.isFrozen(deleting.connection.pendingOldTransportStop.stopRequest.providerConfig)).toBe(true);
    expect(confirmConversationConnectionStop({
      current: deleting.connection,
      reportedAuthorityEpoch: 7,
    })).toEqual({ kind: 'staleAuthority' });
    expect(confirmConversationConnectionStop({
      current: deleting.connection,
      reportedAuthorityEpoch: 8,
    })).toEqual({
      kind: 'deleteFinalizing',
      connection: {
        authorityEpoch: 8,
        enabled: false,
        deletionState: 'finalizingDelete',
        overlapSafety: 'safe',
        historyGap: null,
        providerReadiness: null,
        pollFailure: null,
        maximumObservationAgeMs: 60_000,
        observationAgeExpansionFloorOccurredAt: null,
        pendingOldTransportStop: null,
      },
    });
  });

  it('commits a replacement epoch and frozen old-stop custody before a transfer effect', () => {
    const transferStart = {
      current: connection(),
      pendingOldTransportStop: {
        transportOrigin: {
          serverIdentityId: 'srv_connection_lifecycle',
          materializationRef: {
            pluginId: 'happier.channel.lifecycle',
            machineId: 'machine-lifecycle',
            materializationId: 'materialization-lifecycle',
          },
        },
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 1,
          authorityEpoch: 7,
          transportOrigin: {
            serverIdentityId: 'srv_connection_lifecycle',
            materializationRef: {
              pluginId: 'happier.channel.lifecycle',
              machineId: 'machine-lifecycle',
              materializationId: 'materialization-lifecycle',
            },
          },
        },
        // C2 persists replacement B. This sole frozen slot retains incumbent A
        // so later stop resolution cannot fall back to the current selection.
        providerContributionSelection: {
          contributionId: 'incumbent-contribution-a',
          immutableGenerationId: 'incumbent-generation-a',
        },
        stopRequest: {
          v: 1,
          connectionId: 'connection-lifecycle',
          providerConnectionKey: 'provider:connection-lifecycle',
          providerConfigVersion: 1,
          providerConfig: {},
          credentialRef: null,
          authorityEpoch: 8,
          reason: 'transfer',
        },
      },
      replacement: {
        enabled: true,
        overlapSafety: 'providerExclusive',
        historyGap: { reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable' },
      },
    } as const;

    const transferring = startConversationConnectionTransfer(transferStart);
    expect(transferring).toEqual({
      kind: 'transferPendingOldStop',
      connection: {
        authorityEpoch: 8,
        enabled: true,
        deletionState: 'none',
        overlapSafety: 'providerExclusive',
        pendingOldTransportStop: {
          predecessorCheckpointedPollInvocation:
            transferStart.pendingOldTransportStop.predecessorCheckpointedPollInvocation,
          transportOrigin: transferStart.pendingOldTransportStop.transportOrigin,
          providerContributionSelection: transferStart.pendingOldTransportStop.providerContributionSelection,
          stopRequest: transferStart.pendingOldTransportStop.stopRequest,
          overlapSafety: 'safe',
          acceptedPossibleLoss: false,
        },
        historyGap: transferStart.replacement.historyGap,
        providerReadiness: null,
        pollFailure: null,
        maximumObservationAgeMs: 60_000,
        observationAgeExpansionFloorOccurredAt: null,
      },
    });
    if (transferring.kind !== 'transferPendingOldStop') throw new Error('Expected pending transfer state');
    expect(Object.isFrozen(transferring.connection.pendingOldTransportStop)).toBe(true);
    expect(Object.isFrozen(
      transferring.connection.pendingOldTransportStop?.predecessorCheckpointedPollInvocation,
    )).toBe(true);
    expect(Object.isFrozen(transferring.connection.pendingOldTransportStop?.providerContributionSelection)).toBe(true);
    expect(confirmConversationConnectionStop({
      current: transferring.connection,
      reportedAuthorityEpoch: 7,
    })).toEqual({ kind: 'staleAuthority' });
    expect(confirmConversationConnectionStop({
      current: transferring.connection,
      reportedAuthorityEpoch: 8,
    })).toEqual({
      kind: 'transportStopConfirmed',
      connection: {
        ...transferring.connection,
        pendingOldTransportStop: null,
      },
    });
  });

  it('retains destructive incumbent authority without rewriting replacement enablement', () => {
    const transfer = startConversationConnectionTransfer({
      current: connection({ overlapSafety: 'destructive' }),
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 1,
          authorityEpoch: 7,
          transportOrigin: {
            serverIdentityId: 'srv_connection_lifecycle',
            materializationRef: {
              pluginId: 'happier.channel.lifecycle',
              machineId: 'machine-lifecycle',
              materializationId: 'materialization-lifecycle',
            },
          },
        },
        transportOrigin: {
          serverIdentityId: 'srv_connection_lifecycle',
          materializationRef: {
            pluginId: 'happier.channel.lifecycle',
            machineId: 'machine-lifecycle',
            materializationId: 'materialization-lifecycle',
          },
        },
        providerContributionSelection: {
          contributionId: 'incumbent-contribution',
          immutableGenerationId: 'incumbent-generation',
        },
        stopRequest: {
          v: 1,
          connectionId: 'connection-lifecycle',
          providerConnectionKey: 'provider:connection-lifecycle',
          providerConfigVersion: 1,
          providerConfig: {},
          credentialRef: null,
          authorityEpoch: 8,
          reason: 'transfer',
        },
      },
      replacement: {
        enabled: true,
        overlapSafety: 'safe',
        historyGap: null,
      },
    });

    expect(transfer).toMatchObject({
      kind: 'transferPendingOldStop',
      connection: {
        enabled: true,
        overlapSafety: 'safe',
        pendingOldTransportStop: {
          overlapSafety: 'destructive',
          acceptedPossibleLoss: false,
        },
      },
    });
    if (transfer.kind !== 'transferPendingOldStop') throw new Error('Expected pending transfer state');
    expect(confirmConversationConnectionStop({
      current: transfer.connection,
      reportedAuthorityEpoch: 8,
    })).toMatchObject({
      kind: 'transportStopConfirmed',
      connection: {
        enabled: true,
        pendingOldTransportStop: null,
      },
    });

    const acceptedStop = transfer.connection.pendingOldTransportStop;
    if (acceptedStop === null || acceptedStop === undefined
      || acceptedStop.stopRequest.reason !== 'transfer') {
      throw new Error('Expected the accepted transfer to retain a transfer stop marker.');
    }
    const disabledTransfer = startConversationConnectionTransfer({
      current: connection({ enabled: false, overlapSafety: 'destructive' }),
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation: acceptedStop.predecessorCheckpointedPollInvocation,
        transportOrigin: acceptedStop.transportOrigin,
        providerContributionSelection: acceptedStop.providerContributionSelection,
        stopRequest: { ...acceptedStop.stopRequest, reason: 'transfer' as const },
      },
      replacement: {
        enabled: false,
        overlapSafety: 'safe',
        historyGap: null,
      },
    });
    if (disabledTransfer.kind !== 'transferPendingOldStop') throw new Error('Expected disabled pending transfer state');
    const abandoned = abandonConversationConnectionStop({ current: disabledTransfer.connection });
    expect(abandoned).toEqual({
      kind: 'transferAbandoned',
      connection: {
        ...disabledTransfer.connection,
        authorityEpoch: 9,
        pendingOldTransportStop: {
          ...disabledTransfer.connection.pendingOldTransportStop,
          acceptedPossibleLoss: true,
        },
        pollFailure: null,
      },
    });
    if (abandoned.kind !== 'transferAbandoned') throw new Error('Expected accepted transfer state');
    expect(abandonConversationConnectionStop({ current: abandoned.connection })).toEqual({
      kind: 'rejoined',
      connection: abandoned.connection,
    });
    expect(confirmConversationConnectionStop({
      current: abandoned.connection,
      reportedAuthorityEpoch: 8,
    })).toEqual({ kind: 'staleAuthority' });
  });

  it('keeps an accepted transfer marker admissible across ordinary policy epochs', () => {
    const oldTransportOrigin = {
      serverIdentityId: 'srv_old_transport',
      materializationRef: {
        pluginId: 'happier.channel.lifecycle',
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const unresolved = connection({
      authorityEpoch: 8,
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 1,
          authorityEpoch: 7,
          transportOrigin: oldTransportOrigin,
        },
        transportOrigin: oldTransportOrigin,
        providerContributionSelection: {
          contributionId: 'old-contribution',
          immutableGenerationId: 'old-generation',
        },
        stopRequest: {
          v: 1,
          connectionId: 'connection-lifecycle',
          providerConnectionKey: 'provider:connection-lifecycle',
          providerConfigVersion: 1,
          providerConfig: {},
          credentialRef: null,
          authorityEpoch: 8,
          reason: 'transfer',
        },
        overlapSafety: 'destructive',
        acceptedPossibleLoss: false,
      },
    });
    const deleteStop = {
      predecessorCheckpointedPollInvocation: {
        connectionRevision: 2,
        authorityEpoch: 8,
        transportOrigin: oldTransportOrigin,
      },
      transportOrigin: oldTransportOrigin,
      providerContributionSelection:
        unresolved.pendingOldTransportStop!.providerContributionSelection,
      stopRequest: {
        ...unresolved.pendingOldTransportStop!.stopRequest,
        authorityEpoch: 9,
        reason: 'delete' as const,
      },
    };
    const replacementStop = {
      predecessorCheckpointedPollInvocation: {
        connectionRevision: 2,
        authorityEpoch: 8,
        transportOrigin: oldTransportOrigin,
      },
      transportOrigin: oldTransportOrigin,
      providerContributionSelection:
        unresolved.pendingOldTransportStop!.providerContributionSelection,
      stopRequest: {
        ...unresolved.pendingOldTransportStop!.stopRequest,
        authorityEpoch: 9,
        reason: 'transfer' as const,
      },
    };

    expect(startConversationConnectionDelete({
      current: unresolved,
      pendingOldTransportStop: deleteStop,
    })).toEqual({ kind: 'rejected', code: 'oldTransportStopPending' });
    expect(startConversationConnectionTransfer({
      current: unresolved,
      pendingOldTransportStop: replacementStop,
      replacement: { enabled: true, overlapSafety: 'safe', historyGap: null },
    })).toEqual({ kind: 'rejected', code: 'oldTransportStopPending' });

    // A configuration-only write does not advance authority, but it also
    // cannot erase unresolved frozen stop custody. Only exact stop settlement
    // may clear the slot before an explicit accepted-loss transition.
    expect(transitionConversationConnection({
      current: unresolved,
      requested: { enabled: true, maximumObservationAgeMs: 120_000 },
    })).toMatchObject({
      kind: 'updated',
      connection: {
        authorityEpoch: 8,
        maximumObservationAgeMs: 120_000,
        pendingOldTransportStop: {
          acceptedPossibleLoss: false,
          stopRequest: { reason: 'transfer', authorityEpoch: 8 },
        },
      },
    });

    const accepted = connection({
      ...unresolved,
      authorityEpoch: 9,
      pendingOldTransportStop: {
        ...unresolved.pendingOldTransportStop!,
        acceptedPossibleLoss: true,
      },
    });

    // The accepted marker freezes the E8 stop request while authority is E9.
    // It is settled disclosure rather than live stop custody, so an ordinary
    // enablement/config edit may advance authority without stranding the next
    // exact-current delete or transfer exit.
    const policyUpdate = transitionConversationConnection({
      current: accepted,
      requested: { enabled: false, maximumObservationAgeMs: 120_000 },
    });
    expect(policyUpdate).toMatchObject({
      kind: 'updated',
      connection: {
        authorityEpoch: 10,
        enabled: false,
        maximumObservationAgeMs: 120_000,
        pendingOldTransportStop: {
          acceptedPossibleLoss: true,
          stopRequest: { reason: 'transfer', authorityEpoch: 8 },
        },
      },
    });
    if (policyUpdate.kind !== 'updated') return;

    const deleteReplacement = startConversationConnectionDelete({
      current: policyUpdate.connection,
      pendingOldTransportStop: {
        ...deleteStop,
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 3,
          authorityEpoch: policyUpdate.connection.authorityEpoch,
          transportOrigin: oldTransportOrigin,
        },
        stopRequest: { ...deleteStop.stopRequest, authorityEpoch: 11 },
      },
    });
    expect(deleteReplacement).toMatchObject({
      kind: 'deletePending',
      connection: {
        authorityEpoch: 11,
        deletionState: 'pendingStopReconciliation',
        pendingOldTransportStop: {
          stopRequest: { reason: 'delete', authorityEpoch: 11 },
          acceptedPossibleLoss: false,
        },
      },
    });

    const transferReplacement = startConversationConnectionTransfer({
      current: policyUpdate.connection,
      pendingOldTransportStop: {
        ...replacementStop,
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 3,
          authorityEpoch: policyUpdate.connection.authorityEpoch,
          transportOrigin: oldTransportOrigin,
        },
        stopRequest: { ...replacementStop.stopRequest, authorityEpoch: 11 },
      },
      replacement: { enabled: false, overlapSafety: 'providerExclusive', historyGap: null },
    });
    expect(transferReplacement).toMatchObject({
      kind: 'transferPendingOldStop',
      connection: {
        authorityEpoch: 11,
        enabled: false,
        pendingOldTransportStop: {
          stopRequest: { reason: 'transfer', authorityEpoch: 11 },
          acceptedPossibleLoss: false,
        },
      },
    });
  });

  it('rejects malformed accepted custody instead of treating it as a settled transfer marker', () => {
    const malformed = connection({
      // @ts-expect-error - deliberately omits providerContributionSelection: these cases prove the lifecycle owner rejects an incomplete retained stop marker.
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 1,
          authorityEpoch: 6,
          transportOrigin: {
            serverIdentityId: 'srv_old_transport',
            materializationRef: {
              pluginId: 'happier.channel.lifecycle',
              machineId: 'machine-old',
              materializationId: 'materialization-old',
            },
          },
        },
        transportOrigin: {
          serverIdentityId: 'srv_old_transport',
          materializationRef: {
            pluginId: 'happier.channel.lifecycle',
            machineId: 'machine-old',
            materializationId: 'materialization-old',
          },
        },
        stopRequest: {
          v: 1,
          connectionId: 'connection-lifecycle',
          providerConnectionKey: 'provider:connection-lifecycle',
          providerConfigVersion: 1,
          providerConfig: {},
          credentialRef: null,
          authorityEpoch: 7,
          reason: 'delete',
        },
        overlapSafety: 'destructive',
        acceptedPossibleLoss: true,
      },
    });
    expect(abandonConversationConnectionStop({ current: malformed })).toEqual({ kind: 'staleAuthority' });
    expect(startConversationConnectionDelete({
      current: malformed,
      // @ts-expect-error - deliberately omits providerContributionSelection: these cases prove the lifecycle owner rejects an incomplete retained stop marker.
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation:
          malformed.pendingOldTransportStop!.predecessorCheckpointedPollInvocation,
        transportOrigin: malformed.pendingOldTransportStop!.transportOrigin,
        stopRequest: {
          ...malformed.pendingOldTransportStop!.stopRequest,
          authorityEpoch: 8,
          reason: 'delete',
        },
      },
    })).toEqual({ kind: 'rejected', code: 'oldTransportStopPending' });
  });

  it('does not let an accepted marker at its frozen transfer epoch unlock a new authority path', () => {
    const malformed = connection({
      authorityEpoch: 5,
      // @ts-expect-error - deliberately omits providerContributionSelection: these cases prove the lifecycle owner rejects an incomplete retained stop marker.
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 1,
          authorityEpoch: 4,
          transportOrigin: {
            serverIdentityId: 'srv_old_transport',
            materializationRef: {
              pluginId: 'happier.channel.lifecycle',
              machineId: 'machine-old',
              materializationId: 'materialization-old',
            },
          },
        },
        transportOrigin: {
          serverIdentityId: 'srv_old_transport',
          materializationRef: {
            pluginId: 'happier.channel.lifecycle',
            machineId: 'machine-old',
            materializationId: 'materialization-old',
          },
        },
        stopRequest: {
          v: 1,
          connectionId: 'connection-lifecycle',
          providerConnectionKey: 'provider:connection-lifecycle',
          providerConfigVersion: 1,
          providerConfig: {},
          credentialRef: null,
          // An accepted transfer marker must be past its frozen stop epoch.
          // This stored value never completed the authority-advancing abandon.
          authorityEpoch: 5,
          reason: 'transfer',
        },
        overlapSafety: 'destructive',
        acceptedPossibleLoss: true,
      },
    });
    const nextStop = {
      predecessorCheckpointedPollInvocation:
        malformed.pendingOldTransportStop!.predecessorCheckpointedPollInvocation,
      transportOrigin: malformed.pendingOldTransportStop!.transportOrigin,
      stopRequest: {
        ...malformed.pendingOldTransportStop!.stopRequest,
        authorityEpoch: 6,
      },
    };

    expect(abandonConversationConnectionStop({ current: malformed })).toEqual({ kind: 'staleAuthority' });
    expect(transitionConversationConnection({
      current: malformed,
      requested: { enabled: false, maximumObservationAgeMs: malformed.maximumObservationAgeMs },
    })).toEqual({ kind: 'rejected', code: 'oldTransportStopPending' });
    expect(startConversationConnectionDelete({
      current: malformed,
      // @ts-expect-error - deliberately omits providerContributionSelection: these cases prove the lifecycle owner rejects an incomplete retained stop marker.
      pendingOldTransportStop: {
        ...nextStop,
        stopRequest: { ...nextStop.stopRequest, reason: 'delete' },
      },
    })).toEqual({ kind: 'rejected', code: 'oldTransportStopPending' });
    expect(startConversationConnectionTransfer({
      current: malformed,
      // @ts-expect-error - deliberately omits providerContributionSelection: these cases prove the lifecycle owner rejects an incomplete retained stop marker.
      pendingOldTransportStop: nextStop,
      replacement: { enabled: true, overlapSafety: 'safe', historyGap: null },
    })).toEqual({ kind: 'rejected', code: 'oldTransportStopPending' });
  });

  it('does not let a transfer stop request enter the delete transition', () => {
    const transferStopAsDelete = {
      current: connection(),
      pendingOldTransportStop: {
        transportOrigin: {
          serverIdentityId: 'srv_connection_lifecycle',
          materializationRef: {
            pluginId: 'happier.channel.lifecycle',
            machineId: 'machine-lifecycle',
            materializationId: 'materialization-lifecycle',
          },
        },
        stopRequest: {
          v: 1,
          connectionId: 'connection-lifecycle',
          providerConnectionKey: 'provider:connection-lifecycle',
          providerConfigVersion: 1,
          providerConfig: {},
          credentialRef: null,
          authorityEpoch: 8,
          reason: 'transfer',
        },
      },
    } as unknown as Parameters<typeof startConversationConnectionDelete>[0];

    expect(startConversationConnectionDelete(transferStopAsDelete)).toEqual({
      kind: 'rejected',
      code: 'stopRequestInvalid',
    });
  });

  it('uses the same epoch-owning transition for offline enablement without manufacturing delete intent', () => {
    const disabled = setConversationConnectionEnabled({
      current: connection({
        historyGap: { reportedAt: 1_700_000_000_000, reason: 'applicationAdmissionLost' },
      }),
      enabled: false,
    });

    expect(disabled).toEqual({
      kind: 'updated',
      connection: {
        authorityEpoch: 8,
        enabled: false,
        deletionState: 'none',
        overlapSafety: 'safe',
        pendingOldTransportStop: null,
        historyGap: null,
        providerReadiness: null,
        pollFailure: null,
        maximumObservationAgeMs: 60_000,
        observationAgeExpansionFloorOccurredAt: null,
      },
    });
    if (disabled.kind !== 'updated') throw new Error('Expected enabled-state update');
    expect(setConversationConnectionEnabled({
      current: disabled.connection,
      enabled: false,
    })).toEqual({ kind: 'unchanged', connection: disabled.connection });
  });

  it('updates Account-local connection policy in place while preserving pairing and transport authority', () => {
    const current = connection({
      authorityEpoch: 4,
      historyGap: { reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable' },
    });

    expect(transitionConversationConnection({
      current,
      requested: {
        enabled: false,
        maximumObservationAgeMs: 120_000,
      },
    })).toEqual({
      kind: 'updated',
      connection: {
        authorityEpoch: 5,
        enabled: false,
        deletionState: 'none',
        overlapSafety: 'safe',
        pendingOldTransportStop: null,
        historyGap: null,
        providerReadiness: null,
        pollFailure: null,
        maximumObservationAgeMs: 120_000,
        observationAgeExpansionFloorOccurredAt: null,
      },
    });
  });

  it('changes freshness policy without advancing connection authority', () => {
    const current = connection({
      authorityEpoch: 4,
      historyGap: { reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable' },
    });

    expect(transitionConversationConnection({
      current,
      requested: {
        enabled: true,
        maximumObservationAgeMs: 120_000,
      },
    })).toEqual({
      kind: 'updated',
      connection: {
        ...current,
        maximumObservationAgeMs: 120_000,
      },
    });
  });

  it('keeps the previous freshness horizon as one connection-local floor when widening observation age', () => {
    const current = connection({ authorityEpoch: 4 });

    expect(transitionConversationConnection({
      current,
      requested: {
        enabled: true,
        maximumObservationAgeMs: 120_000,
      },
      now: 70_000,
    })).toEqual({
      kind: 'updated',
      connection: {
        ...current,
        maximumObservationAgeMs: 120_000,
        pollFailure: null,
        observationAgeExpansionFloorOccurredAt: 10_000,
      },
    });
  });

  it('retains the expansion floor through later useful policy edits', () => {
    const original = connection({ authorityEpoch: 4 });
    const expanded = transitionConversationConnection({
      current: original,
      requested: { enabled: true, maximumObservationAgeMs: 120_000 },
      now: 70_000,
    });
    if (expanded.kind !== 'updated') throw new Error('Expected the age expansion to update the connection.');

    const narrowed = transitionConversationConnection({
      current: expanded.connection,
      requested: { enabled: true, maximumObservationAgeMs: 60_000 },
      now: 80_000,
    });
    expect(narrowed).toMatchObject({
      kind: 'updated',
      connection: {
        authorityEpoch: 4,
        maximumObservationAgeMs: 60_000,
        observationAgeExpansionFloorOccurredAt: 10_000,
      },
    });
    if (narrowed.kind !== 'updated') throw new Error('Expected the age reduction to update the connection.');

    expect(transitionConversationConnection({
      current: narrowed.connection,
      requested: { enabled: true, maximumObservationAgeMs: 120_000 },
      now: 130_000,
    })).toMatchObject({
      kind: 'updated',
      connection: {
        authorityEpoch: 4,
        maximumObservationAgeMs: 120_000,
        observationAgeExpansionFloorOccurredAt: 70_000,
      },
    });
  });

  it('clears a poll failure for any relevant connection policy change but retains it for an unchanged request', () => {
    const current = connection({
      pollFailure: {
        phase: 'blocked',
        attemptCount: 1,
        retryNotBeforeMs: null,
        evidence: { kind: 'provider', reason: 'credentialInvalid' },
      },
    });

    expect(transitionConversationConnection({
      current,
      requested: { enabled: true, maximumObservationAgeMs: 120_000 },
    })).toEqual({
      kind: 'updated',
      connection: {
        ...current,
        pollFailure: null,
        maximumObservationAgeMs: 120_000,
      },
    });
    expect(transitionConversationConnection({
      current,
      requested: { enabled: true, maximumObservationAgeMs: 60_000 },
    })).toEqual({ kind: 'unchanged', connection: current });
  });

  it('rejects an authority-changing policy write at the safe-integer epoch boundary', () => {
    const current = connection({ authorityEpoch: Number.MAX_SAFE_INTEGER });

    expect(transitionConversationConnection({
      current,
      requested: { enabled: false, maximumObservationAgeMs: current.maximumObservationAgeMs },
    })).toEqual({ kind: 'rejected', code: 'authorityEpochExhausted' });
    expect(transitionConversationConnection({
      current,
      requested: { enabled: true, maximumObservationAgeMs: current.maximumObservationAgeMs },
    })).toEqual({ kind: 'unchanged', connection: current });
  });

  it('rejects observation-age boundary neighbors before it can write authority', () => {
    const current = connection();

    for (const maximumObservationAgeMs of [
      MIN_CONVERSATION_OBSERVATION_AGE_MS - 1,
      MAX_CONVERSATION_OBSERVATION_AGE_MS + 1,
    ]) {
      expect(transitionConversationConnection({
        current,
        requested: {
          enabled: current.enabled,
          maximumObservationAgeMs,
        },
      })).toEqual({ kind: 'rejected', code: 'maximumObservationAgeInvalid' });
    }
  });

  it('records one current history gap and never lets a stale or changed report rewrite first evidence', () => {
    const current = connection({ authorityEpoch: 4 });
    const recorded = recordConversationConnectionHistoryGap({
      current,
      reportedAuthorityEpoch: 4,
      reportedAt: 1_700_000_000_000,
      fact: { reason: 'providerHistoryUnavailable', diagnostic: 'provider cursor expired' },
    });

    expect(recorded).toEqual({
      kind: 'recorded',
      connection: {
        ...current,
        historyGap: {
          reportedAt: 1_700_000_000_000,
          reason: 'providerHistoryUnavailable',
          diagnostic: 'provider cursor expired',
        },
      },
    });
    if (recorded.kind !== 'recorded') throw new Error('Expected history-gap evidence');
    expect(recordConversationConnectionHistoryGap({
      current: recorded.connection,
      reportedAuthorityEpoch: 4,
      reportedAt: 1_700_000_000_100,
      fact: { reason: 'applicationAdmissionLost' },
    })).toEqual({ kind: 'rejoined', connection: recorded.connection });
    expect(recordConversationConnectionHistoryGap({
      current: recorded.connection,
      reportedAuthorityEpoch: 3,
      reportedAt: 1_700_000_000_200,
      fact: { reason: 'applicationAdmissionLost' },
    })).toEqual({ kind: 'staleAuthority' });
  });

  it('records and clears only current provider-neutral readiness attention', () => {
    const current = connection({ authorityEpoch: 4 });
    const attention = recordConversationConnectionProviderReadiness({
      current,
      reportedAuthorityEpoch: 4,
      fact: {
        kind: 'providerReadiness',
        status: 'attention',
        code: 'providerPermissionMissing',
        diagnostic: 'A remotely configured provider permission is missing.',
      },
    });
    expect(attention).toMatchObject({
      kind: 'recorded',
      connection: {
        providerReadiness: {
          code: 'providerPermissionMissing',
          diagnostic: 'A remotely configured provider permission is missing.',
        },
      },
    });
    if (!('connection' in attention)) return;

    expect(recordConversationConnectionProviderReadiness({
      current: attention.connection,
      reportedAuthorityEpoch: 4,
      fact: {
        kind: 'providerReadiness',
        status: 'attention',
        code: 'providerPermissionMissing',
        diagnostic: 'A remotely configured provider permission is missing.',
      },
    })).toEqual({ kind: 'rejoined', connection: attention.connection });

    const configurationAttention = recordConversationConnectionProviderReadiness({
      current: attention.connection,
      reportedAuthorityEpoch: 4,
      fact: {
        kind: 'providerReadiness',
        status: 'attention',
        code: 'providerConfigurationInvalid',
      },
    });
    expect(configurationAttention).toMatchObject({
      kind: 'recorded',
      connection: {
        providerReadiness: { code: 'providerConfigurationInvalid' },
      },
    });
    if (!('connection' in configurationAttention)) return;

    expect(recordConversationConnectionProviderReadiness({
      current: configurationAttention.connection,
      reportedAuthorityEpoch: 4,
      fact: { kind: 'providerReadiness', status: 'ready' },
    })).toMatchObject({
      kind: 'recorded',
      connection: { providerReadiness: null },
    });
    expect(recordConversationConnectionProviderReadiness({
      current: attention.connection,
      reportedAuthorityEpoch: 3,
      fact: { kind: 'providerReadiness', status: 'ready' },
    })).toEqual({ kind: 'staleAuthority' });
  });
});
