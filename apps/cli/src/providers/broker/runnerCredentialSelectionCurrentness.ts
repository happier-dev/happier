import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema,
  type DaemonProviderTeamCredentialBrokerEligibilityRequestV1,
  type DaemonProviderTeamCredentialBrokerEligibilityResponseV1 } from '@happier-dev/protocol/rpc/providers';
import type { TeamCredentialResourceReadinessV1, TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import type { RunnerCredentialSelectionBindingV1 } from '@happier-dev/protocol/ephemeralRunner/review';
import { teamCredentialBrokerResourceAcceptsMachine } from './teamCredentialBrokerSourceOwner';

type RunnerCredentialSelectionCurrentnessInput = Readonly<{
  registeredMachineId: string;
  selection: RunnerCredentialSelectionBindingV1;
  modelId: string;
  signal: AbortSignal;
  readResource(
    resourceId: string,
    signal: AbortSignal,
  ): Promise<TeamCredentialResourceSummaryV1 | null>;
  resolveEligibility(
    request: DaemonProviderTeamCredentialBrokerEligibilityRequestV1,
    signal?: AbortSignal,
  ): Promise<DaemonProviderTeamCredentialBrokerEligibilityResponseV1>;
}>;

/** Rechecks one Runner's already frozen exact broker Machine against that
 * Machine's canonical current-only source eligibility owner. Pool membership
 * selected the Machine on the Home; it is intentionally neither enumerated nor
 * ranked again here. */
export async function resolveRunnerCredentialSelectionCurrentness(
  input: RunnerCredentialSelectionCurrentnessInput,
): Promise<TeamCredentialResourceReadinessV1> {
  input.signal.throwIfAborted();
  if (input.selection.brokerMachineId !== input.registeredMachineId) {
    return { kind: 'source_unavailable' };
  }
  const resource = await input.readResource(input.selection.resourceId, input.signal);
  input.signal.throwIfAborted();
  if (
    !teamCredentialBrokerResourceAcceptsMachine(resource, input.selection.brokerMachineId)
    || resource.revision !== input.selection.revision
  ) return { kind: 'source_unavailable' };

  if (resource.readiness.kind === 'source_unavailable'
    && resource.readiness.reason === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired) {
    return resource.readiness;
  }

  let rawEligibility: DaemonProviderTeamCredentialBrokerEligibilityResponseV1;
  try {
    rawEligibility = await input.resolveEligibility({
      machineId: input.selection.brokerMachineId,
      teamId: resource.teamId,
      resourceId: resource.id,
      expectedResourceRevision: resource.revision,
      source: resource.source,
      application: input.selection.application,
      modelId: input.modelId,
      sourceRevision: input.selection.sourceRevision,
    }, input.signal);
  } catch {
    input.signal.throwIfAborted();
    return { kind: 'source_unavailable' };
  }
  input.signal.throwIfAborted();
  const eligibility = DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema.safeParse(rawEligibility);
  if (!eligibility.success) return { kind: 'source_unavailable' };
  if (eligibility.data.status === 'eligible') return { kind: 'available' };
  if (eligibility.data.reason === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired) {
    return { kind: 'source_unavailable', reason: eligibility.data.reason };
  }
  return { kind: eligibility.data.reason === 'application_unavailable' ? 'update_required' : 'source_unavailable' };
}
