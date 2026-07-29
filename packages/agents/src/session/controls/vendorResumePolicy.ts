import {
  buildBackendTargetKey,
  readLinkedExternalSessionV1FromMetadata,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import type { AgentId } from '../../types.js';
import { getAgentResumeConfig, isRuntimeCheckedExperimentalVendorResume } from '../../manifest.js';
import { getProviderSessionControlAdapter } from '../../runtime/controlSurface/sessionControlAdapterRegistry.js';
import { hasClaudeVendorResumeContinuityProof } from './claudeVendorResumePolicy.js';

export type VendorResumeEligibilityReasonCode =
  | 'agent_unsupported'
  | 'vendor_resume_id_missing'
  | 'vendor_resume_continuity_proof_missing'
  | 'linked_session_identity_unverified'
  | 'experimental_disabled'
  | 'backend_disabled_by_account_settings';

export type VendorResumeEligibility =
  | Readonly<{ eligible: true; vendorResumeId: string }>
  | Readonly<{ eligible: false; reasonCode: VendorResumeEligibilityReasonCode }>;

export type VendorResumeLinkedSessionCurrentAgent = Readonly<{
  identity: PluginContributionIdentityV1;
  sourceKinds: readonly string[];
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

type ObservedVendorResumeContinuityPolicy = (metadata: unknown) => boolean;

const OBSERVED_VENDOR_RESUME_CONTINUITY_POLICIES: Partial<
  Record<AgentId, ObservedVendorResumeContinuityPolicy>
> = Object.freeze({
  claude: hasClaudeVendorResumeContinuityProof,
});

function readObservedVendorResumeContinuityPolicy(
  agentId: AgentId,
): ObservedVendorResumeContinuityPolicy | null {
  return OBSERVED_VENDOR_RESUME_CONTINUITY_POLICIES[agentId] ?? null;
}

function isBackendDisabledByAccountSettings(agentId: AgentId, accountSettings: Record<string, unknown> | null): boolean {
  const backendEnabledByTargetKey = accountSettings?.backendEnabledByTargetKey;
  const backendEnabledByTargetKeyRecord = asRecord(backendEnabledByTargetKey);
  if (!backendEnabledByTargetKeyRecord) return false;
  return backendEnabledByTargetKeyRecord[buildBackendTargetKey({ kind: 'builtInAgent', agentId })] === false;
}

export function isLinkedVendorResumeIdentityCurrent(input: Readonly<{
  agentId: string;
  metadata: unknown;
  vendorResumeIdField: string | null;
  linkedSessionCurrentAgent?: VendorResumeLinkedSessionCurrentAgent | null;
}>): boolean {
  const metadata = asRecord(input.metadata);
  if (!metadata || !Object.hasOwn(metadata, 'externalSessionV1')) return true;

  const link = readLinkedExternalSessionV1FromMetadata(metadata);
  const qualifiedIdentity = link?.qualifiedIdentity;
  const currentAgent = input.linkedSessionCurrentAgent;
  if (!link || !qualifiedIdentity || !currentAgent || link.agentId !== input.agentId) return false;

  const persistedVendorResumeId = input.vendorResumeIdField
    ? metadata[input.vendorResumeIdField]
    : null;
  if (
    typeof persistedVendorResumeId !== 'string'
    || persistedVendorResumeId.trim().length === 0
    || persistedVendorResumeId !== link.remoteSessionId
  ) {
    return false;
  }

  return (
    qualifiedIdentity.agent.pluginId === currentAgent.identity.pluginId
    && qualifiedIdentity.agent.localId === currentAgent.identity.localId
    && currentAgent.sourceKinds.includes(qualifiedIdentity.source.kind)
  );
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

export function resolveObservedVendorResumeIdForResume(input: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  vendorResumeId: string | null | undefined;
}>): string | null {
  const vendorResumeId = typeof input.vendorResumeId === 'string'
    ? input.vendorResumeId.trim()
    : '';
  if (!vendorResumeId) return null;

  const continuityPolicy = readObservedVendorResumeContinuityPolicy(input.agentId);
  if (!continuityPolicy) return vendorResumeId;

  const metadataVendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, input.metadata);
  if (metadataVendorResumeId !== vendorResumeId) return null;
  return continuityPolicy(input.metadata) ? vendorResumeId : null;
}

function evaluateMetadataVendorResumeId(input: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  linkedSessionCurrentAgent?: VendorResumeLinkedSessionCurrentAgent | null;
}>): VendorResumeEligibility {
  const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, input.metadata);
  if (!vendorResumeId) {
    return { eligible: false, reasonCode: 'vendor_resume_id_missing' };
  }
  const resume = getAgentResumeConfig(input.agentId);
  const vendorResumeIdField =
    resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
  if (!isLinkedVendorResumeIdentityCurrent({
    ...input,
    vendorResumeIdField,
  })) {
    return { eligible: false, reasonCode: 'linked_session_identity_unverified' };
  }
  const eligibleVendorResumeId = resolveObservedVendorResumeIdForResume({
    agentId: input.agentId,
    metadata: input.metadata,
    vendorResumeId,
  });
  return eligibleVendorResumeId
    ? { eligible: true, vendorResumeId: eligibleVendorResumeId }
    : { eligible: false, reasonCode: 'vendor_resume_continuity_proof_missing' };
}

export function evaluateVendorResumeEligibility(input: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
  linkedSessionCurrentAgent?: VendorResumeLinkedSessionCurrentAgent | null;
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
      return evaluateMetadataVendorResumeId(input);
    }

    const enabled = getProviderSessionControlAdapter(input.agentId)?.isExperimentalVendorResumeEnabled?.({
      metadata: input.metadata,
      accountSettings,
    }) === true;
    if (!enabled) {
      return { eligible: false, reasonCode: 'experimental_disabled' };
    }
  }

  return evaluateMetadataVendorResumeId(input);
}
