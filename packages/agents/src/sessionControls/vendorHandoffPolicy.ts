import { buildBackendTargetKey } from '@happier-dev/protocol';
import type { AgentId } from '../types.js';
import { AGENTS_CORE } from '../manifest.js';
import { isCodexVendorResumeBackendEnabled } from '../providerSettings/definitions/codex.js';
import { resolvePersistedCodexRuntimeIdentity } from './codexRuntimeIdentity.js';
import { resolveVendorResumeIdFromSessionMetadata } from './vendorResumePolicy.js';

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
  const backendEnabledByTargetKey = accountSettings?.backendEnabledByTargetKey;
  const backendEnabledByTargetKeyRecord = asRecord(backendEnabledByTargetKey);
  if (!backendEnabledByTargetKeyRecord) return false;
  return backendEnabledByTargetKeyRecord[buildBackendTargetKey({ kind: 'builtInAgent', agentId })] === false;
}

function isCodexVendorHandoffEnabled(input: Readonly<{
  metadata: unknown;
  accountSettings: Record<string, unknown> | null;
}>): boolean {
  const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(input.metadata);
  if (runtimeIdentity?.backendMode === 'acp' || runtimeIdentity?.backendMode === 'appServer') {
    return true;
  }
  return isCodexVendorResumeBackendEnabled(input.accountSettings ?? {});
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

  if (isBackendDisabledByAccountSettings(input.agentId, accountSettings)) {
    return { eligible: false, reasonCode: 'backend_disabled_by_account_settings' };
  }

  const agent = AGENTS_CORE[input.agentId];
  if (!agent.sessionStorage[input.storageMode]) {
    return { eligible: false, reasonCode: 'storage_mode_unsupported' };
  }

  if (agent.handoff.vendorStateTransfer === 'unsupported') {
    return { eligible: false, reasonCode: 'handoff_unsupported' };
  }

  if (agent.handoff.vendorStateTransfer === 'experimental') {
    if (input.agentId === 'codex') {
      if (!isCodexVendorHandoffEnabled({ metadata: input.metadata, accountSettings })) {
        return { eligible: false, reasonCode: 'experimental_disabled' };
      }
    } else {
      return { eligible: false, reasonCode: 'experimental_disabled' };
    }
  }

  const vendorHandoffId = resolveVendorHandoffIdFromSessionMetadata(input.agentId, input.metadata);
  if (!vendorHandoffId) {
    return { eligible: false, reasonCode: 'vendor_handoff_id_missing' };
  }

  return { eligible: true, vendorHandoffId };
}
