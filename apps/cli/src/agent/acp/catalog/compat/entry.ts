import type { AgentCatalogEntry } from '@/backends/types';

import { createBuiltInCliAuthSpec } from '../builtIn/auth';
import { createBuiltInCliDetect } from '../builtIn/detect';
import { createCustomAcpCompatBackend } from './backend';
import {
  LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID,
  LEGACY_CUSTOM_ACP_COMPAT_CLI_SUBCOMMAND,
  LEGACY_CUSTOM_ACP_COMPAT_VENDOR_RESUME_SUPPORT,
} from './customAcp';

export function createCustomAcpCompatEntry(): AgentCatalogEntry {
  const getRuntimeCore: AgentCatalogEntry['getRuntimeCore'] = async () => {
    const [
      { createCatalogRuntimeCore },
      { createBuiltInSessionPlan },
    ] = await Promise.all([
      import('@/agent/runtime/registry/runtimeCore/catalog'),
      import('../builtIn/sessionPlan'),
    ]);

    return createCatalogRuntimeCore({
      providerId: LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID,
      createHostSessionRuntimePlan: (sessionParams) =>
        createBuiltInSessionPlan(
          LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID,
          sessionParams as Parameters<typeof createBuiltInSessionPlan>[1],
        ),
      createRuntime: createCustomAcpCompatBackend,
    });
  };

  const getAcpBackendFactory: AgentCatalogEntry['getAcpBackendFactory'] = async () => {
    return (opts) => ({ backend: createCustomAcpCompatBackend(opts) });
  };

  return {
    id: LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID,
    cliSubcommand: LEGACY_CUSTOM_ACP_COMPAT_CLI_SUBCOMMAND,
    getCliCommandHandler: async () => {
      return async (context) => {
        const { runBackendSessionCliCommand } = await import('@/cli/runBackendSessionCliCommand');
        await runBackendSessionCliCommand({
          context,
          backendIdForSessionRuntime: LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID,
          loadAccountSettings: true,
        });
      };
    },
    getCliDetect: async () => createBuiltInCliDetect(LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID),
    getCliAuthSpec: async () => createBuiltInCliAuthSpec(LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID),
    getAcpBackendFactory,
    getRuntimeCore,
    vendorResumeSupport: LEGACY_CUSTOM_ACP_COMPAT_VENDOR_RESUME_SUPPORT,
  };
}
