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
      { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.', sessionId: 'sess-1' },
      { defaultSessionId: 'sess-1', surface: 'cli', actionsSettings: { v: 1, actions: {} } },
    );
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

    expectActionDisabled(result);
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
