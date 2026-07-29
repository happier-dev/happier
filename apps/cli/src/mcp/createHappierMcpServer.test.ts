import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = process.env;

describe('createHappierMcpServer', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  afterEach(() => {
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@happier-dev/protocol');
    vi.doUnmock('@/session/actions/createCliActionExecutorHarness');
    vi.doUnmock('@/mcp/server/registerHappierMcpBuiltInTools');
    vi.doUnmock('@/agent/tools/happierTools/dispatchBuiltInHappierTool');
  });

  it('returns toolNames aligned with current MCP action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendProviderMessage: () => {},
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient);
    expect(toolNames).not.toContain('review_start');
    expect(toolNames).not.toContain('subagents_plan_start');
    expect(toolNames).toContain('action_spec_search');
  });

  it('uses account action settings for the in-session MCP tool registry when provided', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_account_settings_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendProviderMessage: () => {},
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient, {
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              toolExposureModes: {
                agent: 'direct',
              },
            },
          },
        },
      },
    } as any);

    expect(toolNames).toContain('session_list');
  });

  it('reads current account action settings when registered session-agent MCP tools run', async () => {
    const handlers: Record<string, (args: any) => Promise<any>> = {};

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class FakeMcpServer {
        registerResource() {}
        registerTool(name: string, _meta: any, handler: any) {
          handlers[name] = handler;
        }
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    let currentAccountSettings: any = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'review.start': {
            disabledSurfaces: ['agent'],
          },
        },
      },
    };

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_settings_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendProviderMessage: () => {},
      updateMetadata: () => {},
    } as any, {
      getAccountSettings: () => currentAccountSettings,
    } as any);

    const handler = handlers.action_spec_get;
    expect(typeof handler).toBe('function');

    const disabledResult = await handler({ id: 'review.start' });
    expect(disabledResult.isError).toBe(true);
    expect(JSON.parse(disabledResult.content[0].text)).toMatchObject({
      errorCode: 'action_disabled',
      details: {
        actionId: 'review.start',
        surface: 'agent',
        reason: 'disabled_by_settings',
      },
    });

    currentAccountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {},
      },
    };

    const enabledResult = await handler({ id: 'review.start' });
    expect(enabledResult.isError).toBe(false);
    expect(JSON.parse(enabledResult.content[0].text)).toMatchObject({
      actionSpec: {
        id: 'review.start',
      },
    });
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
      sendProviderMessage: () => {},
      updateMetadata: () => {},
    } as any, {
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: ['agent'],
            },
          },
        },
      },
    } as any);

    expect(captured.deps).toBeDefined();
    expect(captured.deps.isActionApprovalRequired('session.list', { surface: 'agent' })).toBe(true);
  });

  it('reads current session-agent spawn policy when action-backed tools execute', async () => {
    const executorExecute = vi.fn(async (actionId: string, input: unknown, ctx: unknown) => ({
      ok: true,
      result: { actionId, input, ctx },
    }));
    const captured: { deps?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: executorExecute,
        },
      }),
    }));

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

    const firstPolicy = { allowedBackendTargetKeys: ['agent:codex'] };
    const secondPolicy = { allowedBackendTargetKeys: ['agent:claude'] };
    let currentAccountSettings: any = {
      sessionAgentSpawnPolicyV1: firstPolicy,
    };

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_spawn_policy_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendProviderMessage: () => {},
      updateMetadata: () => {},
    } as any, {
      getAccountSettings: () => currentAccountSettings,
    } as any);

    expect(captured.deps).toBeDefined();
    await captured.deps.executeActionByToolName('action_execute', {
      actionId: 'session.spawn_new',
      input: { prompt: 'Spawn a helper' },
    }, 'sess_mcp_live_spawn_policy_1');
    expect(executorExecute).toHaveBeenLastCalledWith(
      'session.spawn_new',
      { prompt: 'Spawn a helper' },
      expect.objectContaining({
        sessionAgentSpawnPolicyV1: firstPolicy,
      }),
    );

    currentAccountSettings = {
      sessionAgentSpawnPolicyV1: secondPolicy,
    };

    await captured.deps.executeActionByToolName('action_execute', {
      actionId: 'session.spawn_new',
      input: { prompt: 'Spawn another helper' },
    }, 'sess_mcp_live_spawn_policy_1');
    expect(executorExecute).toHaveBeenLastCalledWith(
      'session.spawn_new',
      { prompt: 'Spawn another helper' },
      expect.objectContaining({
        sessionAgentSpawnPolicyV1: secondPolicy,
      }),
    );
  });

  it('uses the live session permission mode for session-agent action execution instead of stale metadata', async () => {
    const executorExecute = vi.fn(async (actionId: string, input: unknown, ctx: unknown) => ({
      ok: true,
      result: { actionId, input, ctx },
    }));
    const captured: { deps?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: executorExecute,
        },
      }),
    }));

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

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_permission_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendProviderMessage: () => {},
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 1 }),
      getPermissionMode: () => 'yolo',
    } as any);

    expect(captured.deps).toBeDefined();
    await captured.deps.executeActionByToolName('action_execute', {
      actionId: 'session.spawn_new',
      input: { permissionMode: 'bypassPermissions' },
    }, 'sess_mcp_live_permission_1');

    expect(executorExecute).toHaveBeenLastCalledWith(
      'session.spawn_new',
      { permissionMode: 'bypassPermissions' },
      expect.objectContaining({
        callerPermissionMode: 'yolo',
      }),
    );
  });

  it('passes the live session backend target into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: any) => {
        captured.params = params;
        return {
          executor: {
            execute: vi.fn(async () => ({ ok: true, result: { ok: true } })),
          },
        };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_backend_target_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendProviderMessage: () => {},
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({ path: '/repo/current' }),
      getBackendTarget: () => ({
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      }),
    } as any);

    expect(captured.params).toBeDefined();
    expect(captured.params.getCurrentSessionBackendTarget()).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      sourceKind: 'configured',
      configuredBackendId: 'review-bot',
    });
  });

  it('passes live session location into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: any) => {
        captured.params = params;
        return {
          executor: {
            execute: vi.fn(async () => ({ ok: true, result: { ok: true } })),
          },
        };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_location_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendProviderMessage: () => {},
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({
        permissionMode: 'bypassPermissions',
        permissionModeUpdatedAt: 10,
      }),
      getCurrentSessionLocation: () => ({
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      }),
    } as any);

    expect(captured.params).toBeDefined();
    expect(captured.params.rawSession).toEqual({
      metadata: {
        permissionMode: 'bypassPermissions',
        permissionModeUpdatedAt: 10,
      },
      path: '/repo/current',
      host: 'leeroy-mbp',
      machineId: 'machine-1',
    });
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
      sendProviderMessage: () => {},
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
      sendProviderMessage: () => {},
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
      sendProviderMessage: () => {},
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
      sendProviderMessage: () => {},
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
      sendProviderMessage: () => {},
      updateMetadata: () => {},
    } as any);

    expect(captured.deps).toBeDefined();
    await expect(
      captured.deps.sessionList({ limit: 1, cursor: null, activeOnly: false, archivedOnly: false, includeSystem: false, resumableOnly: false }),
    ).resolves.toEqual({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
  });

  it('dispatches registered tools using the agent surface (internal MCP)', async () => {
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
      sendProviderMessage: () => {},
      updateMetadata: () => {},
    } as any;

    createHappierMcpServer(fakeClient);

    expect(typeof handlers.change_title).toBe('function');
    await handlers.change_title({ title: 'Hello' });
    expect(captured.surface).toBe('agent');
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
        sendProviderMessage: () => {},
        updateMetadata: () => {},
      } as any,
      { credentials: null },
    );

    expect(captured.deps).toBeDefined();
    await captured.deps.changeTitle('sess_change_title_1', 'New title');
    expect(execute).toHaveBeenCalledWith(
      'session.title.set',
      { sessionId: 'sess_change_title_1', title: 'New title' },
      { surface: 'agent', defaultSessionId: 'sess_change_title_1' },
    );
  });

  it('does not perform a redundant metadata write after change_title commits', async () => {
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
        sendProviderMessage: () => {},
        updateMetadata,
      } as any,
      { credentials: null },
    );

    expect(captured.deps).toBeDefined();
    await expect(captured.deps.changeTitle('sess_change_title_refresh_1', 'New title')).resolves.toEqual({
      success: true,
      title: 'New title',
    });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('routes direct-exposed execution_run_start through the shared action executor path', async () => {
    const invokeLocal = vi.fn(async (method: string, params: unknown) => {
      if (method === 'execution.run.start' || method === 'execution.run.send') {
        return {
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'side_1',
          request: params,
        };
      }
      return {};
    });
    const captured: { deps?: any } = {};
    const executorExecute = vi.fn(async (actionId: string, input: unknown, ctx: unknown) => ({
      ok: true,
      result: { actionId, input, ctx },
    }));

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
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: executorExecute,
        },
      }),
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_execution_run_start_1',
        rpcHandlerManager: { invokeLocal },
        sendProviderMessage: () => {},
        updateMetadata: () => {},
      } as any,
      {
        credentials: null,
        accountSettings: {
          actionsSettingsV1: {
            v: 1,
            actions: {
              'execution.run.start': {
                toolExposureModes: {
                  agent: 'direct',
                },
              },
            },
          },
        },
      } as any,
    );

    expect(captured.deps).toBeDefined();
    await captured.deps.executeActionByToolName('execution_run_start', {
      intent: 'plan',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      instructions: 'Plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(executorExecute).toHaveBeenCalledWith('execution.run.start', expect.objectContaining({
      intent: 'plan',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      instructions: 'Plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }), expect.objectContaining({
      surface: 'agent',
    }));
    expect(invokeLocal).not.toHaveBeenCalled();
  });
});
