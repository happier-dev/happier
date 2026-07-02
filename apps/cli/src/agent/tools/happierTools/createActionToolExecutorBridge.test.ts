import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';

describe('createActionToolExecutorBridge', () => {
  it('does not route discoverable-only first-party tools through direct tool names on session agents', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return {
            ok: true,
            result: { actionId, input, ctx },
          };
        },
      },
    });

    const res = await bridge.executeActionByToolName('subagents_delegate_start', {
      sessionId: 'sess-1',
      backendTargetKeys: ['agent:codex'],
      instructions: 'Delegate this.',
    }, 'sess-1');

    expect(res).toEqual({
      ok: false,
      errorCode: 'unknown_tool',
      error: 'Unknown action-backed tool: subagents_delegate_start',
    });
    expect(calls).toEqual([]);
  });

  it('passes approval origin metadata through to action executor context', async () => {
    const calls: unknown[] = [];
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
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      actionsSettings,
      executor: {
        execute: async (_actionId, _input, ctx) => {
          calls.push(ctx);
          return {
            ok: true,
            result: { sessions: [] },
          };
        },
      },
    });

    const approvalOrigin = {
      kind: 'transcript_tool_call' as const,
      sessionId: 'sess-1',
      toolCallId: 'tool-1',
      toolName: 'session_list',
      toolInput: { limit: 20 },
    };
    const res = await bridge.executeActionByToolName('session_list', { limit: 20 }, 'sess-1', { approvalOrigin });

    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        defaultSessionId: 'sess-1',
        surface: 'session_agent',
        approvalOrigin,
      }),
    ]);
  });

  it('passes through approval_request_created results for execution.run.* actions', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async (actionId) => ({
          ok: true,
          result: { kind: 'approval_request_created', artifactId: 'a1', actionId },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.start',
      input: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'execution.run.start' },
    });
  });

  it('normalizes execution.run.wait success payloads instead of returning undefined tool content', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async () => ({
          ok: true,
          result: {
            ok: true,
            status: 'failed',
            result: {
              run: {
                runId: 'run-1',
                status: 'failed',
              },
            },
          },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.wait',
      input: {
        sessionId: 'sess-1',
        runId: 'run-1',
        timeoutSeconds: 5,
      },
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: {
        status: 'failed',
        result: {
          run: {
            runId: 'run-1',
            status: 'failed',
          },
        },
      },
    });
  });

  it('normalizes execution.run.wait timeout payloads into tool errors', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async () => ({
          ok: true,
          result: {
            ok: false,
            code: 'timeout',
          },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.wait',
      input: {
        sessionId: 'sess-1',
        runId: 'run-1',
        timeoutSeconds: 5,
      },
    }, 'sess-1');

    expect(res).toEqual({
      ok: false,
      errorCode: 'timeout',
      error: 'timeout',
    });
  });

  it('routes plugin action-backed tool names through the shared executor without a parallel dispatcher', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'cli',
      registry: createResolvedContributionRegistry({
        providers: [],
        backends: [],
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
              id: 'acme.review.start',
              title: 'Acme Review Start',
              description: 'Start a plugin-defined review workflow',
              safety: 'safe',
              placements: [],
              slash: null,
              bindings: {
                mcpToolName: 'acme_review_start',
              },
              examples: null,
              surfaces: {
                ui: false,
                voice: false,
                session_agent: true,
                mcp: true,
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
                  exportName: 'startReview',
                },
              },
            },
          },
        ],
      }),
      executor: {
        execute: async (actionId, input, ctx) => ({
          ok: true,
          result: { actionId, input, ctx },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('acme_review_start', {
      scope: 'diff',
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: {
        actionId: 'acme.review.start',
        input: { scope: 'diff' },
        ctx: {
          defaultSessionId: 'sess-1',
          surface: 'cli',
        },
      },
    });
  });
});
