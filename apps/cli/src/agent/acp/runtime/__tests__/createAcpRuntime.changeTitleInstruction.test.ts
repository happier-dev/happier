import { describe, expect, it } from 'vitest';

import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient } from '@/testkit/backends/sessionFixtures';
import { createAcpRuntime } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

describe('createAcpRuntime (shared prompt ownership)', () => {
  it('does not append the shared change-title instruction in native-mcp runtime prompts', async () => {
    const captured = { prompts: [] as string[] };
    const backend = createFakeAcpRuntimeBackend({
      sendPrompt: async (_sessionId, prompt) => {
        captured.prompts.push(prompt);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
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
    const backend = createFakeAcpRuntimeBackend({
      sendPrompt: async (_sessionId, prompt) => {
        captured.prompts.push(prompt);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      changeTitleInstruction: { enabled: false },
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    await runtime.sendPrompt('Hello');

    expect(captured.prompts).toHaveLength(1);
    expect(captured.prompts[0]).toBe('Hello');
  });

  it('still forwards raw user prompts unchanged for shell-bridge providers', async () => {
    const captured = { prompts: [] as string[] };
    const backend = createFakeAcpRuntimeBackend({
      sendPrompt: async (_sessionId, prompt) => {
        captured.prompts.push(prompt);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp/workspace',
      happierSessionId: 'happy_session_123',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
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

  it('still forwards raw user prompts unchanged when memory recall guidance is enabled', async () => {
    const captured = { prompts: [] as string[] };
    const backend = createFakeAcpRuntimeBackend({
      sendPrompt: async (_sessionId, prompt) => {
        captured.prompts.push(prompt);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp/workspace',
      happierSessionId: 'happy_session_123',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
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
    expect(captured.prompts[0]).toBe('Do you remember helios-amber?');
  });
});
