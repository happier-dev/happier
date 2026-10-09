import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';
import { markSessionListQueryResultV1 } from '../sessions/awareness/action.js';
import { projectSessionAwarenessV1 } from '../sessions/awareness/projectV1.js';
import { SessionAwarenessProjectionV1Schema } from '../sessions/awareness/projectionV1.js';
import { waitForSessionAwarenessV1 } from '../sessions/awareness/waitV1.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    sessionList: vi.fn(async () => ({ sessions: [] })),
    isApprovalExecutionOriginCurrent: async () => true,
    ...overrides,
  } as unknown as ActionExecutorDeps);
}

describe('ActionExecutor prepared invocation', () => {
  function sessionReadHarness() {
    // Substitute Home reads only; caller resolution, subtree admission and the
    // generic wait's nested activity admission remain real.
    const sessionList = vi.fn<ActionExecutorDeps['sessionList']>(async ({ query }) => markSessionListQueryResultV1({
      sessions: query?.underSessionId === 'parent' ? [{ id: 'child', active: false, presence: 'offline', updatedAt: 10 }] : [],
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    }));
    const sessionActivityGet = vi.fn<ActionExecutorDeps['sessionActivityGet']>(async ({ sessionId }) => projectSessionAwarenessV1({
      nowMs: 10, sessionId, lifecycle: { archivedAtMs: 9 }, runtime: { presence: 'unknown' }, pending: {}, content: { mode: 'plain' },
      currentness: { lifecycle: 'observed', runtime: 'unavailable', pending: 'unavailable' },
    }));
    const executor = createExecutor({ sessionList, sessionActivityGet, isActionApprovalRequired: () => false,
      sessionAwarenessWait: async ({ input, options, readAwareness }) => waitForSessionAwarenessV1({
        condition: input.condition, deadlineMs: options.deadlineMs, signal: options.signal,
        read: async () => {
          const awareness = await readAwareness();
          return awareness ? { awareness: SessionAwarenessProjectionV1Schema.parse(awareness) } : null;
        },
        open: () => { throw new Error('Archived Session must match without subscribing'); },
      }),
    });
    const caller = (sessionId: string): ActionExecutorContext => ({
      surface: 'agent', authority: 'account_automation', serverId: 'home', defaultSessionId: sessionId,
      callerPermissionMode: 'read-only',
      sessionListAccess: 'led_subtree',
      actionCaller: { kind: 'session', sessionId, starterDepth: 1, turnDepth: 2 },
      agentStartContext: {
        caller: { kind: 'session', sessionId, starterDepth: 1, turnDepth: 2 },
        baseline: { machineId: 'machine', directory: '/repo' }, ledSubtreeSessionIds: [], roles: {},
        callerPermissionCeiling: 'read-only', workDepthLimit: 0,
      },
    });
    return { executor, sessionList, sessionActivityGet, caller };
  }

  it('admits a parent reading its server-proved led child before interception and preparation', async () => {
    const harness = sessionReadHarness();
    // The interceptor is the real plugin boundary; both sides use the same admission owner.
    const executor = createExecutor({
      sessionList: harness.sessionList, sessionActivityGet: harness.sessionActivityGet,
      isActionApprovalRequired: () => false,
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
    });
    const prepared = await executor.prepare('session.activity.get', { sessionId: 'child', view: 'awareness' }, harness.caller('parent'));
    if (prepared.kind !== 'ready') throw new Error(`Expected admitted led-child read: ${JSON.stringify(prepared.result)}`);
    expect(prepared.kind).toBe('ready');
    expect(harness.sessionActivityGet).not.toHaveBeenCalled();
    await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true, result: { sessionId: 'child' } });
    expect(harness.sessionList).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ underSessionId: 'parent' }) }));
  });

  it('observes a led child through generic wait and nested activity admission', async () => {
    const { executor, caller } = sessionReadHarness();
    const result = await executor.execute('wait', {
      target: { kind: 'session', serverId: 'home', sessionId: 'child' }, condition: { kind: 'terminal' },
    }, caller('parent'));
    if (!result.ok) throw new Error(`Expected admitted child observation: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ ok: true, result: { disposition: 'matched', snapshot: { awareness: { sessionId: 'child' } } } });
  });

  it('uses the existing host admission Session caller while FIN converges the Action caller', async () => {
    const { executor, caller } = sessionReadHarness();
    await expect(executor.execute('session.activity.get', { sessionId: 'child', view: 'awareness' }, {
      ...caller('parent'), actionCaller: undefined,
    })).resolves.toMatchObject({ ok: true, result: { sessionId: 'child' } });
  });

  it('keeps an explicit led-subtree MCP corpus bounded by the same host Session caller', async () => {
    const { executor, caller, sessionActivityGet } = sessionReadHarness();
    const context: ActionExecutorContext = { ...caller('parent'), surface: 'mcp', actionCaller: undefined };
    await expect(executor.execute('session.activity.get', { sessionId: 'unrelated', view: 'awareness' }, context))
      .resolves.toMatchObject({ ok: false });
    expect(sessionActivityGet).not.toHaveBeenCalled();
    await expect(executor.execute('session.activity.get', { sessionId: 'child', view: 'awareness' }, context))
      .resolves.toMatchObject({ ok: true, result: { sessionId: 'child' } });
  });

  it.each([['parent', 'unrelated'], ['child', 'parent']] as const)('refuses %s reading non-led %s before disclosure', async (source, target) => {
    const { executor, sessionActivityGet, caller } = sessionReadHarness();
    await expect(executor.execute('session.activity.get', { sessionId: target }, caller(source)))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(sessionActivityGet).not.toHaveBeenCalled();
    await expect(executor.execute('wait', {
      target: { kind: 'session', serverId: 'home', sessionId: target }, condition: { kind: 'terminal' },
    }, caller(source))).resolves.toMatchObject({ ok: false });
    expect(sessionActivityGet).not.toHaveBeenCalled();
    await expect(executor.execute('session.activity.get', { sessionId: source, view: 'awareness' }, caller(source)))
      .resolves.toMatchObject({ ok: true, result: { sessionId: source } });
  });

  it.each(['current_session', 'unavailable'] as const)('keeps the host %s restriction despite a led relation', async (sessionListAccess) => {
    const { executor, caller, sessionList, sessionActivityGet } = sessionReadHarness();
    await expect(executor.execute('session.activity.get', { sessionId: 'child' }, { ...caller('parent'), sessionListAccess }))
      .resolves.toMatchObject({ ok: false });
    expect(sessionList).not.toHaveBeenCalled();
    expect(sessionActivityGet).not.toHaveBeenCalled();
  });

  it('cannot forge a subtree read grant through Agent input or a foreign host caller', async () => {
    const { executor, caller, sessionActivityGet } = sessionReadHarness();
    await expect(executor.execute('session.activity.get', {
      sessionId: 'unrelated', sessionListAccess: 'led_subtree', ledSubtreeSessionIds: ['unrelated'],
      actionCaller: { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 },
    }, caller('child'))).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(executor.execute('session.activity.get', { sessionId: 'child' }, {
      ...caller('parent'), actionCaller: { kind: 'session', sessionId: 'foreign', starterDepth: 0, turnDepth: 0 },
    })).resolves.toMatchObject({ ok: false });
    expect(sessionActivityGet).not.toHaveBeenCalled();
  });

  it('refuses missing host caller facts and an unproved subtree without disclosing the target', async () => {
    const { caller, sessionActivityGet } = sessionReadHarness();
    const executor = createExecutor({ sessionActivityGet, isActionApprovalRequired: () => false });
    await expect(executor.execute('session.activity.get', { sessionId: 'child' }, caller('parent'))).resolves.toMatchObject({ ok: false });
    await expect(executor.execute('session.activity.get', { sessionId: 'child' }, {
      ...caller('parent'), agentStartContext: undefined,
    })).resolves.toMatchObject({ ok: false });
    expect(sessionActivityGet).not.toHaveBeenCalled();
  });

  it('does not turn the led read grant into permission to mutate a child', async () => {
    const { executor, caller } = sessionReadHarness();
    const input = { sessionId: 'child', modeId: 'plan' };
    expect(getActionSpec('session.mode.set').inputSchema.safeParse(input).success).toBe(true);
    await expect(executor.execute('session.mode.set', input, caller('parent')))
      .resolves.toMatchObject({ ok: false });
  });

  it('admits registered Session setters for own and server-proved led targets', async () => {
    const { caller, sessionList } = sessionReadHarness();
    const writes: Array<Readonly<{ sessionId: string; fieldId: string; value: unknown }>> = [];
    const executor = createExecutor({ sessionList, isActionApprovalRequired: () => false,
      sessionStateFieldSet: async (request) => {
        writes.push(request);
        return { ok: true, version: 3 };
      },
    });
    for (const sessionId of ['parent', 'child']) {
      for (const [actionId, input, fieldId, value] of [
        ['session.bot.set', { sessionId, bot: { kind: 'bot' } }, 'display.bot', { kind: 'bot' }],
        ['session.instructions.set', { sessionId, serverId: 'home', expectedMetadataRevision: 2, ref: null },
          'intent.context', { kind: 'detach', entryId: 'session.instructions' }],
      ] as const) {
        const prepared = await executor.prepare(actionId, input, caller('parent'));
        expect(prepared.kind).toBe('ready');
        if (prepared.kind !== 'ready') throw new Error(`Expected admitted registered setter: ${JSON.stringify(prepared.result)}`);
        await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true, result: { ok: true, version: 3 } });
        expect(writes.at(-1)).toMatchObject({ sessionId, fieldId, value });
      }
    }
    expect(writes).toHaveLength(4);
    await expect(executor.execute('session.bot.set', { sessionId: 'unrelated', bot: null }, caller('parent')))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(writes).toHaveLength(4);
  });

  it.each(['current_session', 'unavailable'] as const)('keeps registered Session setters within the host %s corpus', async (sessionListAccess) => {
    const { caller, sessionList } = sessionReadHarness();
    const writes: unknown[] = [];
    const executor = createExecutor({ sessionList, isActionApprovalRequired: () => false,
      sessionStateFieldSet: async (request) => { writes.push(request); return { ok: true }; },
    });
    await expect(executor.prepare('session.bot.set', { sessionId: 'child', bot: null }, { ...caller('parent'), sessionListAccess }))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'unsupported_action' } });
    expect(sessionList).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('rechecks registered Session setter membership after preparation and awaited Home reads', async () => {
    const { caller } = sessionReadHarness();
    let attached = true;
    const writes: unknown[] = [];
    const context = caller('parent');
    if (!context.agentStartContext) throw new Error('Missing host caller facts');
    context.agentStartContext = { ...context.agentStartContext, ledSubtreeSessionIds: ['child'] };
    const executor = createExecutor({ isActionApprovalRequired: () => false,
      sessionList: async () => markSessionListQueryResultV1({
        sessions: attached ? [{ id: 'child', active: false, presence: 'offline', updatedAt: 10 }] : [],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }),
      sessionStateFieldSet: async (request) => { writes.push(request); return { ok: true }; },
    });
    const prepared = await executor.prepare('session.bot.set', { sessionId: 'child', bot: null }, context);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected admitted registered setter');
    attached = false;
    await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(writes).toEqual([]);

    attached = true;
    const abort = new AbortController();
    const cancelled = createExecutor({ isActionApprovalRequired: () => false,
      sessionList: async () => {
        abort.abort();
        return markSessionListQueryResultV1({ sessions: [{ id: 'child', active: false, presence: 'offline', updatedAt: 10 }],
          nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
      },
      sessionStateFieldSet: async (request) => { writes.push(request); return { ok: true }; },
    });
    await expect(cancelled.execute('session.bot.set', { sessionId: 'child', bot: null }, { ...context, signal: abort.signal }))
      .resolves.toMatchObject({ ok: false });
    expect(writes).toEqual([]);
  });

  it('rechecks the same read admission after interception changes the target', async () => {
    const { sessionList, sessionActivityGet, caller } = sessionReadHarness();
    const executor = createExecutor({ sessionList, sessionActivityGet, isActionApprovalRequired: () => false,
      interceptActionExecution: async () => ({ status: 'continue', input: { sessionId: 'unrelated', view: 'awareness' } }),
    });
    await expect(executor.prepare('session.activity.get', { sessionId: 'child', view: 'awareness' }, caller('parent')))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false } });
    expect(sessionActivityGet).not.toHaveBeenCalled();
  });

  it('rechecks led membership when a prepared read runs after the child is detached', async () => {
    const { caller, sessionActivityGet } = sessionReadHarness();
    let attached = true;
    const executor = createExecutor({ isActionApprovalRequired: () => false, sessionActivityGet,
      sessionList: async () => markSessionListQueryResultV1({
        sessions: attached ? [{ id: 'child', active: false, presence: 'offline', updatedAt: 10 }] : [],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }),
    });
    const prepared = await executor.prepare('session.activity.get', { sessionId: 'child', view: 'awareness' }, caller('parent'));
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected admitted child read');
    attached = false;
    await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: false });
    expect(sessionActivityGet).not.toHaveBeenCalled();
  });

  it('does not reuse a captured led relation after the server revokes access', async () => {
    const { caller, sessionActivityGet } = sessionReadHarness();
    const context = caller('parent');
    if (!context.agentStartContext) throw new Error('Missing host caller facts');
    context.agentStartContext = { ...context.agentStartContext, ledSubtreeSessionIds: ['child'] };
    let accessible = true;
    const executor = createExecutor({ isActionApprovalRequired: () => false, sessionActivityGet,
      sessionList: async () => markSessionListQueryResultV1({
        sessions: accessible ? [{ id: 'child', active: false, presence: 'offline', updatedAt: 10 }] : [],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }),
    });
    const prepared = await executor.prepare('session.activity.get', { sessionId: 'child', view: 'awareness' }, context);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected admitted child read');
    accessible = false;
    await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(sessionActivityGet).not.toHaveBeenCalled();
  });

  it('refuses unavailable host list access before approval or a prepared continuation', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 'private-session' }] }));
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-exist' }));
    const executor = createExecutor({ sessionList, approvalsCreate, isActionApprovalRequired: () => true });
    const context = { surface: 'agent', authority: 'account_automation', sessionListAccess: 'unavailable' } as const;
    await expect(executor.prepare('session.list', {}, context)).resolves.toEqual({
      kind: 'settled',
      result: { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' },
    });
    await expect(executor.execute('session.list', { sessionListAccess: 'account' }, {
      ...context, bypassApprovals: true,
    })).resolves.toMatchObject({ ok: false });
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionList).not.toHaveBeenCalled();
  });

  it.each([
    { surface: 'cli', authority: 'present_user' },
    { surface: 'ui', authority: 'present_user' },
    { surface: 'api', authority: 'account_automation' },
  ] as const)('preserves existing credential-backed list admission on $surface', async (context) => {
    const payload = { sessions: [{ id: 'permitted-session', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null };
    const executor = createExecutor({ sessionList: async () => payload, isActionApprovalRequired: () => false });
    const prepared = await executor.prepare('session.list', {}, context);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected admitted list');
    await expect(prepared.invocation.run()).resolves.toEqual({ ok: true, result: payload });
  });

  it('defaults an agent list to its host-stamped led subtree', async () => {
    const payload = { sessions: [], nextCursor: null, hasNext: false, queryVersion: 1, attentionNextCursor: null, attentionHasNext: false };
    const sessionList = vi.fn(async () => payload);
    const executor = createExecutor({ sessionList, isActionApprovalRequired: () => false });

    await expect(executor.execute('session.list', {}, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'admitted-session',
    })).resolves.toEqual({ ok: true, result: payload });
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ underSessionId: 'admitted-session' }) }));
    sessionList.mockClear();
    await expect(executor.execute('session.list', { requestedBy: 'owner-account' }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'admitted-session',
      sessionListAccess: 'current_session',
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('admits the exact host-stamped current-Session corpus for an autonomous listing', async () => {
    const payload = { sessions: [{ id: 'admitted-session', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null };
    const sessionList = vi.fn(async () => payload);
    const executor = createExecutor({ sessionList, isActionApprovalRequired: () => false });

    await expect(executor.execute('session.list', {}, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'admitted-session',
      sessionListAccess: 'current_session',
    })).resolves.toEqual({ ok: true, result: payload });
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        defaultSessionId: 'admitted-session',
        sessionListAccess: 'current_session',
      }),
    }));
    sessionList.mockClear();
    await expect(executor.execute('session.list', { underSessionId: 'admitted-session' }, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: 'admitted-session', sessionListAccess: 'current_session',
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('admits a mounted plugin surface driven by the present user, and still refuses an autonomous one', async () => {
    const payload = { sessions: [{ id: 'listed-session', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null };
    const sessionList = vi.fn(async () => payload);
    const executor = createExecutor({ sessionList, isActionApprovalRequired: () => false });

    // A trusted plugin mounted in front of the person is that person reading
    // their own list, so it gets the corpus a `ui` caller gets.
    await expect(executor.execute('session.list', {}, {
      surface: 'plugin',
      authority: 'present_user',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'acme.board',
        contributionLocalId: 'sessions-panel',
      },
    })).resolves.toEqual({ ok: true, result: payload });

    // The same plugin invoked with no present user stays bound to its corpus.
    await expect(executor.execute('session.list', {}, {
      surface: 'plugin',
      authority: 'account_automation',
      actionCaller: { kind: 'plugin', pluginId: 'acme.board' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.list',
    });
  });

  it('settles admission failures without exposing a runnable mutation', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const executor = createExecutor({ sessionList });

    await expect(executor.prepare('session.list', { limit: 'invalid' }, {
      surface: 'api',
      authority: 'account_automation',
    })).resolves.toEqual({
      kind: 'settled',
      result: { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' },
    });
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('defers dispatch and memoizes the exact run promise', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 'session-1', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null }));
    const executor = createExecutor({ sessionList });

    const prepared = await executor.prepare('session.list', { limit: 1 }, {
      surface: 'api',
      authority: 'account_automation',
    });

    expect(prepared.kind).toBe('ready');
    expect(sessionList).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    const firstRun = prepared.invocation.run();
    const concurrentRun = prepared.invocation.run();
    expect(concurrentRun).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { sessions: [{ id: 'session-1', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null },
    });
    expect(prepared.invocation.run()).toBe(firstRun);
    expect(sessionList).toHaveBeenCalledTimes(1);
  });

  it('completes interception and semantic binding before returning ready, then observes settlement', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const interceptActionExecution = vi.fn(async () => ({
      status: 'continue' as const,
      input: { limit: 2 },
    }));
    const observeActionExecution = vi.fn(async () => {});
    const executor = createExecutor({
      sessionList,
      interceptActionExecution,
      observeActionExecution,
    });

    const prepared = await executor.prepare('session.list', { limit: 1 }, {
      surface: 'api',
      authority: 'account_automation',
    });

    expect(prepared.kind).toBe('ready');
    expect(interceptActionExecution).toHaveBeenCalledTimes(1);
    expect(sessionList).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    await prepared.invocation.run();
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.list',
      input: { limit: 2 },
      result: { ok: true, result: { sessions: [] } },
    }));
  });

  it('finishes directory preflight before ready and does not repeat it during run', async () => {
    const input = {
      creationKey: 'prepare-spawn-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: '/workspace/project' },
      agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
    };
    const sessionSpawnNewDirectoryApprovalPreflight = vi.fn(async () => ({
      type: 'not_required' as const,
    }));
    const sessionSpawnNew = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));
    const executor = createExecutor({
      sessionSpawnNewDirectoryApprovalPreflight,
      sessionSpawnNew,
      isActionApprovalRequired: () => false,
    });

    const prepared = await executor.prepare('session.spawn_new', input, {
      // The canonical spawn input carries executionTarget; the public api
      // projection treats placement as transport metadata and omits it.
      surface: 'cli',
      authority: 'present_user',
    });

    expect(prepared.kind).toBe('ready');
    expect(sessionSpawnNewDirectoryApprovalPreflight).toHaveBeenCalledTimes(1);
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');
    await prepared.invocation.run();
    expect(sessionSpawnNewDirectoryApprovalPreflight).toHaveBeenCalledTimes(1);
    expect(sessionSpawnNew).toHaveBeenCalledTimes(1);
  });

  it('retains the canonical fork cutoff, strategy, replay budget, and request identity through run', async () => {
    const sessionFork = vi.fn(async () => ({ ok: true as const, childSessionId: 'child-1' }));
    const executor = createExecutor({
      sessionFork,
      isActionApprovalRequired: () => false,
    });

    const prepared = await executor.prepare('session.fork', {
      sessionId: 'parent-1',
      forkPoint: { type: 'seq', upToSeqInclusive: 42 },
      strategy: 'replay',
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
      replayMaxSeedChars: 40_000,
      requestId: 'fork-request-1',
    }, {
      surface: 'rpc',
      authority: 'present_user',
      serverId: 'server-1',
    });

    expect(prepared.kind).toBe('ready');
    expect(sessionFork).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');
    await prepared.invocation.run();

    expect(sessionFork).toHaveBeenCalledWith({
      sessionId: 'parent-1',
      forkPoint: { type: 'seq', upToSeqInclusive: 42 },
      strategy: 'replay',
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
      replayMaxSeedChars: 40_000,
      requestId: 'fork-request-1',
      serverId: 'server-1',
    });
  });

  it('completes blocking approval admission before ready and dispatches only from run', async () => {
    let storedRequest: ApprovalRequest | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { artifactId: 'approval-1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => ({
      decision: 'approve' as const,
      request: {
        ...request,
        status: 'approved' as const,
        decision: { kind: 'approve' as const, decidedAtMs: 2 },
      },
    }));
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 'session-1', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null }));
    const executor = createExecutor({
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    });

    const prepared = await executor.prepare('session.list', {}, {
      surface: 'mcp',
      serverId: 'server-1',
      actionRequestId: 'request-1',
      defaultSessionId: 'session-1',
      sessionListAccess: 'current_session',
    });

    expect(prepared.kind).toBe('ready');
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
    expect(approvalsWaitForDecision).toHaveBeenCalledTimes(1);
    expect(sessionList).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    const firstRun = prepared.invocation.run();
    expect(prepared.invocation.run()).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { sessions: [{ id: 'session-1', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
    expect(storedRequest).toMatchObject({
      status: 'executed',
      execution: { ok: true, result: { sessions: [{ id: 'session-1', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null } },
    });
  });

  it('keeps blocking waiter ownership when approval is decided concurrently', async () => {
    let storedRequest: ApprovalRequest | null = null;
    let resolveWaiter: ((request: ApprovalRequest) => void) | null = null;
    let markWaiterReady: (() => void) | null = null;
    const waiterReady = new Promise<void>((resolve) => {
      markWaiterReady = resolve;
    });
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { artifactId: 'approval-concurrent-1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      if (request.status === 'approved') resolveWaiter?.(request);
      return { ok: true as const };
    });
    const approvalsResolveBlockingDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      resolveWaiter?.(request);
      return { resolved: true };
    });
    const approvalsWaitForDecision = vi.fn(async () => {
      markWaiterReady?.();
      const request = await new Promise<ApprovalRequest>((resolveDecision) => {
        resolveWaiter = resolveDecision;
      });
      return { decision: 'approve' as const, request };
    });
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 'session-1', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null }));
    const executor = createExecutor({
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    });

    const preparedPromise = executor.prepare('session.list', {}, {
      surface: 'mcp',
      serverId: 'server-1',
      actionRequestId: 'request-2',
      defaultSessionId: 'session-1',
      sessionListAccess: 'current_session',
    });
    await waiterReady;
    const decideResult = await executor.execute('approval.request.decide', {
      artifactId: 'approval-concurrent-1',
      decision: 'approve',
    }, {
      surface: 'mcp',
      authority: 'present_user',
    });
    const prepared = await preparedPromise;

    expect(decideResult).toEqual({ ok: true, result: { ok: true, status: 'approved' } });
    expect(prepared.kind).toBe('ready');
    expect(sessionList).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a ready invocation');

    const firstRun = prepared.invocation.run();
    expect(prepared.invocation.run()).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { sessions: [{ id: 'session-1', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
  });

  it('keeps execute as the terminal prepare-then-run convenience contract', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 'session-1', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null }));
    const executor = createExecutor({ sessionList });

    await expect(executor.execute('session.list', {}, {
      surface: 'api',
      authority: 'account_automation',
    })).resolves.toEqual({
      ok: true,
      result: { sessions: [{ id: 'session-1', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
  });
});
