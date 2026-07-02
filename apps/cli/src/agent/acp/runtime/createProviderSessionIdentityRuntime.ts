import type { AgentId, VendorResumeIdField } from '@happier-dev/agents';
import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import type { AccountSettings, RuntimeDescriptorV1 } from '@happier-dev/protocol';

import type { Metadata, PermissionMode } from '@/api/types';
import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AgentFactoryOptions } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  createProviderSessionIdentityPublisher,
  createSessionRuntimeIdentityMetadataUpdater,
  type SessionRuntimeIdentityMetadataUpdaterParams,
} from '@/agent/runtime/identity';
import {
  createCatalogProviderAcpRuntime,
  type CatalogBackedAcpProviderRuntimeParams,
  type CustomBackedAcpProviderRuntimeParams,
} from './createProviderAcpRuntime';

type CatalogProviderSessionIdentityPublication =
  | Readonly<{
      sessionIdMetadataKey: VendorResumeIdField;
      agentId?: never;
      vendorResumeIdField?: never;
    }>
  | Readonly<{
      sessionIdMetadataKey?: never;
      agentId: AgentId;
      vendorResumeIdField: VendorResumeIdField;
    }>
  | Readonly<{
      sessionIdMetadataKey?: undefined;
      agentId?: undefined;
      vendorResumeIdField?: undefined;
    }>;

type CatalogProviderSessionIdentityRuntimeParams<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions> = Readonly<{
  provider: string;
  loggerLabel: string;
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  transcriptSession?: TranscriptSessionPort;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  memoryRecallGuidanceEnabled?: boolean;
  accountSettings?: AccountSettings | null;
  pendingQueueDrainMaxPopPerWake?: number;
  getPermissionMode?: (() => PermissionMode | null | undefined)
    | CatalogBackedAcpProviderRuntimeParams<TBackendOptions>['getPermissionMode']
    | CustomBackedAcpProviderRuntimeParams<TBackendOptions>['getPermissionMode'];
  resolvePermissionMode?:
    | CatalogBackedAcpProviderRuntimeParams<TBackendOptions>['resolvePermissionMode']
    | CustomBackedAcpProviderRuntimeParams<TBackendOptions>['resolvePermissionMode'];
  backendOptions?: CatalogBackedAcpProviderRuntimeParams<TBackendOptions>['backendOptions'];
  createBackend?: CustomBackedAcpProviderRuntimeParams<TBackendOptions>['createBackend'];
  createReplayBackend?: CustomBackedAcpProviderRuntimeParams<TBackendOptions>['createReplayBackend'];
  inFlightSteer?:
    | CatalogBackedAcpProviderRuntimeParams<TBackendOptions>['inFlightSteer']
    | CustomBackedAcpProviderRuntimeParams<TBackendOptions>['inFlightSteer'];
  hooks?:
    | CatalogBackedAcpProviderRuntimeParams<TBackendOptions>['hooks']
    | CustomBackedAcpProviderRuntimeParams<TBackendOptions>['hooks'];
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

    if (params.agentId && params.vendorResumeIdField) {
      return createProviderSessionIdentityPublisher({
        agentId: params.agentId,
        session: params.session,
        vendorResumeIdField: params.vendorResumeIdField,
        lastPublished: lastPublishedSessionId,
      });
    }

    return null;
  })();

  const runtimeBase = {
    loggerLabel: params.loggerLabel,
    directory: params.directory,
    session: params.session,
    transcriptSession: params.transcriptSession,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    getPermissionMode: params.getPermissionMode,
    accountSettings: params.accountSettings,
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    ...(params.resolvePermissionMode ? { resolvePermissionMode: params.resolvePermissionMode } : {}),
    ...(params.inFlightSteer ? { inFlightSteer: params.inFlightSteer } : {}),
    ...(params.hooks ? { hooks: params.hooks } : {}),
    ...(publishSessionIdentity ? { onSessionIdChange: publishSessionIdentity } : {}),
  } satisfies Omit<
    CatalogBackedAcpProviderRuntimeParams<TBackendOptions>,
    'provider' | 'backendOptions'
  >;

  if (params.createBackend) {
    return createCatalogProviderAcpRuntime<TBackendOptions>({
      provider: params.provider,
      ...runtimeBase,
      createBackend: params.createBackend,
      ...(params.createReplayBackend ? { createReplayBackend: params.createReplayBackend } : {}),
    });
  }

  return createCatalogProviderAcpRuntime<TBackendOptions>({
    provider: params.provider as CatalogBackedAcpProviderRuntimeParams<TBackendOptions>['provider'],
    ...runtimeBase,
    ...(params.backendOptions ? { backendOptions: params.backendOptions } : {}),
  });
}
