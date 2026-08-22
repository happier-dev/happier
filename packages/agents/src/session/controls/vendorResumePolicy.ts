import type { AgentNativeResumeIdentityV1 } from '@happier-dev/protocol';
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
import { readNormalizedRuntimeDescriptor } from '../../runtime/identity/runtimeDescriptor.js';
import { getProviderSessionControlAdapter } from '../../runtime/controlSurface/sessionControlAdapterRegistry.js';

export type VendorResumeEligibilityReasonCode =
  | 'agent_unsupported'
  | 'vendor_resume_id_missing'
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

  // An Agent with no catalog-declared flat field keeps its native id in the
  // agent-agnostic descriptor slot; reading only the flat field there would
  // refuse every external Agent's linked-session resume as unverified.
  const persistedVendorResumeId = input.vendorResumeIdField
    ? metadata[input.vendorResumeIdField]
    : resolveRuntimeDescriptorVendorResumeId(input.agentId as AgentId, metadata);
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

/**
 * The Agent's own native conversation id, from the one carrier that is not an
 * enumeration of bundled vendors.
 *
 * `runtimeDescriptorV1.agent.providerSessionId` is agent-agnostic: the schema
 * accepts any `agentId`, the host stamps the id there for EVERY Session it
 * runs, and the descriptor is what `readProviderSessionIdSessionState` and the
 * CLI/UI resume readers already prefer. It is therefore the only slot an
 * external (manifest-contributed) Agent has, since generated
 * `<vendor>SessionId` fields and session-control adapters exist for bundled
 * Agents only.
 *
 * The descriptor names exactly one Agent, so a descriptor written by a
 * different Agent is never borrowed.
 */
function resolveRuntimeDescriptorVendorResumeId(agentId: AgentId, metadata: unknown): string | null {
  const descriptor = readNormalizedRuntimeDescriptor(metadata);
  return descriptor && descriptor.providerId === agentId
    ? descriptor.providerSessionId
    : null;
}

/**
 * ONE owner for "what is this Session's native resume id", in declared-authority
 * order:
 *
 * 1. the Agent's own session-control adapter, which may prefer a richer handle
 *    (Pi resumes from an absolute session-file path, not a bare id);
 * 2. the Agent's catalog-declared flat `<vendor>SessionId` field;
 * 3. the agent-agnostic runtime-descriptor slot.
 *
 * Tiers 1 and 2 exist only for bundled Agents, so tier 3 is what makes an
 * external Agent resumable at all. It is LAST so that adding it cannot change
 * any bundled Agent's answer.
 */
export function resolveVendorResumeIdFromSessionMetadata(agentId: AgentId, metadata: unknown): string | null {
  const adapterResumeId = getProviderSessionControlAdapter(agentId)?.resolveVendorResumeId?.(metadata);
  if (adapterResumeId) return adapterResumeId;

  const record = asRecord(metadata);
  if (!record) return null;

  const resume = getAgentResumeConfig(agentId);
  const field = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
  if (field) {
    const raw = record[field];
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }

  return resolveRuntimeDescriptorVendorResumeId(agentId, record);
}

/**
 * This Agent's own conversation id, as its catalog declares the slot.
 *
 * There is no proof to match (`AM-24`): a recorded id is either still resumable,
 * which resuming answers, or it is not, and both Agents that support native
 * resume fail loudly rather than silently starting fresh.
 */
export function resolveAgentNativeResumeIdentityFromSessionMetadata(
  agentId: AgentId,
  metadata: unknown,
): AgentNativeResumeIdentityV1 | null {
  const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(agentId, metadata);
  return vendorResumeId ? { v: 1, vendorResumeId } : null;
}

/**
 * This Agent's own on-disk session log for the Session, as its catalog declares
 * the slot — never a vendor key named by the caller.
 *
 * A POINTER, not a gate: the Agent-transition brief offers it to the successor
 * so the successor can read what the predecessor wrote. The path is
 * MACHINE-LOCAL, and it is cleared from the current view at an Agent cutover, so
 * a reader that needs it must read BEFORE the projection runs. The caller
 * verifies the file still exists; Agents prune and rotate their logs.
 */
export function resolveAgentNativeTranscriptPathFromSessionMetadata(
  agentId: AgentId,
  metadata: unknown,
): string | null {
  const field = getAgentResumeConfig(agentId)?.vendorResumeContinuityProofField?.trim();
  if (!field) return null;
  const raw = asRecord(metadata)?.[field];
  if (typeof raw !== 'string') return null;
  return raw.trim() || null;
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
  return { eligible: true, vendorResumeId };
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
