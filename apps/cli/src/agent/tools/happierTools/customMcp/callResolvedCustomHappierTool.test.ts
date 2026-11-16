import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const connectMock = vi.fn();
const callToolMock = vi.fn();
const closeMock = vi.fn();

// The external SDK request boundary captures timeout options; transport and OS
// process supervision remain real, including physical close on cleanup.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    transport?: Transport;
    async connect(transport: Transport) {
      this.transport = transport;
      await transport.start();
      return await connectMock(transport);
    }

    async callTool(request: unknown, resultSchema?: unknown, options?: unknown) {
      return await callToolMock(request, resultSchema, options);
    }

    async close() {
      await this.transport?.close();
      return await closeMock();
    }
  },
}));

describe('callResolvedCustomHappierTool', () => {
  const envKeys = [
    'HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS',
    'HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  // These existing tests characterize stdio/request timeouts, not Account
  // custody; the public command tests exercise the real captured context.
  const operationContext: Readonly<Pick<SavedSecretOperationContextV1, 'isCurrent'>> = { isCurrent: async () => true };

  beforeEach(() => {
    connectMock.mockReset();
    callToolMock.mockReset();
    closeMock.mockReset();
  });

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
  });

  it('uses the configured MCP request lifetime for a supervised stdio tool', async () => {
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    delete process.env.HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS;
    delete process.env.HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS;
    reloadConfiguration();

    const { callResolvedCustomHappierTool } = await import('./callResolvedCustomHappierTool');

    const result = await callResolvedCustomHappierTool({
      source: 'qa_marker_stdio_20260306',
      toolName: 'get_marker',
      args: {},
      operationContext,
      mcpServers: {
        qa_marker_stdio_20260306: { command: process.execPath, args: ['-e', 'process.stdin.resume()'] },
      },
      processEnv: { PATH: '/usr/bin' },
    });

    expect(result).toEqual({
      ok: true,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
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
      operationContext,
      mcpServers: {
        qa_marker_stdio_20260306: { command: process.execPath, args: ['-e', 'process.stdin.resume()'] },
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
