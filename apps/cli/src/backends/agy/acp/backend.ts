import type { AccountSettings } from '@happier-dev/protocol';

import type { AgentBackend } from '@/agent/core';
import { createCatalogDefinedAcpBackend, type CatalogDefinedAcpBackendOptions } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import { createAgyBackgroundContinuationSource } from './agyBackgroundContinuationSource';
import { ensureAgyAcpServerForLaunch } from './ensureAgyAcpServerForLaunch';
import { isPinnedAgyAcpServerConversation, usesPinnedAgyAcpServer } from './pinnedAgyAcpServer';

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
  const backendOptions: CatalogDefinedAcpBackendOptions = {
    ...catalogOptions,
    // ACP 1.3.0 distinguishes failed token refresh/onboarding from generic missing authentication.
    isAuthenticationSetupFailure: ({ code, data }) =>
      code === -32000 && data !== null && typeof data === 'object' && !Array.isArray(data)
      && 'reason' in data && data.reason === 'onboarding_failed',
  };
  if (!usesPinnedAgyAcpServer(options.env)) {
    return createCatalogDefinedAcpBackend('agy', {
      ...backendOptions,
      // Only `agy acp` has been observed resuming a conversation on its own after a background command.
      providerTurnSource: createAgyBackgroundContinuationSource(),
      // `agy acp` opens an empty session for ids it does not know, so conversations the pinned
      // server created for native login in earlier releases must resume on that server.
      prepareProcessLaunch: async ({ loadSessionId }) => {
        const pinnedConversation = loadSessionId !== null
          && await isPinnedAgyAcpServerConversation({ sessionId: loadSessionId, cwd: options.cwd, env: options.env });
        return pinnedConversation ? await ensurePinnedServer() : {};
      },
    });
  }
  const env = Object.fromEntries(Object.entries(options.env ?? {}).filter(([key]) =>
    !ACCOUNT_ENDPOINT_OVERRIDES.some((override) => key.toUpperCase() === override)));
  return createCatalogDefinedAcpBackend('agy', {
    ...backendOptions,
    env,
    unsetEnv: [...options.unsetEnv ?? [], ...ACCOUNT_ENDPOINT_OVERRIDES],
    launch: await ensurePinnedServer(),
  });
}
