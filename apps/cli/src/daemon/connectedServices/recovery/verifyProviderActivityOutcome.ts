import {
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedAccountServiceKey,
} from '@happier-dev/protocol';

import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { getConnectedServiceRuntimeAuthAdapter } from '../catalogHooks';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  type ConnectedServiceChildSelection,
} from '../connectedServiceChildEnvironment';
import type { ConnectedServiceRuntimeTarget } from '../runtimeRegistry/target';
import type {
  ConnectedServiceProviderOutcomeTarget,
  ConnectedServiceProviderRuntimeAuthAdapter,
} from '../runtimeAuth/types';

export type VerifiedConnectedServiceProviderActivityOutcome = Readonly<{
  status: 'verified';
  targets: readonly ConnectedServiceProviderOutcomeTarget[];
}>;

export type ConnectedServiceProviderActivityOutcomeVerification =
  | VerifiedConnectedServiceProviderActivityOutcome
  | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{ status: 'unsupported' }>;

function expectedTarget(selection: ConnectedServiceChildSelection): ConnectedServiceProviderOutcomeTarget | null {
  const revision = ConnectedServiceCredentialRevisionV1Schema.safeParse(selection.credentialRevision);
  if (!revision.success) return null;
  if (selection.kind === 'profile') {
    return {
      serviceId: selection.serviceId,
      profileId: selection.profileId,
      groupId: null,
      groupGeneration: null,
      credentialRevision: revision.data,
    };
  }
  return {
    serviceId: selection.serviceId,
    profileId: selection.activeProfileId,
    groupId: selection.groupId,
    groupGeneration: selection.generation,
    credentialRevision: revision.data,
  };
}

function sameTarget(
  expected: ConnectedServiceProviderOutcomeTarget,
  actual: ConnectedServiceProviderOutcomeTarget,
): boolean {
  return expected.serviceId === actual.serviceId
    && expected.profileId === actual.profileId
    && expected.groupId === actual.groupId
    && expected.groupGeneration === actual.groupGeneration
    && expected.credentialRevision === actual.credentialRevision;
}

export async function verifyProviderActivityOutcome(input: Readonly<{
  target: Pick<
    ConnectedServiceRuntimeTarget,
    'agentId' | 'runtimeIdentityKey' | 'connectedServiceSelectionsEnv' | 'connectedServiceSelections'
  >;
  reportedSelectionsEnvRaw: string | null | undefined;
  event: 'task_started' | 'assistant_message_end';
  loadAdapter?: (agentId: Parameters<typeof getConnectedServiceRuntimeAuthAdapter>[0]) =>
    Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
}>): Promise<ConnectedServiceProviderActivityOutcomeVerification> {
  if (!input.target.agentId || !isCatalogAgentId(input.target.agentId)) {
    return { status: 'unavailable', reason: 'runtime_agent_identity_missing' };
  }
  const adapter = await (input.loadAdapter ?? getConnectedServiceRuntimeAuthAdapter)(input.target.agentId);
  if (!adapter?.verifyProviderOutcome) return { status: 'unsupported' };
  const registeredRaw = input.target.connectedServiceSelectionsEnv[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  if (!registeredRaw || !input.reportedSelectionsEnvRaw) {
    return { status: 'unavailable', reason: 'runtime_selection_epoch_missing' };
  }
  if (registeredRaw !== input.reportedSelectionsEnvRaw) {
    return { status: 'unavailable', reason: 'runtime_selection_epoch_mismatch' };
  }

  const result = await adapter.verifyProviderOutcome({
    target: { agentId: input.target.agentId, targetId: input.target.runtimeIdentityKey },
    selections: input.target.connectedServiceSelections,
    outcome: { kind: 'provider_activity', event: input.event },
  });
  if (result.status !== 'verified') return result;
  if (result.targets.length === 0) {
    return { status: 'unavailable', reason: 'provider_outcome_target_missing' };
  }
  const expectedByServiceId = new Map<ConnectedAccountServiceKey, ConnectedServiceProviderOutcomeTarget>();
  for (const selection of input.target.connectedServiceSelections) {
    const expected = expectedTarget(selection);
    if (!expected) {
      return { status: 'unavailable', reason: 'runtime_selection_revision_missing' };
    }
    expectedByServiceId.set(selection.serviceId, expected);
  }
  const seen = new Set<string>();
  for (const actual of result.targets) {
    const expected = expectedByServiceId.get(actual.serviceId);
    if (!expected || seen.has(actual.serviceId) || !sameTarget(expected, actual)) {
      return { status: 'unavailable', reason: 'provider_outcome_target_mismatch' };
    }
    seen.add(actual.serviceId);
  }
  return { status: 'verified', targets: result.targets };
}
