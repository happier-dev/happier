import { vi } from 'vitest';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import * as acpModule from '@/agent/acp';
import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

export type KimiRuntimeCreateCall = {
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

export function createKimiCatalogBackendSpy(createCalls: KimiRuntimeCreateCall[]) {
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

export function createKimiSessionFixture(opts?: {
  metadataPermissionMode?: PermissionMode;
}): ApiSessionClient {
  const metadata = opts?.metadataPermissionMode
    ? createTestMetadata({ permissionMode: opts.metadataPermissionMode })
    : null;

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
      return metadata;
    },
  } as unknown as ApiSessionClient;
}

export function createKimiPermissionHandlerFixture(): AcpPermissionHandler {
  return {
    handleToolCall: async () => ({ decision: 'approved' }),
  };
}

export function createKimiMessageBufferFixture(): MessageBuffer {
  return new MessageBuffer();
}
