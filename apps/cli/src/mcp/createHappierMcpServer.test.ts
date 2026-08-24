import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { callMachineRpc } = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));

vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc }));

const env = process.env;

describe('createHappierMcpServer', () => {
  beforeEach(() => {
    vi.resetModules();
    callMachineRpc.mockReset();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  afterEach(() => {
    vi.doUnmock('@happier-dev/protocol');
    vi.resetModules();
  });

  it('routes an explicit non-session memory machine through account-scoped machine RPC', async () => {
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
    callMachineRpc.mockResolvedValue({ v: 1, ok: true, hits: [] });
    const invokeLocal = vi.fn(async () => ({ v: 1, ok: true, hits: [] }));
    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const credentials = {
      token: 'token-1',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };

    createHappierMcpServer({
      sessionId: 'sess_mcp_memory_machine_1',
      rpcHandlerManager: { invokeLocal },
      getCurrentSessionLocation: () => ({ machineId: 'machine-session' }),
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any, {
      credentials,
    });

    await expect(captured.deps.daemonMemorySearch({
      machineId: 'machine-selected',
      query: { v: 1, query: 'bridge', scope: { type: 'global' }, mode: 'hints' },
    })).resolves.toEqual({ v: 1, ok: true, hits: [] });
    expect(callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-selected',
      method: 'daemon.memory.search',
      request: { v: 1, query: 'bridge', scope: { type: 'global' }, mode: 'hints' },
    });
    expect(invokeLocal).not.toHaveBeenCalled();
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
    expect(toolNames).not.toContain('subagents_plan_start');
    expect(toolNames).toContain('action_execute');
  });

  it('uses account action settings for the in-session MCP tool registry when provided', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': { enabled: true, disabledSurfaces: ['session_agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_account_settings_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient, {
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              toolExposureModes: { session_agent: 'direct' },
            },
          },
        },
      },
    } as any);

    expect(toolNames).toContain('session_list');
  });

  it('uses account action settings for in-session MCP approval policy when provided', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': { disabledSurfaces: [] },
      },
    });
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
      sessionId: 'sess_mcp_approval_policy_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any, {
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: ['session_agent'],
            },
          },
        },
      },
    } as any);

    expect(captured.deps).toBeDefined();
    expect(captured.deps.isActionApprovalRequired('session.list', { surface: 'session_agent' })).toBe(true);
  });

  it('reads latest account action settings for enablement and approval without recreating the bridge', async () => {
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

    let accountSettings: any = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            disabledSurfaces: ['session_agent'],
          },
        },
      },
    };

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_settings_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any, {
      getAccountSettings: () => accountSettings,
    });

    expect(captured.deps).toBeDefined();
    expect(captured.deps.isActionEnabled('session.list', { surface: 'session_agent' })).toBe(false);
    expect(captured.deps.isActionApprovalRequired('session.list', { surface: 'session_agent' })).toBe(false);

    accountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            disabledSurfaces: [],
            approvalRequiredSurfaces: ['session_agent'],
          },
        },
      },
    };

    expect(captured.deps.isActionEnabled('session.list', { surface: 'session_agent' })).toBe(true);
    expect(captured.deps.isActionApprovalRequired('session.list', { surface: 'session_agent' })).toBe(true);
  });

  it('keeps direct tool registrations scoped to the settings snapshot used to create that MCP server', async () => {
    let accountSettings: any = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            disabledSurfaces: ['session_agent'],
            toolExposureModes: { session_agent: 'direct' },
          },
        },
      },
    };

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_direct_tool_snapshot_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendClaudeSessionMessage: () => {},
      updateMetadata: () => {},
    } as any;

    const first = createHappierMcpServer(fakeClient, {
      getAccountSettings: () => accountSettings,
    });
    expect(first.toolNames).not.toContain('session_list');

    accountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            disabledSurfaces: [],
            toolExposureModes: { session_agent: 'direct' },
          },
        },
      },
    };

    expect(first.toolNames).not.toContain('session_list');
    const second = createHappierMcpServer(fakeClient, {
      getAccountSettings: () => accountSettings,
    });
    expect(second.toolNames).toContain('session_list');
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

  it('passes the live session permission mode into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/actions/createCliActionExecutorHarness')>();
      return {
        ...actual,
        createCliActionExecutorHarness: (params: any) => {
          captured.params = params;
          return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_live_permission_bridge_1',
        rpcHandlerManager: { invokeLocal: async () => ({}) },
        sendClaudeSessionMessage: () => {},
        updateMetadata: () => {},
        getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 1 } as any),
        getPermissionMode: () => 'yolo',
      } as any,
      { credentials: null },
    );

    expect(captured.params).toBeDefined();
    expect(captured.params.getCallerPermissionMode()).toBe('yolo');
  });

  it('falls back to metadata snapshot permission mode when the live getter is unavailable', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/actions/createCliActionExecutorHarness')>();
      return {
        ...actual,
        createCliActionExecutorHarness: (params: any) => {
          captured.params = params;
          return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_metadata_permission_bridge_1',
        rpcHandlerManager: { invokeLocal: async () => ({}) },
        sendClaudeSessionMessage: () => {},
        updateMetadata: () => {},
        getMetadataSnapshot: () => ({ permissionMode: 'safe-yolo', permissionModeUpdatedAt: 1 } as any),
      } as any,
      { credentials: null },
    );

    expect(captured.params).toBeDefined();
    expect(captured.params.getCallerPermissionMode()).toBe('safe-yolo');
  });

  it('passes the live session backend target into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/actions/createCliActionExecutorHarness')>();
      return {
        ...actual,
        createCliActionExecutorHarness: (params: any) => {
          captured.params = params;
          return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_live_backend_target_bridge_1',
        rpcHandlerManager: { invokeLocal: async () => ({}) },
        sendClaudeSessionMessage: () => {},
        updateMetadata: () => {},
        getMetadataSnapshot: () => ({ path: '/repo/current' } as any),
        getBackendTarget: () => ({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
      } as any,
      { credentials: null },
    );

    expect(captured.params).toBeDefined();
    expect(captured.params.getCurrentSessionBackendTarget()).toEqual({
      kind: 'configuredAcpBackend',
      backendId: 'review-bot',
    });
  });

  it('passes live session location into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/actions/createCliActionExecutorHarness')>();
      return {
        ...actual,
        createCliActionExecutorHarness: (params: any) => {
          captured.params = params;
          return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_live_location_bridge_1',
        rpcHandlerManager: { invokeLocal: async () => ({}) },
        sendClaudeSessionMessage: () => {},
        updateMetadata: () => {},
        getMetadataSnapshot: () => ({ permissionMode: 'default' } as any),
        getCurrentSessionLocation: () => ({
          path: '/repo/current',
          host: 'leeroy-mbp',
          machineId: 'machine-1',
        }),
      } as any,
      { credentials: null },
    );

    expect(captured.params).toBeDefined();
    expect(captured.params.rawSession).toMatchObject({
      metadata: { permissionMode: 'default' },
      path: '/repo/current',
      host: 'leeroy-mbp',
      machineId: 'machine-1',
    });
  });
});
