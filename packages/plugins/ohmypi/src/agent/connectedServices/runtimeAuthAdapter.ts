import { summarizeOhMyPiConnectedServiceActiveProfiles } from './activeProfiles.js';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

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
      return { status: 'verified', reason: 'provider_restart_rematerialization_authoritative' };
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
