import type { AgentConnectedAccountLaunchContributionV1, AgentConnectedAccountRuntimeAuthAdapterV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { COPILOT_GITHUB_PURPOSE_ID } from './accountPurposes.js';
import { COPILOT_AUTH_ENV_VARS, COPILOT_GITHUB_TOKEN_ENV_VAR } from './copilotAuth.js';
import { COPILOT_PROVIDER_OWNED_ENV_KEYS } from '../../providerBinding.js';
import { COPILOT_ACP_COMMAND } from '../../acp/command.js';

const restartRequired = () => ({
  supported: false, supportsInTurnApply: false, applied: false,
  status: 'unsupported' as const, recovery: 'restart_resume' as const,
  reason: 'copilot_static_access_token_requires_restart',
});

/** Native ACP exposes no account adoption proof or live access-token replacement. */
export const COPILOT_CONNECTED_ACCOUNT_RUNTIME_AUTH: AgentConnectedAccountRuntimeAuthAdapterV1 = {
  classifyRuntimeAuthFailure: () => null,
  materializeActiveProfile: async () => restartRequired(),
  canHotApply: restartRequired,
  hotApply: async () => restartRequired(),
  verifyActiveAccount: async () => ({
    status: 'unavailable', retryable: false, reason: 'copilot_native_account_adoption_unverifiable',
  }),
  probeQuota: async () => ({ supported: false, status: 'unsupported', reason: 'copilot_native_account_quota_unavailable' }),
  refreshActiveProfile: async () => restartRequired(),
};

export const COPILOT_CONNECTED_ACCOUNT_LAUNCH = {
  environmentUses: [{ purpose: COPILOT_GITHUB_PURPOSE_ID, environmentKey: COPILOT_GITHUB_TOKEN_ENV_VAR }],
  environmentUnsetUses: [...COPILOT_AUTH_ENV_VARS, ...COPILOT_PROVIDER_OWNED_ENV_KEYS]
    .map(environmentKey => ({ purpose: COPILOT_GITHUB_PURPOSE_ID, environmentKey })),
  switchContinuity: { continuityMode: 'restart_same_home',
    supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'] },
  continuity: {
    generationApplicationScope: 'per_session_runtime',
    runtimeAuthAdapter: COPILOT_CONNECTED_ACCOUNT_RUNTIME_AUTH,
    async verifyResumeReachable({ vendorResumeId, nativeInspection }) {
      if (!vendorResumeId) return { ok: false, reason: 'vendor_resume_id_missing' };
      if (!nativeInspection) return { ok: false, reason: 'copilot_native_resume_inspection_unavailable' };
      try {
        await nativeInspection.withDeclaredJsonRpcClient(COPILOT_ACP_COMMAND, async (client) => {
          await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
          await client.request('session/load', { sessionId: vendorResumeId, cwd: nativeInspection.cwd, mcpServers: [] });
        });
        return { ok: true, proof: 'native_session' as const };
      } catch {
        return { ok: false, reason: 'copilot_native_resume_unreachable' };
      }
    },
  },
} satisfies AgentConnectedAccountLaunchContributionV1;
