import { describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

describe('registerHappierMcpBuiltInTools', () => {
  it('does not let process action settings disable built-in MCP tools when no predicate is provided', () => {
    const previous = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    const registered: string[] = [];

    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': { enabled: true, disabledSurfaces: ['mcp'], disabledPlacements: [] },
      },
    });

    try {
      registerHappierMcpBuiltInTools({
        registerTool: (name) => {
          registered.push(name);
        },
      }, {
        sessionId: 'sess-1',
        surface: 'mcp',
        deps: {
          changeTitle: async () => ({ success: true }),
          executeActionByToolName: async () => ({ ok: true as const, result: { sessions: [] } }),
        },
      });

      expect(registered).toContain('session_list');
    } finally {
      if (previous === undefined) {
        delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      } else {
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previous;
      }
    }
  });

  it('derives approval origin metadata from MCP tool call context for session-agent tools', async () => {
    const handlers = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();
    const executeActionByToolName = vi.fn(async () => ({ ok: true as const, result: { sessions: [] } }));
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.list': {
          toolExposureModes: {
            session_agent: 'direct',
          },
        },
      },
    });

    registerHappierMcpBuiltInTools({
      registerTool: (name, _meta, handler) => {
        handlers.set(name, handler as (args: unknown, extra?: unknown) => Promise<unknown>);
      },
    }, {
      sessionId: 'sess-1',
      surface: 'session_agent',
      actionsSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    const handler = handlers.get('session_list');
    if (!handler) throw new Error('Expected session_list to be registered');

    await handler({ limit: 20, ignoredSecret: 'must-not-be-persisted-in-origin' }, { requestId: 'jsonrpc-request-1' });

    expect(executeActionByToolName).toHaveBeenCalledWith(
      'session_list',
      { limit: 20, ignoredSecret: 'must-not-be-persisted-in-origin' },
      'sess-1',
      {
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'sess-1',
          toolCallId: 'jsonrpc-request-1',
          mcpRequestId: 'jsonrpc-request-1',
          toolName: 'session_list',
        },
      },
    );
  });
});
