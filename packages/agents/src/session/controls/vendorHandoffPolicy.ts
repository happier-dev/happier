import { isBackendTargetDisabledByAccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import { getAgentCore } from '../../manifest.js';
import type { AgentId } from '../../types.js';
import { resolveAgentRuntimeControlSurfaceForSession } from './runtimeControlSurface.js';
import { resolveVendorResumeIdFromSessionMetadata } from './vendorResumePolicy.js';

export const VENDOR_HANDOFF_UNSUPPORTED = 'handoff_unsupported';

const DECLARED_HANDOFF_REFUSAL = {
  ok: false,
  errorCode: VENDOR_HANDOFF_UNSUPPORTED,
  error: 'Handoff is unavailable for this Agent.',
} as const;

/** Refuse only a known catalog declaration that excludes every runtime. */
export function readDeclaredVendorHandoffRefusal(agentId: AgentId | null): typeof DECLARED_HANDOFF_REFUSAL | null {
  const core = agentId ? getAgentCore(agentId) : null;
  if (core?.handoff.vendorStateTransfer !== 'unsupported') return null;
  const runtimeKinds = Object.values(core.runtimeKinds?.byKind ?? {});
  if (runtimeKinds.some(({ overrides }) => (overrides?.handoff?.vendorStateTransfer ?? 'unsupported') !== 'unsupported')) {
    return null;
  }
  return DECLARED_HANDOFF_REFUSAL;
}

export type VendorHandoffStorageMode = 'direct' | 'persisted';

export type VendorHandoffEligibilityReasonCode =
  | 'storage_mode_unsupported'
  | 'handoff_unsupported'
  | 'vendor_handoff_id_missing'
  | 'experimental_disabled'
  | 'backend_disabled_by_account_settings';

export type VendorHandoffEligibility =
  | Readonly<{ eligible: true; vendorHandoffId: string }>
  | Readonly<{ eligible: false; reasonCode: VendorHandoffEligibilityReasonCode }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isBackendDisabledByAccountSettings(agentId: AgentId, accountSettings: Record<string, unknown> | null): boolean {
  // The Account Settings catalog owns this key's vocabulary: the parsed
  // projection stores the canonical V2 target key, so indexing it with a
  // locally built legacy key would silently read every backend as enabled.
  return isBackendTargetDisabledByAccountSettings(
    accountSettings,
    { kind: 'builtInAgent', agentId },
  );
}

export function resolveVendorHandoffIdFromSessionMetadata(agentId: AgentId, metadata: unknown): string | null {
  return resolveVendorResumeIdFromSessionMetadata(agentId, metadata);
}

export function evaluateVendorHandoffEligibility(input: Readonly<{
  agentId: AgentId;
  storageMode: VendorHandoffStorageMode;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): VendorHandoffEligibility {
  const accountSettings = asRecord(input.accountSettings) ?? null;
  const runtimeControlSurface = resolveAgentRuntimeControlSurfaceForSession({
    agentId: input.agentId,
    metadata: input.metadata,
  });
  if (!runtimeControlSurface) {
    return { eligible: false, reasonCode: 'handoff_unsupported' };
  }
  const resolvedRuntimeControlSurface = runtimeControlSurface;

  if (isBackendDisabledByAccountSettings(input.agentId, accountSettings)) {
    return { eligible: false, reasonCode: 'backend_disabled_by_account_settings' };
  }

  if (!resolvedRuntimeControlSurface.sessionStorage[input.storageMode]) {
    return { eligible: false, reasonCode: 'storage_mode_unsupported' };
  }

  if (resolvedRuntimeControlSurface.handoff.vendorStateTransfer === 'unsupported') {
    return { eligible: false, reasonCode: 'handoff_unsupported' };
  }

  const vendorHandoffId = resolveVendorHandoffIdFromSessionMetadata(input.agentId, input.metadata);
  if (!vendorHandoffId) {
    return { eligible: false, reasonCode: 'vendor_handoff_id_missing' };
  }

  return { eligible: true, vendorHandoffId };
}
