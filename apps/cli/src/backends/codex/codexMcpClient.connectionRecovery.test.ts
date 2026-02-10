import { beforeEach, describe, expect, it, vi } from 'vitest';

type ClientCall = {
  name: string;
  arguments: Record<string, unknown>;
};

const connectSpy = vi.fn(async () => {});
const closeSpy = vi.fn(async () => {});
const callToolSpy = vi.fn(async (_call: ClientCall) => ({
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: { threadId: 'thread-1' },
}));
const createdClientIds: number[] = [];
const staleClientIds = new Set<number>();
let nextClientId = 1;

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('./mcp/elicitationHandler', () => ({
  registerCodexPermissionHandlers: vi.fn(),
}));

vi.mock('./mcp/client', () => ({
  createCodexTransport: vi.fn(() => ({
    transport: {
      pid: null,
      close: vi.fn(async () => {}),
    },
    versionInfo: {
      command: 'codex',
      mcpCommand: 'mcp-server',
      source: 'detected',
      version: null,
    },
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class Client {
    private readonly __id: number;

    constructor() {
      this.__id = nextClientId++;
      createdClientIds.push(this.__id);
    }
    setNotificationHandler() {}
    setRequestHandler() {}
    async connect() {
      await connectSpy();
    }
    async close() {
      staleClientIds.add(this.__id);
      await closeSpy();
    }
    async callTool(call: ClientCall) {
      if (staleClientIds.has(this.__id)) {
        throw new Error('stale client instance cannot call tools after close');
      }
      return await callToolSpy(call);
    }
  }
  return { Client };
});

describe('CodexMcpClient connection recovery', () => {
  beforeEach(() => {
    connectSpy.mockClear();
    closeSpy.mockClear();
    callToolSpy.mockReset();
    createdClientIds.length = 0;
    staleClientIds.clear();
    nextClientId = 1;
  });

  it('reconnects and retries continueSession once when MCP transport is closed', async () => {
    callToolSpy
      .mockRejectedValueOnce(Object.assign(new Error('MCP error -32000: Connection closed'), { code: -32000 }))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Recovered' }],
        structuredContent: { threadId: 'thread-1' },
      });

    const { CodexMcpClient } = await import('./codexMcpClient');
    const client = new CodexMcpClient();
    client.setThreadIdForResume('thread-1');

    const response = await client.continueSession('hello after idle drop');

    expect(response).toEqual({
      content: [{ type: 'text', text: 'Recovered' }],
      structuredContent: { threadId: 'thread-1' },
    });
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(callToolSpy).toHaveBeenCalledTimes(2);
    expect(callToolSpy.mock.calls[0]?.[0]).toMatchObject({ name: 'codex-reply' });
    expect(callToolSpy.mock.calls[1]?.[0]).toMatchObject({ name: 'codex-reply' });
    expect(createdClientIds).toEqual([1, 2]);
  });

  it('reconnects and retries continueSession once when SDK reports Not connected', async () => {
    callToolSpy
      .mockRejectedValueOnce(new Error('Not connected'))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Recovered from not-connected' }],
        structuredContent: { threadId: 'thread-1' },
      });

    const { CodexMcpClient } = await import('./codexMcpClient');
    const client = new CodexMcpClient();
    client.setThreadIdForResume('thread-1');

    const response = await client.continueSession('hello after stale sdk state');

    expect(response).toEqual({
      content: [{ type: 'text', text: 'Recovered from not-connected' }],
      structuredContent: { threadId: 'thread-1' },
    });
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(callToolSpy).toHaveBeenCalledTimes(2);
    expect(createdClientIds).toEqual([1, 2]);
  });

  it('reconnects and retries continueSession once when MCP returns abort-style -32001 error', async () => {
    callToolSpy
      .mockRejectedValueOnce(
        Object.assign(new Error('MCP error -32001: AbortError: This operation was aborted'), { code: -32001 }),
      )
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Recovered after abort-style MCP error' }],
        structuredContent: { threadId: 'thread-1' },
      });

    const { CodexMcpClient } = await import('./codexMcpClient');
    const client = new CodexMcpClient();
    client.setThreadIdForResume('thread-1');

    const response = await client.continueSession('hello after permission-deny abort');

    expect(response).toEqual({
      content: [{ type: 'text', text: 'Recovered after abort-style MCP error' }],
      structuredContent: { threadId: 'thread-1' },
    });
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(callToolSpy).toHaveBeenCalledTimes(2);
    expect(createdClientIds).toEqual([1, 2]);
  });
});
