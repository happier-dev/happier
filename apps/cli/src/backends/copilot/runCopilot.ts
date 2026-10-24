/**
 * Copilot CLI Entry Point
 *
 * Runs the GitHub Copilot agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';

import { createCopilotAcpRuntime } from '@/backends/copilot/acp/runtime';

export async function runCopilot(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
}): Promise<void> {
  await runStandardAcpProvider(opts, {
    flavor: 'copilot',
    backendDisplayName: 'Copilot',
    uiLogPrefix: '[Copilot]',
    providerName: 'Copilot',
    waitingForCommandLabel: 'Copilot',
    agentMessageType: 'copilot',
    machineMetadata: initialMachineMetadata,
    loadTerminalDisplay: async () => (await import('@/backends/copilot/ui/CopilotTerminalDisplay')).CopilotTerminalDisplay,
    resolveRuntimeDirectory: ({ session, metadata }) => session.getMetadataSnapshot()?.path ?? metadata.path,
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled, processEnv, pendingQueueDrainMaxPopPerWake, providerInputConsumer }) => createCopilotAcpRuntime({
      directory,
      machineId,
      session,
      messageBuffer,
      mcpServers,
      permissionHandler,
      onThinkingChange: setThinking,
      memoryRecallGuidanceEnabled,
      getPermissionMode,
      processEnv,
      pendingQueueDrainMaxPopPerWake,
      providerInputConsumer,
    }),
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        '[copilot] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}
