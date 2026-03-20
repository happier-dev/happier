import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { createPiAcpRuntime } from '@/backends/pi/acp/runtime';
import { buildPiToolsForPermissionMode } from '@/backends/pi/acp/backend';
import { PiTerminalDisplay } from '@/backends/pi/ui/PiTerminalDisplay';

export async function runPi(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
}): Promise<void> {
  await runStandardAcpProvider(opts, {
    flavor: 'pi',
    backendDisplayName: 'Pi',
    uiLogPrefix: '[Pi]',
    providerName: 'Pi',
    waitingForCommandLabel: 'Pi',
    agentMessageType: 'pi',
    supportsMcpServers: false,
    machineMetadata: initialMachineMetadata,
    terminalDisplay: PiTerminalDisplay,
    resolvePermissionModeQueueKey: (permissionMode) => buildPiToolsForPermissionMode(permissionMode).join(','),
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled }) =>
      createPiAcpRuntime({
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
        '[pi] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}
