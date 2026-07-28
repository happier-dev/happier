import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import { createSessionProviderPendingDrainAdapter } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';

import { createCodexAcpBackend, type CodexAcpBackendOptions, type CodexAcpBackendResult } from '@/backends/codex/acp/backend';
import { publishCodexSessionIdMetadata } from '@/backends/codex/utils/codexSessionIdMetadata';
import type { PermissionMode } from '@/api/types';
import { buildCodexAcpEnvOverrides } from '@/backends/codex/acp/env';
import {
  sendPermissionRequestPushNotificationForActiveAccount,
  type PermissionRequestPushSender,
} from '@/settings/notifications/permissionRequestPush';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { createAgentSessionMediaPersister } from '@/session/sessionMedia/createAgentSessionMediaPersister';
import { createSessionMediaAccessPolicy } from '@/session/sessionMedia/createSessionMediaAccessPolicy';
import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import { getProviderCliRuntimeSpec } from '@happier-dev/agents';

export function createCodexAcpRuntime(params: {
  directory: string;
  session: ApiSessionClient;
  pushSender?: PermissionRequestPushSender;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  permissionMode: PermissionMode;
  getPermissionMode?: () => PermissionMode | null | undefined;
  onThinkingChange: (thinking: boolean) => void;
  pendingQueueDrainMaxPopPerWake?: number;
}) {
  const lastCodexAcpThreadIdPublished: { value: string | null; fingerprint?: string | null } = { value: null };
  let lastCodexIdentityGeneration: number | null = null;
  const drainPendingDuringTurn =
    (process.env.HAPPIER_E2E_ACP_TRACE_MARKERS ?? '').toString().trim() === '1';
  const materializeNextPendingMessageSafely = params.session.materializeNextPendingMessageSafely.bind(params.session);

  const runtime = createAcpRuntime({
    provider: 'codex',
    directory: params.directory,
    happierSessionId: params.session.sessionId,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    sessionIdentity: {
      kind: 'persist-bound',
      persistBound: async (event) => {
        if (lastCodexIdentityGeneration !== event.generation) {
          lastCodexAcpThreadIdPublished.value = null;
          lastCodexAcpThreadIdPublished.fingerprint = null;
          lastCodexIdentityGeneration = event.generation;
        }
        await publishCodexSessionIdMetadata({
          session: params.session,
          operation: event.operation,
          getCodexThreadId: () => event.vendorSessionId,
          backendMode: 'acp',
          transcriptStorage: process.env.HAPPIER_TRANSCRIPT_STORAGE === 'direct' ? 'direct' : 'persisted',
          codexHome: process.env.CODEX_HOME ?? null,
          activeServerDir: configuration.activeServerDir,
          processEnv: process.env,
          lastPublished: lastCodexAcpThreadIdPublished,
        });
      },
    },
    onThinkingChange: params.onThinkingChange,
    changeTitleInstruction: { enabled: false },
    hooks: {
      onPermissionRequest: ({ permissionId, toolName }) => {
        if (!params.pushSender) return;
        sendPermissionRequestPushNotificationForActiveAccount({
          pushSender: params.pushSender,
          sessionId: params.session.sessionId,
          sessionTitle: getSessionNotificationTitle(params.session.getMetadataSnapshot?.bind(params.session)) ?? params.session.sessionId,
          agentDisplayName: getProviderCliRuntimeSpec('codex').title,
          permissionId,
          toolName,
          permissionMode: params.getPermissionMode?.() ?? params.permissionMode,
        });
      },
    },
    // Codex ACP supports in-flight steering via the ACP backend's dedicated steer entrypoint.
    inFlightSteer: { enabled: true },
    pendingQueue: {
      drainAfterStartOrLoad: true,
      // Drain server-pending messages mid-turn only in the provider harness / e2e context.
      // In normal interactive use, "queue for review" semantics should not be defeated.
      drainDuringTurn: drainPendingDuringTurn,
      waitForMetadataUpdate: (signal) => params.session.waitForMetadataUpdate(signal),
      maxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
      inputConsumer: createSessionProviderPendingDrainAdapter({
        waitForMetadataUpdate: (signal) => params.session.waitForMetadataUpdate(signal),
        popPendingMessage: async () =>
          (await materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).type === 'materialized',
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => params.session.shouldAttemptPendingMaterialization?.() ?? true,
        reconcilePendingQueueState: (opts) => params.session.reconcilePendingQueueState?.(opts),
      }, { maxPopPerWake: params.pendingQueueDrainMaxPopPerWake }),
    },
    ...(process.env.HAPPIER_TRANSCRIPT_STORAGE === 'direct'
      ? {}
      : {
          sessionMedia: createAgentSessionMediaPersister({
            workingDirectory: params.directory,
            sessionId: params.session.sessionId,
            accessPolicy: createSessionMediaAccessPolicy({
              workingDirectory: params.directory,
              providerMediaRoots: [resolveConfiguredCodexHome(process.env)],
            }),
          }),
        }),
    ensureBackend: async () => {
      const permissionModeRaw = params.getPermissionMode?.() ?? params.permissionMode;
      const permissionMode = typeof permissionModeRaw === 'string' ? permissionModeRaw : undefined;
      const created = createCodexAcpBackend({
        cwd: params.directory,
        env: buildCodexAcpEnvOverrides(),
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
        permissionMode,
      });
      logger.debug(`[CodexACP] Backend created (command=${created.spawn.command})`);
      return created.backend as unknown as AgentBackend;
    },
  });

  return {
    ...runtime,
    rollbackConversation: async () => ({
      ok: false as const,
      errorCode: 'unsupported_action',
      errorMessage: 'Session rollback is unavailable for Codex ACP sessions',
    }),
  };
}
