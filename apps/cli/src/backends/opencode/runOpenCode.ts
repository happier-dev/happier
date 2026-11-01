/**
 * OpenCode CLI Entry Point
 *
 * Runs the OpenCode agent through Happier CLI using the selected server-native or ACP backend.
 */

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderConfig, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

import { maybeUpdateOpenCodeSessionIdMetadata, type OpenCodeSessionMetadataPublicationState } from './utils/opencodeSessionIdMetadata';
import { createOpenCodeAcpRuntime } from './acp/runtime';
import {
  isLoopbackManagedOpenCodeBaseUrl,
  readSharedManagedOpenCodeServerStateBestEffort,
} from './server/sharedManagedServer';
import { createOpenCodeServerRuntime } from './server/runtime';
import { createOpenCodeSharedLocalControl } from './localControl/createOpenCodeSharedLocalControl';
import { resolveOpenCodeLocalControlSupport } from './localControl/resolveOpenCodeLocalControlSupport';
import { resolveOpenCodeBackendModeFromEnv } from './backendMode';
import { hasHostedAttachedTerminalPresentation } from '@/agent/localControl/createAttachedTerminalSupervisor';

export async function runOpenCode(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
  startingMode?: 'local' | 'remote';
}): Promise<void> {
  const lastPublishedOpenCodeSessionMetadata: OpenCodeSessionMetadataPublicationState = {
    sessionId: null as string | null,
    backendMode: null as 'server' | 'acp' | null,
    serverBaseUrl: null as string | null,
    serverBaseUrlExplicit: false,
  };
  const backendMode = resolveOpenCodeBackendModeFromEnv(process.env);
  const hasHostedTerminal = backendMode === 'server' && hasHostedAttachedTerminalPresentation(opts.terminalRuntime);
  let serverRuntime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
  let currentSession: Parameters<NonNullable<StandardAcpProviderConfig['onAfterStart']>>[0]['session'] | null = null;
  let currentRuntime: Parameters<NonNullable<StandardAcpProviderConfig['onAfterStart']>>[0]['runtime'] | null = null;
  let prepareLocalAttachment: (() => Promise<boolean>) | null = null;
  let unregisterAttachPreparation: (() => void) | null = null;
  let mountRemoteUi = (): void => undefined;
  let unmountRemoteUi = async (): Promise<void> => undefined;
  const localControl = createOpenCodeSharedLocalControl({
    support: resolveOpenCodeLocalControlSupport({
      backendMode,
      hasTTY: process.stdout.isTTY && process.stdin.isTTY,
      hasHostedTerminal,
    }),
    startingMode: opts.startingMode ?? (opts.startedBy === 'terminal' && backendMode === 'server' ? 'local' : 'remote'),
    terminalRuntime: opts.terminalRuntime,
    getSession: () => currentSession,
    getSessionId: () => currentRuntime?.getSessionId() ?? null,
    prepareAttachment: async () => prepareLocalAttachment ? await prepareLocalAttachment() : false,
    getDirectory: () => currentSession?.getMetadataSnapshot()?.path ?? process.cwd(),
    getServerTarget: async () => {
      const selected = currentRuntime === serverRuntime ? serverRuntime?.getManagedServerIdentity() : null;
      if (selected) return { baseUrl: selected.baseUrl,
        ...(selected.launchEnvFingerprint ? { managedServerLaunchFingerprint: selected.launchEnvFingerprint } : {}) };
      const raw = typeof process.env.HAPPIER_OPENCODE_SERVER_URL === 'string'
        ? process.env.HAPPIER_OPENCODE_SERVER_URL.trim()
        : '';
      if (raw) return { baseUrl: raw };
      const managed = await readSharedManagedOpenCodeServerStateBestEffort().catch(() => null);
      return managed?.baseUrl && isLoopbackManagedOpenCodeBaseUrl(managed.baseUrl) ? { baseUrl: managed.baseUrl } : null;
    },
    mountRemoteUi: () => mountRemoteUi(),
    unmountRemoteUi: () => unmountRemoteUi(),
  });

  const registerAttachPreparation = (session: NonNullable<typeof currentSession>): void => {
    unregisterAttachPreparation?.();
    unregisterAttachPreparation = backendMode === 'server'
      ? session.registerSessionRuntimeControls?.({ prepareProviderCliAttach: localControl.prepareProviderCliAttach }) ?? null
      : null;
  };

  await runStandardAcpProvider(opts, {
    flavor: 'opencode',
    backendDisplayName: 'OpenCode',
    uiLogPrefix: '[OpenCode]',
    providerName: 'OpenCode',
    waitingForCommandLabel: 'OpenCode',
    agentMessageType: 'opencode',
    startRuntimeBeforeFirstPrompt: backendMode === 'server',
    machineMetadata: initialMachineMetadata,
    terminalHostOwner: hasHostedTerminal ? 'runtime' : 'startup',
    loadTerminalDisplay: async () => (await import('@/backends/opencode/ui/OpenCodeTerminalDisplay')).OpenCodeTerminalDisplay,
    resolveRuntimeDirectory: ({ session, metadata }) => session.getMetadataSnapshot()?.path ?? metadata.path,
    resolveKeepAliveMode: localControl.resolveKeepAliveMode,
    shouldRenderTerminalDisplay: () => localControl.shouldRenderTerminalDisplay(),
    onTerminalDisplayControllerReady: (controller) => {
      mountRemoteUi = controller.mount;
      unmountRemoteUi = controller.unmount;
    },
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled, processEnv, pendingQueueDrainMaxPopPerWake, providerInputConsumer }) => {
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
          processEnv,
          pendingQueueDrainMaxPopPerWake,
          providerInputConsumer,
        });
      }

      serverRuntime = createOpenCodeServerRuntime({
        directory,
        session,
        messageBuffer,
        mcpServers,
        happierMcpAdmission: { kind: 'required' },
        permissionHandler,
        onThinkingChange: setThinking,
        getPermissionMode,
        env: processEnv,
        pendingQueue: {
          drainPending: (drainOpts) => providerInputConsumer.drainPending(drainOpts),
          drainAfterStartOrLoad: true,
          maxPopPerWake: pendingQueueDrainMaxPopPerWake,
        },
      });
      return serverRuntime;
    },
    onSessionSwap: async ({ session }) => {
      currentSession = session;
      registerAttachPreparation(session);
      await localControl.onSessionSwap(session);
    },
    onAttachMetadataSnapshotError: (error) => {
      logger.debug(`[opencode] Error fetching session metadata snapshot (non-fatal): ${String(error instanceof Error ? error.message : error)}`);
    },
    onAttachMetadataSnapshotMissing: () => {
      logger.debug('[opencode] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)');
    },
    onAfterStart: ({ session, runtime, initialControlsApplied, prepareLocalAttachment: prepare }) => {
      currentSession = session;
      currentRuntime = runtime;
      prepareLocalAttachment = prepare;
      registerAttachPreparation(session);
      if (!initialControlsApplied) logger.infoFile('[opencode] native_attachment_controls_not_applied');
      void localControl.onAfterStart({ canAttach: initialControlsApplied }).catch(() => {
        logger.infoFile('[opencode] native_attachment_start_failed');
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
        if (runtime.getSessionId() !== openCodeSessionId || currentRuntime !== runtime || currentSession !== session) {
          logger.debug('[opencode] Runtime session changed before opencodeSessionId publish; skipping stale publish (non-fatal)');
          return;
        }

        await maybeUpdateOpenCodeSessionIdMetadata({
          getOpenCodeSessionId: () => openCodeSessionId,
          backendMode,
          serverBaseUrl: process.env.HAPPIER_OPENCODE_SERVER_URL ?? null,
          serverBaseUrlExplicit: process.env.HAPPIER_OPENCODE_SERVER_URL_EXPLICIT ?? null,
          // Only the actual provider factory's selected client owns managed affinity.
          managedServerLaunchFingerprint: runtime === serverRuntime
            ? serverRuntime?.getManagedServerIdentity()?.launchEnvFingerprint ?? null : null,
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
      serverRuntime = null;
      prepareLocalAttachment = null;
      lastPublishedOpenCodeSessionMetadata.sessionId = null;
      lastPublishedOpenCodeSessionMetadata.backendMode = null;
      lastPublishedOpenCodeSessionMetadata.serverBaseUrl = null;
      lastPublishedOpenCodeSessionMetadata.serverBaseUrlExplicit = false;
      lastPublishedOpenCodeSessionMetadata.managedServerLaunchFingerprint = null;
    },
    onDispose: async () => {
      unregisterAttachPreparation?.();
      unregisterAttachPreparation = null;
      await localControl.dispose();
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}
