import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import {
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  callMcpToolWithResolvedTimeout,
  resolveMcpToolCallRequestOptions,
  resolveMcpToolCallRequestTimeoutMs,
} from './mcpToolCallRequestOptions';

describe('resolveMcpToolCallRequestOptions', () => {
  const envKeys = [
    'HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS',
    'HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
  });

  it('uses a long default timeout instead of the MCP SDK 60s default', async () => {
    delete process.env.HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS;
    delete process.env.HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS;
    reloadConfiguration();

    expect(resolveMcpToolCallRequestOptions({ toolName: 'get_status', args: {} })).toEqual({
      timeout: DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    });
    expect(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it('lets configuration env override the general MCP tool call timeout', async () => {
    process.env.HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS = '240000';
    reloadConfiguration();

    expect(resolveMcpToolCallRequestTimeoutMs({
      toolName: 'get_status',
      args: {},
    })).toBe(240_000);
  });

  it('aligns execution_run_wait timeout with timeoutSeconds plus configured grace', async () => {
    process.env.HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS = '45000';
    reloadConfiguration();

    expect(resolveMcpToolCallRequestTimeoutMs({
      toolName: 'execution_run_wait',
      args: { runId: 'run_123', timeoutSeconds: 120 },
    })).toBe(165_000);
  });

  it('also recognizes provider-prefixed execution_run_wait tool names', async () => {
    process.env.HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS = '45000';
    reloadConfiguration();

    expect(resolveMcpToolCallRequestTimeoutMs({
      toolName: 'mcp__happier__execution_run_wait',
      args: { runId: 'run_123', timeoutSeconds: 120 },
    })).toBe(165_000);
  });
});

describe('callMcpToolWithResolvedTimeout', () => {
  const envKeys = ['HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
  });

  it('passes SDK request options when calling the MCP client', async () => {
    process.env.HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS = '45000';
    reloadConfiguration();

    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const client = { callTool } as unknown as Pick<Client, 'callTool'>;

    await callMcpToolWithResolvedTimeout({
      client,
      toolName: 'execution_run_wait',
      args: { runId: 'run_123', timeoutSeconds: 120 },
    });

    expect(callTool).toHaveBeenCalledWith(
      { name: 'execution_run_wait', arguments: { runId: 'run_123', timeoutSeconds: 120 } },
      undefined,
      { timeout: 165_000 },
    );
  });

  it('preserves request metadata and progress callbacks when calling the MCP client', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const client = { callTool } as unknown as Pick<Client, 'callTool'>;
    const onprogress = vi.fn();

    await callMcpToolWithResolvedTimeout({
      client,
      toolName: 'remember',
      args: { content: 'store this' },
      requestMetadata: { requestTrace: 'trace-1', progressToken: 'downstream-token' },
      onprogress,
    });

    expect(callTool).toHaveBeenCalledWith(
      {
        name: 'remember',
        arguments: { content: 'store this' },
        _meta: { requestTrace: 'trace-1', progressToken: 'downstream-token' },
      },
      undefined,
      {
        timeout: DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
        onprogress,
      },
    );
  });
});
