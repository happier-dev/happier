import type { AgentNativeResumeIdentityV1 } from '@happier-dev/protocol';
import { AgentNativeContinuityProofV1Schema } from '@happier-dev/protocol';
import {
  buildBackendTargetKey,
} from '@happier-dev/protocol/plugins/agents';
import type {
  PluginContributionIdentity,
} from '@happier-dev/protocol/plugins/manifest';
import {
  resolveLinkedExternalSessionMetadataV1,
} from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { AgentId } from '../../types.js';
import { getAgentResumeConfig, isRuntimeCheckedExperimentalVendorResume } from '../../manifest.js';
import { getProviderSessionControlAdapter } from '../../runtime/controlSurface/sessionControlAdapterRegistry.js';

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
  identity: PluginContributionIdentity;
  sourceKinds: readonly string[];
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasObservedVendorResumeContinuityProof(
  agentId: AgentId,
  metadata: unknown,
): boolean {
  const proofField = getAgentResumeConfig(agentId).vendorResumeContinuityProofField;
  if (!proofField) return true;
  const proof = asRecord(metadata)?.[proofField];
  return typeof proof === 'string' && proof.trim().length > 0;
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
  const resolution = resolveLinkedExternalSessionMetadataV1(metadata);
  if (!resolution.ok) {
    return resolution.error === 'linked_session_not_found';
  }
  if (!metadata) return false;

  const link = resolution.linkedSession;
  if (link.agentId !== input.agentId) return false;

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

  if (resolution.source === 'released') return true;

  const qualifiedIdentity = link.qualifiedIdentity;
  const currentAgent = input.linkedSessionCurrentAgent;
  if (!qualifiedIdentity || !currentAgent) return false;

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

  const proofField = getAgentResumeConfig(input.agentId).vendorResumeContinuityProofField;
  if (!proofField) return vendorResumeId;

  const metadataVendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, input.metadata);
  if (metadataVendorResumeId !== vendorResumeId) return null;
  return hasObservedVendorResumeContinuityProof(input.agentId, input.metadata)
    ? vendorResumeId
    : null;
}

/**
 * The read side of `writeProviderSessionIdSessionState`'s matched pair.
 *
 * `REQ-STATE-01` makes the id and its proof atomic on WRITE; without a matching
 * reader, a caller that needs the pair has to read two metadata slots and
 * re-match them itself — which is exactly how a proof belonging to a previous id
 * gets resurrected. Both halves are therefore read here, from the one Agent's
 * catalog-declared slots, and returned as the same pair type the writer accepts.
 *
 * The proof KIND is not persisted: the catalog declares one proof FIELD per
 * Agent and `AgentNativeContinuityProofV1Schema` declares exactly one kind
 * (`transcriptPath`). A second kind must arrive as a catalog declaration, at
 * which point this constant becomes a lookup. A proof that fails that schema is
 * read as NO proof, so it degrades to a fresh target rather than authorizing a
 * resume it cannot justify.
 */
export function resolveAgentNativeResumeIdentityFromSessionMetadata(
  agentId: AgentId,
  metadata: unknown,
): AgentNativeResumeIdentityV1 | null {
  const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(agentId, metadata);
  if (!vendorResumeId) return null;

  const proofField = getAgentResumeConfig(agentId).vendorResumeContinuityProofField?.trim();
  if (!proofField) return { v: 1, vendorResumeId, continuityProof: null };

  const parsedProof = AgentNativeContinuityProofV1Schema.safeParse({
    kind: 'transcriptPath',
    value: asRecord(metadata)?.[proofField],
  });
  return {
    v: 1,
    vendorResumeId,
    continuityProof: parsedProof.success ? parsedProof.data : null,
  };
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
