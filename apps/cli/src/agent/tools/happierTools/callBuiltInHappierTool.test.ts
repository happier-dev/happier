import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSessionTransportContext = vi.fn();
const updateSessionMetadataWithRetry = vi.fn();
const startExecutionRun = vi.fn();
const createCliActionExecutor = vi.fn(() => ({
  execute,
}));
const execute = vi.fn();

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry,
}));

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('@/session/services/executionRuns', () => ({
  startExecutionRun,
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: vi.fn(),
}));

const env = process.env;

describe('callBuiltInHappierTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: { summary: { text: 'Old title' } },
      },
      ctx: { type: 'plain' as const },
      mode: 'plain' as const,
    });
  });

  it('executes action_execute through the shared action executor on the CLI surface', async () => {
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
      {
        defaultSessionId: 'sess-1',
        surface: 'cli',
        actionsSettings: { v: 1, actions: {} },
      },
    );
  });

  it('rejects action_options_resolve on the CLI surface', async () => {
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
      errorCode: 'action_disabled',
      error: 'Action is disabled',
      details: expect.objectContaining({
        actionId: 'action.options.resolve',
        surface: 'cli',
        reason: 'unsupported_surface',
        settingsState: 'enabled',
      }),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(createCliActionExecutor).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: { summary: { text: 'Old title' } },
      },
    }));
  });

  it('preserves session resolution ambiguity details for built-in tool calls', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: false,
      code: 'session_id_ambiguous',
      candidates: ['sess-1', 'sess-2'],
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess',
      toolName: 'change_title',
      args: { title: 'Renamed' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_id_ambiguous',
      error: 'Session id is ambiguous',
      candidates: ['sess-1', 'sess-2'],
    });
  });

  it('reports session lookup timeouts without relabeling them as not-found', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: false,
      code: 'session_lookup_timeout',
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'c000000000000000000000000',
      toolName: 'change_title',
      args: { title: 'Renamed' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_lookup_timeout',
      error: 'Session lookup timed out; try again',
    });
  });

  it('routes change_title through the shared action executor on the CLI surface', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'session.title.set' },
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'change_title',
      args: { title: 'Renamed' },
    });

    expect(result).toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'session.title.set' },
    });
    expect(execute).toHaveBeenCalledWith(
      'session.title.set',
      { sessionId: 'sess-1', title: 'Renamed' },
      { defaultSessionId: 'sess-1', surface: 'cli' },
    );
    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('rejects action_execute when the action is disabled on the CLI surface', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'subagents.plan.start': { enabled: true, disabledSurfaces: ['cli'], disabledPlacements: [] },
      },
    });

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
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
      details: expect.objectContaining({
        actionId: 'subagents.plan.start',
        surface: 'cli',
        reason: 'disabled_by_settings',
        settingsState: 'disabled',
      }),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects action-backed MCP-only tools on the CLI surface', async () => {
    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'memory_ensure_up_to_date',
      args: {
        machineId: 'machine-1',
        sessionId: 'sess-1',
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
      details: expect.objectContaining({
        actionId: 'memory.ensure_up_to_date',
        surface: 'cli',
        reason: 'unsupported_surface',
        settingsState: 'enabled',
      }),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects action-backed CLI direct calls when tool exposure is discoverable-only', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': {
          enabled: true,
          toolExposureModes: { cli: 'discoverable_only' },
        },
      },
    });
    execute.mockResolvedValueOnce({ ok: true, result: { unreachable: true } });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'review_start',
      args: { instructions: 'Review this change.' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unknown_tool',
      error: 'Unknown built-in Happier tool: review_start',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves execution_run_start failures from the shared execution-run service', async () => {
    startExecutionRun.mockResolvedValueOnce({
      ok: false,
      code: 'execution_run_budget_exceeded',
      message: 'Execution run budget exceeded',
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'execution_run_budget_exceeded',
      error: 'Execution run budget exceeded',
    });
  });
});
