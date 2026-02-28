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
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

import { OpenCodeTerminalDisplay } from '@/backends/opencode/ui/OpenCodeTerminalDisplay';

import { maybeUpdateOpenCodeSessionIdMetadata } from './utils/opencodeSessionIdMetadata';
import { createOpenCodeAcpRuntime } from './acp/runtime';
import { createOpenCodeServerRuntime } from './server/runtime';

function resolveOpenCodeBackendModeFromEnv(): 'server' | 'acp' {
  const raw = typeof process.env.HAPPIER_OPENCODE_BACKEND_MODE === 'string'
    ? process.env.HAPPIER_OPENCODE_BACKEND_MODE.trim().toLowerCase()
    : '';
  if (raw === 'acp') return 'acp';
  return 'server';
}

export async function runOpenCode(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
}): Promise<void> {
  const lastPublishedOpenCodeSessionMetadata = { sessionId: null as string | null, backendMode: null as 'server' | 'acp' | null };
  const backendMode = resolveOpenCodeBackendModeFromEnv();

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
    createRuntime: ({ directory, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode }) => {
      if (backendMode === 'acp') {
        return createOpenCodeAcpRuntime({
          directory,
          session,
          messageBuffer,
          mcpServers,
          permissionHandler,
          onThinkingChange: setThinking,
          getPermissionMode,
        });
      }

      return createOpenCodeServerRuntime({
        directory,
        session,
        messageBuffer,
        mcpServers,
        permissionHandler,
        onThinkingChange: setThinking,
        getPermissionMode,
      });
    },
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
        if (backendMode === 'server') {
          updateAgentStateBestEffort(
            session,
            (currentState) => ({
              ...currentState,
              capabilities: {
                ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
                askUserQuestionAnswersInPermission: true,
              },
            }),
            '[opencode]',
            'initial_agent_state',
          );
        }

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
          backendMode,
          updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
          lastPublished: lastPublishedOpenCodeSessionMetadata,
        });
      })().catch((error) => {
        logger.debug('[opencode] Failed to publish opencodeSessionId metadata (non-fatal)', error);
      });
    },
    onAfterReset: () => {
      lastPublishedOpenCodeSessionMetadata.sessionId = null;
      lastPublishedOpenCodeSessionMetadata.backendMode = null;
    },
    formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
  });
}
