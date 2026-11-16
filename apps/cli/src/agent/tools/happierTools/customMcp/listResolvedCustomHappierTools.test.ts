import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const connectMock = vi.fn();
const listToolsMock = vi.fn();
const closeMock = vi.fn();

// Failure is injected at the external SDK connection boundary; the transport
// and subprocess cleanup use their production owners.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    transport?: Transport;
    async connect(transport: Transport) {
      this.transport = transport;
      await transport.start();
      return await connectMock(transport);
    }

    async listTools() {
      return await listToolsMock();
    }

    async close() {
      await this.transport?.close();
      return await closeMock();
    }
  },
}));

describe('listResolvedCustomHappierTools', () => {
  beforeEach(() => {
    connectMock.mockReset();
    listToolsMock.mockReset();
    closeMock.mockReset();
  });

  it('skips failed MCP sources and keeps listing remaining tools', async () => {
    connectMock.mockRejectedValueOnce(new Error('Connection closed'));

    listToolsMock.mockResolvedValue({
      tools: [{ name: 'get_marker', description: 'Read QA marker', inputSchema: { type: 'object' } }],
    });

    const { listResolvedCustomHappierTools } = await import('./listResolvedCustomHappierTools');

    const result = await listResolvedCustomHappierTools({
      mcpServers: {
        failing: { command: process.execPath, args: ['-e', 'process.stdin.resume()'] },
        qa_marker_stdio_20260306: { command: process.execPath, args: ['-e', 'process.stdin.resume()'] },
      },
      processEnv: {},
    });

    expect(result.tools).toEqual([
      expect.objectContaining({
        source: 'qa_marker_stdio_20260306',
        name: 'get_marker',
        description: 'Read QA marker',
      }),
    ]);
    expect(result.warnings).toEqual([
      {
        source: 'failing',
        error: 'Connection closed',
      },
    ]);
    expect(closeMock).toHaveBeenCalledTimes(2);
  });
});
