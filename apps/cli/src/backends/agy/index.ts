import { createAgyConnectedServicesMaterializer } from './connectedServices/createAgyConnectedServicesMaterializer';
import { agyQuotaFetcherDescriptor } from './connectedServices/quotaFetcher';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import type { AgentCatalogEntry } from '@/backends/types';
import { createCatalogDefinedAcpEntry } from '@/agent/acp/catalog/createCatalogDefinedAcpEntry';
import { createCatalogDefinedAcpBackend } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import type { AccountSettings } from '@happier-dev/protocol';
import { agyDaemonSpawnHooks } from './daemon/spawnHooks';

const lifecycle: ConnectedServiceCredentialLifecycleDescriptor = {
  providerId: 'agy', serviceIds: ['antigravity'], spawnPreflightOauthRefresh: { mode: 'expiry_window' },
  refreshedCredentialApplication: { mode: 'restart_required' }, predictiveSoftSwitch: { mode: 'unsupported' },
  sameAccountFanoutStrategy: 'none', generationApplicationScope: 'per_session_runtime', runtimeAuthApply: { directLiveHotAuth: 'unsupported' },
};

const genericEntry = createCatalogDefinedAcpEntry('agy');

export const agent = {
  ...genericEntry,
  connectedServiceQuotaFetcherDescriptor: agyQuotaFetcherDescriptor,
  getCloudConnectTarget: async () => (await import('./cloud/connect')).agyCloudConnect,
  getConnectedServiceMaterializer: async () => createAgyConnectedServicesMaterializer(),
  getConnectedServiceCredentialLifecycleDescriptor: async () => lifecycle,
  getPreflightSessionControlsProbeAdapter: async () => ({ connectedServiceAuth: 'materialized-env-for-catalogs' as const }),
  resolveConnectedServiceSwitchContinuity: async () => ({ mode: 'unsupported' as const, reason: 'Antigravity live account switching is not supported' }),
  getCliCommandHandler: async () => (await import('./cli/command')).handleAgyCliCommand,
  getCapabilities: async () => (await import('./cli/extraCapabilities')).capabilities,
  getAcpBackendFactory: async () => {
    return async (opts) => {
      const options = opts as Parameters<typeof createCatalogDefinedAcpBackend>[1] & {
        accountSettings?: AccountSettings | null;
        readinessOnly?: boolean;
      };
      const { ensureAgyAcpServerForLaunch } = await import('./acp/ensureAgyAcpServerForLaunch');
      const launch = await ensureAgyAcpServerForLaunch({
        accountSettings: options.accountSettings,
        env: options.env,
        ...(options.readinessOnly ? { readinessOnly: true } : {}),
      });
      return { backend: createCatalogDefinedAcpBackend('agy', { ...options, launch }) };
    };
  },
  getDaemonSpawnHooks: async () => agyDaemonSpawnHooks,
  runtimeInstallableKeys: [INSTALLABLE_KEYS.AGY_ACP_SERVER],
} satisfies AgentCatalogEntry;
