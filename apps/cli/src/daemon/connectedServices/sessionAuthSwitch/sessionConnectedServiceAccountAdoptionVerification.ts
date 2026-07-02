import type { ConnectedServiceBindingsV1, ConnectedServiceId } from '@happier-dev/protocol';

import { getConnectedServiceRuntimeAuthAdapter } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import type {
  ConnectedServiceAccountTransitionVerificationResult,
  ConnectedServiceProviderRuntimeAuthAdapter,
} from '../runtimeAuth/types';

export type ConnectedServiceAccountAdoptionVerificationInput = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  target: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string | null;
    groupId?: string | null;
  }>;
  normalizedBindings: ConnectedServiceBindingsV1;
  action: 'hot_applied' | 'restart_requested';
  runtimeAuthSelection?: unknown;
}>;

export type ConnectedServiceAccountAdoptionVerifier = (
  input: ConnectedServiceAccountAdoptionVerificationInput,
) => Promise<ConnectedServiceAccountTransitionVerificationResult>;

export function createSessionConnectedServiceAccountAdoptionVerifier(deps?: Readonly<{
  resolveRuntimeAuthAdapter?: (agentId: CatalogAgentId) => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
}>): ConnectedServiceAccountAdoptionVerifier {
  const resolveRuntimeAuthAdapter = deps?.resolveRuntimeAuthAdapter
    ?? (async (agentId: CatalogAgentId) => await getConnectedServiceRuntimeAuthAdapter(agentId));

  return async function verifySessionConnectedServiceAccountAdoption(
    input: ConnectedServiceAccountAdoptionVerificationInput,
  ): Promise<ConnectedServiceAccountTransitionVerificationResult> {
    const adapter = await resolveRuntimeAuthAdapter(input.agentId);
    if (!adapter?.verifyActiveAccount) {
      return {
        status: 'unavailable',
        retryable: false,
        reason: 'active_account_verifier_unavailable',
      };
    }
    const binding = input.normalizedBindings.bindingsByServiceId[input.serviceId];
    return await adapter.verifyActiveAccount({
      target: { agentId: input.agentId },
      selection: input.runtimeAuthSelection ?? {
        serviceId: input.serviceId,
        binding,
        profileId: input.target.profileId,
        ...(input.target.groupId ? { groupId: input.target.groupId, activeProfileId: input.target.profileId } : {}),
      },
    });
  };
}
