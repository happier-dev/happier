import { buildBackendTargetKey } from '@happier-dev/protocol';
import type { AgentId, VendorResumeSupportLevel } from '../types.js';
import { isAbsolutePathLike } from '../path/isAbsolutePathLike.js';
import { AGENTS_CORE } from '../manifest.js';
import { isCodexVendorResumeBackendEnabled } from '../providerSettings/definitions/codex.js';
import { resolveCodexSessionBackendMode } from './providerSessionBackends.js';
import { readSessionMetadataRuntimeDescriptor } from './agentRuntimeDescriptor.js';

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
  const record = asRecord(metadata);
  if (!record) return null;

  if (agentId === 'codex') {
    const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(record, 'codex');
    if (runtimeDescriptor?.vendorSessionId) return runtimeDescriptor.vendorSessionId;
  }

  if (agentId === 'opencode') {
    const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(record, 'opencode');
    if (runtimeDescriptor?.vendorSessionId) return runtimeDescriptor.vendorSessionId;
  }

  if (agentId === 'pi') {
    const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(record, 'pi');
    if (runtimeDescriptor?.sessionFile && isAbsolutePathLike(runtimeDescriptor.sessionFile)) {
      return runtimeDescriptor.sessionFile;
    }
    if (runtimeDescriptor?.vendorSessionId) return runtimeDescriptor.vendorSessionId;
  }

  const resume = AGENTS_CORE[agentId]?.resume;
  const field = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
  if (!field) return null;

  const raw = record[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

/**
 * This Agent's own on-disk session log for the Session, as its catalog declares
 * the slot — never a vendor key named by the caller.
 *
 * A POINTER, not a gate (`AM-24`): the Agent-transition brief offers it to the
 * successor so the successor can read what the predecessor wrote. Native resume
 * does not consult it, and a missing log never refuses a resume.
 *
 * The path is MACHINE-LOCAL, so only a consumer that can prove it is on the same
 * machine may use it, and it is cleared from the current view at an Agent
 * cutover: a reader that needs it must read before the projection runs. The
 * caller verifies the file still exists; Agents prune and rotate their logs.
 */
export function resolveAgentNativeTranscriptPathFromSessionMetadata(
  agentId: AgentId,
  metadata: unknown,
): string | null {
  const record = asRecord(metadata);
  if (!record) return null;
  const resume = AGENTS_CORE[agentId]?.resume;
  const field = resume && 'vendorResumeContinuityProofField' in resume
    ? resume.vendorResumeContinuityProofField ?? null
    : null;
  if (!field) return null;
  const raw = record[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed && isAbsolutePathLike(trimmed) ? trimmed : null;
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
  // Widened via `as`: the literal union in AGENTS_CORE only reflects the agents declared
  // today, while this guard must keep holding for future agents that declare 'unsupported'.
  const vendorResume = resumeConfig?.vendorResume as VendorResumeSupportLevel | undefined;
  if (!resumeConfig || vendorResume === 'unsupported') {
    return { eligible: false, reasonCode: 'agent_unsupported' };
  }

  if (vendorResume === 'experimental') {
    const experimentalResumePolicy = 'experimentalResumePolicy' in resumeConfig
      ? resumeConfig.experimentalResumePolicy
      : undefined;

    if (experimentalResumePolicy === 'runtime_checked') {
      const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(input.agentId, input.metadata);
      if (!vendorResumeId) {
        return { eligible: false, reasonCode: 'vendor_resume_id_missing' };
      }
      return { eligible: true, vendorResumeId };
    }

    // Codex vendor-resume is currently available through the supported richer backend modes.
    if (input.agentId === 'codex') {
      const codexBackendMode = resolveCodexSessionBackendMode({
        metadata: input.metadata,
        accountSettings,
      });
      if (!isCodexVendorResumeBackendEnabled(codexBackendMode ? { codexBackendMode } : {})) {
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
