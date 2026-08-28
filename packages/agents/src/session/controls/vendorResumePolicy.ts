import {
  AgentNativeResumeIdentityV1Schema,
  isBackendTargetDisabledByAccountSettings,
  readRuntimeDescriptorV1FromMetadata,
  type AgentNativeResumeIdentityV1,
} from '@happier-dev/protocol';
import type {
  PluginContributionIdentity,
} from '@happier-dev/protocol/plugins/manifest';
import {
  resolveLinkedExternalSessionMetadataV1,
} from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { AgentId } from '../../types.js';
import { getAgentResumeConfig, isRuntimeCheckedExperimentalVendorResume } from '../../manifest.js';
import { resolveAgentRuntimeControlSurfaceForSession } from './runtimeControlSurface.js';

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
  // The Account Settings catalog owns this key's vocabulary: the parsed
  // projection stores the canonical V2 target key, so indexing it with a
  // locally built legacy key would silently read every backend as enabled.
  return isBackendTargetDisabledByAccountSettings(
    accountSettings,
    { kind: 'builtInAgent', agentId },
  );
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
    : resolveCanonicalNativeResumeId(input.agentId as AgentId, metadata);
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
 * Canonical generic Session identity. The descriptor envelope only attributes
 * it to the current Agent; its opaque `agent` payload is never interpreted.
 */
function resolveCanonicalNativeResumeId(agentId: AgentId, metadata: unknown): string | null {
  const record = asRecord(metadata);
  if (!record) return null;
  const descriptor = readRuntimeDescriptorV1FromMetadata(record);
  if (descriptor?.agentId !== agentId) return null;
  const identity = AgentNativeResumeIdentityV1Schema.safeParse(record.nativeResumeIdentityV1);
  return identity.success ? identity.data.vendorResumeId : null;
}

/**
 * ONE owner for "what is this Session's native resume id", in declared-authority
 * order:
 *
 * 1. the Agent catalog's released flat `<vendor>SessionId` compatibility field;
 * 2. the canonical generic native-resume identity attributed by descriptor.
 *
 * The first source exists only for bundled Agents. Keeping it ahead of the
 * generic carrier preserves released persisted behavior without teaching
 * generic code to interpret the opaque descriptor payload.
 */
export function resolveVendorResumeIdFromSessionMetadata(agentId: AgentId, metadata: unknown): string | null {
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

  return resolveCanonicalNativeResumeId(agentId, record);
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

    const runtimeSurface = resolveAgentRuntimeControlSurfaceForSession({
      agentId: input.agentId,
      metadata: input.metadata,
    });
    if (runtimeSurface?.resume.vendorResume === 'unsupported') {
      return { eligible: false, reasonCode: 'experimental_disabled' };
    }
  }

  return evaluateMetadataVendorResumeId(input);
}
