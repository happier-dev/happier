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

  // R4-3: the canonical action path (protocol actionExecutor `execution.run.start`) rejects a
  // malformed connected-services selection with `invalid_parameters`. The legacy manual tool must
  // keep the SAME contract — a malformed selection is a bad parameter, not an unparseable payload.
  it('rejects a malformed connected-services selection with invalid_parameters (action-path parity)', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: { v: 999, bindingsByServiceId: 'not-an-object' },
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('forwards a valid connected-services selection into the run-start request', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
          },
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      request: expect.objectContaining({
        connectedServices: expect.objectContaining({
          bindingsByServiceId: expect.objectContaining({
            'openai-codex': expect.objectContaining({ groupId: 'happier' }),
          }),
        }),
      }),
    });
  });

  it('keeps invalid_action_input for an unparseable payload (missing intent)', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: { backendTarget: { kind: 'builtInAgent', agentId: 'claude' } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_input' });
  });
});
