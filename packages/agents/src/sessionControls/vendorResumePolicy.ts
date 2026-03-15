import type { AgentId } from '../types.js';
import { AGENTS_CORE } from '../manifest.js';
import { resolveCodexSpawnExtrasFromSettings } from '../providerSettings/definitions/codex.js';

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
  const backendEnabledById = accountSettings?.backendEnabledById;
  const backendEnabledByIdRecord = asRecord(backendEnabledById);
  if (!backendEnabledByIdRecord) return false;
  return backendEnabledByIdRecord[agentId] === false;
}

export function resolveVendorResumeIdFromSessionMetadata(agentId: AgentId, metadata: unknown): string | null {
  const field = AGENTS_CORE[agentId]?.resume?.vendorResumeIdField ?? null;
  if (!field) return null;

  const record = asRecord(metadata);
  if (!record) return null;

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

  const resumeConfig = AGENTS_CORE[input.agentId]?.resume;
  if (!resumeConfig || resumeConfig.vendorResume === 'unsupported') {
    return { eligible: false, reasonCode: 'agent_unsupported' };
  }

  if (resumeConfig.vendorResume === 'experimental') {
    // Codex vendor-resume is ACP-only; treat ACP enablement as the experiment gate.
    if (input.agentId === 'codex') {
      const extras = resolveCodexSpawnExtrasFromSettings(accountSettings ?? {});
      if (extras.experimentalCodexAcp !== true) {
        return { eligible: false, reasonCode: 'experimental_disabled' };
      }
    } else {
      return { eligible: false, reasonCode: 'experimental_disabled' };
    }
  }

  const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, input.metadata);
  if (!vendorResumeId) {
    return { eligible: false, reasonCode: 'vendor_resume_id_missing' };
  }

  return { eligible: true, vendorResumeId };
}
