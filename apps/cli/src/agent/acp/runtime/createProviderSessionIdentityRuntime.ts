import type { VendorResumeIdField } from '@happier-dev/agents';
import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';

import type { Metadata, PermissionMode } from '@/api/types';
import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AgentFactoryOptions } from '@/agent/catalog/factoryOptions';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  createSessionRuntimeIdentityMetadataUpdater,
  type SessionRuntimeIdentityMetadataUpdaterParams,
} from '@/agent/runtime/identity';
import type { RuntimeTurnSessionOpenIntent } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
  createCatalogProviderAcpRuntime,
  type CustomBackedAcpProviderRuntimeParams,
} from './createProviderAcpRuntime';

type CatalogProviderSessionIdentityPublication =
  | Readonly<{
      sessionIdMetadataKey: VendorResumeIdField;
    }>
  | Readonly<{
      sessionIdMetadataKey?: undefined;
    }>;

type CatalogProviderSessionIdentityRuntimeParams<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions> = Readonly<{
  provider: string;
  transcriptProvider?: string;
  loggerLabel: string;
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  transcriptSession?: TranscriptSessionPort;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  sessionOpenIntent?: RuntimeTurnSessionOpenIntent;
  memoryRecallGuidanceEnabled?: boolean;
  getPermissionMode?: CustomBackedAcpProviderRuntimeParams<TBackendOptions>['getPermissionMode'];
  resolvePermissionMode?: CustomBackedAcpProviderRuntimeParams<TBackendOptions>['resolvePermissionMode'];
  createBackend: CustomBackedAcpProviderRuntimeParams<TBackendOptions>['createBackend'];
  createReplayBackend?: CustomBackedAcpProviderRuntimeParams<TBackendOptions>['createReplayBackend'];
  inFlightSteer?: CustomBackedAcpProviderRuntimeParams<TBackendOptions>['inFlightSteer'];
  hooks?: CustomBackedAcpProviderRuntimeParams<TBackendOptions>['hooks'];
  buildRuntimeDescriptor?: (providerSessionId: string) => RuntimeDescriptorV1 | null;
}> & CatalogProviderSessionIdentityPublication;

export function createCatalogProviderSessionIdentityRuntime<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions>(
  params: CatalogProviderSessionIdentityRuntimeParams<TBackendOptions>,
) {
  const lastPublishedSessionId = { value: null as string | null };
  const publishSessionIdentity = (() => {
    if (params.sessionIdMetadataKey) {
      const updateSessionRuntimeIdentity = createSessionRuntimeIdentityMetadataUpdater(params.sessionIdMetadataKey);
      const buildRuntimeDescriptor = params.buildRuntimeDescriptor;
      return (nextSessionId: string | null) => {
        updateSessionRuntimeIdentity({
          sessionId: params.session.sessionId,
          getSessionId: () => nextSessionId,
          updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
          lastPublished: lastPublishedSessionId,
          ...(buildRuntimeDescriptor
            ? {
                decorateMetadata: (metadata, providerSessionId) =>
                  applyRuntimeDescriptorSessionMetadata(
                    metadata,
                    buildRuntimeDescriptor(providerSessionId),
                  ),
              }
            : {}),
        } satisfies SessionRuntimeIdentityMetadataUpdaterParams);
      };
    }

    return null;
  })();

  const runtimeBase = {
    loggerLabel: params.loggerLabel,
    ...(params.transcriptProvider ? { transcriptProvider: params.transcriptProvider } : {}),
    directory: params.directory,
    session: params.session,
    transcriptSession: params.transcriptSession,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    ...(params.sessionOpenIntent ? { sessionOpenIntent: params.sessionOpenIntent } : {}),
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    getPermissionMode: params.getPermissionMode,
    ...(params.resolvePermissionMode ? { resolvePermissionMode: params.resolvePermissionMode } : {}),
    ...(params.inFlightSteer ? { inFlightSteer: params.inFlightSteer } : {}),
    ...(params.hooks ? { hooks: params.hooks } : {}),
    ...(publishSessionIdentity ? { onSessionIdChange: publishSessionIdentity } : {}),
  } satisfies Omit<
    CustomBackedAcpProviderRuntimeParams<TBackendOptions>,
    'provider' | 'createBackend' | 'createReplayBackend'
  >;

  return createCatalogProviderAcpRuntime<TBackendOptions>({
    provider: params.provider,
    ...runtimeBase,
    createBackend: params.createBackend,
    ...(params.createReplayBackend ? { createReplayBackend: params.createReplayBackend } : {}),
  });
}
