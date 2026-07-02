import { buildBackendTargetKey } from '@happier-dev/protocol';
import type { AgentId } from '../../types.js';
import { getAgentResumeConfig, isRuntimeCheckedExperimentalVendorResume } from '../../manifest.js';
import { getProviderSessionControlAdapter } from '../../runtime/controlSurface/sessionControlAdapterRegistry.js';

export type VendorResumeEligibilityReasonCode =
  | 'agent_unsupported'
  | 'vendor_resume_id_missing'
  | 'experimental_disabled'
  | 'backend_disabled_by_account_settings';

export type VendorResumeEligibility =
  | Readonly<{ eligible: true; vendorResumeId: string }>
  | Readonly<{ eligible: false; reasonCode: VendorResumeEligibilityReasonCode }>;

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

export function resolveVendorResumeIdFromSessionMetadata(agentId: AgentId, metadata: unknown): string | null {
  const adapterResumeId = getProviderSessionControlAdapter(agentId)?.resolveVendorResumeId?.(metadata);
  if (adapterResumeId) return adapterResumeId;

  const record = asRecord(metadata);
  if (!record) return null;

  const resume = getAgentResumeConfig(agentId);
  const field = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
  if (!field) return null;

  const raw = record[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

export function evaluateVendorResumeEligibility(input: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): VendorResumeEligibility {
  const accountSettings = asRecord(input.accountSettings) ?? null;

  if (isBackendDisabledByAccountSettings(input.agentId, accountSettings)) {
    return { eligible: false, reasonCode: 'backend_disabled_by_account_settings' };
  }

  const resumeConfig = getAgentResumeConfig(input.agentId);
  if (!resumeConfig || resumeConfig.vendorResume === 'unsupported') {
    return { eligible: false, reasonCode: 'agent_unsupported' };
  }

  if (resumeConfig.vendorResume === 'experimental') {
    if (isRuntimeCheckedExperimentalVendorResume(input.agentId)) {
      const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, input.metadata);
      if (!vendorResumeId) {
        return { eligible: false, reasonCode: 'vendor_resume_id_missing' };
      }
      return { eligible: true, vendorResumeId };
    }

    const enabled = getProviderSessionControlAdapter(input.agentId)?.isExperimentalVendorResumeEnabled?.({
      metadata: input.metadata,
      accountSettings,
    }) === true;
    if (!enabled) {
      return { eligible: false, reasonCode: 'experimental_disabled' };
    }
  }

  const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, input.metadata);
  if (!vendorResumeId) {
    return { eligible: false, reasonCode: 'vendor_resume_id_missing' };
  }

  return { eligible: true, vendorResumeId };
}
