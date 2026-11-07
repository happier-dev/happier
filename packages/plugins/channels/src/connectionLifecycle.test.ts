import { describe, expect, it } from 'vitest';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/plugin-sdk/actions';

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
      },
    });
  });

  // Owner ruling 2026-10-29: provider-derived dedupe replaces per-connection age.
  it('retains a poll failure when the enabled policy is unchanged', () => {
    const current = connection({ pollFailure: { phase: 'blocked', attemptCount: 1,
      retryNotBeforeMs: null, evidence: { kind: 'provider', reason: 'credentialInvalid' } } });
    expect(transitionConversationConnection({ current, requested: { enabled: true } }))
      .toEqual({ kind: 'unchanged', connection: current });
    expect(transitionConversationConnection({ current, requested: { enabled: false } }))
      .toMatchObject({ kind: 'updated', connection: { enabled: false, pollFailure: null } });
  });

  it('rejects an authority-changing policy write at the safe-integer epoch boundary', () => {
    const current = connection({ authorityEpoch: Number.MAX_SAFE_INTEGER });

    expect(transitionConversationConnection({
      current,
      requested: { enabled: false },
    })).toEqual({ kind: 'rejected', code: 'authorityEpochExhausted' });
    expect(transitionConversationConnection({
      current,
      requested: { enabled: true },
    })).toEqual({ kind: 'unchanged', connection: current });
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
