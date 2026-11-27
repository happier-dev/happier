import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { GEMINI_API_KEY_ENV } from '@happier-dev/plugin-sdk/connected-accounts';

import { ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV, ANTIGRAVITY_NATIVE_TOKEN_FILE } from '../install/cliRuntime.js';

export const antigravityConnectedAccountLaunch: AgentConnectedAccountLaunchContributionV1 = {
  environmentUses: [
    { purpose: 'model_upstream', environmentKey: ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV },
    { purpose: 'gemini-api-key', environmentKey: GEMINI_API_KEY_ENV },
  ],
  stateSharingDescriptor: {
    nativeHome: {
      environmentKey: 'GEMINI_HOME',
      defaultRelativePath: '.gemini',
      materializedDirectoryName: 'gemini-home',
      groupHome: 'selectedAccount',
      // Gemini API-key authentication records its method in the profile, so a
      // key-only launch still gets a private home.
      purposes: ['gemini-api-key'],
    },
    providerSupportStatus: 'supported',
    config: {
      supported: true, modes: ['linked', 'copied', 'isolated'],
      entries: [
        { path: 'config/skills', mode: 'linked_or_copied' },
        { path: 'antigravity-cli/skills', mode: 'linked_or_copied' },
        { path: 'config/hooks.json', mode: 'linked_or_copied' },
        { path: 'config/mcp_config.json', mode: 'linked_or_copied' },
        // Holds native `trustedWorkspaces`.
        { path: 'antigravity-cli/settings.json', mode: 'copied' },
      ],
    },
    state: {
      supported: true, modes: ['isolated', 'shared'],
      entries: [
        { path: 'antigravity-cli/conversations', mode: 'linked', createIfMissing: 'directory' },
        { path: 'antigravity-cli/brain', mode: 'linked', createIfMissing: 'directory' },
        // Conversation titles; without it a shared conversation lists with another title.
        { path: 'antigravity-cli/annotations', mode: 'linked', createIfMissing: 'directory' },
        // Retired-server store kept only so its conversations stay reachable until a
        // resume adopts them into the native store; never created for new homes.
        { path: 'antigravity-acp/conversations', mode: 'linked' },
        { path: 'antigravity-acp/brain', mode: 'linked' },
      ],
      sharedStatePrivacyRiskAcknowledgementRequired: true,
      symlinkUnavailableDegradePolicy: 'block_continuity',
    },
    authIsolation: {
      mode: 'materialized_home',
      secretEntries: [ANTIGRAVITY_NATIVE_TOKEN_FILE],
    },
  },
  switchContinuity: {
    continuityMode: 'restart_shared_state_required',
    supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected', 'same_connected_group'],
    providerStateSharingRequired: {
      serviceIds: ['antigravity-account'],
      supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected', 'same_connected_group'],
    },
  },
  continuity: {
    generationApplicationScope: 'per_session_runtime',
    runtimeAuthAdapter: {
      classifyRuntimeAuthFailure() { return null; },
      async materializeActiveProfile() { return { supported: true }; },
      canHotApply() { return { supported: false, recovery: 'restart_rematerialize' }; },
      async hotApply() { return { applied: false, reason: 'hot_apply_unsupported' }; },
      async verifyActiveAccount() {
        return { status: 'unavailable', retryable: true, reason: 'agy_provider_outcome_pending' };
      },
      async verifyProviderOutcome({ selections, outcome }) {
        // The launch, not model output, binds the account: the runtime epoch's
        // agy runs with file-only token storage (agy >= 1.5.18, checked before
        // any Session opens) in a profile holding only this credential. Any
        // provider activity of that registered epoch therefore proves it.
        if (outcome.kind !== 'provider_activity') {
          return { status: 'unavailable', reason: 'agy_provider_activity_required' };
        }
        const selection = selections.length === 1 ? selections[0] : undefined;
        if (selection?.serviceId !== 'happier.agent.antigravity/antigravity-account'
          || !selection.credentialRevision?.trim()) {
          return { status: 'unavailable', reason: 'agy_exact_epoch_required' };
        }
        const profileId = selection.kind === 'profile' ? selection.profileId : selection.activeProfileId;
        const isGroup = selection.kind === 'group';
        if ((selection.kind !== 'profile' && !isGroup) || !profileId?.trim()
          || (isGroup && (!selection.groupId?.trim() || selection.generation == null
            || !Number.isInteger(selection.generation) || selection.generation < 0))) {
          return { status: 'unavailable', reason: 'agy_exact_epoch_required' };
        }
        return {
          status: 'verified',
          source: 'agy_provider_activity',
          targets: [{
            serviceId: selection.serviceId,
            profileId,
            groupId: isGroup ? selection.groupId! : null,
            groupGeneration: isGroup ? selection.generation! : null,
            credentialRevision: selection.credentialRevision,
          }],
        };
      },
      async probeQuota() { return { status: 'unsupported' }; },
      async refreshActiveProfile() { return { status: 'unsupported' }; },
    },
    async verifyResumeReachable({ vendorResumeId, sessionFiles }) {
      const id = vendorResumeId?.trim();
      if (!id || id === '.' || id === '..' || /[\\/]/u.test(id)) {
        return { ok: false, reason: 'agy_session_state_not_found' };
      }
      // The conversation database proves the session; its brain and metadata are
      // carried with it when present so cross-home imports keep them.
      const reachable = async (store: 'antigravity-cli' | 'antigravity-acp') => {
        const db = { path: `${store}/conversations/${id}.db`, kind: 'file' as const };
        const brain = { path: `${store}/brain/${id}`, kind: 'directory' as const };
        const companions = store === 'antigravity-acp'
          ? [{ path: `${store}/conversations/${id}.meta`, kind: 'json_object' as const }, brain] : [brain];
        if ((await sessionFiles.verifyDeclaredPaths({ paths: [db, ...companions] })).found) return true;
        return (await sessionFiles.verifyDeclaredPaths({ paths: [db] })).found;
      };
      if (await reachable('antigravity-cli')) return { ok: true };
      // A retired-server conversation is adopted into the native store at launch.
      return await reachable('antigravity-acp') ? { ok: true } : { ok: false, reason: 'agy_session_state_not_found' };
    },
  },
};
