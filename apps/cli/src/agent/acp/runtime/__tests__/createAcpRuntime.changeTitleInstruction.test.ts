import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
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

describe('createAcpRuntime (shared prompt ownership)', () => {
  it('does not append the shared change-title instruction in native-mcp runtime prompts', async () => {
    const captured = { prompts: [] as string[] };
    const backend = createFakeBackend(captured);

    const session: AcpRuntimeSessionClient = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendTranscriptDraftDelta: () => {},
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
    expect(captured.prompts[0]).toBe('Hello');
    expect(captured.prompts[1]).toBe('Next');
  });

  it('still leaves native-mcp prompts unchanged when the legacy change-title toggle is disabled', async () => {
    const captured = { prompts: [] as string[] };
    const backend = createFakeBackend(captured);

    const session: AcpRuntimeSessionClient = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendTranscriptDraftDelta: () => {},
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' }),
    };

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: () => {},
      changeTitleInstruction: { enabled: false },
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    await runtime.sendPrompt('Hello');

    expect(captured.prompts).toHaveLength(1);
    expect(captured.prompts[0]).toBe('Hello');
  });

  it('appends shell bridge guidance on every prompt for shell-bridge providers', async () => {
    const captured = { prompts: [] as string[] };
    const backend = createFakeBackend(captured);

    const session: AcpRuntimeSessionClient = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendTranscriptDraftDelta: () => {},
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' }),
    };

    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp/workspace',
      happierSessionId: 'happy_session_123',
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
    expect(captured.prompts[0]).toContain('--session-id');
    expect(captured.prompts[0]).toContain('happy_session_123');
    expect(captured.prompts[0]).not.toContain('sess_main');
    expect(captured.prompts[1]).toBe('Next');
  });

  it('includes memory recall shell-bridge guidance when local memory is usable', async () => {
    const captured = { prompts: [] as string[] };
    const backend = createFakeBackend(captured);

    const session: AcpRuntimeSessionClient = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendTranscriptDraftDelta: () => {},
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' }),
    };

    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp/workspace',
      happierSessionId: 'happy_session_123',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: () => {},
      memoryRecallGuidance: {
        enabled: true,
        machineId: 'machine-123',
      },
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.sendPrompt('Do you remember helios-amber?');

    expect(captured.prompts).toHaveLength(1);
    expect(captured.prompts[0]).toContain('For recall questions about earlier conversations');
    expect(captured.prompts[0]).toContain('memory_search');
    expect(captured.prompts[0]).toContain('memory_get_window');
    expect(captured.prompts[0]).toContain('machine-123');
    expect(captured.prompts[0]).toContain('Do not use provider-native memory files');
  });
});
