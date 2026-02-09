import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import * as acpModule from '@/agent/acp';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { Metadata, PermissionMode } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createKiloAcpRuntime } from './runtime';

type CreateCall = {
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

function createSessionFixture(): AcpRuntimeSessionClient {
  return {
    keepAlive() {},
    sendAgentMessage() {},
    async sendAgentMessageCommitted() {},
    async sendUserTextMessageCommitted() {},
    updateMetadata(_updater: (metadata: Metadata) => Metadata) {},
    async fetchRecentTranscriptTextItemsForAcpImport() {
      return [];
    },
  };
}

describe('Kilo ACP runtime permission mode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: CreateCall[] = [];
    const createSpy = vi.spyOn(acpModule, 'createCatalogAcpBackend')
      .mockImplementation(async (agentId, opts) => {
        const catalogOpts = (opts ?? {}) as { permissionMode?: PermissionMode | null };
        createCalls.push({
          agentId,
          permissionMode: catalogOpts.permissionMode,
        });
        return {
          backend: createFakeBackend(createCalls.length),
        } as unknown as Awaited<ReturnType<typeof acpModule.createCatalogAcpBackend>>;
      });

    let permissionMode: PermissionMode = 'default';
    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' }),
    };

    const runtime = createKiloAcpRuntime({
      directory: '/tmp',
      session: createSessionFixture() as unknown as ApiSessionClient,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: () => {},
      getPermissionMode: () => permissionMode,
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls).toEqual([
      { agentId: 'kilo', permissionMode: 'default' },
    ]);

    permissionMode = 'read-only';
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls[1]).toEqual({ agentId: 'kilo', permissionMode: 'read-only' });
  });
});
