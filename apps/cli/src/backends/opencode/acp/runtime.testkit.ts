import { vi } from 'vitest';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import * as acpModule from '@/agent/acp';
import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

export type OpenCodeRuntimeCreateCall = {
  agentId: string;
  permissionMode: PermissionMode | null | undefined;
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

export function createOpenCodeCatalogBackendSpy(createCalls: OpenCodeRuntimeCreateCall[]) {
  return vi.spyOn(acpModule, 'createCatalogAcpBackend').mockImplementation(async (agentId, opts) => {
    const catalogOpts = (opts ?? {}) as { permissionMode?: PermissionMode | null };
    createCalls.push({
      agentId,
      permissionMode: catalogOpts.permissionMode,
    });
    return {
      backend: createFakeBackend(createCalls.length),
    } as unknown as Awaited<ReturnType<typeof acpModule.createCatalogAcpBackend>>;
  });
}

export function createOpenCodeSessionFixture(): ApiSessionClient {
  return {
    keepAlive() {},
    sendAgentMessage() {},
    async sendAgentMessageCommitted() {},
    async sendUserTextMessageCommitted() {},
    updateMetadata() {},
    async fetchRecentTranscriptTextItemsForAcpImport() {
      return [];
    },
    getMetadataSnapshot() {
      return null;
    },
  } as unknown as ApiSessionClient;
}

export function createOpenCodePermissionHandlerFixture(): AcpPermissionHandler {
  return {
    handleToolCall: async () => ({ decision: 'approved' }),
  };
}

export function createOpenCodeMessageBufferFixture(): MessageBuffer {
  return new MessageBuffer();
}
