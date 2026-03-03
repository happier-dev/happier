import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { createAcpRuntime, type AcpRuntimeBackend } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

function createFakeBackend(captured: { prompts: string[] }) {
  let handler: ((msg: AgentMessage) => void) | null = null;
  const backend = {
    onMessage(fn: (msg: AgentMessage) => void) {
      handler = fn;
    },
    async startSession() {
      return { sessionId: 'sess_main' };
    },
    async sendPrompt(_sessionId: string, prompt: string) {
      captured.prompts.push(prompt);
      void handler;
    },
    async cancel() {},
    async dispose() {},
  };
  return backend as unknown as AcpRuntimeBackend;
}

describe('createAcpRuntime (change title instruction)', () => {
  it('appends CHANGE_TITLE_INSTRUCTION to the first prompt only', async () => {
    const captured = { prompts: [] as string[] };
    const backend = createFakeBackend(captured);

    const session: AcpRuntimeSessionClient = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' }),
    };

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    await runtime.sendPrompt('Hello');
    await runtime.sendPrompt('Next');

    expect(captured.prompts).toHaveLength(2);
    expect(captured.prompts[0]).toContain('Hello');
    expect(captured.prompts[0]).toContain(CHANGE_TITLE_INSTRUCTION);
    expect(captured.prompts[1]).toBe('Next');
  });
});

