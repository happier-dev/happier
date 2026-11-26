import type { AgentBackend } from '@/agent/core';
import { createCatalogDefinedAcpBackend, type CatalogDefinedAcpBackendOptions } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import { createAgyBackgroundContinuationSource } from './agyBackgroundContinuationSource';
import { resolveAgyAcpLaunch } from './agyAcpLaunch';

export type AgyAcpBackendOptions = CatalogDefinedAcpBackendOptions;

export async function createAgyAcpBackend(options: AgyAcpBackendOptions): Promise<AgentBackend> {
  return createCatalogDefinedAcpBackend('agy', {
    ...options,
    launch: async ({ resolveDefaultLaunch }) => {
      const command = resolveDefaultLaunch();
      const launch = resolveAgyAcpLaunch({ ...process.env, ...options.env });
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
  });
}
