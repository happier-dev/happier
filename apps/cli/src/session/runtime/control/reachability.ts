import type {
  HostRuntimeControlReachabilityDelegateV1,
  HostRuntimeControlReachabilityInputV1,
  HostRuntimeControlResultV1,
} from '@happier-dev/agents';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { canResumeFromMaterializedState } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedState';

type MaterializedStateReachabilityInput = Parameters<typeof canResumeFromMaterializedState>[0];

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStateMode(value: unknown): 'shared' | 'isolated' | null {
  return value === 'shared' || value === 'isolated' ? value : null;
}

function readCatalogAgentId(value: unknown): CatalogAgentId | null {
  return typeof value === 'string' && (CATALOG_AGENT_IDS as readonly string[]).includes(value)
    ? value as CatalogAgentId
    : null;
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'string') return null;
    record[key] = child;
  }
  return record;
}

function readMaterializedStateReachabilityInput(
  value: HostRuntimeControlReachabilityInputV1,
): MaterializedStateReachabilityInput | null {
  const agentId = readCatalogAgentId(value.agentId);
  const serviceId = ConnectedServiceIdSchema.safeParse(value.serviceId);
  const targetMaterializedRoot = readString(value.targetMaterializedRoot);
  const targetMaterializedEnv = readStringRecord(value.targetMaterializedEnv);
  const vendorResumeId = readString(value.vendorResumeId);
  const cwd = readString(value.cwd);
  const requestedStateMode = readStateMode(value.requestedStateMode);
  const effectiveStateMode = readStateMode(value.effectiveStateMode);
  const materializationIdentity = value.materializationIdentity;
  if (
    !agentId
    || !serviceId.success
    || !targetMaterializedRoot
    || !targetMaterializedEnv
    || !vendorResumeId
    || !cwd
    || !requestedStateMode
    || !effectiveStateMode
    || !materializationIdentity
    || typeof materializationIdentity !== 'object'
    || Array.isArray(materializationIdentity)
  ) {
    return null;
  }
  return {
    agentId,
    serviceId: serviceId.data,
    targetMaterializedRoot,
    targetMaterializedEnv,
    requestedStateMode,
    effectiveStateMode,
    materializationIdentity: materializationIdentity as MaterializedStateReachabilityInput['materializationIdentity'],
    vendorResumeId,
    cwd,
    candidatePersistedSessionFile: readString(value.candidatePersistedSessionFile),
  };
}

function failure(code: string): HostRuntimeControlResultV1<unknown> {
  return {
    ok: false,
    code,
    error: code,
    diagnostics: [{ code }],
  };
}

export function createSessionRuntimeControlReachability(): HostRuntimeControlReachabilityDelegateV1 {
  return {
    verifyMaterializedState: async (input) => {
      const reachabilityInput = readMaterializedStateReachabilityInput(input);
      if (!reachabilityInput) return failure('resume_reachability_unavailable');
      return {
        ok: true,
        value: await canResumeFromMaterializedState(reachabilityInput),
      };
    },
  };
}
