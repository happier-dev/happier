import { hasBuiltInAcpConfig, isAgentId } from '@happier-dev/agents';

import { createCatalogAcpBackend } from '@/agent/acp';
import { loadBuiltInRuntimeOwners } from '@/agent/acp/catalog/builtIn/runtimeOwners';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { createAcpRuntime, type AcpRuntimeBackend } from '@/agent/acp/runtime/createAcpRuntime';
import type { McpServerConfig } from '@/agent';
import type { AgentFactoryOptions } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import {
  sendPermissionRequestPushNotificationForActiveAccount,
  type PermissionRequestPushSender,
} from '@/settings/notifications/permissionRequestPush';

type CatalogAcpProviderRuntimeParams<TBackendOptions extends AgentFactoryOptions> = {
  loggerLabel: string;
  directory: string;
  session: ApiSessionClient;
  transcriptSession?: TranscriptSessionPort;
  pushSender?: PermissionRequestPushSender;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  onSessionIdChange?: (nextSessionId: string | null) => void;
  inFlightSteer?: Parameters<typeof createAcpRuntime>[0]['inFlightSteer'];
  hooks?: Parameters<typeof createAcpRuntime>[0]['hooks'];
  memoryRecallGuidance?: Parameters<typeof createAcpRuntime>[0]['memoryRecallGuidance'];
};

export type CatalogBackedAcpProviderRuntimeParams<TBackendOptions extends AgentFactoryOptions> =
  CatalogAcpProviderRuntimeParams<TBackendOptions> & {
    provider: Parameters<typeof createCatalogAcpBackend>[0];
    backendOptions?: Omit<TBackendOptions, 'cwd' | 'mcpServers' | 'permissionHandler' | 'permissionMode'>;
    getPermissionMode?: () => PermissionMode | null | undefined;
    resolvePermissionMode?: (args: {
      getPermissionMode?: () => PermissionMode | null | undefined;
      session: ApiSessionClient;
    }) => PermissionMode | null | undefined;
    createBackend?: never;
    createReplayBackend?: never;
  };

export type CustomBackedAcpProviderRuntimeParams<TBackendOptions extends AgentFactoryOptions> =
  CatalogAcpProviderRuntimeParams<TBackendOptions> & {
    provider: string;
    backendOptions?: never;
    getPermissionMode?: () => PermissionMode | null | undefined;
    resolvePermissionMode?: (args: {
      getPermissionMode?: () => PermissionMode | null | undefined;
      session: ApiSessionClient;
    }) => PermissionMode | null | undefined;
    createBackend: (args: { permissionMode?: PermissionMode }) => AcpRuntimeBackend | Promise<AcpRuntimeBackend>;
    createReplayBackend?: () => AcpRuntimeBackend | Promise<AcpRuntimeBackend>;
  };

function isCustomBackedAcpProviderRuntimeParams<TBackendOptions extends AgentFactoryOptions>(
  params:
    | CatalogBackedAcpProviderRuntimeParams<TBackendOptions>
    | CustomBackedAcpProviderRuntimeParams<TBackendOptions>,
): params is CustomBackedAcpProviderRuntimeParams<TBackendOptions> {
  return 'createBackend' in params;
}

type CatalogAcpRuntimeBackendCreateResult = Readonly<{ backend: AcpRuntimeBackend }>;

async function createCatalogRuntimeBackend<TBackendOptions extends AgentFactoryOptions>(
  params: CatalogBackedAcpProviderRuntimeParams<TBackendOptions>,
  permissionMode: PermissionMode | undefined,
): Promise<AcpRuntimeBackend> {
  const backendOptions = {
    cwd: params.directory,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    permissionMode,
    ...(params.backendOptions ?? {}),
  } as unknown as TBackendOptions;

  if (isAgentId(params.provider) && hasBuiltInAcpConfig(params.provider)) {
    const runtimeOwners = await loadBuiltInRuntimeOwners(params.provider);
    return runtimeOwners.createRuntime(backendOptions) as AcpRuntimeBackend;
  }

  const created = await createCatalogAcpBackend<TBackendOptions, CatalogAcpRuntimeBackendCreateResult>(
    params.provider,
    backendOptions,
  );
  return created.backend;
}

export function createCatalogProviderAcpRuntime<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions>(
  params: CatalogBackedAcpProviderRuntimeParams<TBackendOptions>,
): ReturnType<typeof createAcpRuntime>;
export function createCatalogProviderAcpRuntime<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions>(
  params: CustomBackedAcpProviderRuntimeParams<TBackendOptions>,
): ReturnType<typeof createAcpRuntime>;
export function createCatalogProviderAcpRuntime<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions>(
  params:
    | CatalogBackedAcpProviderRuntimeParams<TBackendOptions>
    | CustomBackedAcpProviderRuntimeParams<TBackendOptions>,
): ReturnType<typeof createAcpRuntime> {
  const sendPermissionPush = (evt: { permissionId: string; toolName: string }): void => {
    if (!params.pushSender) return;
    try {
      sendPermissionRequestPushNotificationForActiveAccount({
        pushSender: params.pushSender,
        sessionId: params.session.sessionId,
        permissionId: evt.permissionId,
        toolName: evt.toolName,
        permissionMode: params.getPermissionMode?.(),
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
    happierSessionId: params.session.sessionId,
    session: params.session,
    transcriptSession: params.transcriptSession,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    hooks,
    inFlightSteer: params.inFlightSteer,
    memoryRecallGuidance: params.memoryRecallGuidance,
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

      if (isCustomBackedAcpProviderRuntimeParams(params)) {
        const created = await params.createBackend(permissionMode ? { permissionMode } : {});
        logger.debug(`[${params.loggerLabel}] Backend created`);
        return created;
      }

      const created = await createCatalogRuntimeBackend(params, permissionMode);
      logger.debug(`[${params.loggerLabel}] Backend created`);
      return created;
    },
    ...(isCustomBackedAcpProviderRuntimeParams(params)
      ? {
          createReplayBackend: async () => {
            if (params.createReplayBackend) {
              return await params.createReplayBackend();
            }
            return await params.createBackend({});
          },
        }
      : {}),
    onSessionIdChange: params.onSessionIdChange,
  });
}
