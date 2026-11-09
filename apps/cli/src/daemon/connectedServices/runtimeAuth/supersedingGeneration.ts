import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';
import type { ConnectedServiceProviderAdoptedGenerationTarget } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { ConnectedServiceAuthGroupGenerationConsumer } from "@/daemon/connectedServices/accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer";
import { resolveCommittedGenerationFromRuntimeAuthRecovery } from "@/daemon/connectedServices/sessionAuthSwitch/resolveCommittedGenerationFromRuntimeAuthRecovery";

export function isSupersededRuntimeAuthFailure(
  input: Readonly<{
    result: unknown;
  }>,
): boolean {
  if (
    !input.result ||
    typeof input.result !== 'object' ||
    !('status' in input.result) ||
    input.result.status !== 'recovery_superseded' ||
    !('reason' in input.result) ||
    (input.result.reason !== 'source_tuple_unavailable' &&
      input.result.reason !== 'source_tuple_mismatch')
  ) {
    return false;
  }
  return true;
}

export async function settleSupersedingRuntimeAuthGenerationForSource(
  input: Readonly<{
    recovery: unknown;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    sessionId: string;
    fromProfileId: string | null;
    consumeCommittedAuthGroupGeneration: (
      consumeInput: Parameters<
        ConnectedServiceAuthGroupGenerationConsumer['consume']
      >[0],
    ) => Promise<
      Pick<
        Awaited<
          ReturnType<ConnectedServiceAuthGroupGenerationConsumer['consume']>
        >,
        'outcome' | 'resultsBySessionId'
      >
    >;
  }>,
): Promise<ConnectedServiceProviderAdoptedGenerationTarget> {
  const resolved = resolveCommittedGenerationFromRuntimeAuthRecovery({
    serviceId: input.serviceId,
    groupId: input.groupId,
    recovery: input.recovery,
    provenance: 'runtime_failure',
  });
  if (!resolved?.sourceRequiresConvergence) {
    throw Object.assign(
      new Error(
        'connected_service_runtime_auth_superseding_generation_target_unavailable',
      ),
      {
        code: 'connected_service_runtime_auth_superseding_generation_target_unavailable',
        retryable: true,
      },
    );
  }
  const consumption = await input.consumeCommittedAuthGroupGeneration({
    committedGeneration: resolved.committedGeneration,
    switchReason: 'automatic_runtime_failure',
    sessions: [
      {
        sessionId: input.sessionId,
        activity: 'live',
        fromProfileId: input.fromProfileId,
      },
    ],
    executionAuthority: 'runtime_recovery',
  });
  if (consumption.outcome !== 'adopted_current') {
    throw Object.assign(
      new Error(
        'connected_service_runtime_auth_superseding_generation_not_acknowledged',
      ),
      {
        code: 'connected_service_runtime_auth_superseding_generation_not_acknowledged',
        retryable: true,
        outcome: consumption.outcome,
      },
    );
  }
  const recipient = consumption.resultsBySessionId[input.sessionId];
  const adopted = recipient?.providerAdoptedTarget;
  if (recipient?.reconciliationDisposition !== 'converged' || !adopted
    || adopted.serviceId !== resolved.committedGeneration.decisionCommittedTarget.serviceId
    || adopted.groupId !== resolved.committedGeneration.decisionCommittedTarget.groupId) {
    const code = 'connected_service_runtime_auth_superseding_generation_target_not_settled';
    throw Object.assign(new Error(code), { code, retryable: true });
  }
  return adopted;
}
