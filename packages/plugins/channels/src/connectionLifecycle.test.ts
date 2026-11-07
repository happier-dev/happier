import { describe, expect, it } from 'vitest';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/plugin-sdk/actions';
import {
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
} from '@happier-dev/channels-protocol/v1';

import {
  freezeConversationConnectionTransportOrigin,
  recordConversationConnectionHistoryGap,
  recordConversationConnectionProviderReadiness,
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
  it('fences delete immediately and retains only cleanup recovery', () => {
    const started = startConversationConnectionDelete({
      current: connection(),
    });
    expect(started).toMatchObject({ kind: 'deleteFinalizing', connection: {
      authorityEpoch: 8, enabled: false, deletionState: 'finalizingDelete', pendingOldTransportStop: null,
    } });
  });
  it('lets explicit Delete recover a retained legacy pending row without another generation', () => {
    const transportOrigin = { serverIdentityId: 'srv_lifecycle', machineId: 'machine-offline' };
    const started = startConversationConnectionDelete({ current: connection({
      authorityEpoch: 8, enabled: false, deletionState: 'pendingStopReconciliation',
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation: { connectionRevision: 1, authorityEpoch: 7, transportOrigin },
        transportOrigin, providerContributionSelection: { contributionId: 'provider' },
        stopRequest: { v: 1, connectionId: 'connection-1', providerConnectionKey: 'provider:1',
          providerConfigVersion: 1, providerConfig: {}, credentialRef: null, authorityEpoch: 8, reason: 'delete' },
        predecessorTransportKind: 'socket', endpointRetarget: 'notRequired', overlapSafety: 'safe', acceptedPossibleLoss: false,
      },
    }) });
    expect(started).toMatchObject({ kind: 'deleteFinalizing', connection: {
      authorityEpoch: 8, enabled: false, deletionState: 'finalizingDelete', pendingOldTransportStop: null,
    } });
  });
  it('transfers with one new generation and no old-worker stop custody', () => {
    const started = startConversationConnectionTransfer({
      current: connection(),
      replacement: { enabled: true, overlapSafety: 'safe', historyGap: null },
    });
    expect(started).toMatchObject({ kind: 'transferred', connection: {
      authorityEpoch: 8, enabled: true, pendingOldTransportStop: null,
    } });
  });
  it('retains only Home and Machine placement across compatible source replacements', () => {
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_lifecycle', sourceRef: {
      pluginId: 'happier.channel.lifecycle', machineId: 'machine-1',
      sourceCustody: { kind: 'development', registeredRootId: '/runtime-1/provider' },
    } });
    const frozen = freezeConversationConnectionTransportOrigin({ serverIdentityId: origin.serverIdentityId, machineId: 'machine-1' });
    expect(frozen).toEqual({ serverIdentityId: 'srv_lifecycle', machineId: 'machine-1' });
    expect(Object.isFrozen(frozen)).toBe(true);
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
        historyGap: current.historyGap,
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

  it('preserves an owner-selected freshness policy beyond thirty days', () => {
    const current = connection();
    const maximumObservationAgeMs = 31 * 86_400_000;
    expect(transitionConversationConnection({
      current,
      requested: { enabled: current.enabled, maximumObservationAgeMs },
    })).toMatchObject({ kind: 'updated', connection: { maximumObservationAgeMs } });
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
