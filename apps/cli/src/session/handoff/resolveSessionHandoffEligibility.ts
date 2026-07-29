import {
  evaluateVendorHandoffEligibility,
  isAgentId,
  resolveAgentIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';
import { readLinkedExternalSessionV1FromMetadata } from '@happier-dev/protocol';
import { resolveSessionRuntimeIdentityFallback } from '@/agent/runtime/identity';

type SessionStorageMode = 'direct' | 'persisted';

export type SessionHandoffEligibility =
  | Readonly<{
      eligible: true;
      agentId: AgentId;
      storageMode: SessionStorageMode;
      sourceMachineId: string;
      vendorHandoffId: string;
    }>
  | Readonly<{
      eligible: false;
      reasonCode:
        | 'agent_unknown'
        | 'source_machine_missing'
        | 'storage_mode_unsupported'
        | 'handoff_unsupported'
        | 'vendor_handoff_id_missing'
        | 'experimental_disabled'
        | 'backend_disabled_by_account_settings';
      agentId?: AgentId;
      storageMode?: SessionStorageMode;
    }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function buildVendorEligibilityMetadata(
  metadata: Record<string, unknown>,
  runtimeDescriptorV1: unknown,
): Record<string, unknown> {
  if (asRecord(metadata.runtimeDescriptorV1)) {
    return metadata;
  }
  if (!asRecord(runtimeDescriptorV1)) {
    return metadata;
  }
  return {
    ...metadata,
    runtimeDescriptorV1,
  };
}

export function resolveSessionHandoffEligibility(input: Readonly<{
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): SessionHandoffEligibility {
  const metadata = asRecord(input.metadata);
  if (!metadata) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }

  const runtimeIdentity = resolveSessionRuntimeIdentityFallback({ metadata });
  const externalSessionLink = readLinkedExternalSessionV1FromMetadata(metadata);
  const agentId = externalSessionLink?.agentId ?? resolveAgentIdFromSessionMetadata(metadata);
  if (!agentId) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }
  if (!isAgentId(agentId)) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }

  const sourceMachineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
  if (!sourceMachineId) {
    return { eligible: false, reasonCode: 'source_machine_missing' };
  }

  const storageMode: SessionStorageMode = externalSessionLink ? 'direct' : 'persisted';
  const vendorEligibilityMetadata = buildVendorEligibilityMetadata(
    metadata,
    runtimeIdentity.runtimeDescriptorV1,
  );
  const vendor = evaluateVendorHandoffEligibility({
    agentId,
    storageMode,
    metadata: vendorEligibilityMetadata,
    accountSettings: input.accountSettings,
  });

  if (!vendor.eligible && vendor.reasonCode === 'vendor_handoff_id_missing' && runtimeIdentity.providerSessionId) {
    return {
      eligible: true,
      agentId,
      storageMode,
      sourceMachineId,
      vendorHandoffId: runtimeIdentity.providerSessionId,
    };
  }

  if (!vendor.eligible) {
    return {
      eligible: false,
      reasonCode: vendor.reasonCode,
      agentId,
      storageMode,
    };
  }

  return {
    eligible: true,
    agentId,
    storageMode,
    sourceMachineId,
    vendorHandoffId: vendor.vendorHandoffId,
  };
}
