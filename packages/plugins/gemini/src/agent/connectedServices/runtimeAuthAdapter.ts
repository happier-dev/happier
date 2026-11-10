import type { AgentConnectedAccountRuntimeAuthAdapterV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { GEMINI_CONNECTED_ACCOUNT_SERVICE } from '../../connectedAccounts/service.js';

const GEMINI_ACCOUNT_SERVICE_ID = `${GEMINI_CONNECTED_ACCOUNT_SERVICE.pluginId}/${GEMINI_CONNECTED_ACCOUNT_SERVICE.localId}`;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function exactTarget(selectionValue: unknown) {
  const selection = record(selectionValue);
  if (!selection || selection.serviceId !== GEMINI_ACCOUNT_SERVICE_ID) return null;
  const revision = typeof selection.credentialRevision === 'string' && selection.credentialRevision.length > 0
    ? selection.credentialRevision
    : null;
  if (revision === null) return null;
  if (selection.kind === 'profile') {
    const profileId = text(selection.profileId);
    return profileId ? {
      serviceId: GEMINI_ACCOUNT_SERVICE_ID, profileId, groupId: null, groupGeneration: null, credentialRevision: revision,
    } : null;
  }
  if (selection.kind !== 'group') return null;
  const profileId = text(selection.activeProfileId);
  const groupId = text(selection.groupId);
  const groupGeneration = typeof selection.generation === 'number' && Number.isInteger(selection.generation) && selection.generation >= 0
    ? selection.generation
    : null;
  return profileId && groupId && groupGeneration !== null ? {
    serviceId: GEMINI_ACCOUNT_SERVICE_ID, profileId, groupId, groupGeneration, credentialRevision: revision,
  } : null;
}

export function createGeminiConnectedServiceRuntimeAuthAdapter(): AgentConnectedAccountRuntimeAuthAdapterV1 {
  return {
    classifyRuntimeAuthFailure(input) {
      const diagnostic = record(input.error);
      const details = record(diagnostic?.details);
      // Gemini CLI v0.60.0 acpSession.ts and v0.8.2 zedIntegration.ts emit
      // RequestError(429). JSON-RPC internal error codes and prose are not quota evidence.
      if ((diagnostic?.code !== 'acp_turn_failed' && diagnostic?.code !== 'acp_input_custody_unknown'
        && diagnostic?.code !== 'acp_input_rejected_before_effect')
        || details?.requestErrorCode !== 429) return null;
      const serviceId = GEMINI_ACCOUNT_SERVICE_ID;
      const selection = record(input.selection);
      if (selection && selection.serviceId !== serviceId) return null;
      const target = selection ? exactTarget(selection) : null;
      return {
        kind: 'rate_limit', limitCategory: 'rate_limit', quotaScope: 'unknown', serviceId,
        profileId: target?.profileId ?? null, groupId: target?.groupId ?? null,
        ...(target?.groupGeneration !== null && target?.groupGeneration !== undefined ? { groupGeneration: target.groupGeneration } : {}),
        ...(target?.credentialRevision ? { expectedCredentialRevision: target.credentialRevision } : {}),
        resetsAtMs: null, retryAfterMs: null, planType: null, rateLimits: null,
        source: 'structured_provider_error',
      };
    },
    async materializeActiveProfile() { return { supported: true }; },
    canHotApply() { return { supported: false, recovery: 'restart_rematerialize' }; },
    async hotApply() { return { applied: false, reason: 'hot_apply_unsupported' }; },
    async verifyActiveAccount() {
      return { status: 'unavailable' as const, retryable: true, reason: 'gemini_provider_outcome_pending' };
    },
    async verifyProviderOutcome(input: Readonly<{ selections?: unknown; outcome?: unknown }>) {
      const outcome = record(input.outcome);
      if (outcome?.kind !== 'provider_activity' || outcome.event !== 'assistant_message_end') {
        return { status: 'unavailable' as const, reason: 'gemini_provider_activity_required' };
      }
      const selections = Array.isArray(input.selections) ? input.selections : [];
      const targets = selections.flatMap((selection) => {
        const target = exactTarget(selection);
        return target ? [target] : [];
      });
      if (targets.length !== 1) {
        return { status: 'unavailable' as const, reason: 'gemini_exact_epoch_required' };
      }
      return { status: 'verified' as const, source: 'gemini_provider_activity', targets };
    },
    async probeQuota() { return { status: 'unsupported' }; },
    async refreshActiveProfile() { return { status: 'unsupported' }; },
  };
}
