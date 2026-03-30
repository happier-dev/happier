import {
  AGENTS_CORE,
  evaluateVendorHandoffEligibility,
  resolveAgentIdFromFlavor,
  type AgentId,
} from '@happier-dev/agents';

type SessionStorageMode = 'direct' | 'persisted';

type SessionHandoffEligibility =
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

function hasKnownAgentIdentity(metadata: Record<string, unknown>): AgentId | null {
  const byFlavor = resolveAgentIdFromFlavor(metadata.flavor);
  if (byFlavor) return byFlavor;

  for (const [agentId, core] of Object.entries(AGENTS_CORE) as [AgentId, (typeof AGENTS_CORE)[AgentId]][]) {
    const resume = core.resume;
    if (!('vendorResumeIdField' in resume)) continue;
    const field = resume.vendorResumeIdField;
    if (!field) continue;
    const raw = metadata[field];
    if (typeof raw === 'string' && raw.trim()) return agentId;
  }

  return null;
}

function getSessionStorageMode(metadata: Record<string, unknown>): SessionStorageMode {
  const directSession = metadata.directSessionV1;
  if (!directSession || typeof directSession !== 'object') return 'persisted';
  return (directSession as { v?: unknown }).v === 1 ? 'direct' : 'persisted';
}

export function resolveSessionHandoffEligibility(input: Readonly<{
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): SessionHandoffEligibility {
  const metadata = asRecord(input.metadata);
  if (!metadata) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }

  const agentId = hasKnownAgentIdentity(metadata);
  if (!agentId) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }

  const sourceMachineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
  if (!sourceMachineId) {
    return { eligible: false, reasonCode: 'source_machine_missing' };
  }

  const storageMode = getSessionStorageMode(metadata);
  const vendor = evaluateVendorHandoffEligibility({
    agentId,
    storageMode,
    metadata,
    accountSettings: input.accountSettings,
  });
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
