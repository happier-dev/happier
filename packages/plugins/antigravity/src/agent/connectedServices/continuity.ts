import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export const antigravityConnectedAccountLaunch: AgentConnectedAccountLaunchContributionV1 = {
  environmentUses: [{ purpose: 'model_upstream', environmentKey: 'AGY_ACP_FORCE_FILE_STORAGE' }],
  environmentUnsetUses: [
    { purpose: 'model_upstream', environmentKey: 'AGY_ACP_CCPA_BASE_URL' },
    { purpose: 'model_upstream', environmentKey: 'AGY_ACP_CCPA_PROJECT' },
  ],
  stateSharingDescriptor: {
    nativeHome: {
      environmentKey: 'GEMINI_HOME',
      defaultRelativePath: '.gemini',
      materializedDirectoryName: 'gemini-home',
      groupHome: 'selectedAccount',
    },
    providerSupportStatus: 'supported',
    config: {
      supported: true, modes: ['linked', 'copied', 'isolated'],
      entries: [
        { path: 'config/skills', mode: 'linked_or_copied' },
        { path: 'antigravity-cli/skills', mode: 'linked_or_copied' },
        { path: 'config/hooks.json', mode: 'linked_or_copied' },
        { path: 'config/mcp_config.json', mode: 'linked_or_copied' },
        { path: 'antigravity-acp/trusted_workspaces.json', mode: 'copied' },
      ],
    },
    state: {
      supported: true, modes: ['isolated', 'shared'],
      entries: [
        { path: 'antigravity-acp/conversations', mode: 'linked', createIfMissing: 'directory' },
        { path: 'antigravity-acp/brain', mode: 'linked', createIfMissing: 'directory' },
      ],
      sharedStatePrivacyRiskAcknowledgementRequired: true,
      symlinkUnavailableDegradePolicy: 'block_continuity',
    },
    authIsolation: {
      mode: 'materialized_home',
      secretEntries: ['antigravity-acp/acp_token.json', 'antigravity-acp/acp_business_token.json', 'antigravity-acp/settings.json'],
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
        // The host checks this evidence against the registered runtime epoch.
        // Process startup alone cannot prove the selected account is usable.
        if (outcome.kind !== 'provider_activity' || outcome.event !== 'assistant_message_end') {
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
      const required = await sessionFiles.verifyDeclaredPaths({ paths: [
        { path: `antigravity-acp/conversations/${id}.db`, kind: 'file' },
        { path: `antigravity-acp/conversations/${id}.meta`, kind: 'json_object' },
        { path: `antigravity-acp/brain/${id}`, kind: 'directory' },
      ] });
      if (!required.found) return { ok: false, reason: 'agy_session_state_not_found' };
      const trajectory = await sessionFiles.findDeclaredCandidate({
        includeNativeSessionId: false,
        matchesCandidate: ({ fileName }) => fileName === `${id}.db`,
      });
      return trajectory.found ? { ok: true } : { ok: false, reason: 'agy_session_state_not_found' };
    },
  },
};
