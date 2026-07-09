import {
  resolveConnectedServicesProviderStateSharingPolicyV1,
  type AccountSettings,
} from '@happier-dev/protocol';
import { AGENTS_CORE } from '@happier-dev/agents';
import { canResumeFromMaterializedState } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedState';

import type { CatalogAgentId } from '@/agent/catalog/ids';

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
  warnings?: readonly string[];
}>): Promise<SessionConnectedServiceSwitchContinuity> {
  if (!input.accountSettings) {
    // Incident Jun-11 H-A: a missing in-memory account-settings snapshot (freshly restarted
    // daemon, no spawn/settings hint yet) is an infrastructure gap, NOT proof that provider
    // state sharing is unsupported. Surface a distinct error code so recovery retries
    // (RuntimeAuthRecoveryScheduler classifies it retryable) instead of terminalizing.
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

    const serviceId = asNonEmptyString(input.serviceId);
    const targetMaterializedRoot = asNonEmptyString(input.targetMaterializedRoot);
    const vendorResumeId = asNonEmptyString(input.vendorResumeId);
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
    };
  }
  return {
    mode: 'unsupported',
    errorCode: 'provider_state_sharing_required',
    warnings: input.warnings ?? [],
  };
}
