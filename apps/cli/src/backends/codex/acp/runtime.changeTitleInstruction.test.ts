import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { CodexAcpBackendOptions, CodexAcpBackendResult } from './backend';

const captured: { prompts: string[] } = { prompts: [] };

function makeFakeBackend() {
  const handlers: AgentMessageHandler[] = [];
  const backend: AgentBackend = {
    async startSession() {
      return { sessionId: 'session-1' };
    },
    async sendPrompt(_sessionId, prompt) {
      captured.prompts.push(prompt);
    },
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
    createCodexAcpBackend: (_opts: CodexAcpBackendOptions): CodexAcpBackendResult => {
      return {
        backend: makeFakeBackend(),
        spawn: { command: 'codex-acp', args: [] },
      };
    },
  };
});

describe('Codex ACP runtime (change title instruction)', () => {
  it('does not append internal change title instruction to user prompts', async () => {
    captured.prompts.length = 0;

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
      permissionMode: 'default',
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.sendPrompt('Hello');

    expect(captured.prompts).toEqual(['Hello']);
  });
});

