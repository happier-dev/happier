import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

const restartRequired = () => ({
  supported: false, supportsInTurnApply: false, applied: false,
  status: 'unsupported' as const, recovery: 'restart_resume' as const,
  reason: 'codebuddy_static_access_token_requires_restart',
});

export const CODEBUDDY_CONNECTED_ACCOUNT_LAUNCH = {
  switchContinuity: { continuityMode: 'restart_same_home',
    supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'] },
  continuity: {
    generationApplicationScope: 'per_session_runtime',
    runtimeAuthAdapter: {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => restartRequired(),
      canHotApply: restartRequired,
      hotApply: async () => restartRequired(),
      verifyActiveAccount: async () => ({ status: 'unavailable' as const, retryable: false,
        reason: 'codebuddy_native_account_adoption_unverifiable' }),
      probeQuota: async () => ({ supported: false, status: 'unsupported' as const,
        reason: 'codebuddy_native_account_quota_unavailable' }),
      refreshActiveProfile: async () => restartRequired(),
    },
    // The host has no declared native history/home proof for this runtime.
    verifyResumeReachable: async () => ({ ok: false as const, reason: 'codebuddy_resume_reachability_unavailable' }),
  },
} satisfies AgentConnectedAccountLaunchContributionV1;
