/**
 * OpenCode CLI Entry Point
 *
 * Runs the OpenCode agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderConfig, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

import { OpenCodeTerminalDisplay } from '@/backends/opencode/ui/OpenCodeTerminalDisplay';

import { maybeUpdateOpenCodeSessionIdMetadata } from './utils/opencodeSessionIdMetadata';
import { createOpenCodeAcpRuntime } from './acp/runtime';
import {
  isLoopbackManagedOpenCodeBaseUrl,
  readSharedManagedOpenCodeServerStateBestEffort,
} from './server/sharedManagedServer';
import { createOpenCodeServerRuntime } from './server/runtime';
import { createOpenCodeSharedLocalControl } from './localControl/createOpenCodeSharedLocalControl';
import { resolveOpenCodeLocalControlSupport } from './localControl/resolveOpenCodeLocalControlSupport';

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
  startingMode?: 'local' | 'remote';
}): Promise<void> {
  const lastPublishedOpenCodeSessionMetadata = {
    sessionId: null as string | null,
    backendMode: null as 'server' | 'acp' | null,
    serverBaseUrl: null as string | null,
    serverBaseUrlExplicit: false,
  };
  const backendMode = resolveOpenCodeBackendModeFromEnv();
  let currentSession: Parameters<NonNullable<StandardAcpProviderConfig['onAfterStart']>>[0]['session'] | null = null;
  let currentRuntime: Parameters<NonNullable<StandardAcpProviderConfig['onAfterStart']>>[0]['runtime'] | null = null;
  let mountRemoteUi = (): void => undefined;
  let unmountRemoteUi = async (): Promise<void> => undefined;
  const localControl = createOpenCodeSharedLocalControl({
    support: resolveOpenCodeLocalControlSupport({
      backendMode,
      hasTTY: process.stdout.isTTY && process.stdin.isTTY,
    }),
    startingMode: opts.startingMode ?? (opts.startedBy === 'terminal' && backendMode === 'server' ? 'local' : 'remote'),
    getSession: () => currentSession,
    getSessionId: () => currentRuntime?.getSessionId() ?? null,
    getDirectory: () => currentSession?.getMetadataSnapshot()?.path ?? process.cwd(),
    getServerBaseUrl: async () => {
      const raw = typeof process.env.HAPPIER_OPENCODE_SERVER_URL === 'string'
        ? process.env.HAPPIER_OPENCODE_SERVER_URL.trim()
        : '';
      if (raw) return raw;
      const managed = await readSharedManagedOpenCodeServerStateBestEffort().catch(() => null);
      return managed?.baseUrl && isLoopbackManagedOpenCodeBaseUrl(managed.baseUrl) ? managed.baseUrl : null;
    },
    mountRemoteUi: () => mountRemoteUi(),
    unmountRemoteUi: () => unmountRemoteUi(),
  });

  await runStandardAcpProvider(opts, {
    flavor: 'opencode',
    backendDisplayName: 'OpenCode',
    uiLogPrefix: '[OpenCode]',
    providerName: 'OpenCode',
    waitingForCommandLabel: 'OpenCode',
    agentMessageType: 'opencode',
    startRuntimeBeforeFirstPrompt: backendMode === 'server',
    machineMetadata: initialMachineMetadata,
    terminalDisplay: OpenCodeTerminalDisplay,
    resolveRuntimeDirectory: ({ session, metadata }) => session.getMetadataSnapshot()?.path ?? metadata.path,
    resolveKeepAliveMode: localControl.resolveKeepAliveMode,
    shouldRenderTerminalDisplay: () => localControl.shouldRenderTerminalDisplay(),
    onTerminalDisplayControllerReady: (controller) => {
      mountRemoteUi = controller.mount;
      unmountRemoteUi = controller.unmount;
    },
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled }) => {
      if (backendMode === 'acp') {
        return createOpenCodeAcpRuntime({
          directory,
          machineId,
          session,
          messageBuffer,
          mcpServers,
          permissionHandler,
          onThinkingChange: setThinking,
          memoryRecallGuidanceEnabled,
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
    onSessionSwap: async ({ session }) => {
      currentSession = session;
      await localControl.onSessionSwap(session);
    },
    onAttachMetadataSnapshotError: (error) => {
      logger.debug(`[opencode] Error fetching session metadata snapshot (non-fatal): ${String(error instanceof Error ? error.message : error)}`);
    },
    onAttachMetadataSnapshotMissing: () => {
      logger.debug('[opencode] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)');
    },
    onAfterStart: ({ session, runtime }) => {
      currentSession = session;
      currentRuntime = runtime;
      void localControl.onAfterStart().catch((error) => {
        logger.debug('[opencode] Failed to start local control attachment (non-fatal)', error);
      });
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
          serverBaseUrl: process.env.HAPPIER_OPENCODE_SERVER_URL ?? null,
          serverBaseUrlExplicit: process.env.HAPPIER_OPENCODE_SERVER_URL_EXPLICIT ?? null,
          transcriptStorage: process.env.HAPPIER_TRANSCRIPT_STORAGE === 'direct' ? 'direct' : 'persisted',
          updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
          lastPublished: lastPublishedOpenCodeSessionMetadata,
        });
      })().catch((error) => {
        logger.debug('[opencode] Failed to publish opencodeSessionId metadata (non-fatal)', error);
      });
    },
    onAfterReset: () => {
      currentRuntime = null;
      lastPublishedOpenCodeSessionMetadata.sessionId = null;
      lastPublishedOpenCodeSessionMetadata.backendMode = null;
      lastPublishedOpenCodeSessionMetadata.serverBaseUrl = null;
      lastPublishedOpenCodeSessionMetadata.serverBaseUrlExplicit = false;
    },
    onDispose: async () => {
      await localControl.dispose();
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}
