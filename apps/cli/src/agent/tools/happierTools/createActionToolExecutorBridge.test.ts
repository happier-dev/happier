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
import {
  ActionsSettingsV1Schema,
  createActionExecutor,
  markSessionListQueryResultV1,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { SessionBoardGetInputV1Schema } from '@happier-dev/protocol/sessions/board';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';

describe('createActionToolExecutorBridge', () => {
  it('refuses generic and previously admitted direct calls when current Action availability changes', async () => {
    // Session listing crosses the authenticated server boundary; admission and dispatch stay real.
    const sessionList = vi.fn(async () => markSessionListQueryResultV1({
      sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false,
    }));
    const executor = createActionExecutor({
      ...createCliActionDeps({ token: 'test-token', sessionId: 'lead', mode: 'plain', ctx: null }),
      sessionList,
      isActionApprovalRequired: () => false,
    });
    let enabled = true;
    const bridge = createActionToolExecutorBridge({
      surface: 'agent', executor, requiredDirectActionIds: ['session.list'],
      isActionEnabled: (id) => id !== 'session.list' || enabled,
    });
    await expect(bridge.executeActionByToolName('session_list', {}, 'lead')).resolves.toEqual({ ok: true, result: expect.anything() });
    sessionList.mockClear();
    enabled = false;
    for (const [toolName, args] of [
      ['action_execute', { actionId: 'session.list', input: {} }],
      ['session_list', {}],
    ] as const) {
      await expect(bridge.executeActionByToolName(toolName, args, 'lead')).resolves.toMatchObject({
        ok: false, errorCode: 'action_disabled', details: { reason: 'disabled_by_policy' },
      });
    }
    expect(sessionList).not.toHaveBeenCalled();
    enabled = true;
    await expect(bridge.executeActionByToolName('action_execute', { actionId: 'session.list', input: {} }, 'lead'))
      .resolves.toMatchObject({ ok: true });
  });

  it('defaults normal agent listing to the led subtree and retains an explicitly restricted corpus', async () => {
    // The list port is the authenticated server HTTP boundary; the bridge and executor stay real.
    const sessionList = vi.fn(async () => markSessionListQueryResultV1({
      sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false,
    }));
    const executor = createActionExecutor({
      ...createCliActionDeps({ token: 'test-token', sessionId: 'lead', mode: 'plain', ctx: null }),
      sessionList,
      isActionApprovalRequired: () => false,
    });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', executor });
    const result = await bridge.executeActionByToolName('action_execute', { actionId: 'session.list', input: {} }, 'lead');
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ underSessionId: 'lead' }) }));
    const restricted = createActionToolExecutorBridge({
      surface: 'agent', executor, resolveSessionListAccess: () => 'current_session',
    });
    sessionList.mockClear();
    await expect(restricted.executeActionByToolName('action_execute', { actionId: 'session.list', input: { underSessionId: 'lead' } }, 'lead'))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('keeps current-Session Board tools on the host-bound Session before family dispatch', async () => {
    const sessionBoardAction = vi.fn(async (args: Parameters<NonNullable<ActionExecutorDeps['sessionBoardAction']>>[0]) => {
      const input = SessionBoardGetInputV1Schema.parse(args.input);
      return {
        v: 1 as const,
        serverId: args.context.serverId ?? 'home-1',
        sessionId: input.sessionId ?? args.context.defaultSessionId ?? 'missing-session',
        capabilities: { readTranscript: true, editSessionRecords: true },
        layout: null,
        items: [],
        incomplete: false,
        page: { cursor: null, hasNext: false },
      };
    });
    const executor = createActionExecutor({
      ...createCliActionDeps({ token: 'test-token', sessionId: 'session-1', mode: 'plain', ctx: null }),
      sessionBoardAction,
      isActionApprovalRequired: () => false,
    });
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      executor: {
        execute: (actionId, input, context) => executor.execute(actionId, input, {
          ...context,
          serverId: 'home-1',
        }),
      },
    });
    const executeBoardGet = async (input: unknown) => await bridge.executeActionByToolName(
      'action_execute',
      { actionId: 'session.board.get', input },
      'session-1',
    );

    await expect(executeBoardGet({ sessionId: 'session-2' })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.board.get',
    });
    expect(sessionBoardAction).not.toHaveBeenCalled();

    await expect(executeBoardGet({})).resolves.toMatchObject({
      ok: true,
      result: { serverId: 'home-1', sessionId: 'session-1' },
    });
    await expect(executeBoardGet({ sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      result: { serverId: 'home-1', sessionId: 'session-1' },
    });
    expect(sessionBoardAction).toHaveBeenCalledTimes(2);
  });

  it('executes a Run-required Session read through the canonical Action bridge without widening mutations', async () => {
    const execute = vi.fn(async (actionId: string, input: unknown) => ({
      ok: true as const,
      result: { actionId, input },
    }));
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      executor: { execute },
      requiredDirectActionIds: ['session.transcript.get'],
    });

    await expect(bridge.executeActionByToolName(
      'session_transcript_get',
      { limit: 10 },
      'sess-1',
    )).resolves.toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledWith(
      'session.transcript.get',
      expect.objectContaining({ sessionId: 'sess-1', limit: 10 }),
      expect.objectContaining({ defaultSessionId: 'sess-1', surface: 'agent' }),
    );

    await expect(bridge.executeActionByToolName(
      'session_discussion_post',
      { discussionId: 'discussion-1', content: { v: 1, parts: [{ t: 'text', text: 'No' }] } },
      'sess-1',
    )).resolves.toMatchObject({ ok: false, errorCode: 'unknown_tool' });
  });

  it('preserves an explicit discoverable-only preference for a Run-required read', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      executor: { execute: vi.fn(async () => ({ ok: true as const, result: {} })) },
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: {
          'session.transcript.get': { toolExposureModes: { agent: 'discoverable_only' } },
        },
      }),
      requiredDirectActionIds: ['session.transcript.get'],
    });

    await expect(bridge.executeActionByToolName(
      'session_transcript_get',
      { limit: 10 },
      'sess-1',
    )).resolves.toMatchObject({ ok: false, errorCode: 'unknown_tool' });
  });

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
        ref: { agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'claude-opus-4-8' },
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

  it('forwards canonical draftInput through the public option bridge', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      executor: {
        execute: async (actionId, input) => {
          calls.push({ actionId, input });
          return {
            ok: true,
            result: {
              actionId: 'subagents.delegate.start',
              fieldPath: 'modelId',
              optionsSourceId: 'agents.models.available',
              options: [],
            },
          };
        },
      },
    });

    await bridge.resolveActionOptions({
      actionId: 'subagents.delegate.start',
      fieldPath: 'modelId',
      optionsSourceId: null,
      sessionId: null,
      limit: null,
      query: null,
      draftInput: { backendTargetKeys: ['agent:pi'] },
    }, 'session_current');

    expect(calls).toEqual([{
      actionId: 'action.options.resolve',
      input: {
        actionId: 'subagents.delegate.start',
        fieldPath: 'modelId',
        draftInput: { backendTargetKeys: ['agent:pi'] },
      },
    }]);
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

  it('stamps only an explicitly host-bound current Session corpus for external MCP', async () => {
    const contexts: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      resolveSessionListAccess: (sessionId) => (
        sessionId === 'sess-bound' ? 'current_session' : undefined
      ),
      executor: {
        execute: async (_actionId, _input, context) => {
          contexts.push(context);
          return { ok: true, result: { sessions: [] } };
        },
      },
    });

    await bridge.executeActionByToolName(
      'session_list',
      {},
      'sess-bound',
      { actionRequestId: 'mcp-request-1' },
    );
    await bridge.executeActionByToolName('session_list', {}, 'cli-global');

    expect(contexts).toEqual([
      expect.objectContaining({
        surface: 'mcp',
        defaultSessionId: 'sess-bound',
        actionRequestId: 'mcp-request-1',
        sessionListAccess: 'current_session',
      }),
      expect.not.objectContaining({ sessionListAccess: expect.anything() }),
    ]);
  });

  it('stamps automation identity and active turn causal authority onto Agent execution-run actions', async () => {
    const calls: unknown[] = [];
    const causalPermissionAuthority = {
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'default',
    } as const;
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      resolveCallerPermissionMode: () => 'yolo',
      resolveActiveTurnPermissionWitness: () => ({
        turnId: 'turn-active',
        causalPermissionAuthority,
      }),
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
          authority: 'account_automation',
          causalPermissionAuthority,
        }),
      }),
    ]);
  });

  it('never combines causal authority from one active turn with the next active turn id', async () => {
    const calls: unknown[] = [];
    const turnAWitness = Object.freeze({
      turnId: 'turn-a',
      causalPermissionAuthority: Object.freeze({
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'yolo' as const,
      }),
    });
    let activeTurn: Readonly<{
      turnId: string;
      causalPermissionAuthority: Readonly<{
        kind: 'admittedSessionInputV1';
        admittedPermissionCeiling: string;
      }>;
    }> = turnAWitness;
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      resolveActiveTurnPermissionWitness: async () => {
        const witness = activeTurn;
        activeTurn = {
          turnId: 'turn-b',
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'read_only',
          },
        } as const;
        return witness;
      },
      executor: {
        execute: async (_actionId, _input, ctx) => {
          calls.push(ctx);
          return { ok: true, result: { ok: true } };
        },
      },
    });

    await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.start',
      input: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Inspect the change.',
      },
    }, 'sess-1');

    expect(calls).toEqual([
      expect.objectContaining({
        causalPermissionAuthority: expect.objectContaining({ admittedPermissionCeiling: 'yolo' }),
        sessionInputSource: expect.objectContaining({ sourceTurnId: 'turn-a' }),
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

  it('binds only explicitly declared session machine defaults and keeps historical session ids explicit', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      defaultSessionMachineId: 'machine-1',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return { ok: true, result: { ok: true } };
        },
      },
    });

    await bridge.executeActionByToolName('action_execute', {
      actionId: 'memory.search',
      input: { query: { text: 'handoff' } },
    }, 'current-session');
    await bridge.executeActionByToolName('action_execute', {
      actionId: 'memory.get_window',
      input: { seqFrom: 10, seqTo: 20 },
    }, 'current-session');

    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'memory.search',
        input: { machineId: 'machine-1', query: { text: 'handoff' } },
        ctx: expect.objectContaining({ defaultSessionMachineId: 'machine-1' }),
      }),
      expect.objectContaining({
        actionId: 'memory.get_window',
        input: { machineId: 'machine-1', seqFrom: 10, seqTo: 20 },
      }),
    ]);
  });

  it('applies the same declared contextual defaults to trusted plugin actions', async () => {
    const calls: unknown[] = [];
    const pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[] = [{
      toolId: 'acme.memory/search-tool',
      actionId: 'acme.memory/search',
      name: 'acme_memory_search',
      title: 'Search Acme memory',
      description: 'Search memory.',
      inputSchema: {
        type: 'object',
        properties: { machineId: { type: 'string' }, query: { type: 'string' } },
        required: ['machineId', 'query'],
        additionalProperties: false,
      },
      contextualDefaults: { machineId: 'current_session_machine' },
      surfaces: ['agent'],
    }];
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      defaultSessionMachineId: 'machine-1',
      pluginToolCatalog,
      executor: {
        execute: async (actionId, input) => {
          calls.push({ actionId, input });
          return { ok: true, result: { ok: true } };
        },
      },
    });

    await bridge.executeActionByToolName('acme_memory_search', { query: 'handoff' }, 'session-1');

    expect(calls).toEqual([{
      actionId: 'acme.memory/search',
      input: { machineId: 'machine-1', query: 'handoff' },
    }]);
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

  it('normalizes execution.run.wait observation timeout as a successful nonterminal result', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async () => ({
          ok: true,
          result: {
            ok: true,
            status: 'running',
            disposition: 'observation_timeout',
            runId: 'run-1',
            timeoutMs: 5_000,
            observedAtMs: 6_000,
            deadlineAtMs: 6_000,
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
        status: 'running',
        disposition: 'observation_timeout',
        runId: 'run-1',
        timeoutMs: 5_000,
        observedAtMs: 6_000,
        deadlineAtMs: 6_000,
      },
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
              api: false,
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
      expectedContributorOccurrenceId: 'occurrence-g',
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
          expectedContributorOccurrenceId: 'occurrence-g',
        }),
      }),
      expect.objectContaining({
        actionId: 'acme.composition/review-start',
        context: expect.objectContaining({
          expectedContributorOccurrenceId: 'occurrence-g',
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
