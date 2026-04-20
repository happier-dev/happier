import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';

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

    async callTool(request: unknown, resultSchema?: unknown, options?: unknown) {
      return await callToolMock(request, resultSchema, options);
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
  const envKeys = [
    'HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS',
    'HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(() => {
    connectMock.mockReset();
    callToolMock.mockReset();
    closeMock.mockReset();
    stderrResumeMock.mockReset();
    constructedTransports.length = 0;
  });

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
  });

  it('pipes and drains child stderr before calling the MCP tool', async () => {
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    delete process.env.HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS;
    delete process.env.HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS;
    reloadConfiguration();

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
    expect(callToolMock).toHaveBeenCalledWith(
      { name: 'get_marker', arguments: {} },
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    const requestOptions = callToolMock.mock.calls[0]?.[2] as { timeout?: unknown } | undefined;
    expect(typeof requestOptions?.timeout).toBe('number');
    expect(requestOptions?.timeout).toBeGreaterThan(60_000);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('aligns execution_run_wait MCP request timeout with the requested wait duration', async () => {
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
    process.env.HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS = '180000';
    process.env.HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS = '45000';
    reloadConfiguration();

    const { callResolvedCustomHappierTool } = await import('./callResolvedCustomHappierTool');

    await callResolvedCustomHappierTool({
      source: 'qa_marker_stdio_20260306',
      toolName: 'execution_run_wait',
      args: { runId: 'run_123', timeoutSeconds: 120 },
      mcpServers: {
        qa_marker_stdio_20260306: { command: 'ok-server', args: ['--stdio'] },
      },
      processEnv: {
        PATH: '/usr/bin',
      },
    });

    expect(callToolMock).toHaveBeenCalledWith(
      { name: 'execution_run_wait', arguments: { runId: 'run_123', timeoutSeconds: 120 } },
      undefined,
      expect.objectContaining({ timeout: 165_000 }),
    );
  });
});
