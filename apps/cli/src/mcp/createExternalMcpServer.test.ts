import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExternalMcpServer as createExternalMcpServerStatic } from '@/mcp/createExternalMcpServer';

const env = process.env;

function isStartExecutionRun(value: unknown): value is (sessionId: string, request: unknown) => Promise<unknown> {
  return typeof value === 'function';
}

describe('createExternalMcpServer', () => {
  beforeEach(() => {
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('returns toolNames aligned with per-surface action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['mcp'], disabledPlacements: [] },
      },
    });

    const { toolNames } = createExternalMcpServerStatic({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });

    expect(toolNames).not.toContain('review_start');
  });

  it('includes action-backed tools and the action_execute escape hatch', async () => {
    const { toolNames } = createExternalMcpServerStatic({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });

    expect(toolNames).toEqual(expect.arrayContaining(['action_execute', 'session_list']));
  });

  it('registers action-spec resources for the mcp surface', async () => {
    vi.resetModules();

    let capturedSurface: string | undefined;
    vi.doMock('@/mcp/resources/registerHappierMcpResources', () => ({
      registerHappierMcpResources: (_server: any, opts: any) => {
        capturedSurface = opts?.surface;
      },
    }));

    const { createExternalMcpServer } = await import('@/mcp/createExternalMcpServer');

    createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });

    expect(capturedSurface).toBe('mcp');
  });

  it('uses the canonical plain Session crypto context for token-only credentials', async () => {
    vi.resetModules();

    let capturedHarnessParams: Record<string, unknown> | null = null;
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: Record<string, unknown>) => {
        capturedHarnessParams = params;
        return {
          executor: {
            execute: async () => ({ ok: false, errorCode: 'not_implemented' }),
          },
        };
      },
    }));

    const { createExternalMcpServer } = await import('@/mcp/createExternalMcpServer');
    const credentials = {
      token: 'plain-token',
      encryption: null,
    } as const;

    createExternalMcpServer({ credentials });

    expect(capturedHarnessParams).toMatchObject({
      credentials,
      token: 'plain-token',
      mode: 'plain',
      ctx: null,
    });
  });

  it('passes through approval_request_created for execution_run_start tool calls via the shared action executor', async () => {
    vi.resetModules();

    let capturedExecuteActionByToolName: unknown = null;

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class FakeMcpServer {
        registerResource() {}
        registerTool() {}
      },
    }));

    vi.doMock('@/mcp/resources/registerHappierMcpResources', () => ({
      registerHappierMcpResources: () => {},
    }));

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: any, params: any) => {
        capturedExecuteActionByToolName = params?.deps?.executeActionByToolName ?? null;
        return { toolNames: [] };
      },
    }));

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: async (actionId: string) => ({
            ok: true,
            result: { kind: 'approval_request_created', artifactId: 'a1', actionId },
          }),
        },
      }),
    }));

    const { createExternalMcpServer } = await import('@/mcp/createExternalMcpServer');

    createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });

    expect(typeof capturedExecuteActionByToolName).toBe('function');

    if (!capturedExecuteActionByToolName) {
      throw new Error('expected executeActionByToolName to be registered');
    }

    if (typeof capturedExecuteActionByToolName !== 'function') {
      throw new Error('expected executeActionByToolName to be callable');
    }

    const res = await capturedExecuteActionByToolName('execution_run_start', {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      instructions: 'Review.',
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'execution.run.start' },
    });
  });

  it('passes through approval_request_created for change_title tool calls', async () => {
    vi.resetModules();

    let capturedChangeTitle: unknown = null;

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class FakeMcpServer {
        registerResource() {}
        registerTool() {}
      },
    }));

    vi.doMock('@/mcp/resources/registerHappierMcpResources', () => ({
      registerHappierMcpResources: () => {},
    }));

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: any, params: any) => {
        capturedChangeTitle = params?.deps?.changeTitle ?? null;
        return { toolNames: [] };
      },
    }));

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: async (actionId: string) => ({
            ok: true,
            result: { kind: 'approval_request_created', artifactId: 'a1', actionId },
          }),
        },
      }),
    }));

    const { createExternalMcpServer } = await import('@/mcp/createExternalMcpServer');

    createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });

    expect(typeof capturedChangeTitle).toBe('function');
    if (!capturedChangeTitle || typeof capturedChangeTitle !== 'function') {
      throw new Error('expected changeTitle to be registered');
    }

    const res = await (capturedChangeTitle as (sessionId: string, title: string) => Promise<unknown>)(
      'sess-1',
      'hello',
    );

    expect(res).toEqual({
      kind: 'approval_request_created',
      artifactId: 'a1',
      actionId: 'session.title.set',
    });
  });

  it('retains a real MCP primary target while excluding unowned tracked targeting', async () => {
    vi.doUnmock('@/mcp/resources/registerHappierMcpResources');
    vi.doUnmock('@/mcp/server/registerHappierMcpBuiltInTools');
    vi.resetModules();

    type ToolHandler = (args: unknown, extra?: unknown) => Promise<unknown>;
    type PrimaryTargetSetter = (args: Readonly<{ sessionId: string | null }>) => Promise<unknown>;

    const handlers = new Map<string, ToolHandler>();

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class FakeMcpServer {
        registerResource() {}
        registerTool(name: string, _meta: unknown, handler: ToolHandler) {
          handlers.set(name, handler);
        }
      },
    }));

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (
        _params: unknown,
        overrides?: Readonly<{ sessionTargetPrimarySet?: PrimaryTargetSetter }>,
      ) => ({
        executor: {
          execute: async (actionId: string, input: unknown, context: Readonly<{ defaultSessionId: string }>) => {
            if (actionId === 'session.target.primary.set') {
              const sessionId = input && typeof input === 'object' && !Array.isArray(input)
                && typeof (input as Readonly<{ sessionId?: unknown }>).sessionId === 'string'
                ? (input as Readonly<{ sessionId: string }>).sessionId
                : null;
              return {
                ok: true as const,
                result: await overrides?.sessionTargetPrimarySet?.({ sessionId }),
              };
            }
            return {
              ok: true as const,
              result: { defaultSessionId: context.defaultSessionId },
            };
          },
        },
      }),
    }));

    const { createExternalMcpServer } = await import('@/mcp/createExternalMcpServer');
    const { toolNames } = createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });

    expect(toolNames).not.toContain('session_target_tracked_set');

    const setPrimary = handlers.get('session_target_primary_set');
    const listSessions = handlers.get('session_list');
    expect(setPrimary).toBeDefined();
    expect(listSessions).toBeDefined();

    await expect(setPrimary?.({ sessionId: 'sess-primary' })).resolves.toMatchObject({ isError: false });
    const listResult = await listSessions?.({}) as Readonly<{
      isError: boolean;
      content: readonly Readonly<{ type: string; text: string }>[];
    }>;
    expect(listResult.isError).toBe(false);
    expect(JSON.parse(listResult.content[0]?.text ?? '{}')).toEqual({ defaultSessionId: 'sess-primary' });
  });

});
