import { describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import { z } from 'zod';

import { registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

describe('registerHappierMcpBuiltInTools', () => {
  it('adapts the complete plugin tool presentation to the MCP SDK contract', async () => {
    const registered = new Map<string, {
      meta: unknown;
      handler: (args: unknown) => Promise<unknown>;
    }>();

    registerHappierMcpBuiltInTools({
      registerTool: (name, meta, handler) => {
        registered.set(name, { meta, handler });
      },
    }, {
      sessionId: 'sess-1',
      surface: 'mcp',
      pluginToolCatalog: [{
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
          required: ['scope'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            completed: { type: 'boolean' },
          },
          required: ['completed'],
          additionalProperties: false,
        },
        safety: 'danger',
        inputHints: {
          fields: [{
            path: 'scope',
            title: { key: 'review.scope', fallback: 'Scope' },
            widget: 'select',
          }],
        },
        examples: { mcp: { argsExample: '{"scope":"diff"}' } },
        promptSnippet: 'Start an Acme review.',
        promptGuidelines: ['Choose the narrowest applicable scope.'],
        availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
        surfaces: ['agent', 'mcp', 'cli'],
      }],
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => ({ ok: true as const, result: { completed: true } }),
      },
    });

    const registration = registered.get('acme_review_start');
    const meta = registration?.meta as {
      inputSchema?: z.ZodType;
      outputSchema?: z.ZodType;
      annotations?: unknown;
      _meta?: unknown;
    } | undefined;
    expect(meta?.inputSchema?.safeParse({ scope: 'diff' }).success).toBe(true);
    expect(meta?.inputSchema?.safeParse({}).success).toBe(false);
    expect(meta?.inputSchema ? z.toJSONSchema(meta.inputSchema, { target: 'draft-7' }) : null).toMatchObject({
      type: 'object',
      properties: {
        scope: { type: 'string' },
      },
      required: ['scope'],
      additionalProperties: false,
    });
    expect(meta?.outputSchema ? z.toJSONSchema(meta.outputSchema, { target: 'draft-7' }) : null).toMatchObject({
      type: 'object',
      properties: {
        completed: { type: 'boolean' },
      },
      required: ['completed'],
      additionalProperties: false,
    });
    expect(meta?.annotations).toEqual({ destructiveHint: true });
    expect(meta?._meta).toEqual({
      'happier.dev/pluginTool': {
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/review-start',
        safety: 'danger',
        inputHints: {
          fields: [{
            path: 'scope',
            title: { key: 'review.scope', fallback: 'Scope' },
            widget: 'select',
          }],
        },
        examples: { mcp: { argsExample: '{"scope":"diff"}' } },
        promptSnippet: 'Start an Acme review.',
        promptGuidelines: ['Choose the narrowest applicable scope.'],
        availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
      },
    });
    await expect(registration?.handler({ scope: 'diff' })).resolves.toEqual({
      content: [{ type: 'text', text: '{"completed":true}' }],
      structuredContent: { completed: true },
      isError: false,
    });
  });

  it('registers model-list tools with schemas that accept canonical V2 backend target keys', async () => {
    const cases = [
      {
        surface: 'mcp' as const,
        actionsSettings: null,
      },
      {
        surface: 'agent' as const,
        actionsSettings: ActionsSettingsV1Schema.parse({
          v: 1,
          actions: {
            'agents.models.list': {
              toolExposureModes: {
                agent: 'direct',
              },
            },
          },
        }),
      },
    ];

    for (const item of cases) {
      const registered = new Map<string, {
        meta: { inputSchema?: { safeParse?: (value: unknown) => { success: boolean } } };
        handler: (args: unknown, extra?: unknown) => Promise<unknown>;
      }>();
      const executeActionByToolName = vi.fn(async (_toolName: string, args: unknown) => ({
        ok: true as const,
        result: { args },
      }));

      registerHappierMcpBuiltInTools({
        registerTool: (name, meta, handler) => {
          registered.set(name, {
            meta: meta as { inputSchema?: { safeParse?: (value: unknown) => { success: boolean } } },
            handler: handler as (args: unknown, extra?: unknown) => Promise<unknown>,
          });
        },
      }, {
        sessionId: 'sess-1',
        surface: item.surface,
        actionsSettings: item.actionsSettings,
        deps: {
          changeTitle: async () => ({ success: true }),
          executeActionByToolName,
        },
      });

      const tool = registered.get('agents_models_list');
      expect(tool).toBeTruthy();
      const input = { backendTargetKey: 'backend:codex', limit: 1 };
      expect(tool?.meta.inputSchema?.safeParse?.(input)?.success).toBe(true);

      await expect(tool?.handler(input)).resolves.toEqual({
        content: [{ type: 'text', text: JSON.stringify({ args: input }) }],
        isError: false,
      });
      if (item.surface === 'agent') {
        expect(executeActionByToolName).toHaveBeenCalledWith(
          'agents_models_list',
          input,
          'sess-1',
          {
            approvalOrigin: {
              kind: 'transcript_tool_call',
              sessionId: 'sess-1',
              toolName: 'agents_models_list',
            },
          },
        );
      } else {
        expect(executeActionByToolName).toHaveBeenCalledWith(
          'agents_models_list',
          input,
          'sess-1',
        );
      }
    }
  });

  it('allows direct session action tools to rely on the MCP default session target', () => {
    const registered = new Map<string, unknown>();

    registerHappierMcpBuiltInTools({
      registerTool: (name, meta) => {
        registered.set(name, meta);
      },
    }, {
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => ({ ok: true as const, result: { status: 'cleared' } }),
      },
    });

    const meta = registered.get('session_terminal_composer_clear') as { inputSchema?: { safeParse?: (value: unknown) => { success: boolean } } } | undefined;
    expect(meta).toBeTruthy();
    expect(meta?.inputSchema?.safeParse?.({})?.success).toBe(true);
    expect(meta?.inputSchema?.safeParse?.({ sessionId: 'sess-2' })?.success).toBe(true);
  });

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
            agent: 'direct',
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
      surface: 'agent',
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

  it('returns valid MCP text content when a direct action succeeds without a result payload', async () => {
    const handlers = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();

    registerHappierMcpBuiltInTools({
      registerTool: (name, _meta, handler) => {
        handlers.set(name, handler as (args: unknown, extra?: unknown) => Promise<unknown>);
      },
    }, {
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => ({ ok: true as const, result: undefined }),
      },
    });

    const handler = handlers.get('session_permission_respond');
    if (!handler) throw new Error('Expected session_permission_respond to be registered');

    await expect(handler({
      requestId: 'workspace-indexing-permission',
      decision: 'deny',
    })).resolves.toEqual({
      content: [{ type: 'text', text: 'null' }],
      isError: false,
    });
  });
});
