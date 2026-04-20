import { resolveAgentIdFromSessionMetadata } from '../resolveAgentIdFromSessionMetadata.js';
import { isConcreteBackendDefinitionAgentId } from '../definitions/resolveBackendOwnership.js';
import type { AgentId } from '../types.js';
import { readLegacyConfiguredBackendIdFromMetadata } from '../compat/legacyConfiguredBackend.js';
import {
  evaluateVendorResumeEligibility,
  type VendorResumeEligibilityReasonCode,
} from './vendorResumePolicy.js';

export type ExistingSessionAutomationEligibilityReasonCode =
  | VendorResumeEligibilityReasonCode
  | 'agent_unknown';

export type ExistingSessionAutomationEligibility =
  | Readonly<{ eligible: true; agentId: AgentId; strategy: 'vendor_resume' }>
  | Readonly<{ eligible: true; compatBackendId: string; strategy: 'happy_attach' }>
  | Readonly<{ eligible: false; reasonCode: ExistingSessionAutomationEligibilityReasonCode }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveAgentIdFromMetadata(metadata: Record<string, unknown>): AgentId | null {
  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  return agentId && isConcreteBackendDefinitionAgentId(agentId) ? agentId : null;
}

export function evaluateExistingSessionAutomationEligibility(input: Readonly<{
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): ExistingSessionAutomationEligibility {
  const metadata = asRecord(input.metadata);
  if (!metadata) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }

  const compatBackendId = readLegacyConfiguredBackendIdFromMetadata(metadata);
  if (compatBackendId) {
    return {
      eligible: true,
      compatBackendId,
      strategy: 'happy_attach',
    };
  }

  const agentId = resolveAgentIdFromMetadata(metadata);
  if (!agentId) {
    return { eligible: false, reasonCode: 'agent_unknown' };
  }

  const eligibility = evaluateVendorResumeEligibility({
    agentId,
    metadata,
    accountSettings: input.accountSettings ?? null,
  });
  if (!eligibility.eligible) {
    return eligibility;
  }

  return {
    eligible: true,
    agentId,
    strategy: 'vendor_resume',
  };
}
