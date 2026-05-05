/**
 * Copilot CLI Entry Point
 *
 * Runs the GitHub Copilot agent through Happier CLI using ACP.
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

import { CopilotTerminalDisplay } from '@/backends/copilot/ui/CopilotTerminalDisplay';
import { createCopilotAcpRuntime } from '@/backends/copilot/acp/runtime';

export type CopilotSessionRuntimeOptions = HostSessionRuntimeRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
};

export function createCopilotSessionRuntimePlan(opts: CopilotSessionRuntimeOptions): HostSessionRuntimePlan {
  return createCatalogHostSessionRuntimePlan({
    providerId: 'copilot',
    opts,
    config: createCatalogHostSessionRuntimeConfig({
      providerId: 'copilot',
      config: {
        flavor: 'copilot',
        policyAgentId: 'copilot',
        displayName: 'Copilot',
        terminalDisplay: CopilotTerminalDisplay,
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
        }) => createCopilotAcpRuntime({
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
        attachMetadataLogLabel: 'copilot',
        formatPromptErrorMessage: formatProviderPromptErrorMessage,
      },
    }),
  });
}

export async function runCopilotSessionRuntime(opts: CopilotSessionRuntimeOptions): Promise<void> {
  await runHostSessionRuntimePlan(createCopilotSessionRuntimePlan(opts));
}
