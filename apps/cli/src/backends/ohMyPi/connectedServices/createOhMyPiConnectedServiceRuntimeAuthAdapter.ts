import { summarizeOhMyPiConnectedServiceActiveProfiles } from './ohMyPiConnectedServiceActiveProfiles';
import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function activeProfiles(input: ConnectedServiceRuntimeAuthTargetInput) {
  const selection = readRecord(input.selection);
  return summarizeOhMyPiConnectedServiceActiveProfiles({
    openaiCodexProfileId: readString(selection?.openaiCodexProfileId),
    openaiProfileId: readString(selection?.openaiProfileId),
    claudeSubscriptionProfileId: readString(selection?.claudeSubscriptionProfileId),
    anthropicProfileId: readString(selection?.anthropicProfileId),
    geminiProfileId: readString(selection?.geminiProfileId),
  });
}

export function createOhMyPiConnectedServiceRuntimeAuthAdapter(): ConnectedServiceProviderRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure() {
      return null;
    },
    async materializeActiveProfile(input) {
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
