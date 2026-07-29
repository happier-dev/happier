import { beforeEach, describe, expect, it, vi } from 'vitest';

const daemonBoundary = vi.hoisted(() => ({
  readCatalog: vi.fn(),
  executeAction: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  readDaemonPluginCatalog: daemonBoundary.readCatalog,
  requestDaemonPluginActionExecution: daemonBoundary.executeAction,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: vi.fn(async () => ({
    ok: true,
    sessionId: 'sess-1',
    rawSession: {
      id: 'sess-1',
      metadata: {},
    },
    ctx: { type: 'plain' as const },
    mode: 'plain' as const,
  })),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: vi.fn(),
}));

import { callBuiltInHappierTool } from './callBuiltInHappierTool';

describe('callBuiltInHappierTool plugin tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    daemonBoundary.readCatalog.mockResolvedValue({
      kind: 'available',
      plugins: [],
      tools: [{
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/review-start',
        name: 'acme_review_start',
        title: 'Acme Review Start',
        description: 'Start a plugin-defined review workflow',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
          },
          additionalProperties: false,
        },
        surfaces: ['agent', 'mcp', 'cli'],
      }],
    });
    daemonBoundary.executeAction.mockResolvedValue({
      matched: true,
      result: {
        ok: true,
        result: { completed: true },
      },
    });
  });

  it('discovers and dispatches a daemon-projected tool through the CLI source entrypoint', async () => {
    const result = await callBuiltInHappierTool({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      toolName: 'acme_review_start',
      args: { scope: 'diff' },
    });

    expect(result).toEqual({
      ok: true,
      result: { completed: true },
    });
    expect(daemonBoundary.executeAction).toHaveBeenCalledWith({
      actionId: 'acme.review.plugin/review-start',
      input: { scope: 'diff' },
      surface: 'cli',
      defaultSessionId: 'sess-1',
    });
  });
});
