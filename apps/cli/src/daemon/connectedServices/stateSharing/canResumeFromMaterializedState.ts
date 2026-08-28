import type { CatalogAgentId } from '@/agent/catalog/types';
import { verifyResumeReachabilityByAgent } from '@/daemon/connectedServices/verifyResumeReachabilityByAgent';

import {
  canResumeFromMaterializedStateCore,
  type CanResumeFromMaterializedStateCoreInput,
  type CanResumeFromMaterializedStateResult,
} from './canResumeFromMaterializedStateCore';
import type { ConnectedServiceStateSharingManifestV1 } from './connectedServiceStateSharingManifest';

type StateMode = CanResumeFromMaterializedStateCoreInput['effectiveStateMode'];

export type CanResumeFromMaterializedStateInput = Readonly<{
  agentId: CatalogAgentId;
  serviceId: string;
  targetMaterializedRoot: string;
  effectiveStateMode: StateMode;
  requestedStateMode: StateMode;
  materializationIdentity: Readonly<{ v: 1; id: string }>;
  vendorResumeId: string;
  cwd: string;
  runtimeDescriptorV1?: CanResumeFromMaterializedStateCoreInput['runtimeDescriptorV1'];
  candidatePersistedSessionFile?: string | null;
  manifest?: ConnectedServiceStateSharingManifestV1 | null;
}>;

export type { CanResumeFromMaterializedStateResult };

export async function canResumeFromMaterializedState(
  input: CanResumeFromMaterializedStateInput,
): Promise<CanResumeFromMaterializedStateResult> {
  return await canResumeFromMaterializedStateCore({
    targetMaterializedRoot: input.targetMaterializedRoot,
    requestedStateMode: input.requestedStateMode,
    effectiveStateMode: input.effectiveStateMode,
    materializationIdentity: input.materializationIdentity,
    vendorResumeId: input.vendorResumeId,
    cwd: input.cwd,
    ...(input.runtimeDescriptorV1 ? { runtimeDescriptorV1: input.runtimeDescriptorV1 } : {}),
    candidatePersistedSessionFile: input.candidatePersistedSessionFile ?? null,
    manifest: input.manifest,
    verifyResumeReachable: async (providerInput) => await verifyResumeReachabilityByAgent({
      agentId: input.agentId,
      input: providerInput,
    }),
  });
}
