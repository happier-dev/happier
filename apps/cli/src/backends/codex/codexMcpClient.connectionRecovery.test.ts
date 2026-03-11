import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_CODEX_PATH: process.env.HAPPIER_CODEX_PATH,
};
const TEMP_DIRS = new Set<string>();

function createFakeCodexBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-client-'));
  TEMP_DIRS.add(dir);
  const isWindows = process.platform === 'win32';
  const binPath = join(dir, isWindows ? 'codex.cmd' : 'codex');
  writeFileSync(binPath, isWindows ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
  if (!isWindows) chmodSync(binPath, 0o755);
  return binPath;
}

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
    process.env.PATH = '';
    process.env.HAPPIER_CODEX_PATH = createFakeCodexBinary();
    connectSpy.mockClear();
    closeSpy.mockClear();
    callToolSpy.mockReset();
    createdClientIds.length = 0;
    staleClientIds.clear();
    nextClientId = 1;
  });

  afterEach(() => {
    if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = ORIGINAL_ENV.PATH;
    if (ORIGINAL_ENV.HAPPIER_CODEX_PATH === undefined) delete process.env.HAPPIER_CODEX_PATH;
    else process.env.HAPPIER_CODEX_PATH = ORIGINAL_ENV.HAPPIER_CODEX_PATH;
    for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
    TEMP_DIRS.clear();
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
