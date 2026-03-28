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

  it('routes any surfaced action through approvals when required by the caller policy', async () => {
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

    expect(res.ok).toBe(true);
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
    expect(agentsBackendsList).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'agents.backends.list',
        createdBy: expect.objectContaining({ surface: 'cli' }),
      }),
    }));
  });

  it('never routes session.title.set through approvals even when a caller policy requests it', async () => {
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

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionTitleSet).toHaveBeenCalledWith({ sessionId: 's1', title: 'Renamed' });
    expect(approvalsCreate).not.toHaveBeenCalled();
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

  it('forces approval.request.create createdBy.sessionId to match actionArgs.sessionId when present', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's2', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli', sessionId: 's1' },
    }, {
      surface: 'mcp',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({
          surface: 'mcp',
          sessionId: 's2',
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

  it('executes approved prompt library actions even when the decision surface is ui_button', async () => {
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
      surface: 'ui_button',
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
      surface: 'ui_button',
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
      surface: 'ui_button',
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
    const approvalsGet = vi.fn()
      .mockResolvedValueOnce(createApprovalRequest('open'))
      .mockResolvedValueOnce(createApprovalRequest('executed'));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
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
