import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { CODEBUDDY_ACP_COMMAND } from '../acp/preflight.js';

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
    verifyResumeReachable: async ({ vendorResumeId, nativeInspection }) => {
      if (!vendorResumeId) return { ok: false as const, reason: 'vendor_resume_id_missing' };
      if (!nativeInspection) return { ok: false as const, reason: 'codebuddy_resume_inspection_unavailable' };
      try {
        await nativeInspection.withDeclaredJsonRpcClient(CODEBUDDY_ACP_COMMAND, async (client) => {
          await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
          await client.request('session/load', { sessionId: vendorResumeId, cwd: nativeInspection.cwd, mcpServers: [] });
        });
        return { ok: true as const, proof: 'native_session' as const };
      } catch {
        return { ok: false as const, reason: 'codebuddy_resume_unreachable' };
      }
    },
  },
} satisfies AgentConnectedAccountLaunchContributionV1;
