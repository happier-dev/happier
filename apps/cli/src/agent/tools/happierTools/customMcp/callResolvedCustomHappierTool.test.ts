import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectMock = vi.fn();
const callToolMock = vi.fn();
const closeMock = vi.fn();
const stderrResumeMock = vi.fn();
const constructedTransports: Array<{ command: string; stderr?: string }> = [];

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    async connect(transport: { command: string }) {
      return await connectMock(transport);
    }

    async callTool(request: unknown) {
      return await callToolMock(request);
    }

    async close() {
      return await closeMock();
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    command: string;
    args: string[];
    env: Record<string, string>;
    stderr = { resume: stderrResumeMock };

    constructor(config: { command: string; args?: string[]; env?: Record<string, string>; stderr?: string }) {
      this.command = config.command;
      this.args = config.args ?? [];
      this.env = config.env ?? {};
      constructedTransports.push({ command: this.command, stderr: config.stderr });
    }
  },
}));

describe('callResolvedCustomHappierTool', () => {
  beforeEach(() => {
    connectMock.mockReset();
    callToolMock.mockReset();
    closeMock.mockReset();
    stderrResumeMock.mockReset();
    constructedTransports.length = 0;
  });

  it('pipes and drains child stderr before calling the MCP tool', async () => {
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const { callResolvedCustomHappierTool } = await import('./callResolvedCustomHappierTool');

    const result = await callResolvedCustomHappierTool({
      source: 'qa_marker_stdio_20260306',
      toolName: 'get_marker',
      args: {},
      mcpServers: {
        qa_marker_stdio_20260306: { command: 'ok-server', args: ['--stdio'], env: { TOKEN: '1' } },
      },
      processEnv: { PATH: '/usr/bin' },
    });

    expect(result).toEqual({
      ok: true,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
    expect(constructedTransports).toEqual([{ command: 'ok-server', stderr: 'pipe' }]);
    expect(stderrResumeMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledWith({ name: 'get_marker', arguments: {} });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
