import type { AgentBackend } from '@/agent/core';
import { createCatalogDefinedAcpBackend, type CatalogDefinedAcpBackendOptions } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import { createAgyBackgroundContinuationSource } from './agyBackgroundContinuationSource';
import { resolveAgyAcpLaunch, resolveAgyMachineProfileDir } from './agyAcpLaunch';
import { importLegacyAgyConversation } from './agyConversationStore';
import { agySessionModelAdapter, withOfferedAgyThoughtLevels } from './modelControls';
import { AgyTransport } from './transport';

export type AgyAcpBackendOptions = CatalogDefinedAcpBackendOptions;

export async function createAgyAcpBackend(options: AgyAcpBackendOptions): Promise<AgentBackend> {
  return withOfferedAgyThoughtLevels(createCatalogDefinedAcpBackend('agy', {
    ...options,
    sessionModelAdapter: agySessionModelAdapter,
    transportHandler: new AgyTransport(),
    launch: async ({ loadSessionId, resolveDefaultLaunch }) => {
      const command = resolveDefaultLaunch();
      const env = { ...process.env, ...options.env };
      const launch = resolveAgyAcpLaunch(env);
      if (loadSessionId) await importLegacyAgyConversation(launch.profileDir ?? resolveAgyMachineProfileDir(env), loadSessionId);
      return {
        command: command.command,
        args: [...command.args, ...launch.args],
        env: launch.env,
        unsetEnv: launch.unsetEnv,
        ...(launch.admitInitializedAgent ? { admitInitializedAgent: launch.admitInitializedAgent } : {}),
        requireListedSessionOnLoad: true,
        providerTurnSource: createAgyBackgroundContinuationSource(),
      };
    },
  }));
}
