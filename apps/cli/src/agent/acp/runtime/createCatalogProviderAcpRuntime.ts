import { createCatalogAcpBackend } from '@/agent/acp';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { sendPermissionRequestPushNotificationForActiveAccount } from '@/settings/notifications/permissionRequestPush';

type CatalogAcpProviderRuntimeParams<TBackendOptions extends object> = {
  provider: Parameters<typeof createCatalogAcpBackend>[0];
  loggerLabel: string;
  directory: string;
  session: ApiSessionClient;
  pushSender?: Readonly<{
    sendToAllDevices: (title: string, body: string, data: Record<string, unknown>) => void;
  }>;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  backendOptions?: Omit<TBackendOptions, 'cwd' | 'mcpServers' | 'permissionHandler' | 'permissionMode'>;
  getPermissionMode?: () => PermissionMode | null | undefined;
  resolvePermissionMode?: (args: {
    getPermissionMode?: () => PermissionMode | null | undefined;
    session: ApiSessionClient;
  }) => PermissionMode | null | undefined;
  onSessionIdChange?: (nextSessionId: string | null) => void;
  inFlightSteer?: Parameters<typeof createAcpRuntime>[0]['inFlightSteer'];
  hooks?: Parameters<typeof createAcpRuntime>[0]['hooks'];
};

export function createCatalogProviderAcpRuntime<TBackendOptions extends object = Record<string, never>>(
  params: CatalogAcpProviderRuntimeParams<TBackendOptions>,
) {
  const sendPermissionPush = (evt: { permissionId: string; toolName: string }): void => {
    if (!params.pushSender) return;
    try {
      sendPermissionRequestPushNotificationForActiveAccount({
        pushSender: params.pushSender,
        sessionId: params.session.sessionId,
        permissionId: evt.permissionId,
        toolName: evt.toolName,
      });
    } catch {
      // best-effort
    }
  };

  const hooks = params.hooks
    ? {
        ...params.hooks,
        onPermissionRequest: (evt: { permissionId: string; toolName: string; payload: unknown; reason: string }) => {
          try {
            params.hooks?.onPermissionRequest?.(evt);
          } catch {
            // ignore
          }
          sendPermissionPush(evt);
        },
      }
    : {
        onPermissionRequest: (evt: { permissionId: string; toolName: string; payload: unknown; reason: string }) => {
          sendPermissionPush(evt);
        },
      };

  return createAcpRuntime({
    provider: params.provider,
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    hooks,
    inFlightSteer: params.inFlightSteer,
    pendingQueue: {
      waitForMetadataUpdate: (signal) => params.session.waitForMetadataUpdate(signal),
      popPendingMessage: () => params.session.popPendingMessage(),
    },
    ensureBackend: async () => {
      const permissionModeRaw = params.resolvePermissionMode
        ? params.resolvePermissionMode({
            getPermissionMode: params.getPermissionMode,
            session: params.session,
          })
        : params.getPermissionMode?.();
      const permissionMode = typeof permissionModeRaw === 'string' ? permissionModeRaw : undefined;

      const created = await createCatalogAcpBackend<TBackendOptions>(params.provider, {
        cwd: params.directory,
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
        permissionMode,
        ...(params.backendOptions ?? {}),
      } as unknown as TBackendOptions);

      logger.debug(`[${params.loggerLabel}] Backend created`);
      return created.backend as unknown as AgentBackend;
    },
    onSessionIdChange: params.onSessionIdChange,
  });
}
