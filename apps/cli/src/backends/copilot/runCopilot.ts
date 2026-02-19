/**
 * Copilot CLI Entry Point
 *
 * Runs the GitHub Copilot agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';

import { CopilotTerminalDisplay } from '@/backends/copilot/ui/CopilotTerminalDisplay';
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
    terminalDisplay: CopilotTerminalDisplay,
    resolveRuntimeDirectory: ({ session, metadata }) => session.getMetadataSnapshot()?.path ?? metadata.path,
    createRuntime: ({ directory, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode }) => createCopilotAcpRuntime({
      directory,
      session,
      messageBuffer,
      mcpServers,
      permissionHandler,
      onThinkingChange: setThinking,
      getPermissionMode,
    }),
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        '[copilot] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
  });
}
