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
  ApprovalRequestSchema,
} from '@happier-dev/protocol';
import { SessionBoardGetInputV1Schema } from '@happier-dev/protocol/sessions/board';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { dispatchBuiltInHappierTool } from './dispatchBuiltInHappierTool';

describe('createActionToolExecutorBridge', () => {
  it('dispatches session code Actions with the host Machine and root, while preserving explicit targets and approval', async () => {
    const queries: unknown[] = [];
    const approvals: unknown[] = [];
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      // Machine RPC and approval Artifact persistence are system boundaries.
      languageIntelligenceQuery: async args => { queries.push(args); return { status: 'loading' }; },
      languageIntelligenceRestart: async args => { queries.push(args); return { status: 'unavailable', reason: 'session_unavailable' }; },
      approvalsCreate: async ({ request }) => { approvals.push(ApprovalRequestSchema.parse(request)); return { artifactId: 'scoped-edit' }; },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      approvalsUpdate: async () => ({ ok: true }),
    });
    const bridge = createActionToolExecutorBridge({ executor: {
      execute: (id, input, context) => executor.execute(id, input, { ...context, serverId: 'home', runtimeAccountId: 'account' }),
    }, surface: 'agent', requiredDirectActionIds: ['code.definition.get'],
      defaultSessionMachineId: 'session-machine', defaultSessionRootPath: '/session/repo' });
    const dispatch = (actionId: string, input: unknown) => dispatchBuiltInHappierTool({
      toolName: 'action_execute', args: { actionId, input }, sessionId: 'session', sessionMachineId: 'session-machine',
      sessionRootPath: '/session/repo', surface: 'agent', actionRequestId: `${actionId}-request`, deps: {
        executeActionByToolName: bridge.executeActionByToolName,
        resolveActionOptions: args => bridge.resolveActionOptions(args, 'session'),
        changeTitle: async () => ({ success: true }),
      },
    });
    const target = { path: 'src/example.ts' };
    for (const [actionId, input] of [
      ['code.definition.get', { ...target, line: 2, symbol: 'example' }],
      ['code.hover.get', { ...target, line: 2, symbol: 'example' }],
      ['code.references.list', { ...target, line: 2, character: 0 }],
      ['code.symbols.list', target], ['code.diagnostics.list', target],
      ['code.rename.preview', { ...target, line: 2, symbol: 'example', newName: 'renamed' }],
      ['code.file.rename.preview', { ...target, newPath: 'src/renamed.ts' }],
      ['code.codeActions.list', { ...target, line: 2, symbol: 'example' }],
    ] as const) {
      expect(await dispatch(actionId, input), actionId).toMatchObject({ ok: true, result: { status: 'loading' } });
    }
    expect(await dispatch('code.restart', {})).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    expect(queries).toHaveLength(9);
    for (const query of queries) expect(query).toMatchObject({ machineId: 'session-machine', request: { rootPath: '/session/repo' } });
    expect(queries[0]).toMatchObject({ request: { kind: 'definition', path: target.path, text: 'disk', position: { line: 1, symbol: 'example' } } });
    expect(await bridge.executeActionByToolName('code_definition_get', { ...target, line: 2, symbol: 'example' }, 'session'))
      .toMatchObject({ ok: true, result: { status: 'loading' } });
    expect(queries.at(-1)).toMatchObject({ machineId: 'session-machine', request: { rootPath: '/session/repo' } });
    expect(await dispatch('code.definition.get', { ...target, machineId: 'explicit-machine', rootPath: '/explicit/repo', line: 2, symbol: 'example' }))
      .toMatchObject({ ok: true });
    expect(queries.at(-1)).toMatchObject({ machineId: 'explicit-machine', request: { rootPath: '/explicit/repo' } });
    expect(await dispatch('code.definition.get', { ...target, machineId: 'another-machine', line: 2, symbol: 'example' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    const files = [{ path: target.path, expectedHash: 'a'.repeat(64), edits: [] }];
    for (const actionId of ['code.rename.apply', 'code.file.rename.apply'] as const) {
      expect(await dispatch(actionId, { ...target, files })).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    }
    const operation = { kind: 'codeAction', expectedHash: 'a'.repeat(64), action: { serverId: 'server', title: 'Fix',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, files, hasCommand: false } };
    expect(await dispatch('code.codeAction.apply', { ...target, operation })).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(approvals).toMatchObject([
      { actionId: 'code.rename.apply', actionArgs: { machineId: 'session-machine', rootPath: '/session/repo', ...target, files } },
      { actionId: 'code.file.rename.apply', actionArgs: { machineId: 'session-machine', rootPath: '/session/repo', ...target, files } },
      { actionId: 'code.codeAction.apply', actionArgs: { machineId: 'session-machine', rootPath: '/session/repo', ...target, operation } },
    ]);
    const discovery = await dispatchBuiltInHappierTool({ toolName: 'action_spec_get', args: { id: 'code.definition.get' },
      sessionId: 'session', sessionMachineId: 'session-machine', sessionRootPath: '/session/repo', surface: 'agent',
      deps: { executeActionByToolName: bridge.executeActionByToolName, changeTitle: async () => ({ success: true }) },
    });
    expect(discovery).toMatchObject({ ok: true, result: { actionSpec: { inputSchema: { required: ['path', 'line'] } } } });
    // Sessionless callers retain the strict Machine/root/file contract.
    expect(getActionSpec('code.definition.get').inputSchema.safeParse({ ...target, line: 2, symbol: 'example' }).success).toBe(false);
  });
  it('dispatches session workspace reads and Processes and captures replacement scope before approval', async () => {
    const requests: unknown[] = [];
    let approval: unknown;
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      workspaceFilesSearch: async input => { requests.push(input); return { ok: true, files: [], hasMore: false, coverage: 'complete' }; },
      workspaceFilesReplacePreview: async input => { requests.push(input); return { ok: true, files: [], skipped: { notText: 0 }, hasMore: false, coverage: 'complete' }; },
      machineProcessesAction: async ({ input }) => { requests.push(input); return { row: null }; },
      approvalsCreate: async ({ request }) => { approval = ApprovalRequestSchema.parse(request); return { artifactId: 'replace-approval' }; },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      approvalsUpdate: async () => ({ ok: true }),
    });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', defaultSessionMachineId: 'session-machine',
      defaultSessionRootPath: '/session/repo', executor: {
        execute: (id, input, context) => executor.execute(id, input, { ...context, serverId: 'home', runtimeAccountId: 'account' }),
      },
    });
    for (const [actionId, input] of [
      ['workspace.files.search', { query: 'before' }],
      ['workspace.files.replace.preview', { query: 'before', replacement: 'after' }],
      ['machines.processes.get', { ref: 'opaque-process' }],
    ] as const) {
      expect(await bridge.executeActionByToolName('action_execute', { actionId, input }, 'session'), actionId).toMatchObject({ ok: true });
    }
    expect(requests).toMatchObject([
      { machineId: 'session-machine', rootPath: '/session/repo', query: 'before' },
      { machineId: 'session-machine', rootPath: '/session/repo', query: 'before', replacement: 'after' },
      { machineId: 'session-machine', ref: 'opaque-process' },
    ]);
    const operation = { kind: 'replace', matcher: { query: 'before', replacement: 'after' }, files: [{ path: 'a.ts', expectedHash: 'a'.repeat(64) }] };
    const result = await bridge.executeActionByToolName('action_execute', { actionId: 'workspace.files.replace', input: { operation } }, 'session',
      { actionRequestId: 'scoped-replace' });
    expect(result, result.ok ? 'unexpected effect' : result.errorCode).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(approval).toMatchObject({ actionId: 'workspace.files.replace', actionArgs: { machineId: 'session-machine', rootPath: '/session/repo', operation } });
  });

  it('binds an in-session capability change before creating its real approval request', async () => {
    const approvals: unknown[] = [];
    const executor = createActionExecutor({
      ...createCliActionDeps({ token: 'test-token', sessionId: 'invoking-session', mode: 'plain', ctx: null }),
      // Artifact persistence is the external boundary; discovery, binding,
      // validation, approval policy and the request producer remain real.
      approvalsCreate: async ({ request }) => {
        approvals.push(ApprovalRequestSchema.parse(request));
        return { artifactId: 'capability-approval' };
      },
    });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', executor: {
      execute: (actionId, input, context) => executor.execute(actionId, input, { ...context,
        serverId: 'fixture-home', actionCaller: { kind: 'host' } }),
    } });
    const input = { kind: 'skill', id: 'library-skill', state: 'on', reason: 'Read the project instructions' };
    expect(await bridge.executeActionByToolName('action_execute', {
      actionId: 'session.capabilities.set', input,
    }, 'invoking-session', { actionRequestId: 'enable-skill' })).toMatchObject({
      ok: true, result: { kind: 'approval_request_created', artifactId: 'capability-approval' },
    });
    expect(approvals).toEqual([expect.objectContaining({
      actionId: 'session.capabilities.set', actionArgs: { ...input, sessionId: 'invoking-session' },
    })]);
  });
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

  it('refuses a foreign subtree on a current-Session bridge before reading the list', async () => {
    // Session listing is the HTTP boundary; bridge binding and Action admission stay real.
    const sessionList = vi.fn(async () => markSessionListQueryResultV1({
      sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: null, attentionHasNext: false,
    }));
    const executor = createActionExecutor({
      ...createCliActionDeps({ token: 'test-token', sessionId: 'lead', mode: 'plain', ctx: null }),
      sessionList,
      isActionApprovalRequired: () => false,
    });
    const caller = { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 } as const;
    const bridge = createActionToolExecutorBridge({
      surface: 'agent',
      executor: { execute: (actionId, input, context) => executor.execute(actionId, input, {
        ...context,
        actionCaller: caller,
        agentStartContext: { caller, baseline: { machineId: 'machine', directory: '/repo' }, roles: {},
          ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default' },
      }) },
      resolveSessionListAccess: () => 'current_session',
      requiredDirectActionIds: ['session.list'],
    });
    for (const [toolName, args] of [
      ['action_execute', { actionId: 'session.list', input: { underSessionId: 'another-lead' } }],
      ['session_list', { underSessionId: 'another-lead' }],
    ] as const) {
      await expect(bridge.executeActionByToolName(toolName, args, 'lead'))
        .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    }
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
      details: { cause: 'caller_context_unavailable' },
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
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'session.list': { toolExposureModes: { mcp: 'direct' } },
      } }),
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
        inputId: 'accepted-input',
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
          sessionInputSource: expect.objectContaining({ sourceTurnId: 'turn-active', sourceInputId: 'accepted-input' }),
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
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'session.terminalComposer.clear': { toolExposureModes: { mcp: 'direct' } },
    } });
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      actionsSettings,
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
          actionsSettings,
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
      toolId: 'acme.memory/search',
      toolExposure: { agent: 'direct' },
      actionId: 'acme.memory/actions/search',
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
      actionId: 'acme.memory/actions/search',
      input: { machineId: 'machine-1', query: 'handoff' },
    }]);
  });

  it('preserves explicit direct action tool session ids on external mcp', async () => {
    const calls: unknown[] = [];
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'session.terminalComposer.clear': { toolExposureModes: { mcp: 'direct' } },
    } });
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      actionsSettings,
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
          actionsSettings,
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
          identity: { pluginId: 'acme.review.plugin', localId: 'review-start' },
          manifestPath: '/plugins/acme/review/.happier-plugin/plugin.json',
          daemonEntryPath: '/plugins/acme/review/daemon.mjs',
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme/review',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
          },
          admittedTarget: {
            declaration: {
              id: 'review-start', title: 'Acme Review Start',
              description: 'Start a plugin-defined review workflow',
              scopes: ['global'], surfaces: ['agent', 'mcp', 'cli'],
              dangerLevel: 'safe', execution: { target: 'daemon' },
              inputSchema: { type: 'object', properties: {}, additionalProperties: true },
              tool: { name: 'acme_review_start' },
              toolExposure: { cli: 'direct' },
            },
            hostAccessRequests: [], historyGapSources: [], surfaces: ['agent', 'mcp', 'cli'],
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
            scopes: ['global'],
            execution: { target: 'daemon' },
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
        actionId: 'acme.review.plugin/actions/review-start',
        input: { scope: 'diff' },
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'cli',
          actionsSettings: null,
        }),
      },
    });
  });

  it('carries an admitted plugin generation through direct action execution', async () => {
    const calls: Array<{ actionId: string; context: unknown }> = [];
    const pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[] = [{
      toolId: 'acme.composition/review-start',
      toolExposure: { agent: 'direct' },
      actionId: 'acme.composition/actions/review-start',
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
    )).resolves.toEqual({ ok: true, result: { actionId: 'acme.composition/actions/review-start' } });
    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'acme.composition/actions/review-start',
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
