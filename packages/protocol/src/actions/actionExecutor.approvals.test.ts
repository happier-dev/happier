import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestV1 } from '../approvals/approvalRequestV1.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

const defaultActionsSettings = ActionsSettingsV1Schema.parse({ v: 1 });

function createApprovalRequest(
  status: ApprovalRequestV1['status'] = 'open',
  overrides: Partial<ApprovalRequestV1> = {},
): ApprovalRequestV1 {
  const base: ApprovalRequestV1 = {
    v: 1,
    status,
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'mcp', sessionId: 's1' },
    actionId: 'session.message.send',
    actionArgs: { sessionId: 's1', message: 'hello' },
    summary: 'Send message',
    requestedSurface: 'mcp',
  };

  if (status === 'approved') {
    return { ...base, ...overrides, decision: { kind: 'approve', decidedAtMs: 2 } };
  }

  if (status === 'rejected') {
    return { ...base, ...overrides, decision: { kind: 'reject', decidedAtMs: 2 } };
  }

  if (status === 'executed') {
    return {
      ...base,
      ...overrides,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true, result: { ok: true } },
    };
  }

  if (status === 'failed') {
    return {
      ...base,
      ...overrides,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: false, errorCode: 'action_failed', error: 'action_failed' },
    };
  }

  return { ...base, ...overrides };
}

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  const executor = createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    executionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
  return {
    ...executor,
    execute: (
      actionId: Parameters<typeof executor.execute>[0],
      input: Parameters<typeof executor.execute>[1],
      context: Parameters<typeof executor.execute>[2] = {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
      },
    ) => executor.execute(actionId, input, context),
  };
}

