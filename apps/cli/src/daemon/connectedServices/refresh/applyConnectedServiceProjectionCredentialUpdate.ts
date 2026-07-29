import type {
  ConnectedServiceExecutionAuthorityV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import type { ConnectedServiceRuntimeRefreshTarget } from '../runtimeRegistry/registry';
import type { ConnectedServiceProjectedCredentialPresence } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import { settleConnectedServiceCredentialDeletion } from './createConnectedServicesAuthUpdatedRestartHandler';

type PresentCredentialProjection = Extract<
  ConnectedServiceProjectedCredentialPresence,
  Readonly<{ status: 'present' }>
>;

type CredentialProjectionRuntimeTarget = Pick<
  ConnectedServiceRuntimeRefreshTarget,
  'pid' | 'agentId' | 'sessionId' | 'materializationKey' | 'bindings'
>;

function targetContainsBinding(
  target: CredentialProjectionRuntimeTarget,
  binding: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
): boolean {
  return target.bindings.some((candidate) =>
    candidate.serviceId === binding.serviceId
    && candidate.profileId === binding.profileId,
  );
}

function isSameLifecycleTarget(
  expected: Readonly<{
    pid: number;
    sessionId?: string | null;
    materializationKey?: string | null;
  }>,
  candidate: CredentialProjectionRuntimeTarget,
): boolean {
  return expected.sessionId
    ? candidate.sessionId === expected.sessionId
    : candidate.pid === expected.pid
      && candidate.materializationKey === expected.materializationKey;
}

export async function applyConnectedServiceProjectionCredentialUpdate(params: Readonly<{
  input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialPresence: ConnectedServiceProjectedCredentialPresence;
    executionAuthority: ConnectedServiceExecutionAuthorityV1;
  }>;
  listRuntimeTargets: () => ReadonlyArray<CredentialProjectionRuntimeTarget>;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  getRefreshCoordinator: () => Readonly<{
    handleExternalCredentialUpdate(input: Readonly<{
      serviceId: ConnectedServiceId;
      profileId: string;
      credentialPresence: PresentCredentialProjection;
      executionAuthority: ConnectedServiceExecutionAuthorityV1;
    }>): Promise<void>;
  }> | null;
}>): Promise<void> {
  if (params.input.credentialPresence.status === 'legacy_unfenced') return;

  const binding = {
    serviceId: params.input.serviceId,
    profileId: params.input.profileId,
  } as const;
  if (params.input.credentialPresence.status === 'absent') {
    const affectedTargets = params.listRuntimeTargets().filter((target) =>
      targetContainsBinding(target, binding),
    );
    if (affectedTargets.length === 0) return;
    await settleConnectedServiceCredentialDeletion({
      binding,
      affectedTargets,
      stopSession: params.stopSession,
      isCredentialTargetPresent: ({ target }) =>
        params.listRuntimeTargets().some((candidate) =>
          isSameLifecycleTarget(target, candidate)
          && targetContainsBinding(candidate, binding),
        ),
    });
    return;
  }

  const coordinator = params.getRefreshCoordinator();
  if (!coordinator) {
    throw new Error('connected_service_credential_projection_materialization_owner_unavailable');
  }
  await coordinator.handleExternalCredentialUpdate({
    ...params.input,
    credentialPresence: params.input.credentialPresence,
  });
}
