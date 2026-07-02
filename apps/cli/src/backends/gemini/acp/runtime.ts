import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderSessionIdentityRuntime } from '@/agent/acp/runtime/createProviderSessionIdentityRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { PermissionMode } from '@/api/types';
import type { AccountSettings } from '@happier-dev/protocol';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { GeminiDiffProcessor } from '@/backends/gemini/utils/diffProcessor';
import type { GeminiBackendOptions } from '@/backends/gemini/acp/backend';

function isStreamingChunk(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return r._stream === true || typeof r.stdoutChunk === 'string' || typeof r.stderrChunk === 'string';
}

function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(result as Record<string, unknown>, 'error');
}

export function createGeminiAcpRuntime(params: {
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
  backendOptions?: {
    currentUserEmail?: string;
    model?: string | null;
  };
}) {
  void params.machineId;

  const diffProcessor = new GeminiDiffProcessor();

  return createCatalogProviderSessionIdentityRuntime<GeminiBackendOptions>({
    provider: 'gemini',
    agentId: 'gemini',
    vendorResumeIdField: 'geminiSessionId',
    loggerLabel: 'GeminiACP',
    directory: params.directory,
    machineId: params.machineId,
    session: params.session,
    transcriptSession: params.transcriptSession,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled,
    accountSettings: params.accountSettings,
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    getPermissionMode: params.getPermissionMode,
    backendOptions: params.backendOptions,
    hooks: {
      onBeginTurn: () => {
        diffProcessor.reset();
      },
      onToolResult: ({ toolName, callId, result }) => {
        if (isStreamingChunk(result) || isToolResultError(result)) return;
        diffProcessor.processToolResult(toolName, result, callId);
      },
      onBeforeFlushTurn: ({ sendToolCall, sendToolResult }) => {
        diffProcessor.setMessageCallback((msg: any) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'tool-call') {
            sendToolCall({ toolName: msg.name, input: msg.input, callId: msg.callId });
            return;
          }
          if (msg.type === 'tool-call-result') {
            sendToolResult({ callId: msg.callId, output: msg.output });
          }
        });
        diffProcessor.flushTurn();
      },
    },
  });
}