describe('createActionExecutor (approvals)', () => {
  it('routes plugin dev-loop actions through one executor dependency on the agent surface', async () => {
    const pluginsDevLoopAction = vi.fn(async ({ actionId }) => ({
      kind: actionId.replaceAll('.', '_'),
      ok: true,
    }));
    const executor = createExecutor({ pluginsDevLoopAction } as any);

    for (const [actionId, input] of [
      ['plugins.list', {}],
      ['plugins.uninstall', { pluginId: 'acme.dev-loop' }],
    ] as const) {
      const result = await executor.execute(
        actionId as any,
        input,
        {
          surface: 'agent' as any,
          bypassApprovals: true,
          ...(actionId === 'plugins.uninstall'
            ? { authority: 'present_user' as const }
            : {}),
        },
      );

      expect(result).toEqual({
        ok: true,
        result: {
          kind: actionId.replaceAll('.', '_'),
          ok: true,
        },
      });
      expect(pluginsDevLoopAction).toHaveBeenCalledWith({
        actionId,
        input,
        context: expect.objectContaining({ surface: 'agent' }),
      });
    }
  });

  it('lists approval requests through the bounded approval artifact store dependency', async () => {
    const approvalsList = vi.fn(async () => ({
      items: [
        {
          artifactId: 'a1',
          status: 'open',
          actionId: 'session.message.send',
          summary: 'Send message',
          updatedAtMs: 2,
        },
      ],
      queryPlan: {
        kind: 'approval_artifact_header_scan',
        hydratedTranscripts: false,
      },
    }));

    const executor = createExecutor({ approvalsList } as any);
    const res = await executor.execute(
      'approval.request.list' as any,
      { status: 'open', limit: 5 },
      { surface: 'rpc', serverId: 'server-1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        items: [
          {
            artifactId: 'a1',
            status: 'open',
            actionId: 'session.message.send',
            summary: 'Send message',
            updatedAtMs: 2,
          },
        ],
        queryPlan: {
          kind: 'approval_artifact_header_scan',
          hydratedTranscripts: false,
        },
      },
    });
    expect(approvalsList).toHaveBeenCalledWith({
      status: 'open',
      limit: 5,
      serverId: 'server-1',
    });
  });

  it('gets approval requests through the keyed approval artifact dependency', async () => {
    const request = createApprovalRequest();
    const approvalsGet = vi.fn(async () => request);

    const executor = createExecutor({ approvalsGet });
    const res = await executor.execute(
      'approval.request.get' as any,
      { artifactId: 'a1' },
      { surface: 'rpc', serverId: 'server-1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        artifactId: 'a1',
        request,
        queryPlan: {
          kind: 'approval_artifact_id_lookup',
          backingStore: 'ArtifactStore',
          boundedBy: 'approval artifact id',
          hydratedTranscripts: false,
        },
      },
    });
    expect(approvalsGet).toHaveBeenCalledWith({ artifactId: 'a1', serverId: 'server-1' });
  });

  it('does not route non-surfaced actions through approvals even when a policy requires approvals', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({
      approvalsCreate,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'ui.voice_global.reset' && ctx.surface === 'mcp',
    } as any);

    const res = await executor.execute(
      'ui.voice_global.reset' as any,
      {},
      { surface: 'mcp' },
    );

    expect(res).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'ui.voice_global.reset',
        surface: 'mcp',
        reason: 'unsupported_surface',
      }),
    }));
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('routes actions through approvals when required by the caller policy', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'mcp',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'mcp' },
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.message.send',
        summary: expect.stringContaining('Send a message'),
        createdBy: expect.objectContaining({ surface: 'mcp', sessionId: 's1' }),
      }),
    }));
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
  });

  it('uses host-provided approval preview metadata for plugin installs', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const buildApprovalPreview = vi.fn(async ({ actionId, input, defaultPreview }) => ({
      ...defaultPreview,
      pluginInstall: {
        actionId,
        path: (input as any).path,
        plugin: {
          id: 'acme.dev-loop',
          version: '1.0.0',
          title: 'Acme Dev Loop',
        },
        provenance: {
          sourceKind: 'path',
        },
        permissions: {
          required: ['network'],
          optional: ['filesystem.read'],
        },
      },
    }));
    const executor = createExecutor({
      approvalsCreate,
      buildApprovalPreview,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'plugins.install' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'plugins.install' as any,
      { path: '/tmp/acme-dev-loop', dev: true },
      { surface: 'agent' as any, authority: 'present_user' },
    );

    expect(res.ok).toBe(true);
    expect(buildApprovalPreview).toHaveBeenCalledWith({
      actionId: 'plugins.install',
      input: { path: '/tmp/acme-dev-loop', dev: true },
      context: expect.objectContaining({ surface: 'agent' }),
      defaultPreview: { actionId: 'plugins.install', actionArgs: { path: '/tmp/acme-dev-loop', dev: true } },
    });
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'plugins.install',
        preview: expect.objectContaining({
          pluginInstall: expect.objectContaining({
            plugin: {
              id: 'acme.dev-loop',
              version: '1.0.0',
              title: 'Acme Dev Loop',
            },
            provenance: expect.objectContaining({ sourceKind: 'path' }),
            permissions: {
              required: ['network'],
              optional: ['filesystem.read'],
            },
          }),
        }),
      }),
    }));
  });

  it('records transcript tool-call origin metadata on policy-created approvals', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      {
        surface: 'agent',
        defaultSessionId: 's1',
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 's1',
          toolCallId: 'tool-1',
          toolName: 'session_message_send',
          toolInput: { sessionId: 's1', message: 'hello' },
        },
      } as any,
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.message.send',
        origin: {
          kind: 'transcript_tool_call',
          sessionId: 's1',
          toolCallId: 'tool-1',
          toolName: 'session_message_send',
          toolInput: { sessionId: 's1', message: 'hello' },
        },
      }),
    }));
  });

  it('links policy-created cross-session approvals to the requesting session', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 'target-session', message: 'hello target' },
      {
        surface: 'agent',
        defaultSessionId: 'requesting-session',
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'requesting-session',
          toolCallId: 'tool-cross-session',
          toolName: 'session_message_send',
          toolInput: { sessionId: 'target-session', message: 'hello target' },
        },
      } as any,
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.message.send',
        actionArgs: expect.objectContaining({ sessionId: 'target-session' }),
        createdBy: expect.objectContaining({
          surface: 'agent',
          sessionId: 'requesting-session',
        }),
        origin: expect.objectContaining({
          kind: 'transcript_tool_call',
          sessionId: 'requesting-session',
          toolCallId: 'tool-cross-session',
          toolName: 'session_message_send',
        }),
      }),
    }));
  });

  it('records createdBy.surface=cli when approvals are created from the CLI surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'cli',
    });

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'cli' },
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({ surface: 'cli', sessionId: 's1' }),
      }),
    }));
  });

  it('marks approval requests created from the CLI surface as createdBy.surface=cli', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({
      approvalsCreate,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'cli',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'cli' },
    );

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({ surface: 'cli', sessionId: 's1' }),
      }),
    }));
  });

  it('routes eligible actions through approvals when required by the caller policy', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const executionRunStart = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      executionRunStart,
      isActionApprovalRequired: (actionId) => actionId === 'review.start',
    } as any);

    const res = await executor.execute(
      'review.start' as any,
      { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      { surface: 'cli' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).not.toHaveBeenCalled();
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
  });

  it.each([
    {
      name: 'approval storage is unavailable',
      overrides: {},
      context: { surface: 'cli' as const, actionCaller: { kind: 'host' as const } },
    },
    {
      name: 'plugin approval provenance is incomplete',
      overrides: { approvalsCreate: vi.fn(async () => ({ artifactId: 'a1' })) },
      context: {
        surface: 'plugin' as const,
        actionCaller: { kind: 'plugin' as const, pluginId: 'acme.plugin' },
      },
    },
  ])('classifies $name before execution.run.start dispatch as noRunCreated', async ({ overrides, context }) => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
    }));
    const executor = createExecutor({
      executionRunStart,
      isActionApprovalRequired: (actionId) => actionId === 'execution.run.start',
      ...overrides,
    });

    await expect(executor.execute('execution.run.start' as any, {
      sessionId: 's1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Inspect the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, context)).resolves.toEqual({
      ok: false,
      errorCode: context.surface === 'plugin'
        ? 'plugin_action_caller_required'
        : 'approvals_not_supported',
      error: context.surface === 'plugin'
        ? 'plugin_action_caller_required'
        : 'approvals_not_supported',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('returns unsupported after creating a blocking approval when no live approval waiter is available', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const agentsBackendsList = vi.fn(async () => ({ items: [] }));

    const executor = createExecutor({
      approvalsCreate,
      agentsBackendsList,
      isActionApprovalRequired: (actionId) => actionId === 'agents.backends.list',
    } as any);

    const res = await executor.execute(
      'agents.backends.list' as any,
      {},
      { surface: 'cli' },
    );

    expect(res).toEqual({ ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' });
    expect(agentsBackendsList).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'agents.backends.list',
        approval: { flow: 'blocking', result: 'required' },
        createdBy: expect.objectContaining({ surface: 'cli' }),
      }),
    }));
  });

  it('defers API policy approvals even when the Action normally has a blocking result', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'api-approval-1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsWaitForDecision = vi.fn(async () => {
      throw new Error('external API approvals must not wait for a decision');
    });

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'action.spec.search' && ctx.surface === 'api',
    } as any);

    await expect(executor.execute(
      'action.spec.search' as any,
      { query: 'approval', limit: 1 },
      { surface: 'api', authority: 'account_automation', actionCaller: { kind: 'host' } },
    )).resolves.toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'api-approval-1',
        actionId: 'action.spec.search',
      },
    });
    expect(approvalsWaitForDecision).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'action.spec.search',
        approval: { flow: 'deferred', result: 'required' },
      }),
    }));
  });

  it('waits for a blocking approval and returns the underlying action result when approved', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 's1', title: 'One' }] }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      expect(sessionList).not.toHaveBeenCalled();
      return {
        decision: 'approve' as const,
        request: {
          ...request,
          status: 'approved' as const,
          decision: { kind: 'approve' as const, decidedAtMs: 2 },
        },
      };
    });

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const res = await executor.execute(
      'session.list' as any,
      { limit: 10 },
      { surface: 'mcp' },
    );

    expect(res).toEqual({ ok: true, result: { sessions: [{ id: 's1', title: 'One' }] } });
    expect(approvalsWaitForDecision).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        actionId: 'session.list',
        approval: { flow: 'blocking', result: 'required' },
      }),
      serverId: null,
    }));
    expect(sessionList).toHaveBeenCalledWith({
      limit: 10,
      cursor: undefined,
      includeLastMessagePreview: undefined,
      activeOnly: undefined,
      archivedOnly: undefined,
      includeSystem: undefined,
      resumableOnly: undefined,
    });
    expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executed',
        execution: expect.objectContaining({ ok: true, result: { sessions: [{ id: 's1', title: 'One' }] } }),
      }),
    }));
  });

  it('returns an already executed blocking approval result without re-executing the target action', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const recordedResult = { sessions: [{ id: 's1', title: 'Recorded' }] };
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 's2', title: 'Duplicate' }] }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => ({
      decision: 'approve' as const,
      request: {
        ...request,
        status: 'executed' as const,
        decision: { kind: 'approve' as const, decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true as const, result: recordedResult },
      },
    }));

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const res = await executor.execute(
      'session.list' as any,
      { limit: 10 },
      { surface: 'mcp' },
    );

    expect(res).toEqual({ ok: true, result: recordedResult });
    expect(sessionList).not.toHaveBeenCalled();
    expect(approvalsUpdate).not.toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ status: 'executed' }),
    }));
  });

  it('executes a concurrently approved blocking action exactly once', async () => {
    let storedRequest: ApprovalRequestV1 | null = null;
    let resolveWaiter: ((request: ApprovalRequestV1) => void) | null = null;
    let markWaiterReady: (() => void) | null = null;
    const waiterReady = new Promise<void>((resolve) => {
      markWaiterReady = resolve;
    });
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { artifactId: 'a1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      if (request.status === 'approved') resolveWaiter?.(request);
      return { ok: true as const };
    });
    const approvalsResolveBlockingDecision = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      resolveWaiter?.(request);
      return { resolved: true };
    });
    const approvalsWaitForDecision = vi.fn(async () => {
      markWaiterReady?.();
      const request = await new Promise<ApprovalRequestV1>((resolveDecision) => {
        resolveWaiter = resolveDecision;
      });
      return { decision: 'approve' as const, request };
    });
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 's1', title: 'One' }] }));

    const executor = createExecutor({
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const blockingCall = executor.execute('session.list' as any, {}, { surface: 'mcp', authority: 'present_user' });

    await waiterReady;
    const decideResult = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'mcp',
      authority: 'present_user',
    });
    const blockingResult = await blockingCall;

    expect(decideResult.ok).toBe(true);
    expect(blockingResult).toEqual({ ok: true, result: { sessions: [{ id: 's1', title: 'One' }] } });
    expect(sessionList).toHaveBeenCalledTimes(1);
  });

  it('returns approval_rejected when a blocking approval is rejected', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => ({
      decision: 'reject' as const,
      request,
    }));

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const res = await executor.execute(
      'session.list' as any,
      {},
      { surface: 'mcp' },
    );

    expect(res).toEqual({ ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' });
    expect(sessionList).not.toHaveBeenCalled();
    expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'rejected',
        decision: expect.objectContaining({ kind: 'reject' }),
      }),
    }));
  });

  it('routes session.title.set through approvals when required by the caller policy', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionTitleSet = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      sessionTitleSet,
      isActionApprovalRequired: (actionId) => actionId === 'session.title.set',
    } as any);

    const res = await executor.execute(
      'session.title.set' as any,
      { sessionId: 's1', title: 'Renamed' },
      { surface: 'mcp', defaultSessionId: null },
    );

    expect(res.ok).toBe(true);
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
    expect(sessionTitleSet).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.title.set',
        createdBy: expect.objectContaining({ surface: 'mcp', sessionId: 's1' }),
      }),
    }));
  });

  it('allows approval.request.create for any action (except approval actions)', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'agents.backends.list',
      actionArgs: {},
      summary: 'List backends',
      createdBy: { surface: 'system' },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'agents.backends.list',
        summary: 'List backends',
      }),
    }));
  });

  it('rejects deciding approval artifacts that target approval queue actions', async () => {
    for (const actionId of ['approval.request.list', 'approval.request.get'] as const) {
      const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
        actionId,
        actionArgs: actionId === 'approval.request.get' ? { artifactId: 'a2' } : {},
        summary: 'Nested approval action',
      }));
      const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
      const approvalsList = vi.fn(async () => ({ items: [], queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false } }));

      const executor = createExecutor({
        approvalsGet,
        approvalsUpdate,
        approvalsList,
      } as any);

      const res = await executor.execute('approval.request.decide' as any, {
        artifactId: 'a1',
        decision: 'approve',
      });

      expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
      expect(approvalsUpdate).not.toHaveBeenCalled();
      expect(approvalsList).not.toHaveBeenCalled();
    }
  });

  it('creates an approval request via deps.approvalsCreate', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        status: 'open',
        actionId: 'session.message.send',
        summary: 'Send message',
      }),
    }));
  });

  it('inherits transcript tool-call origin metadata from context for approval.request.create', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    }, {
      surface: 'agent',
      defaultSessionId: 's1',
      approvalOrigin: {
        kind: 'transcript_tool_call',
        sessionId: 's1',
        messageId: 'msg-context',
        toolCallId: 'tool-context',
        toolName: 'approval_request_create',
        toolInput: { actionId: 'session.message.send' },
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        origin: {
          kind: 'transcript_tool_call',
          sessionId: 's1',
          messageId: 'msg-context',
          toolCallId: 'tool-context',
          toolName: 'approval_request_create',
          toolInput: { actionId: 'session.message.send' },
        },
      }),
    }));
  });

  it('rejects approval.request.create when target action args fail target schema validation', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: '' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('rejects creating approval requests with a blank (trimmed) summary', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: '   ',
      createdBy: { surface: 'system' },
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('forces approval.request.create createdBy.surface to match the execution surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli' },
    }, {
      surface: 'mcp',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({
          surface: 'mcp',
        }),
      }),
    }));
  });

  it('host-stamps plugin provenance for approval-queue requests without publishing the raw action', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      createdBy: { surface: 'cli', pluginId: 'forged.plugin' },
    }, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'acme.plugin',
        contributionLocalId: 'approval-queue',
      },
      defaultSessionId: 'requesting-session',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: {
          surface: 'system',
          pluginId: 'acme.plugin',
          contributionLocalId: 'approval-queue',
          sessionId: 'requesting-session',
        },
        requestedSurface: 'plugin',
      }),
    }));
  });

  it('links approval.request.create cross-session approvals to the requesting session', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 'target-session', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli', sessionId: 'injected-session' },
    }, {
      surface: 'mcp',
      defaultSessionId: 'requesting-session',
      approvalOrigin: {
        kind: 'transcript_tool_call',
        sessionId: 'requesting-session',
        toolCallId: 'tool-create-cross-session',
        toolName: 'approval_request_create',
        toolInput: { actionId: 'session.message.send' },
      },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionArgs: expect.objectContaining({ sessionId: 'target-session' }),
        createdBy: expect.objectContaining({
          surface: 'mcp',
          sessionId: 'requesting-session',
        }),
        origin: expect.objectContaining({
          sessionId: 'requesting-session',
          toolCallId: 'tool-create-cross-session',
        }),
      }),
    }));
  });

  it('ignores approval.request.create createdBy.sessionId when actionArgs.sessionId is missing and uses ctx.defaultSessionId instead', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli', sessionId: 's-injected' },
    }, {
      surface: 'mcp',
      defaultSessionId: 's-default',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({
          surface: 'mcp',
          sessionId: 's-default',
        }),
      }),
    }));
  });

  it('persists the server hint on created approval requests when present in the execution context', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system', sessionId: 's1' },
    }, {
      surface: 'ui',
      serverId: 'server-a',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        serverId: 'server-a',
      }),
      serverId: 'server-a',
    }));
  });

  it('allows creating approval requests for safe actions (eligibility is policy-driven, not safety-driven)', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
      createdBy: { surface: 'system' },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'review.start',
        summary: 'Run review',
      }),
    }));
  });

  it('executes the underlying action when an approval is approved', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest());
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'approved',
        decision: expect.objectContaining({ kind: 'approve' }),
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      }),
    }));
  });

  it('returns an approved blocking decision without executing when an external waiter owns execution', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      actionId: 'session.list',
      actionArgs: {},
      approval: { flow: 'blocking', result: 'required' },
      summary: 'List sessions',
      requestedSurface: 'mcp',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsResolveBlockingDecision = vi.fn(async () => ({ resolved: true }));
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 's1', title: 'One' }] }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      sessionList,
    } as any);

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'approved',
      },
    });
    expect(approvalsResolveBlockingDecision).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      decision: 'approve',
      request: expect.objectContaining({
        status: 'approved',
        actionId: 'session.list',
      }),
    }));
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('executes an approved blocking decision when no live waiter owns execution', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      actionId: 'session.list',
      actionArgs: {},
      approval: { flow: 'blocking', result: 'required' },
      summary: 'List sessions',
      requestedSurface: 'mcp',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsResolveBlockingDecision = vi.fn(async () => ({ resolved: false }));
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 's1', title: 'One' }] }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      sessionList,
    } as any);

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({
          ok: true,
          result: { sessions: [{ id: 's1', title: 'One' }] },
        }),
      },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
  });

  it('marks approvals as failed when the execution surface cannot be resolved (fails closed)', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      createdBy: { surface: 'system', sessionId: 's1' },
      requestedSurface: undefined,
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'failed',
        execution: expect.objectContaining({
          ok: false,
          errorCode: 'approval_execution_surface_invalid',
        }),
      }),
    }));
  });

  it('does not re-route already-approved actions through approvals when executing them', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', { createdBy: { surface: 'mcp', sessionId: 's1' } }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'nested' }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'mcp',
    } as any);

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'mcp',
      authority: 'present_user',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
  });

  it('uses the stored approval serverId when the decision context omits one', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', { serverId: 'server-a' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(approvalsGet).toHaveBeenCalledWith({ artifactId: 'a1', serverId: null });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      serverId: 'server-a',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-a',
      request: expect.objectContaining({
        serverId: 'server-a',
        status: 'approved',
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-a',
      request: expect.objectContaining({
        serverId: 'server-a',
        status: 'executed',
      }),
    }));
  });

  it('executes approved prompt library actions even when the decision surface is ui', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      actionId: 'prompt_doc.update',
      actionArgs: {
        artifactId: 'doc-1',
        title: 'Review prompt',
        markdown: '# Review',
      },
      summary: 'Update prompt',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const promptDocUpdate = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, promptDocUpdate });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'ui',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      },
    });
    expect(promptDocUpdate).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      title: 'Review prompt',
      markdown: '# Review',
    });
  });

  it('does not bypass per-surface disablement when executing approved actions', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      createdBy: { surface: 'system', sessionId: 's1' },
      requestedSurface: 'agent',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSendMessage,
      isActionEnabled: (_id, ctx) => ctx.surface !== 'agent',
    });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'ui',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'action_disabled' }),
      },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('does not bypass per-surface disablement when executing approvals created from the CLI surface', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      createdBy: { surface: 'cli', sessionId: 's1' },
      requestedSurface: 'cli',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSendMessage,
      isActionEnabled: (_id, ctx) => ctx.surface !== 'cli',
    });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'ui',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'action_disabled' }),
      },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('resumes an already-approved approval by finalizing execution', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('approved'));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).toHaveBeenCalledTimes(1);
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    expect(approvalsUpdate).toHaveBeenCalledTimes(1);
    expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      }),
    }));
  });

  it.each([
    {
      status: 'rejected',
      decision: 'reject',
      expected: { ok: true, result: { ok: true, status: 'rejected' } },
    },
    {
      status: 'executed',
      decision: 'approve',
      expected: {
        ok: true,
        result: { ok: true, status: 'executed', execution: expect.objectContaining({ ok: true }) },
      },
    },
    {
      status: 'failed',
      decision: 'approve',
      expected: {
        ok: true,
        result: { ok: true, status: 'failed', execution: expect.objectContaining({ ok: false, errorCode: 'action_failed' }) },
      },
    },
  ] as const)('returns the existing terminal result for duplicate $decision decisions on $status approvals', async ({ status, decision, expected }) => {
    const approvalsGet = vi.fn(async () => createApprovalRequest(status));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision,
    });

    expect(res).toEqual(expected);
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'approved', decision: 'reject' },
    { status: 'rejected', decision: 'approve' },
    { status: 'executed', decision: 'reject' },
    { status: 'failed', decision: 'reject' },
    { status: 'canceled', decision: 'approve' },
    { status: 'canceled', decision: 'reject' },
  ] as const)('rejects deciding a $status approval without mutating or executing', async ({ status, decision }) => {
    const approvalsGet = vi.fn(async () => createApprovalRequest(status));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision,
    });

    expect(res).toEqual({ ok: false, errorCode: 'approval_not_open', error: 'approval_not_open' });
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('does not re-execute an approval on duplicate approve delivery', async () => {
    let storedRequest = createApprovalRequest('open');
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const first = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });
    const second = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      },
    });
    expect(sessionSendMessage).toHaveBeenCalledTimes(1);
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
  });

  // FINALIZATION-PLAN §3.2 activation proof: after the per-family `RUNTIME_ACTION_DISABLED_SURFACES`
  // flip, a dangerous AGENT-initiated runtime action now passes the enablement gate and REACHES the
  // surface-keyed approval floor (`AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS`, wired through the
  // real `isApprovalRequiredByActionsSettings`) — it is no longer short-circuited by `action_disabled`
  // (finding #31). User-initiated forms execute the runtime directly with no prompt.
  describe('§3.2 agent-approval activation (runtime families flipped on agent)', () => {
    // `browser.context.capturePage` is approval-floored for `agent` AND in
    // RESULT_REQUIRED → a `blocking` approval flow, so the executor waits for a decision. We
    // resolve the decision deterministically per-test to prove the routing path.
    const wireApprovalFloor = (
      runtimeActionExecute: ReturnType<typeof vi.fn>,
      approvalsCreate: ReturnType<typeof vi.fn>,
      decision: 'approve' | 'reject' = 'reject',
    ) =>
      createExecutor({
        runtimeActionExecute,
        approvalsCreate,
        approvalsWaitForDecision: vi.fn(async ({ request }: any) => ({
          decision,
          request: {
            ...request,
            status: decision === 'approve' ? 'approved' : 'rejected',
            decision: { kind: decision === 'approve' ? 'approve' : 'reject', decidedAtMs: 2 },
          },
        })),
        approvalsUpdate: vi.fn(async () => ({ ok: true })),
        // Wire the REAL surface-keyed approval floor exactly as the production default executor
        // does, with no persisted overrides — the dangerous agent subset must still be gated.
        isActionApprovalRequired: (actionId, ctx) =>
          isApprovalRequiredByActionsSettings(actionId, defaultActionsSettings, ctx),
      } as any);
    const capturedPageResult = {
      v: 1,
      kind: 'browserPageReference',
      contextId: 'context_1',
      sourceViewId: 'v1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'previewProxy',
      capturedAtMs: 1,
      navigationGeneration: 0,
      lifecycleState: 'available',
      redactionLevel: 'none',
    } as const;
    const attachedContextResult = {
      v: 1,
      attachmentId: 'attachment_1',
      contextId: 'context_1',
      sourceViewId: 'v1',
      capturedNavigationGeneration: 0,
      currentNavigationGeneration: 0,
      state: 'available',
    } as const;

    it('routes an agent-initiated dangerous capture to the approval gate (not action_disabled)', async () => {
      const runtimeActionExecute = vi.fn(async () => ({ captured: true }));
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'cap-1' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.capturePage' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      // Reaches the APPROVAL gate (NOT the disabled gate); rejected → runtime never runs. This is
      // the §3.2 activation proof: pre-flip this would have short-circuited to `action_disabled`.
      expect((res as any).errorCode).toBe('approval_rejected');
      expect(approvalsCreate).toHaveBeenCalledTimes(1);
      expect(runtimeActionExecute).not.toHaveBeenCalled();
    });

    it('runs the runtime executor for an agent capture once approval is granted', async () => {
      const runtimeActionExecute = vi.fn(async () => capturedPageResult);
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'cap-3' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'approve');

      const res = await executor.execute(
        'browser.context.capturePage' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      expect(res).toEqual({ ok: true, result: capturedPageResult });
      expect(approvalsCreate).toHaveBeenCalledTimes(1);
      expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
    });

    it('executes the same capture user-initiated (ui) with no approval prompt', async () => {
      const runtimeActionExecute = vi.fn(async () => capturedPageResult);
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'cap-2' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.capturePage' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'ui', defaultSessionId: 's1' },
      );

      expect(res).toEqual({ ok: true, result: capturedPageResult });
      expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
      expect(approvalsCreate).not.toHaveBeenCalled();
    });

    it('routes agent-initiated browser context attach to approvals by default', async () => {
      const runtimeActionExecute = vi.fn(async () => ({ attached: true }));
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'attach-1' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.attachToComposer' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      expect((res as any).errorCode).toBe('approval_rejected');
      expect(approvalsCreate).toHaveBeenCalledTimes(1);
      expect(runtimeActionExecute).not.toHaveBeenCalled();
    });

    it('keeps user-initiated browser context attach unprompted', async () => {
      const runtimeActionExecute = vi.fn(async () => attachedContextResult);
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'attach-2' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.attachToComposer' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'ui', defaultSessionId: 's1' },
      );

      expect(res).toEqual({
        ok: true,
        result: {
          ...attachedContextResult,
          requiresReconfirmBeforeSend: false,
        },
      });
      expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
      expect(approvalsCreate).not.toHaveBeenCalled();
    });

    it('still fail-closes an unsurfaced runtime action on agent (devices.simulator.input.orientation)', async () => {
      const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'd-1' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'devices.simulator.input.orientation' as any,
        { type: 'simulator.input.orientation', orientation: 'landscapeLeft' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      // Statically-unbacked (no producer) → UNSURFACED on every surface; the approval gate is never
      // reached. (The browser-diagnostics interaction verbs are now executor-backed and surfaced.)
      expect(res).toEqual(expect.objectContaining({
        ok: false,
        errorCode: 'action_disabled',
        error: 'action_disabled',
        details: expect.objectContaining({
          actionId: 'devices.simulator.input.orientation',
          surface: 'agent',
          reason: 'unsupported_surface',
        }),
      }));
      expect(approvalsCreate).not.toHaveBeenCalled();
      expect(runtimeActionExecute).not.toHaveBeenCalled();
    });
  });
});
