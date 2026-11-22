import type { AccountSettings } from '@happier-dev/protocol';

import type { AgentBackend } from '@/agent/core';
import { createCatalogDefinedAcpBackend, type CatalogDefinedAcpBackendOptions } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import { createAgyBackgroundContinuationSource } from './agyBackgroundContinuationSource';
import { ensureAgyAcpServerForLaunch } from './ensureAgyAcpServerForLaunch';
import { resolveAgyAcpRuntime } from './pinnedAgyAcpServer';

// ACP 1.3.0 lets these inherited values override the selected account's endpoint/project.
const ACCOUNT_ENDPOINT_OVERRIDES = ['AGY_ACP_CCPA_BASE_URL', 'AGY_ACP_CCPA_PROJECT'] as const;

export type AgyAcpBackendOptions = CatalogDefinedAcpBackendOptions & Readonly<{
  accountSettings?: AccountSettings | null;
  readinessOnly?: boolean;
}>;

export async function createAgyAcpBackend(options: AgyAcpBackendOptions): Promise<AgentBackend> {
  const { accountSettings, readinessOnly, ...catalogOptions } = options;
  const ensurePinnedServer = () => ensureAgyAcpServerForLaunch({
    accountSettings,
    env: options.env,
    ...(readinessOnly ? { readinessOnly: true } : {}),
  });
  return createCatalogDefinedAcpBackend('agy', {
    ...catalogOptions,
    // ACP 1.3.0 distinguishes failed token refresh/onboarding from generic missing authentication.
    isAuthenticationSetupFailure: ({ code, data }) =>
      code === -32000 && data !== null && typeof data === 'object' && !Array.isArray(data)
      && 'reason' in data && data.reason === 'onboarding_failed',
    launch: async ({ loadSessionId, resolveDefaultLaunch }) => {
      const runtime = await resolveAgyAcpRuntime({
        vendorResumeId: loadSessionId,
        cwd: options.cwd,
        env: options.env,
      });
      if (runtime === 'native') {
        return {
          ...resolveDefaultLaunch(),
          requireListedSessionOnLoad: true,
          providerTurnSource: createAgyBackgroundContinuationSource(),
        };
      }
      const launch = await ensurePinnedServer();
      return runtime === 'connected' ? { ...launch, unsetEnv: ACCOUNT_ENDPOINT_OVERRIDES } : launch;
    },
  });
}
