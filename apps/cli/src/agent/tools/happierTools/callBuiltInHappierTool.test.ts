import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSessionById = vi.fn();
const updateSessionMetadataWithRetry = vi.fn();
const resolveSessionEncryptionContextFromCredentials = vi.fn(() => ({ type: 'plain' as const }));
const resolveSessionStoredContentEncryptionMode = vi.fn(() => 'plain' as const);
const execute = vi.fn();

vi.mock('@/sessionControl/sessionsHttp', () => ({
  fetchSessionById,
}));

vi.mock('@/sessionControl/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry,
}));

vi.mock('@/sessionControl/sessionEncryptionContext', () => ({
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
}));

vi.mock('@/sessionControl/createSessionControlActionExecutor', () => ({
  createSessionControlActionExecutor: vi.fn(() => ({
    execute,
  })),
}));

vi.mock('@/sessionControl/sessionRpc', () => ({
  callSessionRpc: vi.fn(),
}));

describe('callBuiltInHappierTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      metadata: { summary: { text: 'Old title' } },
    });
  });

  it('executes action_execute through the shared action executor on the MCP surface', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { started: true } });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'subagents.plan.start',
        input: { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.' },
      },
    });

    expect(result).toEqual({
      ok: true,
      result: { started: true },
    });
    expect(execute).toHaveBeenCalledWith(
      'subagents.plan.start',
      { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.' },
      { defaultSessionId: 'sess-1', surface: 'mcp' },
    );
  });

  it('resolves action_options_resolve through the shared action executor on the MCP surface', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [{ value: 'plan', label: 'Plan' }],
      },
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_options_resolve',
      args: {
        optionsSourceId: 'session.modes.available',
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [{ value: 'plan', label: 'Plan' }],
      },
    });
    expect(execute).toHaveBeenCalledWith(
      'action.options.resolve',
      { optionsSourceId: 'session.modes.available' },
      { defaultSessionId: 'sess-1', surface: 'mcp' },
    );
  });

  it('preserves action_options_resolve executor errors instead of rewriting them as unsupported', async () => {
    execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_options_resolve',
      args: {
        optionsSourceId: 'session.modes.available',
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
  });

  it('reports malformed action_options_resolve payloads as resolver failures', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: null,
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_options_resolve',
      args: {
        optionsSourceId: 'session.modes.available',
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_options_resolve_failed',
      error: 'Options source resolution failed',
    });
  });
});
