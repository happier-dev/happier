import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { CodexAcpBackendOptions, CodexAcpBackendResult } from './backend';

const createCalls: Array<{ opts: CodexAcpBackendOptions }> = [];

function makeFakeBackend(id: string) {
  const handlers: AgentMessageHandler[] = [];
  const backend: AgentBackend = {
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
  return backend;
}

vi.mock('@/backends/codex/acp/backend', async () => {
  const actual = await vi.importActual<typeof import('./backend')>('@/backends/codex/acp/backend');
  return {
    ...actual,
    createCodexAcpBackend: (opts: CodexAcpBackendOptions): CodexAcpBackendResult => {
      createCalls.push({ opts });
      return {
        backend: makeFakeBackend(String(createCalls.length)),
        spawn: { command: 'codex-acp', args: [] },
      };
    },
  };
});

describe('Codex ACP runtime permission mode wiring', () => {
  it('forwards permissionMode to createCodexAcpBackend and recreates backend after reset', async () => {
    createCalls.length = 0;
    let permissionMode: 'default' | 'yolo' = 'default';

    const session: Pick<ApiSessionClient, 'sendAgentMessage' | 'updateMetadata' | 'keepAlive'> = {
      sendAgentMessage(_provider, _body, _opts) {},
      async updateMetadata(_handler) {},
      keepAlive(_thinking, _mode) {},
    };
    const messageBuffer: Pick<MessageBuffer, 'addMessage' | 'removeLastMessage' | 'updateLastMessage'> = {
      addMessage(_content, _type) {},
      removeLastMessage(_type) {
        return false;
      },
      updateLastMessage(_contentDelta, _type) {},
    };
    const permissionHandler: Pick<AcpPermissionHandler, 'handleToolCall'> = {
      handleToolCall: async (_toolCallId, _toolName, _input) => ({ decision: 'approved' }),
    };

    const { createCodexAcpRuntime } = await import('./runtime');
    const runtime = createCodexAcpRuntime({
      directory: '/tmp',
      session: session as ApiSessionClient,
      messageBuffer: messageBuffer as MessageBuffer,
      mcpServers: {},
      permissionHandler: permissionHandler as AcpPermissionHandler,
      onThinkingChange() {},
      permissionMode,
      getPermissionMode: () => permissionMode,
    });

    await runtime.startOrLoad({});
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.opts?.permissionMode).toBe('default');

    permissionMode = 'yolo';
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]?.opts?.permissionMode).toBe('yolo');
  });
});
