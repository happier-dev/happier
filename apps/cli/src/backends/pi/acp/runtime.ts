import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { Metadata, PermissionMode } from '@/api/types';
import type { AccountSettings } from '@happier-dev/protocol';
import {
  maybeUpdatePiSessionIdMetadata,
  type PublishedPiSessionMetadata,
} from '@happier-dev/plugins-pi/agent/sessionMetadata';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

export function createPiAcpRuntime(params: {
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
  getPermissionMode?: () => PermissionMode | null | undefined;
}) {
  const lastPublishedPiSessionMetadata = { value: null as PublishedPiSessionMetadata | null };

  return createCatalogProviderAcpRuntime({
    provider: 'pi',
    loggerLabel: 'PiACP',
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
    accountSettings: params.accountSettings,
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    getPermissionMode: params.getPermissionMode,
    inFlightSteer: { enabled: true },
    onSessionIdChange: (nextSessionId) => {
      maybeUpdatePiSessionIdMetadata<Metadata>({
        getPiSessionId: () => nextSessionId,
        getPiSessionFile: () => null,
        updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
        lastPublished: lastPublishedPiSessionMetadata,
      });
    },
  });
}
