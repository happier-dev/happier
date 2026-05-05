import { describe, expect, it, vi } from 'vitest';

import { createCodexMcpRuntime } from './createMcpRuntime';

const mocks = vi.hoisted(() => {
  class TestCodexMcpClient {
    public handler: ((message: unknown) => void) | null = null;
    public readonly setPermissionHandler = vi.fn();
    public readonly connect = vi.fn(async () => undefined);
    public readonly hasActiveSession = vi.fn(() => true);
    public readonly startSession = vi.fn(async () => ({}));
    public readonly continueSession = vi.fn(async () => ({}));
    public readonly clearSession = vi.fn();
    public readonly forceCloseSession = vi.fn(async () => undefined);
    public readonly getSessionId = vi.fn(() => 'codex-session-id');

    constructor() {
      mocks.clients.push(this);
    }

    setHandler(handler: (message: unknown) => void): void {
      this.handler = handler;
    }
  }

  return {
    clients: [] as TestCodexMcpClient[],
    TestCodexMcpClient,
  };
});

vi.mock('../../mcp/sessionClient', () => ({
  CodexMcpClient: mocks.TestCodexMcpClient,
}));

vi.mock('../../mcp/resolveCodexMcpServerSpawn', () => ({
  resolveCodexMcpServerSpawn: vi.fn(async () => ({ mode: 'stdio', command: ['codex'] })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('createCodexMcpRuntime', () => {
  it('publishes Codex MCP messages to runtime subscribers', async () => {
    mocks.clients.length = 0;
    const runtime = await createCodexMcpRuntime({
      session: {
        sendCodexMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        keepAlive: vi.fn(),
      },
      messageBuffer: { addMessage: vi.fn() },
      permissionHandler: {},
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      mcpServers: {},
      directory: '/tmp/project',
    } as never);
    const messages: unknown[] = [];
    runtime.subscribeRuntimeMessages((message) => {
      messages.push(message);
    });

    mocks.clients[0]?.handler?.({ type: 'task_started', id: 'codex-turn' });

    expect(messages).toEqual([{ type: 'task_started', id: 'codex-turn' }]);
  });
});
