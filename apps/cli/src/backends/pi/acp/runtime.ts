import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import type { PiBackendOptions } from '@/backends/pi/acp/backend';
import { publishPiSessionIdMetadata } from '@/backends/pi/utils/piSessionIdMetadata';
import { resolvePiSessionIdFromResumeReference } from '@/backends/pi/utils/piSessionFiles';

export function createPiAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  getSessionOpenAbortSignal?: () => AbortSignal | undefined;
  memoryRecallGuidanceEnabled?: boolean;
  getPermissionMode?: () => PermissionMode | null | undefined;
  pendingQueueDrainMaxPopPerWake?: number;
  providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
}) {
  const lastPublishedPiSessionId: { value: string | null; sessionFile?: string | null } = { value: null };
  let lastPiIdentityGeneration: number | null = null;

  return createCatalogProviderAcpRuntime<PiBackendOptions>({
    provider: 'pi',
    loggerLabel: 'PiACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    sessionIdentity: {
      kind: 'custom',
      persistBound: async (event) => {
        if (lastPiIdentityGeneration !== event.generation) {
          lastPublishedPiSessionId.value = null;
          lastPublishedPiSessionId.sessionFile = null;
          lastPiIdentityGeneration = event.generation;
        }
        await publishPiSessionIdMetadata({
          operation: event.operation,
          session: params.session,
          getPiSessionId: () => event.vendorSessionId,
          cwd: params.directory,
          processEnv: process.env,
          lastPublished: lastPublishedPiSessionId,
        });
      },
    },
    resolveExpectedVendorSessionIdForResume: resolvePiSessionIdFromResumeReference,
    onThinkingChange: params.onThinkingChange,
    getSessionOpenAbortSignal: params.getSessionOpenAbortSignal,
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    getPermissionMode: params.getPermissionMode,
    backendOptions: {
      env: process.env,
    },
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    providerInputConsumer: params.providerInputConsumer,
    inFlightSteer: { enabled: true },
  });
}
