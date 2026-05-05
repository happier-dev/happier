/**
 * Kilo CLI Entry Point
 *
 * Runs the Kilo agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import type { Credentials } from '@/persistence';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/catalogPlan';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { runHostSessionRuntimePlan, type HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';

import { KiloTerminalDisplay } from '@/backends/kilo/ui/KiloTerminalDisplay';
import { createKiloAcpRuntime } from '@/backends/kilo/acp/runtime';

export type KiloSessionRuntimeOptions = HostSessionRuntimeRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
};

export function createKiloSessionRuntimePlan(opts: KiloSessionRuntimeOptions): HostSessionRuntimePlan {
  return createCatalogHostSessionRuntimePlan({
    providerId: 'kilo',
    opts,
    config: createCatalogHostSessionRuntimeConfig({
      providerId: 'kilo',
      config: {
        flavor: 'kilo',
        policyAgentId: 'kilo',
        displayName: 'Kilo',
        terminalDisplay: KiloTerminalDisplay,
        resolveRuntimeDirectory: ({ session, metadata }) => session.getMetadataSnapshot()?.path ?? metadata.path,
        createNativeRuntime: ({
          directory,
          machineId,
          session,
          transcriptSession,
          messageBuffer,
          mcpServers,
          permissionHandler,
          setThinking,
          getPermissionMode,
          memoryRecallGuidanceEnabled,
        }) => createKiloAcpRuntime({
          directory,
          machineId,
          session,
          transcriptSession,
          messageBuffer,
          mcpServers,
          permissionHandler,
          onThinkingChange: setThinking,
          memoryRecallGuidanceEnabled,
          getPermissionMode,
        }),
        attachMetadataLogLabel: 'kilo',
        formatPromptErrorMessage: formatProviderPromptErrorMessage,
      },
    }),
  });
}

export async function runKiloSessionRuntime(opts: KiloSessionRuntimeOptions): Promise<void> {
  await runHostSessionRuntimePlan(createKiloSessionRuntimePlan(opts));
}
