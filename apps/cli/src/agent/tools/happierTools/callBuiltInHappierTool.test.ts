import { beforeEach, describe, expect, it, vi } from 'vitest';

function createMockResolvedContributionRegistry(params?: Readonly<{
  actions?: readonly unknown[];
}>): {
  generationId: string;
  providers: [];
  backends: [];
  actions: readonly unknown[];
  resources: [];
  uiDescriptors: [];
  activationTargets: [];
  hookRegistrations: [];
  actionsById: Map<never, never>;
  resourcesById: Map<never, never>;
  uiDescriptorsById: Map<never, never>;
  surfaceHandlersByBackendId: Map<never, never>;
  catalogEntriesById: {};
  providerDefinitionsById: Map<never, never>;
  backendDefinitionsById: Map<never, never>;
  pluginDiagnosticsByPluginId: {};
} {
  return {
    generationId: 'registry:test',
    providers: [],
    backends: [],
    actions: params?.actions ?? [],
    resources: [],
    uiDescriptors: [],
    activationTargets: [],
    hookRegistrations: [],
    actionsById: new Map<never, never>(),
    resourcesById: new Map<never, never>(),
    uiDescriptorsById: new Map<never, never>(),
    surfaceHandlersByBackendId: new Map<never, never>(),
    catalogEntriesById: {},
    providerDefinitionsById: new Map<never, never>(),
    backendDefinitionsById: new Map<never, never>(),
    pluginDiagnosticsByPluginId: {},
  };
}

const { getResolvedContributionRegistry } = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(() => createMockResolvedContributionRegistry()),
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

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: vi.fn(),
}));

const env = process.env;

describe('callBuiltInHappierTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createCliActionExecutor.mockReturnValue({
      execute,
    });
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
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
      { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.' },
      { defaultSessionId: 'sess-1', surface: 'cli' },
    );
  });

  it('executes trusted non-MCP plugin action_execute calls through the shared action executor on the CLI surface', async () => {
    getResolvedContributionRegistry.mockReturnValue(createMockResolvedContributionRegistry({
      actions: [
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.review.plugin',
          manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
          manifestDigest: 'sha256:acme-review',
          daemonEntryPath: '/plugins/acme/review/daemon.mjs',
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme/review',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
          },
          definition: {
            kindVersion: 1,
            id: 'acme.cli.review.start',
            title: 'Acme CLI Review Start',
            description: 'Start a CLI-only plugin-defined review workflow',
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: {},
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              session_agent: true,
              mcp: false,
              cli: true,
              rpc: false,
              sdk: false,
            },
            inputHints: null,
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: true,
            },
            execution: {
              routing: 'plugin',
              handler: {
                target: 'plugin',
                exportName: 'startCliReview',
              },
            },
          },
        },
      ],
    }));
    execute.mockResolvedValueOnce({ ok: true, result: { started: true } });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'acme.cli.review.start',
        input: { scope: 'diff' },
      },
    });

    expect(result).toEqual({
      ok: true,
      result: { started: true },
    });
    expect(execute).toHaveBeenCalledWith(
      'acme.cli.review.start',
      { scope: 'diff' },
      { defaultSessionId: 'sess-1', surface: 'cli' },
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

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
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

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
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
    });
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

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'Action is disabled',
    });
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
