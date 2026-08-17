import { summarizeOhMyPiConnectedServiceActiveProfiles } from './activeProfiles.js';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk';

const REQUIRED_SERVICE_IDS = [
  'openai-codex',
  'openai',
  'claude-subscription',
  'anthropic',
  'gemini',
] as const;

function exactTarget(selectionValue: unknown) {
  const selection = isRecord(selectionValue) ? selectionValue : null;
  if (!selection || !REQUIRED_SERVICE_IDS.includes(selection.serviceId as typeof REQUIRED_SERVICE_IDS[number])) return null;
  const credentialRevision = readString(selection.credentialRevision);
  if (!credentialRevision) return null;
  const serviceId = selection.serviceId as typeof REQUIRED_SERVICE_IDS[number];
  if (selection.kind === 'profile') {
    const profileId = readString(selection.profileId);
    return profileId ? {
      serviceId, profileId, groupId: null, groupGeneration: null, credentialRevision,
    } : null;
  }
  if (selection.kind !== 'group') return null;
  const profileId = readString(selection.activeProfileId);
  const groupId = readString(selection.groupId);
  const groupGeneration = typeof selection.generation === 'number' && Number.isInteger(selection.generation) && selection.generation >= 0
    ? selection.generation
    : null;
  return profileId && groupId && groupGeneration !== null ? {
    serviceId, profileId, groupId, groupGeneration, credentialRevision,
  } : null;
}

type RuntimeAuthTargetInput = Readonly<{
  selection?: unknown;
}>;

function activeProfiles(input: RuntimeAuthTargetInput) {
  const selection = isRecord(input.selection) ? input.selection : null;
  return summarizeOhMyPiConnectedServiceActiveProfiles({
    openaiCodexProfileId: readString(selection?.openaiCodexProfileId),
    openaiProfileId: readString(selection?.openaiProfileId),
    claudeSubscriptionProfileId: readString(selection?.claudeSubscriptionProfileId),
    anthropicProfileId: readString(selection?.anthropicProfileId),
    geminiProfileId: readString(selection?.geminiProfileId),
  });
}

export function createOhMyPiConnectedServiceRuntimeAuthAdapter() {
  return {
    classifyRuntimeAuthFailure() {
      return null;
    },
    async materializeActiveProfile(input: RuntimeAuthTargetInput) {
      return { supported: true, activeProfiles: activeProfiles(input) };
    },
    canHotApply() {
      return { supported: false, recovery: 'restart_rematerialize' };
    },
    async hotApply() {
      return { applied: false, reason: 'hot_apply_unsupported' };
    },
    async recoverAfterRuntimeAuthSwitch() {
      return { recovered: false, recovery: 'restart_rematerialize' };
    },
    async verifyActiveAccount() {
      return {
        status: 'unavailable',
        retryable: true,
        reason: 'ohmypi_provider_outcome_pending',
      };
    },
    async verifyProviderOutcome(input: Readonly<{ selections?: unknown; outcome?: unknown }>) {
      const outcome = isRecord(input.outcome) ? input.outcome : null;
      if (outcome?.kind !== 'provider_activity' || outcome.event !== 'assistant_message_end') {
        return { status: 'unavailable' as const, reason: 'ohmypi_provider_activity_required' };
      }
      const selections = Array.isArray(input.selections) ? input.selections : [];
      if (selections.length !== REQUIRED_SERVICE_IDS.length) {
        return { status: 'unavailable' as const, reason: 'ohmypi_complete_selection_required' };
      }
      const targets = selections.flatMap((selection) => {
        const target = exactTarget(selection);
        return target ? [target] : [];
      });
      const targetServiceIds = new Set(targets.map((target) => target.serviceId));
      if (targets.length !== REQUIRED_SERVICE_IDS.length
        || REQUIRED_SERVICE_IDS.some((serviceId) => !targetServiceIds.has(serviceId))) {
        return { status: 'unavailable' as const, reason: 'ohmypi_exact_epoch_required' };
      }
      return { status: 'verified' as const, source: 'ohmypi_provider_activity', targets };
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
