import { createCatalogDefinedAcpBackend, type CatalogDefinedAcpBackendOptions } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import type { AgentBackend } from '@/agent/core';
import { createKimiWireSource } from './kimiWireSource';
import { requireCurrentKimiRuntime } from '@/backends/kimi/cli/runtimeDiscovery';

export type KimiBackendOptions = CatalogDefinedAcpBackendOptions;

/** ACP owns execution; the native journal supplies otherwise omitted background turns. */
export function createKimiBackend(options: KimiBackendOptions): AgentBackend {
  return createCatalogDefinedAcpBackend('kimi', {
    ...options,
    initialSessionModeId: 'default',
    providerTurnSource: createKimiWireSource(),
    prepareProcessLaunch: async () => {
      const runtime = await requireCurrentKimiRuntime({
        processEnv: { ...process.env, ...options.env },
        cwd: options.cwd,
      });
      return { command: runtime.command, args: ['acp'] };
    },
  });
}
