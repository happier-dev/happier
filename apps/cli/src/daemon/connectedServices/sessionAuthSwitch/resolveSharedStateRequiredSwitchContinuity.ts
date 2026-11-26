import {
  resolveConnectedServicesProviderStateSharingPolicyV1,
  type AccountSettings,
} from '@happier-dev/protocol';
import { AGENTS_CORE } from '@happier-dev/agents';
import { canResumeFromMaterializedState } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedState';

import type { CatalogAgentId } from '@/backends/types';

import type { SessionConnectedServiceSwitchContinuity } from './switchSessionConnectedServiceAuth';

function agentSupportsSharedSessionState(agentId: CatalogAgentId): boolean {
  const connectedServices = AGENTS_CORE[agentId].connectedServices;
  if (!connectedServices || !('providerStateSharing' in connectedServices)) {
    return false;
  }
  const withProviderStateSharing = connectedServices as Readonly<{
    providerStateSharing?: Readonly<{ state?: Readonly<{ supported?: boolean }> }>;
  }>;
  return withProviderStateSharing.providerStateSharing?.state?.supported === true;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeWarnings(warnings: readonly string[] | undefined, reachabilityReason: string | null): readonly string[] {
  const normalizedWarnings = warnings ?? [];
  if (!reachabilityReason) return normalizedWarnings;
  if (normalizedWarnings.includes(reachabilityReason)) return normalizedWarnings;
  return [...normalizedWarnings, reachabilityReason];
}

export async function resolveSharedStateRequiredSwitchContinuity(input: Readonly<{
  agentId: CatalogAgentId;
  accountSettings: AccountSettings | Readonly<Record<string, unknown>> | null | undefined;
  serviceId?: string;
  targetMaterializedRoot?: string | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  materializationIdentity?: Readonly<{ v: 1; id: string }> | null;
  vendorResumeId?: string | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
  failedFirstLaunch?: 'retry_original_transition';
  warnings?: readonly string[];
}>): Promise<SessionConnectedServiceSwitchContinuity> {
  if (!input.accountSettings) {
    // Incident Jun-11 H-A: a NULL settings snapshot means "settings unknown" (e.g. a freshly
    // restarted daemon that has not bootstrapped its snapshot yet), NOT "sharing disabled".
    // Surface a RETRYABLE settings-unavailable code so the recovery scheduler arms a durable
    // retry instead of terminalizing as non_retryable_apply_failure.
    return {
      mode: 'unsupported',
      errorCode: 'provider_state_sharing_settings_unavailable',
      warnings: input.warnings ?? [],
    };
  }
  const policy = resolveConnectedServicesProviderStateSharingPolicyV1(
    input.accountSettings?.connectedServicesProviderStateSharingSettingsV1,
    input.agentId,
  );
  if (policy.stateMode === 'shared') {
    if (!agentSupportsSharedSessionState(input.agentId)) {
      return {
        mode: 'unsupported',
        errorCode: 'provider_state_sharing_unavailable',
        warnings: input.warnings ?? [],
      };
    }

    if (input.failedFirstLaunch === 'retry_original_transition'
      && !asNonEmptyString(input.vendorResumeId)
      && !asNonEmptyString(input.candidatePersistedSessionFile)) {
      return { mode: 'restart_rematerialize', warnings: input.warnings ?? [] };
    }

    const vendorResumeId = asNonEmptyString(input.vendorResumeId);
    const serviceId = asNonEmptyString(input.serviceId);
    const targetMaterializedRoot = asNonEmptyString(input.targetMaterializedRoot);
    const cwd = asNonEmptyString(input.cwd);
    const materializationIdentity = input.materializationIdentity ?? null;
    if (
      !serviceId
      || !targetMaterializedRoot
      || !vendorResumeId
      || !cwd
      || !materializationIdentity
      || !input.targetMaterializedEnv
    ) {
      return {
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
        warnings: mergeWarnings(input.warnings, 'provider_session_state_unavailable_for_resume'),
      };
    }

    const reachability = await canResumeFromMaterializedState({
      agentId: input.agentId,
      serviceId,
      targetMaterializedRoot,
      targetMaterializedEnv: input.targetMaterializedEnv,
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
      materializationIdentity,
      vendorResumeId,
      cwd,
      candidatePersistedSessionFile: input.candidatePersistedSessionFile ?? null,
    });
    if (!reachability.ok) {
      return {
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
        warnings: mergeWarnings(input.warnings, reachability.reason),
        diagnostics: reachability.continuityDiagnostics,
      };
    }
    return {
      mode: 'restart_rematerialize',
      warnings: input.warnings ?? [],
      // INC-6: surface what was PROVEN so successful switches carry the continuity context in
      // telemetry instead of all-null fields.
      diagnostics: {
        materializationIdentityId: materializationIdentity.id,
        targetMaterializedRoot,
        vendorResumeId,
        cwd,
        candidatePersistedSessionFile: input.candidatePersistedSessionFile ?? null,
        requestedStateMode: 'shared',
        effectiveStateMode: reachability.effectiveStateMode,
      },
    };
  }
  return {
    mode: 'unsupported',
    errorCode: 'provider_state_sharing_required',
    warnings: input.warnings ?? [],
  };
}
