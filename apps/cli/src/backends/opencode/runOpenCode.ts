/**
 * OpenCode CLI Entry Point
 *
 * Runs the OpenCode agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';

import { OpenCodeTerminalDisplay } from '@/backends/opencode/ui/OpenCodeTerminalDisplay';

import { maybeUpdateOpenCodeSessionIdMetadata } from './utils/opencodeSessionIdMetadata';
import { createOpenCodeAcpRuntime } from './acp/runtime';

export async function runOpenCode(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
}): Promise<void> {
  const lastPublishedOpenCodeSessionId = { value: null as string | null };

  await runStandardAcpProvider(opts, {
    flavor: 'opencode',
    backendDisplayName: 'OpenCode',
    uiLogPrefix: '[OpenCode]',
    providerName: 'OpenCode',
    waitingForCommandLabel: 'OpenCode',
    agentMessageType: 'opencode',
    machineMetadata: initialMachineMetadata,
    terminalDisplay: OpenCodeTerminalDisplay,
    resolveRuntimeDirectory: ({ session, metadata }) => session.getMetadataSnapshot()?.path ?? metadata.path,
    createRuntime: ({ directory, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode }) => createOpenCodeAcpRuntime({
      directory,
      session,
      messageBuffer,
      mcpServers,
      permissionHandler,
      onThinkingChange: setThinking,
      getPermissionMode,
    }),
    onAttachMetadataSnapshotError: (error) => {
      logger.debug(`[opencode] Error fetching session metadata snapshot (non-fatal): ${String(error instanceof Error ? error.message : error)}`);
    },
    onAttachMetadataSnapshotMissing: () => {
      logger.debug('[opencode] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)');
    },
    onAfterStart: ({ session, runtime }) => {
      const openCodeSessionId = runtime.getSessionId();
      if (!openCodeSessionId) return;

      // Do not block first prompt on metadata readiness; publish in the background.
      void (async () => {
        // OpenCode resume depends on writing `opencodeSessionId` into Happy session metadata.
        // Ensure we have a decrypted metadata snapshot so the update doesn't silently no-op.
        const snapshot = await session.ensureMetadataSnapshot({ timeoutMs: 60_000 });
        if (!snapshot) {
          logger.debug('[opencode] Unable to fetch session metadata snapshot; skipping opencodeSessionId publish (non-fatal)');
          return;
        }

        // If runtime was reset/restarted while we were waiting for metadata, do not publish stale ids.
        if (runtime.getSessionId() !== openCodeSessionId) {
          logger.debug('[opencode] Runtime session changed before opencodeSessionId publish; skipping stale publish (non-fatal)');
          return;
        }

        await maybeUpdateOpenCodeSessionIdMetadata({
          getOpenCodeSessionId: () => openCodeSessionId,
          updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
          lastPublished: lastPublishedOpenCodeSessionId,
        });
      })().catch((error) => {
        logger.debug('[opencode] Failed to publish opencodeSessionId metadata (non-fatal)', error);
      });
    },
    onAfterReset: () => {
      lastPublishedOpenCodeSessionId.value = null;
    },
    formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
  });
}
