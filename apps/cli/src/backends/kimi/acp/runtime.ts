import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderSessionIdentityRuntime } from '@/agent/acp/runtime/createProviderSessionIdentityRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import type { PermissionMode } from '@/api/types';

export function createKimiAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  transcriptSession?: TranscriptSessionPort;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  memoryRecallGuidanceEnabled?: boolean;
  getPermissionMode?: () => PermissionMode | null | undefined;
}) {
  return createCatalogProviderSessionIdentityRuntime({
    provider: 'kimi',
    loggerLabel: 'KimiACP',
    sessionIdMetadataKey: 'kimiSessionId',
    directory: params.directory,
    machineId: params.machineId,
    session: params.session,
    transcriptSession: params.transcriptSession,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled,
    getPermissionMode: params.getPermissionMode,
    resolvePermissionMode: ({ getPermissionMode, session }) =>
      getPermissionMode?.() ?? session.getMetadataSnapshot?.()?.permissionMode,
  });
}
