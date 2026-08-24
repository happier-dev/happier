import { beforeEach, describe, expect, it, vi } from 'vitest';

function createMockResolvedContributionRegistry(params?: Readonly<{
  actions?: readonly unknown[];
}>): {
  generationId: string;
  agents: [];
  actions: readonly unknown[];
  resources: [];
  activationTargets: [];
  actionsById: Map<never, never>;
  resourcesById: Map<never, never>;
  catalogEntriesById: {};
  agentDefinitionsById: Map<never, never>;
  pluginDiagnosticsByPluginId: {};
} {
  return {
    generationId: 'registry:test',
    agents: [],
        actions: params?.actions ?? [],
    resources: [],
    activationTargets: [],
    actionsById: new Map<never, never>(),
    resourcesById: new Map<never, never>(),
        catalogEntriesById: {},
    agentDefinitionsById: new Map<never, never>(),
    pluginDiagnosticsByPluginId: {},
  };
}

const { getResolvedContributionRegistry } = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(() => createMockResolvedContributionRegistry()),
}));
const { readDaemonPluginCatalog } = vi.hoisted(() => ({
  readDaemonPluginCatalog: vi.fn(async () => ({
    kind: 'unavailable' as const,
    code: 'test_daemon_unavailable',
  })),
}));

const resolveSessionTransportContext = vi.fn();
const updateSessionMetadataWithRetry = vi.fn();
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

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry,
}));

vi.mock('@/daemon/controlClient', () => ({
  readDaemonPluginCatalog,
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: vi.fn(),
}));

const env = process.env;

function expectActionDisabled(result: unknown): void {
  expect(result).toMatchObject({
    ok: false,
    errorCode: 'action_disabled',
    error: 'Action is disabled',
  });
}

describe('callBuiltInHappierTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createCliActionExecutor.mockReturnValue({
      execute,
    });
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    readDaemonPluginCatalog.mockResolvedValue({
      kind: 'unavailable',
      code: 'test_daemon_unavailable',
    });
    getResolvedContributionRegistry.mockReturnValue(createMockResolvedContributionRegistry());
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: { summary: { text: 'Old title' } },
      },
      ctx: null,
      mode: 'plain' as const,
    });
  });

  it('creates the shared action executor for a token-only plain Session', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { started: true } });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: null },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'subagents.plan.start',
        input: { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.' },
      },
    });

    expect(createCliActionExecutor).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { token: 'token', encryption: null },
      mode: 'plain',
      ctx: null,
    }));
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
      { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.', sessionId: 'sess-1' },
      { defaultSessionId: 'sess-1', surface: 'cli', actionsSettings: { v: 1, actions: {} } },
    );
  });

  it('uses the semantic agent surface and session machine for an internal bridge call', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1', machineId: 'machine-1', metadata: { permissionMode: 'safe-yolo' } },
      ctx: null,
      mode: 'plain' as const,
    });
    execute.mockResolvedValueOnce({ ok: true, result: { items: [] } });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: null },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'memory.search',
        input: { query: { v: 1, query: 'handoff', scope: { type: 'global' }, mode: 'hints' } },
      },
      surface: 'agent',
      toolCallId: 'pi-tool-call-1',
    });

    expect(execute).toHaveBeenCalledWith(
      'memory.search',
      expect.objectContaining({ machineId: 'machine-1' }),
      expect.objectContaining({
        defaultSessionId: 'sess-1',
        defaultSessionMachineId: 'machine-1',
        surface: 'agent',
        callerPermissionMode: 'safe-yolo',
        actionRequestId: 'pi-tool-call-1',
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'sess-1',
          toolCallId: 'pi-tool-call-1',
          toolName: 'action_execute',
        },
      }),
    );
  });

  it('rejects agent bridge calls when session permission metadata cannot be decrypted', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        machineId: 'machine-1',
        metadata: 'not-valid-encrypted-metadata',
      },
      ctx: { type: 'plain' as const },
      mode: 'e2ee' as const,
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'session.message.send',
        input: { sessionId: 'sess-1', message: 'should not be sent' },
      },
      surface: 'agent',
      toolCallId: 'pi-tool-call-1',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_metadata_unavailable',
      error: 'Session metadata is unavailable for Agent tool authorization',
    });
    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed for explicit plugin action ids that are not exposed by the authoritative registry', async () => {
    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'qa.self-improving.loop.tool',
        input: {},
      },
    });

    expectActionDisabled(result);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed for runtime action ids through action_execute on the CLI tool surface', async () => {
    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'browser.navigate',
        input: {
          sessionId: 'sess-1',
          browserViewId: 'browser-view-1',
          url: 'https://example.test/',
        },
      },
    });

    expectActionDisabled(result);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps ordinary action_options_resolve calls on the CLI surface', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [],
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
        options: [],
      },
    });
    expect(execute).toHaveBeenCalledWith(
      'action.options.resolve',
      { optionsSourceId: 'session.modes.available' },
      expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
    );
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

    expectActionDisabled(result);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects action-backed MCP-only tools on the CLI surface', async () => {
    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'memory_search',
      args: {
        machineId: 'machine-1',
        query: { q: 'needle' },
      },
    });

    expectActionDisabled(result);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves execution_run_start failures from the shared action executor', async () => {
    execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'execution_run_budget_exceeded',
      error: 'Execution run budget exceeded',
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
