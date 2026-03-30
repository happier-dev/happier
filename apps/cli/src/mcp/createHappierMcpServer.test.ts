import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = process.env;

describe('createHappierMcpServer', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('returns toolNames aligned with current MCP action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['session_agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient);
    expect(toolNames).not.toContain('review_start');
    expect(toolNames).toContain('subagents_plan_start');
  });

  it('forwards execution.run.list request payloads through the shared action executor deps', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const invokeLocal = vi.fn(async (_method: string, params: unknown) => params);
    createHappierMcpServer({
      sessionId: 'sess_mcp_payload_1',
      rpcHandlerManager: { invokeLocal },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any);

    expect(captured.deps).toBeDefined();
    await captured.deps.executionRunList('sess_mcp_payload_1', { status: 'running' });
    expect(invokeLocal).toHaveBeenCalledWith('execution.run.list', { status: 'running' });
  });

  it('prefers the session execution-run service when the client provides one', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const invokeLocal = vi.fn(async (_method: string, params: unknown) => params);
    const list = vi.fn(async () => ({ ok: true, data: { runs: [{ runId: 'run_1' }] } }));
    createHappierMcpServer({
      sessionId: 'sess_mcp_payload_2',
      rpcHandlerManager: { invokeLocal },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
      executionRuns: {
        start: vi.fn(),
        list,
        get: vi.fn(),
        send: vi.fn(),
        stop: vi.fn(),
        action: vi.fn(),
      },
    } as any);

    expect(captured.deps).toBeDefined();
    await captured.deps.executionRunList('sess_mcp_payload_2', { status: 'running' });
    expect(list).toHaveBeenCalledWith({ status: 'running' });
    expect(invokeLocal).not.toHaveBeenCalled();
  });

  it('treats raw local execution-run rpc error payloads as errors in the fallback bridge', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const invokeLocal = vi.fn(async () => ({
      error: 'RPC method not available',
      errorCode: 'RPC_METHOD_NOT_AVAILABLE',
    }));
    createHappierMcpServer({
      sessionId: 'sess_mcp_payload_3',
      rpcHandlerManager: { invokeLocal },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any);

    expect(captured.deps).toBeDefined();
    await expect(captured.deps.executionRunList('sess_mcp_payload_3', { status: 'running' })).resolves.toEqual({
      ok: false,
      code: 'RPC_METHOD_NOT_AVAILABLE',
      message: 'RPC method not available',
    });
  });

  it('forwards prompt_registry.install through the shared action executor deps', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const invokeLocal = vi.fn(async (_method: string, params: unknown) => ({
      ok: true,
      digest: 'sha256:deadbeef',
      request: params,
    }));
    createHappierMcpServer({
      sessionId: 'sess_mcp_prompt_registry_1',
      rpcHandlerManager: { invokeLocal },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any);

    expect(captured.deps).toBeDefined();
    const res = await captured.deps.promptRegistryInstall({
      machineId: 'machine_1',
      sourceId: 'source_1',
      itemId: 'item_1',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'codex.prompts',
        scope: 'user',
        targetName: 'example-skill',
        installMode: 'copy',
      },
    });
    expect(invokeLocal).toHaveBeenCalledWith('daemon.promptRegistry.install', {
      sourceId: 'source_1',
      itemId: 'item_1',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'codex.prompts',
        scope: 'user',
        targetName: 'example-skill',
        installMode: 'copy',
      },
    });
    expect(res).toMatchObject({ ok: true, digest: 'sha256:deadbeef' });
  });

  it('routes session control deps through the shared CLI action deps (not unsupported stubs)', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_session_control_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any);

    expect(captured.deps).toBeDefined();
    await expect(
      captured.deps.sessionList({ limit: 1, cursor: null, activeOnly: false, archivedOnly: false, includeSystem: false, resumableOnly: false }),
    ).resolves.toEqual({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
  });

  it('dispatches registered tools using the session_agent surface (internal MCP)', async () => {
    const captured: { surface?: string } = {};
    const handlers: Record<string, (args: any) => Promise<any>> = {};

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class FakeMcpServer {
        registerResource() {}
        registerTool(name: string, _meta: any, handler: any) {
          handlers[name] = handler;
        }
      },
    }));

    vi.doMock('@/agent/tools/happierTools/dispatchBuiltInHappierTool', () => ({
      dispatchBuiltInHappierTool: async (params: any) => {
        captured.surface = params.surface;
        return { ok: true, result: { ok: true } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_surface_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any;

    createHappierMcpServer(fakeClient);

    expect(typeof handlers.change_title).toBe('function');
    await handlers.change_title({ title: 'Hello' });
    expect(captured.surface).toBe('session_agent');
  });

  it('routes change_title through the action executor (so approvals/enablement apply)', async () => {
    const execute = vi.fn(async () => ({ ok: true, result: { ok: true } }));
    const captured: { deps?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/actions/createCliActionExecutorHarness')>();
      return {
        ...actual,
        createCliActionExecutorHarness: () => ({ executor: { execute } }),
      };
    });

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/mcp/server/registerHappierMcpBuiltInTools')>();
      return {
        ...actual,
        registerHappierMcpBuiltInTools: (_server: any, params: any) => {
          captured.deps = params.deps;
          return { toolNames: [] };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_change_title_1',
        rpcHandlerManager: { invokeLocal: async () => ({}) },
        sendClaudeSessionMessage: () => {},
        updateMetadata: () => {},
      } as any,
      { credentials: null },
    );

    expect(captured.deps).toBeDefined();
    await captured.deps.changeTitle('sess_change_title_1', 'New title');
    expect(execute).toHaveBeenCalledWith(
      'session.title.set',
      { sessionId: 'sess_change_title_1', title: 'New title' },
      { surface: 'session_agent', defaultSessionId: 'sess_change_title_1' },
    );
  });

  it('treats session-agent metadata refresh after change_title as best-effort', async () => {
    const execute = vi.fn(async () => ({ ok: true, result: { ok: true } }));
    const updateMetadata = vi.fn(() => {
      throw new Error('local metadata sync failed');
    });
    const captured: { deps?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/actions/createCliActionExecutorHarness')>();
      return {
        ...actual,
        createCliActionExecutorHarness: () => ({ executor: { execute } }),
      };
    });

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/mcp/server/registerHappierMcpBuiltInTools')>();
      return {
        ...actual,
        registerHappierMcpBuiltInTools: (_server: any, params: any) => {
          captured.deps = params.deps;
          return { toolNames: [] };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_change_title_refresh_1',
        rpcHandlerManager: { invokeLocal: async () => ({}) },
        sendClaudeSessionMessage: () => {},
        updateMetadata,
      } as any,
      { credentials: null },
    );

    expect(captured.deps).toBeDefined();
    await expect(captured.deps.changeTitle('sess_change_title_refresh_1', 'New title')).resolves.toEqual({
      success: true,
      title: 'New title',
    });
    expect(updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('routes execution_run_start through the action executor (so approvals/enablement apply)', async () => {
    const execute = vi.fn(async () => ({ ok: true, result: { ok: true } }));
    const captured: { deps?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/actions/createCliActionExecutorHarness')>();
      return {
        ...actual,
        createCliActionExecutorHarness: () => ({ executor: { execute } }),
      };
    });

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/mcp/server/registerHappierMcpBuiltInTools')>();
      return {
        ...actual,
        registerHappierMcpBuiltInTools: (_server: any, params: any) => {
          captured.deps = params.deps;
          return { toolNames: [] };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_execution_run_start_1',
        rpcHandlerManager: { invokeLocal: async () => ({}) },
        sendClaudeSessionMessage: () => {},
        updateMetadata: () => {},
      } as any,
      { credentials: null },
    );

    expect(captured.deps).toBeDefined();
    await captured.deps.startExecutionRun('sess_execution_run_start_1', { intent: 'plan' });
    expect(execute).toHaveBeenCalledWith(
      'execution.run.start',
      { intent: 'plan' },
      { surface: 'session_agent', defaultSessionId: 'sess_execution_run_start_1' },
    );
  });
});
