import { describe, expect, it } from 'vitest';

import { normalizeExecutionRunStartToolInput } from './manualToolContracts';

describe('normalizeExecutionRunStartToolInput', () => {
  it('accepts review execution_run_start requests with a built-in backend target', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: {
        sessionId: 'sess_mcp_1',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    });

    expect(result).toEqual({
      ok: true,
      request: expect.objectContaining({
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      }),
    });
  });

  it('accepts review execution_run_start requests with a canonical v2 backend target', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: {
        sessionId: 'sess_mcp_1',
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    });

    expect(result).toEqual({
      ok: true,
      request: expect.objectContaining({
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      }),
    });
  });
});
