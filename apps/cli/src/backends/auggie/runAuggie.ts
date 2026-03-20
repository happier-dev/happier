/**
 * Auggie CLI Entry Point
 *
 * Runs the Auggie agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';

import { createAuggieAcpRuntime } from '@/backends/auggie/acp/runtime';
import { readAuggieAllowIndexingFromEnv } from '@/backends/auggie/utils/env';
import { AuggieTerminalDisplay } from '@/backends/auggie/ui/AuggieTerminalDisplay';

const AUGGIE_AUTH_HINT = 'Auggie appears not authenticated. Run `auggie login` on this machine (the same user running the daemon) and try again.';

export async function runAuggie(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
}): Promise<void> {
  const allowIndexingFromEnv = readAuggieAllowIndexingFromEnv();

  await runStandardAcpProvider(opts, {
    flavor: 'auggie',
    backendDisplayName: 'Auggie',
    uiLogPrefix: '[Auggie]',
    providerName: 'Auggie',
    waitingForCommandLabel: 'Auggie',
    agentMessageType: 'auggie',
    machineMetadata: initialMachineMetadata,
    terminalDisplay: AuggieTerminalDisplay,
    beforeInitializeSession: ({ metadata }) => {
      (metadata as any).auggieAllowIndexing = allowIndexingFromEnv;
    },
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled }) => {
      const metadataSnapshot = session.getMetadataSnapshot?.() ?? null;
      const allowIndexing = allowIndexingFromEnv || metadataSnapshot?.auggieAllowIndexing === true;
      return createAuggieAcpRuntime({
        directory,
        machineId,
        session,
        messageBuffer,
        mcpServers,
        permissionHandler,
        onThinkingChange: setThinking,
        memoryRecallGuidanceEnabled,
        allowIndexing,
        getPermissionMode,
      });
    },
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        '[auggie] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: (error) => {
      logger.debug('[Auggie] Error during prompt:', error);
      return formatProviderPromptErrorMessage(error, { authHint: AUGGIE_AUTH_HINT });
    },
  });
}
