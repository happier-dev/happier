import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { createPiAcpRuntime } from '@/backends/pi/acp/runtime';
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
    machineMetadata: initialMachineMetadata,
    terminalDisplay: PiTerminalDisplay,
    createRuntime: ({ directory, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode }) =>
      createPiAcpRuntime({
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
        '[pi] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
  });
}
