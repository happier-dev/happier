import { describe, expect, it, vi } from 'vitest';

import * as acpCatalog from '@/agent/acp';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AuggieBackendOptions } from './backend';

type CreateCall = { agentId: string; opts: AuggieBackendOptions };

const createCalls: CreateCall[] = [];

function makeFakeBackend(id: string): AgentBackend {
  const handlers: AgentMessageHandler[] = [];
  return {
    async startSession() {
      return { sessionId: `session-${id}` };
    },
    async sendPrompt() {},
    async cancel() {},
    onMessage(handler: AgentMessageHandler) {
      handlers.push(handler);
    },
    async dispose() {
      handlers.length = 0;
    },
  };
}

type SessionStubContract = Pick<
  ApiSessionClient,
  | 'sendAgentMessageCommitted'
  | 'sendUserTextMessageCommitted'
  | 'fetchRecentTranscriptTextItemsForAcpImport'
  | 'updateMetadata'
  | 'keepAlive'
  | 'sendAgentMessage'
>;

function createSessionStub(): ApiSessionClient {
  const stub: SessionStubContract = {
    sendAgentMessageCommitted: async () => {},
    sendUserTextMessageCommitted: async () => {},
    fetchRecentTranscriptTextItemsForAcpImport: async () => [],
    updateMetadata: () => {},
    keepAlive: () => {},
    sendAgentMessage: () => {},
  };
  return stub as ApiSessionClient;
}

describe('Auggie ACP runtime permission mode wiring', () => {
  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    createCalls.length = 0;
    let permissionMode: PermissionMode = 'default';
    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' }),
    };

    const createCatalogSpy = vi
      .spyOn(acpCatalog, 'createCatalogAcpBackend')
      .mockImplementation(async (agentId, opts) => {
        createCalls.push({ agentId: String(agentId), opts: opts as AuggieBackendOptions });
        return { backend: makeFakeBackend(String(createCalls.length)) } as never;
      });

    try {
      const { createAuggieAcpRuntime } = await import('./runtime');
      const runtime = createAuggieAcpRuntime({
        directory: '/tmp',
        session: createSessionStub(),
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler,
        onThinkingChange() {},
        allowIndexing: false,
        getPermissionMode: () => permissionMode,
      });

      await runtime.startOrLoad({});
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]?.agentId).toBe('auggie');
      expect(createCalls[0]?.opts?.permissionMode).toBe('default');

      permissionMode = 'yolo';
      await runtime.reset();
      await runtime.startOrLoad({});
      expect(createCalls).toHaveLength(2);
      expect(createCalls[1]?.opts?.permissionMode).toBe('yolo');
    } finally {
      createCatalogSpy.mockRestore();
    }
  });
});
