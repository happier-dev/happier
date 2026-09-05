import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import {
  sendPermissionRequestPushNotificationForActiveAccount,
  type PermissionRequestPushSender,
} from '@/settings/notifications/permissionRequestPush';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';

import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';
import { createConfiguredAcpSessionIdentityPublication } from './createConfiguredAcpSessionIdentityPublication';
import type { ResolvedConfiguredAcpBackend } from './resolveConfiguredAcpBackendFromAccountSettings';

type CreateConfiguredAcpRuntimeParams = Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  loggerLabel: string;
  directory: string;
  session: ApiSessionClient;
  pushSender?: PermissionRequestPushSender;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  launchEnv: Readonly<Record<string, string>>;
  onThinkingChange: (thinking: boolean) => void;
  getPermissionMode?: () => PermissionMode | null | undefined;
  onSessionIdChange?: (nextSessionId: string | null) => void;
  memoryRecallGuidance?: Parameters<typeof createAcpRuntime>[0]['memoryRecallGuidance'];
  pendingQueueDrainMaxPopPerWake?: number;
  providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
}>;

export function createConfiguredAcpRuntime(params: CreateConfiguredAcpRuntimeParams) {
  const sendPermissionPush = (evt: { permissionId: string; toolName: string }): void => {
    if (!params.pushSender) return;
    try {
      sendPermissionRequestPushNotificationForActiveAccount({
        pushSender: params.pushSender,
        sessionId: params.session.sessionId,
        sessionTitle: getSessionNotificationTitle(params.session.getMetadataSnapshot?.bind(params.session)) ?? params.session.sessionId,
        agentDisplayName: params.backend.title,
        permissionId: evt.permissionId,
        toolName: evt.toolName,
        permissionMode: params.getPermissionMode?.(),
      });
    } catch {
      // best-effort
    }
  };

  // The backend is created lazily by ensureBackend (below) and only learns
  // whether the adapter supports session/load once the ACP initialize
  // handshake completes; the identity publication re-checks on every bind.
  let sessionLoadSupportProbe: { supportsSessionLoad?: () => boolean } | null = null;

  return createAcpRuntime({
    provider: `acp:${params.backend.backendId}`,
    directory: params.directory,
    happierSessionId: params.session.sessionId,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    sessionIdentity: createConfiguredAcpSessionIdentityPublication({
      session: params.session,
      isSessionLoadSupported: () => sessionLoadSupportProbe?.supportsSessionLoad?.() === true,
    }),
    memoryRecallGuidance: params.memoryRecallGuidance,
    hooks: {
      onPermissionRequest: (evt) => {
        sendPermissionPush(evt);
      },
    },
    pendingQueue: {
      drainAfterStartOrLoad: true,
      maxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
      inputConsumer: params.providerInputConsumer,
    },
    ensureBackend: async () => {
      const permissionMode = params.getPermissionMode?.() ?? undefined;
      const backend = createConfiguredAcpBackend({
        cwd: params.directory,
        backend: params.backend,
        launchEnv: params.launchEnv,
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
        ...(permissionMode ? { permissionMode } : {}),
      });
      sessionLoadSupportProbe = backend as unknown as { supportsSessionLoad?: () => boolean };
      logger.debug(`[${params.loggerLabel}] Backend created`);
      return backend as unknown as AgentBackend;
    },
    createReplayBackend: async () => {
      return createConfiguredAcpBackend({
        cwd: params.directory,
        backend: params.backend,
        launchEnv: params.launchEnv,
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
      }) as unknown as AgentBackend;
    },
  });
}
