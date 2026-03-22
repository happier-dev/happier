/**
 * Kilo CLI Entry Point
 *
 * Runs the Kilo agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';

import { KiloTerminalDisplay } from '@/backends/kilo/ui/KiloTerminalDisplay';
import { createKiloAcpRuntime } from '@/backends/kilo/acp/runtime';

export async function runKilo(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
}): Promise<void> {
  await runStandardAcpProvider(opts, {
    flavor: 'kilo',
    backendDisplayName: 'Kilo',
    uiLogPrefix: '[Kilo]',
    providerName: 'Kilo',
    waitingForCommandLabel: 'Kilo',
    agentMessageType: 'kilo',
    machineMetadata: initialMachineMetadata,
    terminalDisplay: KiloTerminalDisplay,
    resolveRuntimeDirectory: ({ session, metadata }) => session.getMetadataSnapshot()?.path ?? metadata.path,
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled }) => createKiloAcpRuntime({
      directory,
      machineId,
      session,
      messageBuffer,
      mcpServers,
      permissionHandler,
      onThinkingChange: setThinking,
      memoryRecallGuidanceEnabled,
      getPermissionMode,
    }),
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        '[kilo] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}
