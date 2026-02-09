import { vi } from 'vitest';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import * as acpModule from '@/agent/acp';
import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

export type QwenRuntimeCreateCall = {
  agentId: string;
  permissionMode: PermissionMode | undefined;
};

function createFakeBackend(id: number): AgentBackend {
  let onMessageHandler: AgentMessageHandler | null = null;

  return {
    async startSession() {
      return { sessionId: `session-${id}` };
    },
    async sendPrompt() {},
    async cancel() {},
    onMessage(handler) {
      onMessageHandler = handler;
    },
    async dispose() {
      onMessageHandler = null;
    },
  };
}

export function createQwenCatalogBackendSpy(createCalls: QwenRuntimeCreateCall[]) {
  return vi.spyOn(acpModule, 'createCatalogAcpBackend').mockImplementation(async (agentId, opts) => {
    const catalogOpts = (opts ?? {}) as { permissionMode?: PermissionMode };
    createCalls.push({
      agentId,
      permissionMode: catalogOpts.permissionMode,
    });
    return {
      backend: createFakeBackend(createCalls.length),
    } as unknown as Awaited<ReturnType<typeof acpModule.createCatalogAcpBackend>>;
  });
}

export function createQwenSessionFixture(): ApiSessionClient {
  return {
    keepAlive() {},
    sendAgentMessage() {},
    async sendAgentMessageCommitted() {},
    async sendUserTextMessageCommitted() {},
    updateMetadata() {},
    async fetchRecentTranscriptTextItemsForAcpImport() {
      return [];
    },
  } as unknown as ApiSessionClient;
}

export function createQwenPermissionHandlerFixture(): AcpPermissionHandler {
  return {
    handleToolCall: async () => ({ decision: 'approved' }),
  };
}

export function createQwenMessageBufferFixture(): MessageBuffer {
  return new MessageBuffer();
}
