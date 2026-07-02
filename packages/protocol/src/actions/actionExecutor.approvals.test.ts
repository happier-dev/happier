import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestV1 } from '../approvals/approvalRequestV1.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

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
  return createActionExecutor({
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
    sessionSpawnPicker: async () => ({}),
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
}

describe('createActionExecutor (approvals)', () => {
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

    expect(res).toEqual({ ok: false, errorCode: 'action_disabled', error: 'action_disabled' });
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

  it('records transcript tool-call origin metadata on policy-created approvals', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'session_agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      {
        surface: 'session_agent',
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
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'session_agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 'target-session', message: 'hello target' },
      {
        surface: 'session_agent',
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
          surface: 'session_agent',
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

    const blockingCall = executor.execute('session.list' as any, {}, { surface: 'mcp' });

    await waiterReady;
    const decideResult = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'mcp',
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
      surface: 'session_agent',
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
    expect(sessionSendMessage).toHaveBeenCalledWith({ sessionId: 's1', message: 'hello', serverId: undefined });
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
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSendMessage).toHaveBeenCalledWith({ sessionId: 's1', message: 'hello', serverId: undefined });
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
    expect(sessionSendMessage).toHaveBeenCalledWith({ sessionId: 's1', message: 'hello', serverId: 'server-a' });
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
      createdBy: { surface: 'session_agent', sessionId: 's1' },
      requestedSurface: 'session_agent',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSendMessage,
      isActionEnabled: (_id, ctx) => ctx.surface !== 'session_agent',
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
    expect(sessionSendMessage).toHaveBeenCalledWith({ sessionId: 's1', message: 'hello', serverId: undefined });
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
});
