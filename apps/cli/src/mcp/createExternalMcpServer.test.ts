import { beforeEach, describe, expect, it, vi } from 'vitest';

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

    expect(toolNames).not.toContain('review_start');
  });

  it('includes action-backed tools and the action_execute escape hatch', async () => {
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

  it('passes through approval_request_created for execution.run.start tool calls', async () => {
    vi.resetModules();

    let capturedStartExecutionRun: unknown = null;

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
        capturedStartExecutionRun = params?.deps?.startExecutionRun ?? null;
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

    expect(typeof capturedStartExecutionRun).toBe('function');

    if (!capturedStartExecutionRun) {
      throw new Error('expected startExecutionRun to be registered');
    }

    if (!isStartExecutionRun(capturedStartExecutionRun)) {
      throw new Error('expected startExecutionRun to be callable');
    }

    const res = await capturedStartExecutionRun('sess-1', {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

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
});
