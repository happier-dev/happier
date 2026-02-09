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

import { createAuggieAcpRuntime } from '@/backends/auggie/acp/runtime';
import { readAuggieAllowIndexingFromEnv } from '@/backends/auggie/utils/env';
import { AuggieTerminalDisplay } from '@/backends/auggie/ui/AuggieTerminalDisplay';

function formatAuggiePromptError(err: unknown): { message: string; isAuthError: boolean } {
  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    return { message: err.message, isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('401') };
  }
  if (typeof err === 'string') {
    const lower = err.toLowerCase();
    return { message: err, isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('401') };
  }
  if (err && typeof err === 'object') {
    const maybeMessage = (err as { message?: unknown }).message;
    const maybeCode = (err as { code?: unknown }).code;
    const maybeDetails = (err as { data?: unknown }).data as { details?: unknown } | undefined;

    const message = typeof maybeMessage === 'string' ? maybeMessage : null;
    const details = typeof maybeDetails?.details === 'string' ? maybeDetails.details : null;
    const code = typeof maybeCode === 'number' ? maybeCode : null;

    const combined =
      details && message ? `${message}${typeof code === 'number' ? ` (code ${code})` : ''}: ${details}` : (details ?? message);
    if (combined) {
      const lower = combined.toLowerCase();
      return { message: combined, isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('api key') || lower.includes('token') || lower.includes('401') };
    }

    try {
      const json = JSON.stringify(err);
      const lower = json.toLowerCase();
      return { message: json, isAuthError: lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('401') };
    } catch {
      return { message: String(err), isAuthError: false };
    }
  }
  return { message: String(err), isAuthError: false };
}

function formatAuggiePromptErrorMessage(err: unknown): string {
  logger.debug('[Auggie] Error during prompt:', err);
  const formatted = formatAuggiePromptError(err);
  const extraHint = formatted.isAuthError
    ? 'Auggie appears not authenticated. Run `auggie login` on this machine (the same user running the daemon) and try again.'
    : null;
  return `Error: ${formatted.message}${extraHint ? `\n\n${extraHint}` : ''}`;
}

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
    createRuntime: ({ directory, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode }) => {
      const metadataSnapshot = session.getMetadataSnapshot?.() ?? null;
      const allowIndexing = allowIndexingFromEnv || metadataSnapshot?.auggieAllowIndexing === true;
      return createAuggieAcpRuntime({
        directory,
        session,
        messageBuffer,
        mcpServers,
        permissionHandler,
        onThinkingChange: setThinking,
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
    formatPromptErrorMessage: formatAuggiePromptErrorMessage,
  });
}
