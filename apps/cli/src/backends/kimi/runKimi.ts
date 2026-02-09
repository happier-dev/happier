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

import { KimiTerminalDisplay } from '@/backends/kimi/ui/KimiTerminalDisplay';
import { createKimiAcpRuntime } from './acp/runtime';

function formatKimiPromptError(err: unknown): { message: string; isAuthError: boolean } {
  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    return {
      message: err.message,
      isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('api key') || lower.includes('401'),
    };
  }
  if (typeof err === 'string') {
    const lower = err.toLowerCase();
    return {
      message: err,
      isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('api key') || lower.includes('401'),
    };
  }
  return { message: String(err), isAuthError: false };
}

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
    machineMetadata: initialMachineMetadata,
    terminalDisplay: KimiTerminalDisplay,
    createRuntime: ({ directory, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode }) => createKimiAcpRuntime({
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
        '[kimi] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: (error) => {
      const formatted = formatKimiPromptError(error);
      const extraHint = formatted.isAuthError
        ? 'Kimi appears not configured. Ensure the API key is set for the user running the daemon (e.g. `kimi config set --key api_key --value "..."`).'
        : null;
      return `Error: ${formatted.message}${extraHint ? `\n\n${extraHint}` : ''}`;
    },
  });
}
