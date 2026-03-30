/**
 * Kimi CLI Entry Point
 *
 * Runs the Kimi agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';

import { KimiTerminalDisplay } from '@/backends/kimi/ui/KimiTerminalDisplay';
import { createKimiAcpRuntime } from './acp/runtime';

const KIMI_AUTH_HINT = 'Kimi appears not configured. Ensure the API key is set for the user running the daemon (e.g. `kimi config set --key api_key --value "..."`).';

export async function runKimi(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
}): Promise<void> {
  await runStandardAcpProvider(opts, {
    flavor: 'kimi',
    backendDisplayName: 'Kimi',
    uiLogPrefix: '[Kimi]',
    providerName: 'Kimi',
    waitingForCommandLabel: 'Kimi',
    agentMessageType: 'kimi',
    supportsMcpServers: false,
    machineMetadata: initialMachineMetadata,
    terminalDisplay: KimiTerminalDisplay,
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled }) => createKimiAcpRuntime({
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
        '[kimi] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: (error) => formatProviderPromptErrorMessage(error, { authHint: KIMI_AUTH_HINT }),
  });
}
