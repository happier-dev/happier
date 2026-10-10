import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export const antigravityConnectedAccountLaunch: AgentConnectedAccountLaunchContributionV1 = {
  environmentUses: [{ purpose: 'model_upstream', environmentKey: 'AGY_ACP_FORCE_FILE_STORAGE' }],
  stateSharingDescriptor: {
    nativeHome: { environmentKey: 'GEMINI_HOME', defaultRelativePath: '.gemini' },
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
      secretEntries: ['antigravity-acp/acp_token.json', 'antigravity-acp/business_acp_token.json', 'antigravity-acp/settings.json'],
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
      const trajectory = await sessionFiles.findDeclaredCandidate({ matchesCandidate: ({ fileName }) => fileName === `${id}.db` });
      return trajectory.found ? { ok: true } : { ok: false, reason: 'agy_session_state_not_found' };
    },
  },
};
