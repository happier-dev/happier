const { activeRuntimeRegistryState } = vi.hoisted(() => ({
  activeRuntimeRegistryState: {
    registry: null as import('@/plugins/projection/registry/types').ResolvedContributionRegistry | null,
  },
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: () => ({
      activeRegistry: activeRuntimeRegistryState.registry
        ? {
            contributes: activeRuntimeRegistryState.registry,
            targetActionInvocations: {
              evaluateCatalogPolicy: () => ({
                outcome: 'visible',
                code: 'plugin_action_available',
                requiresCurrentIntent: false,
              }),
            },
          }
        : null,
    }),
    isRuntimeRegistryCurrent: () => true,
  },
}));

import { describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';

describe('createActionToolExecutorBridge', () => {
  it('preserves V2 session spawn option context for the canonical action options resolver', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return {
            ok: true,
            result: {
              actionId: 'session.spawn_new',
              fieldPath: 'modelSelection',
              optionsSourceId: 'agents.models.available',
              options: [],
            },
          };
        },
      },
    });
    const sessionSpawnOptionContext = {
      executionTarget: { serverId: 'local', machineId: 'm1' },
      directory: '/repo',
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      modelSelection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'backend:claude', modelId: 'claude-opus-4-8' },
      },
    } as const;

    await expect(bridge.resolveActionOptions({
      actionId: 'session.spawn_new',
      fieldPath: 'modelSelection',
      optionsSourceId: null,
      sessionId: null,
      limit: 10,
      query: null,
      ...sessionSpawnOptionContext,
    } as Parameters<typeof bridge.resolveActionOptions>[0] & typeof sessionSpawnOptionContext, 'sess-1')).resolves.toEqual({
      ok: true,
      result: {
        actionId: 'session.spawn_new',
        fieldPath: 'modelSelection',
        optionsSourceId: 'agents.models.available',
        options: [],
      },
    });

    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'action.options.resolve',
        input: {
          actionId: 'session.spawn_new',
          fieldPath: 'modelSelection',
          limit: 10,
          ...sessionSpawnOptionContext,
        },
        ctx: expect.objectContaining({ defaultSessionId: 'sess-1', surface: 'mcp' }),
      }),
    ]);
  });

  it('does not route discoverable-only first-party tools through direct tool names on session agents', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
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
            agent: 'direct',
          },
        },
      },
    });
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
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
        surface: 'agent',
        approvalOrigin,
      }),
    ]);
  });

  it('stamps the active turn causal authority onto agent execution-run actions', async () => {
    const calls: unknown[] = [];
    const causalPermissionAuthority = {
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'default',
    } as const;
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      resolveCallerPermissionMode: () => 'yolo',
      resolveCausalPermissionAuthority: () => causalPermissionAuthority,
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return { ok: true, result: { ok: true } };
        },
      },
    });

    await expect(bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.start',
      input: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Inspect the change.',
        permissionMode: 'yolo',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    }, 'sess-1')).resolves.toEqual({ ok: true, result: {} });

    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'execution.run.start',
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'agent',
          callerPermissionMode: 'yolo',
          causalPermissionAuthority,
        }),
      }),
    ]);
  });

  it('parses JSON-string action_execute input before invoking the action executor', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return {
            ok: true,
            result: { ok: true },
          };
        },
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'session.transcript.get',
      input: '{"sessionId":"sess-2","limit":20,"roles":["user","assistant"]}',
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { ok: true },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'session.transcript.get',
        input: {
          sessionId: 'sess-2',
          limit: 20,
          roles: ['user', 'assistant'],
        },
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'agent',
          actionsSettings: null,
        }),
      }),
    ]);
  });

  it('preserves structured error details returned by action_execute', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      executor: {
        execute: async () => ({
          ok: false,
          errorCode: 'permission_escalation_denied',
          error: 'permission_escalation_denied',
          details: {
            reason: 'permission_escalation_denied',
            surface: 'agent',
            requestedOrdinal: 3,
            callerOrdinal: 1,
          },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'session.spawn_new',
      input: { permissionMode: 'yolo' },
    }, 'sess-1');

    expect(res).toEqual({
      ok: false,
      errorCode: 'permission_escalation_denied',
      error: 'permission_escalation_denied',
      details: {
        reason: 'permission_escalation_denied',
        surface: 'agent',
        requestedOrdinal: 3,
        callerOrdinal: 1,
      },
    });
  });

  it('uses the default session id as the fallback action_execute input sessionId', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return {
            ok: true,
            result: { ok: true },
          };
        },
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'session.terminalComposer.clear',
      input: '{}',
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { ok: true },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'session.terminalComposer.clear',
        input: {
          sessionId: 'sess-1',
        },
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'mcp',
          actionsSettings: null,
        }),
      }),
    ]);
  });

  it('uses the default session id as the fallback direct action tool input sessionId', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return {
            ok: true,
            result: { ok: true },
          };
        },
      },
    });

    const res = await bridge.executeActionByToolName('session_terminal_composer_clear', {}, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { ok: true },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'session.terminalComposer.clear',
        input: {
          sessionId: 'sess-1',
        },
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'mcp',
          actionsSettings: null,
        }),
      }),
    ]);
  });

  it('preserves explicit direct action tool session ids on external mcp', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return {
            ok: true,
            result: { ok: true },
          };
        },
      },
    });

    const res = await bridge.executeActionByToolName('session_terminal_composer_clear', {
      sessionId: 'sess-2',
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { ok: true },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'session.terminalComposer.clear',
        input: {
          sessionId: 'sess-2',
        },
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'mcp',
          actionsSettings: null,
        }),
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
      errorCode: 'execution_run_wait_timeout',
      error: 'Execution run wait timed out',
      details: { runId: 'run-1' },
    });
  });

  it('routes plugin action-backed tool names through the shared executor without a parallel dispatcher', async () => {
    const registry = createResolvedContributionRegistry({
      agents: [],
            actions: [
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.review.plugin',
          manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
          daemonEntryPath: '/plugins/acme/review/daemon.mjs',
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme/review',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
          },
          definition: {
            kindVersion: 1,
            id: 'review-start',
            title: 'Acme Review Start',
            description: 'Start a plugin-defined review workflow',
            safety: 'safe',
            dangerLevel: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui: false,
              voice: false,
              agent: true,
              mcp: true,
              cli: true,
              rpc: false,
              sdk: false,
              plugin: false,
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
      tools: [
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'acme.review.plugin',
          manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
          daemonEntryPath: '/plugins/acme/review/daemon.mjs',
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme/review',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
          },
          definition: {
            kindVersion: 1,
            id: 'review-tool',
            name: 'acme_review_start',
            title: 'Acme Review Start',
            description: 'Start a plugin-defined review workflow',
            safety: 'safe',
            surfaces: ['cli'],
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: true,
            },
            action: 'review-start',
            actionId: 'acme.review.plugin/review-start',
          },
        },
      ],
    });
    activeRuntimeRegistryState.registry = registry;
    const bridge = createActionToolExecutorBridge({
      surface: 'cli',
      registry,
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
        actionId: 'acme.review.plugin/review-start',
        input: { scope: 'diff' },
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'cli',
          actionsSettings: null,
        }),
      },
    });
  });

  it('carries an admitted plugin generation through direct and generic action execution', async () => {
    const calls: Array<{ actionId: string; context: unknown }> = [];
    const pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[] = [{
      toolId: 'acme.composition/review-tool',
      actionId: 'acme.composition/review-start',
      name: 'acme_composition_review_start',
      title: 'Acme composition review',
      description: 'Run the composition-selected review action.',
      inputSchema: { type: 'object', additionalProperties: false },
      safety: 'safe',
      surfaces: ['agent'],
      expectedContributorImmutableGenerationId: 'generation-g',
    }];
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      pluginToolCatalog,
      executor: {
        execute: async (actionId, _input, context) => {
          calls.push({ actionId, context });
          return { ok: true, result: { actionId } };
        },
      },
    });

    await expect(bridge.executeActionByToolName(
      'acme_composition_review_start',
      {},
      'sess-1',
    )).resolves.toEqual({ ok: true, result: { actionId: 'acme.composition/review-start' } });
    await expect(bridge.executeActionByToolName('action_execute', {
      actionId: 'acme.composition/review-start',
      input: {},
    }, 'sess-1')).resolves.toEqual({ ok: true, result: { actionId: 'acme.composition/review-start' } });

    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'acme.composition/review-start',
        context: expect.objectContaining({
          expectedContributorImmutableGenerationId: 'generation-g',
        }),
      }),
      expect.objectContaining({
        actionId: 'acme.composition/review-start',
        context: expect.objectContaining({
          expectedContributorImmutableGenerationId: 'generation-g',
        }),
      }),
    ]);
  });

  // CON-4: the in-transcript agent tool dispatch chokepoint MUST tag the executor context with
  // `surface: 'agent'` by default. The agent approval floor at
  // `isApprovalRequiredByActionsSettings` only fires on that surface tag — if this chokepoint ever
  // tagged a different surface, the entire derived danger floor (CON-1/CON-2/CON-3) would be inert.
  it('defaults the agent dispatch context surface to agent so the danger floor fires (CON-4)', async () => {
    const calls: { surface?: unknown }[] = [];
    const bridge = createActionToolExecutorBridge({
      // surface intentionally omitted — the agent entrypoint default is the chokepoint under test.
      executor: {
        execute: async (_actionId, _input, ctx) => {
          calls.push(ctx as { surface?: unknown });
          return { ok: true, result: { ok: true } };
        },
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'browser.automation.click',
      input: '{}',
    }, 'sess-1');

    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({ surface: 'agent' }),
    ]);
  });
});
