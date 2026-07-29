import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

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
  if (!selection || selection.serviceId !== 'gemini') return null;
  const revision = ConnectedServiceCredentialRevisionV1Schema.safeParse(selection.credentialRevision);
  if (!revision.success) return null;
  if (selection.kind === 'profile') {
    const profileId = text(selection.profileId);
    return profileId ? {
      serviceId: 'gemini', profileId, groupId: null, groupGeneration: null, credentialRevision: revision.data,
    } : null;
  }
  if (selection.kind !== 'group') return null;
  const profileId = text(selection.activeProfileId);
  const groupId = text(selection.groupId);
  const groupGeneration = typeof selection.generation === 'number' && Number.isInteger(selection.generation) && selection.generation >= 0
    ? selection.generation
    : null;
  return profileId && groupId && groupGeneration !== null ? {
    serviceId: 'gemini', profileId, groupId, groupGeneration, credentialRevision: revision.data,
  } : null;
}

export function createGeminiConnectedServiceRuntimeAuthAdapter() {
  return {
    classifyRuntimeAuthFailure() { return null; },
    async materializeActiveProfile() { return { supported: true }; },
    canHotApply() { return { supported: false, recovery: 'restart_rematerialize' }; },
    async hotApply() { return { applied: false, reason: 'hot_apply_unsupported' }; },
    async recoverAfterRuntimeAuthSwitch() { return { recovered: false, recovery: 'restart_rematerialize' }; },
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
