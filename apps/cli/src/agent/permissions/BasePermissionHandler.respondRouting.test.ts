import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, buildSessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, createActionExecutor, isApprovalRequiredByActionsSettings, type ActionExecutorDeps } from '@happier-dev/protocol/actions';

import { AgentStateRequestStore, AgentStateResponseTargetDispatcher, type PermissionResponseClaim } from './agentStateRequestStore';
import { createSessionActionConfirmationAdapter } from '@/session/actions/approvals/sessionActionConfirmation';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from './testkit/serverBoundPermissionRpcHandlerManager';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import type { PermissionResult } from './BasePermissionHandler';
import { abortPendingAcpPermissionRequests } from '@/agent/acp/permissions/permissionFinalization';
import { SessionActionConfirmationsV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import { readSharedMetadataActionConfirmationState } from '@happier-dev/session-core/pending';
import { createDeferred } from '@/testkit/async/deferred';

beforeEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
  setActiveAccountSettingsSnapshot({ scopeKey: 'permission-test', source: 'network', settingsVersion: 1,
    settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
    promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
});
afterEach(() => resetActiveAccountSettingsSnapshotForTests());

class FakeSession {
  sessionId = 'session-test';
  rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  agentState: any = { requests: {}, completedRequests: {} };
  metadata: any = null;
  permissionResponseClaimWriteCount = 0;
  private readonly responseTargetDispatcher = new AgentStateResponseTargetDispatcher();

  getAgentStateResponseTargetDispatcher() {
    return this.responseTargetDispatcher;
  }

  private requestStore: AgentStateRequestStore | null = null;

  bindAgentStateRequestStore(store: AgentStateRequestStore) {
    this.requestStore = store;
  }

  getAgentStateRequestStore() {
    return this.requestStore;
  }

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    const nextState = updater(this.agentState);
    if (Object.values(nextState.requests ?? {}).some((request: any) => (
      request
      && typeof request === 'object'
      && Object.hasOwn(request, 'permissionResponseClaimV1')
    ))) {
      this.permissionResponseClaimWriteCount += 1;
    }
    this.agentState = nextState;
    return this.agentState;
  }

  getMetadataSnapshot() {
    return this.metadata;
  }
}

describe('BasePermissionHandler permission-response routing (gap 28/29)', () => {
  it('retires an aborted Run waiter without dispatching another native answer', async () => {
    const session = new FakeSession();
    new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Run withdrawal]' });
    const store = session.getAgentStateRequestStore()!;
    let applications = 0;
    store.registerResponseTargetHandler('execution_run_host_bridge', async () => {
      applications++;
      return false;
    }, { application: 'beforeCompletion' });
    try {
      await store.publishRequestAndWait({ requestId: 'withdrawn-run-waiter', toolName: 'Bash',
        toolInput: { command: 'echo harmless' }, createdAt: 1,
        responseTarget: { kind: 'execution_run_host_bridge' } });
      await expect(store.completeRequest({ requestId: 'withdrawn-run-waiter', status: 'canceled', decision: 'abort',
        reason: 'The local waiter was detached', extraCompletedFields: { responseTarget: undefined } })).resolves.toBe(true);
      expect(session.agentState.requests['withdrawn-run-waiter']).toBeUndefined();
      expect(session.agentState.completedRequests['withdrawn-run-waiter']).toMatchObject({ status: 'canceled', decision: 'abort' });
      expect(applications).toBe(0);
    } finally { store.dispose(); }
  });

  it.each(['refused', 'notHandled', 'pending', 'replaced'] as const)('keeps a Run question answer pending until native application is acknowledged: %s', async state => {
    const session = new FakeSession();
    new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Run question application]' });
    const store = session.getAgentStateRequestStore()!;
    const entered = createDeferred<void>();
    const nativeAck = createDeferred<void>();
    let refuse = state === 'refused';
    let notHandled = state === 'notHandled';
    let applications = 0;
    // Only the native application boundary is replaced; question RPC admission,
    // answer validation, request coordination and persistence remain real.
    store.registerResponseTargetHandler('execution_run_host_bridge', async dispatch => {
      applications++;
      expect(dispatch.completedRequest).toMatchObject({ structuredAnswersV1: { color: ['Blue'] },
        answerDetails: { color: { note: 'Native note' } } });
      if (refuse) throw new Error('Native answer refused');
      if (notHandled) return false;
      entered.resolve();
      await nativeAck.promise;
      return true;
    }, { application: 'beforeCompletion' });
    await store.publishRequestAndWait({ requestId: 'run-native-question', toolName: 'AskUserQuestion',
      toolInput: { questions: [{ id: 'color', question: 'Color?', selection: 'single',
        options: [{ id: 'Blue', label: 'Blue' }], allowCustom: true, allowNote: true }] },
      createdAt: 1, lifetime: 'occurrence', kind: 'user_action', source: 'native-question',
      questionV1: { mode: 'wait', lasting: false, type: 'decision' }, currentHandler: { kind: 'person' },
      responseTarget: { kind: 'execution_run_host_bridge' } });
    const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer')!;
    const answer = { id: 'run-native-question', approved: true, answers: { color: ['Blue'] },
      answerDetails: { color: { note: 'Native note' } } };
    let acknowledged = false;
    try {
      if (refuse) {
        await expect(rpc(answer)).rejects.toThrow('Native answer refused');
        expect(session.agentState.requests['run-native-question']).toBeDefined();
        expect(session.agentState.completedRequests['run-native-question']).toBeUndefined();
        refuse = false;
      }
      if (notHandled) {
        await expect(rpc(answer)).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        expect(session.agentState.requests['run-native-question']).toBeDefined();
        expect(session.agentState.completedRequests['run-native-question']).toBeUndefined();
        notHandled = false;
      }
      const answering = Promise.resolve(rpc(answer)).then(value => { acknowledged = true; return value; });
      await entered.promise;
      expect(acknowledged).toBe(false);
      expect(session.agentState.requests['run-native-question']).toBeDefined();
      expect(session.agentState.completedRequests['run-native-question']).toBeUndefined();
      if (state === 'replaced') {
        session.updateAgentState((current: import('@/api/types').AgentState) => ({ ...current, requests: { ...current.requests,
          'run-native-question': { ...current.requests?.['run-native-question'], createdAt: 2 } } }));
      }
      nativeAck.resolve();
      if (state === 'replaced') {
        await expect(answering).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        expect(session.agentState.requests['run-native-question'].createdAt).toBe(2);
        expect(session.agentState.completedRequests['run-native-question']).toBeUndefined();
      } else {
        await expect(answering).resolves.toBeUndefined();
        expect(session.agentState.requests['run-native-question']).toBeUndefined();
        expect(session.agentState.completedRequests['run-native-question']).toMatchObject({ status: 'approved',
          structuredAnswersV1: answer.answers, answerDetails: answer.answerDetails });
        expect(session.agentState.completedRequests['run-native-question'].responseTarget).toBeFalsy();
      }
      expect(applications).toBe(state === 'refused' || state === 'notHandled' ? 2 : 1);
    } finally { nativeAck.resolve(); store.dispose(); }
  });

  it('preserves selected answers, custom text and notes through RPC application and completed state', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Question details]' });
    let applied: PermissionResult | undefined;
    const pending = handler.handleToolCall('detailed-question', 'AskUserQuestion', {
      questions: [{ question: 'Choose?', options: [{ label: 'Yes', description: 'Continue' }], multiSelect: true,
        allowCustom: true, allowNote: true }],
    }, { acknowledgeDecisionApplication: async result => { applied = result; } });
    const answers = { 'Choose?': ['Yes'] };
    const answerDetails = { 'Choose?': { freeText: 'A custom alternative', note: 'Keep the selected answer too' } };
    await vi.waitFor(() => expect(session.agentState.requests['detailed-question']).toBeDefined());
    const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer')!;
    await expect(rpc({ id: 'detailed-question', approved: true, answers, answerDetails })).resolves.toBeUndefined();
    await expect(pending).resolves.toMatchObject({ decision: 'approved', answers, answerDetails });
    expect(applied).toMatchObject({ decision: 'approved', answers, answerDetails });
    expect(session.agentState.completedRequests['detailed-question']).toMatchObject({
      status: 'approved', structuredAnswersV1: answers, answerDetails,
    });
  });

  it('withdraws an open native question on explicit foreground Stop', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Stop]' });
    const pending = handler.handleToolCall('stopped-question', 'AskUserQuestion', {
      questions: [{ question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }], multiSelect: false }],
    }).catch(() => null);
    await vi.waitFor(() => expect(session.agentState.requests['stopped-question']).toBeDefined());
    await handler.reset({ scope: 'foreground' });
    await pending;
    expect(session.agentState.requests['stopped-question']).toBeUndefined();
    expect(session.agentState.completedRequests['stopped-question'])
      .toMatchObject({ status: 'canceled', reason: 'Foreground turn stopped' });
  });

  it.each(['reset', 'plugin', 'turn', 'acp-finalization'] as const)('keeps native questions answerable after incidental %s', async (lifecycle) => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Lifetime]' });
    const owner = { kind: 'plugin' as const, pluginId: 'plugin-a' };
    const context = { owner, turnId: 'question-turn' };
    const question = handler.handleToolCall('retained-question', 'AskUserQuestion', {
      questions: [{ question: 'Choose?', options: [{ label: 'Yes', description: 'Continue' }], multiSelect: false }],
    }, context).catch(() => null);
    const approval = handler.handleToolCall('retired-approval', 'Write', { path: '/tmp/x', content: 'hi' },
      context).catch(() => null);
    await vi.waitFor(() => {
      expect(session.agentState.requests['retained-question']).toBeDefined();
      expect(session.agentState.requests['retired-approval']).toBeDefined();
    });
    if (lifecycle === 'reset') await handler.reset();
    if (lifecycle === 'plugin') await handler.cancelByPlugin('plugin-a', 'agent_runtime_replaced');
    if (lifecycle === 'turn') await handler.cancelByPluginTurn('plugin-a', 'question-turn', 'turn ended');
    if (lifecycle === 'acp-finalization') await abortPendingAcpPermissionRequests(handler, 'ACP turn failed');
    expect(session.agentState.requests['retained-question']).toBeDefined();
    expect(session.agentState.completedRequests['retired-approval']).toMatchObject({ status: 'canceled' });
    await Promise.all([question, approval]);
    const replacement = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Replacement]' });
    const rpc = session.rpcHandlerManager.handlers.get('permission')!;
    await expect(rpc({ id: 'retained-question', approved: true, answers: { 'Choose?': 'Yes' } })).resolves.toBeUndefined();
    expect(session.agentState.requests['retained-question']).toBeUndefined();
    expect(session.agentState.completedRequests['retained-question']).toMatchObject({ status: 'approved' });
    await replacement.reset();
  });

  it.each([
    { name: 'unknown request', requestId: 'unknown', turnId: 'turn-current', decision: 'allow', errorCode: 'permission_request_not_found' },
    { name: 'stale turn', requestId: 'pending', turnId: 'turn-old', decision: 'allow', errorCode: 'permission_request_not_found' },
    { name: 'non-offered Session grant', requestId: 'pending', turnId: 'turn-current', decision: 'approved_for_session', errorCode: 'permission_response_invalid' },
  ] as const)('refuses an agent Action answer for $name without settling the current request', async ({ requestId, turnId, decision, errorCode }) => {
    const session = new FakeSession();
    session.agentState.requests.pending = {
      tool: 'Happier Action', kind: 'permission', source: 'happier_action',
      arguments: { actionId: 'session.message.send', sessionId: session.sessionId },
      turnId: 'turn-current', createdAt: 1,
    };
    new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Test]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'session.permission.respond': ['agent'] } });
    // Only the Session RPC transport is replaced; admission, policy, codecs,
    // request currentness and offered-answer validation are the real owners.
    const deps = {
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      sessionPermissionRespond: async ({ requestId: id, turnId: turn, decision: answer }) => rpc(
        buildSessionPermissionRespondRpcParamsV1({ id: id ?? '', turnId: turn ?? undefined, decision: answer }),
      ),
    } satisfies Pick<ActionExecutorDeps, 'isActionApprovalRequired' | 'sessionPermissionRespond'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const result = await executor.execute('session.permission.respond', { sessionId: session.sessionId, requestId, turnId, decision }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: session.sessionId,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode });
    expect(session.agentState.requests.pending).toMatchObject({ turnId: 'turn-current' });
    expect(session.agentState.completedRequests.pending).toBeUndefined();
  });
  it('rejects unknown permission RPC fields before settling the pending request', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');
    const pending = handler.handleToolCall('contradictory-request', 'Write', { path: '/tmp/x', content: 'hi' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    const result = await rpc({ id: 'contradictory-request', approved: true, decision: 'approved', actor: 'forged' });
    expect(result).toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
    expect(session.agentState.requests['contradictory-request']).toBeDefined();
    const canceled = expect(pending).rejects.toThrow('Session reset');
    await handler.reset();
    await canceled;
  });
  it('keeps predecessor scalar question answers on the legacy permission route', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Test]' });
    const pending = handler.handleToolCall('legacy-question', 'AskUserQuestion', {
      questions: [{ question: 'Choose?', options: [{ label: 'Yes', description: 'Continue' }], multiSelect: false }],
    });
    const rpc = session.rpcHandlerManager.handlers.get('permission')!;
    await expect(rpc({ id: 'legacy-question', approved: true, answers: { 'Choose?': 'Yes' } })).resolves.toBeUndefined();
    await expect(pending).resolves.toMatchObject({ decision: 'approved', answers: { 'Choose?': ['Yes'] } });
  });
  it.each(['approve', 'reset'] as const)('preserves live Action confirmation delivery after handler replacement: %s', async (completion) => {
    const session = new FakeSession();
    const initialHandler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Initial]' });
    const initialStore = session.getAgentStateRequestStore()!;
    const adapter = createSessionActionConfirmationAdapter({
      sessionId: session.sessionId, store: initialStore,
      sessionSignal: new AbortController().signal,
      getAuthenticatedAccountId: async () => 'account-owner',
    });
    await initialHandler.reset();
    let resolvedDecision: string | undefined;
    const pending = adapter.confirm({
      actionId: 'session.activity.get', input: { sessionId: session.sessionId },
      preview: { sessionId: session.sessionId }, sessionId: session.sessionId,
      context: {
        surface: 'agent', authority: 'account_automation', defaultSessionId: session.sessionId,
        sessionInputSource: { sourceSessionId: session.sessionId, sourceTurnId: 'turn-action', via: 'action' },
      },
    }, { turnId: 'turn-action', lifetimeSignal: new AbortController().signal, isCurrent: () => true })
      .then((result) => { resolvedDecision = result?.decision; });
    await vi.waitFor(() => expect(initialStore.listOutstandingRequests()).toHaveLength(1));
    const requestId = initialStore.listOutstandingRequests()[0]!.requestId;
    // Retained metadata preserves its presentation kind across handler replacement.
    const retained = SessionActionConfirmationsV1Schema.parse({
      v: 1, requests: session.agentState.requests, completedRequests: {},
    });
    expect(retained.requests[requestId]?.kind).toBe('user_action');
    session.agentState = readSharedMetadataActionConfirmationState({ actionConfirmationsV1: retained }, 1);
    expect(session.agentState.requests[requestId]).toBeDefined();
    const currentHandler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Current]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    if (completion === 'approve') {
      await rpc({ id: requestId, turnId: 'turn-action', approved: true, decision: 'approved' });
    } else {
      await currentHandler.reset();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const decisionAfterResponse = resolvedDecision;
    await adapter.dispose();
    await pending;
    expect(decisionAfterResponse).toBe(completion === 'approve' ? 'approve' : 'canceled');
    expect(session.agentState.completedRequests[requestId]).toMatchObject(completion === 'approve'
      ? { status: 'approved', decision: 'approved' }
      : { status: 'canceled', decision: 'abort' });
  });

  it.each([
    { decision: 'approved_for_session' },
    { decision: 'approved', allowedTools: ['Bash'] },
    { decision: 'approved', allowTools: ['Bash'] },
  ])('rejects native permission grants on a Happier Action confirmation: %j', async (grant) => {
    const session = new FakeSession();
    session.agentState.requests['action-confirmation'] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: { command: 'echo hi' },
      source: 'happier_action',
      createdAt: 1,
    };
    new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Test]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    const result = await rpc!({ id: 'action-confirmation', approved: true, ...grant });
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(session.agentState.requests['action-confirmation']).toBeDefined();
    expect(session.agentState.completedRequests['action-confirmation']).toBeUndefined();
  });

  it('accepts one authenticated request-scoped Action decision with exact turn custody', async () => {
    const session = new FakeSession();
    session.agentState.requests['action-confirmation'] = {
      tool: 'Happier Action',
      kind: 'permission',
      arguments: { actionId: 'session.message.send', sessionId: session.sessionId },
      source: 'happier_action',
      turnId: 'turn-action',
      createdAt: 1,
    };
    new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Test]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    await expect(rpc!({
      id: 'action-confirmation', turnId: 'turn-action', approved: true, decision: 'approved', answeringClientCategory: 'ios',
    })).resolves.toBeUndefined();
    expect(session.agentState.requests['action-confirmation']).toBeUndefined();
    expect(session.agentState.completedRequests['action-confirmation']).toEqual(expect.objectContaining({
      status: 'approved',
      decision: 'approved',
      turnId: 'turn-action',
      answeringClientCategory: 'ios',
      permissionDecisionActorV1: expect.objectContaining({ accountId: 'account-owner' }),
    }));
  });

  it('returns a typed permission_request_not_found for an unknown explicit id over the RPC route', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();

    const result = await rpc!({ id: 'never-seen-request', approved: true, decision: 'approved' });
    expect(result).toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'never-seen-request',
    });
  });

  it('returns void (success) over the RPC route when the explicit id resolves a pending request', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const promise = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    const result = await rpc!({ id: 'tool-1', approved: true, decision: 'approved' });
    expect(result).toBeUndefined();
    expect((await promise).decision).toBe('approved');
  });

  it('durably claims an authenticated present-user answer before settling the request', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const promise = handler.handleToolCall('preactivation-request', 'Write', { path: '/tmp/x', content: 'hi' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');

    await expect(rpc!({ id: 'preactivation-request', approved: true, decision: 'approved' })).resolves.toBeUndefined();
    await expect(promise).resolves.toEqual(expect.objectContaining({ decision: 'approved' }));
    expect(session.permissionResponseClaimWriteCount).toBe(1);
  });

  it('binds a provided question answer turn to the published request while preserving ordinary turnless answers', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[QuestionTurn]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer')!;
    const input = { questions: [{ id: 'branch', question: 'Which branch?', options: [{ id: 'main', label: 'Main' }, { id: 'release', label: 'Release' }] }] };
    const turnA = handler.handleToolCall('reused-question', 'AskUserQuestion', input, { turnId: 'turn-a' });
    await vi.waitFor(() => expect(session.agentState.requests['reused-question']).toMatchObject({ turnId: 'turn-a' }));
    await expect(rpc({ id: 'reused-question', turnId: 'turn-a', approved: true, answers: { branch: ['main'] } })).resolves.toBeUndefined();
    await expect(turnA).resolves.toMatchObject({ decision: 'approved', answers: { branch: ['main'] } });

    const turnB = handler.handleToolCall('reused-question', 'AskUserQuestion', input, { turnId: 'turn-b' });
    let turnBSettled = false;
    void turnB.then(() => { turnBSettled = true; }, () => { turnBSettled = true; });
    await vi.waitFor(() => expect(session.agentState.requests['reused-question']).toMatchObject({ turnId: 'turn-b' }));
    await expect(rpc({ id: 'reused-question', turnId: 'turn-a', approved: true, answers: { branch: ['main'] } }))
      .resolves.toEqual({ ok: false, errorCode: 'permission_request_not_found', requestId: 'reused-question' });
    expect(turnBSettled).toBe(false);
    expect(session.agentState.requests['reused-question']).toMatchObject({ turnId: 'turn-b' });
    await expect(rpc({ id: 'reused-question', turnId: 'turn-b', approved: true, answers: { branch: ['release'] } })).resolves.toBeUndefined();
    await expect(turnB).resolves.toMatchObject({ decision: 'approved', answers: { branch: ['release'] } });

    const ordinary = handler.handleToolCall('ordinary-question', 'AskUserQuestion', input, { turnId: 'turn-c' });
    await vi.waitFor(() => expect(session.agentState.requests['ordinary-question']).toMatchObject({ turnId: 'turn-c' }));
    await expect(rpc({ id: 'ordinary-question', approved: true, answers: { branch: ['main'] } })).resolves.toBeUndefined();
    await expect(ordinary).resolves.toMatchObject({ decision: 'approved', answers: { branch: ['main'] } });
    await handler.reset();
  });

  it('does not write a turn-bound question answer over a replacement published during settlement', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[QuestionTurnWrite]' });
    const pending = handler.handleToolCall('inflight-question', 'AskUserQuestion', {
      questions: [{ id: 'branch', question: 'Which branch?', options: [{ id: 'main', label: 'Main' }] }],
    }, { turnId: 'turn-a' });
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(session.agentState.requests['inflight-question']).toMatchObject({ turnId: 'turn-a' }));
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const writing = new Promise<void>((resolve) => { reached = resolve; });
    const update = session.updateAgentState.bind(session);
    session.updateAgentState = async (updater) => {
      reached();
      await paused;
      return update(updater);
    };
    const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer')!;
    const answering = rpc({ id: 'inflight-question', turnId: 'turn-a', approved: true, answers: { branch: ['main'] } });
    await writing;
    session.agentState.requests['inflight-question'] = { ...session.agentState.requests['inflight-question'], turnId: 'turn-b' };
    release();
    await expect(answering).resolves.toEqual({ ok: false, errorCode: 'permission_request_not_found', requestId: 'inflight-question' });
    expect(session.agentState.requests['inflight-question']).toMatchObject({ turnId: 'turn-b' });
    expect(session.agentState.completedRequests['inflight-question']).toBeUndefined();
    session.updateAgentState = update;
    await handler.reset({ scope: 'foreground' });
  });

  it('does not let a delayed answer from turn A settle a reused request id in turn B', async () => {
    const session = new FakeSession();
    const handler = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    const causalContext = (turnId: string) => ({
      turnId,
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'default' as const,
      },
    });

    const turnA = handler.handleToolCall(
      'reused-request',
      'Write',
      { path: '/tmp/a', content: 'a' },
      causalContext('turn-a'),
    );
    await expect(rpc!({
      id: 'reused-request',
      turnId: 'turn-a',
      approved: false,
      decision: 'denied',
    })).resolves.toBeUndefined();
    await expect(turnA).resolves.toEqual(expect.objectContaining({ decision: 'denied' }));
    await expect(rpc!({
      id: 'reused-request',
      turnId: 'turn-a',
      approved: false,
      decision: 'denied',
    })).resolves.toBeUndefined();

    const turnB = handler.handleToolCall(
      'reused-request',
      'Write',
      { path: '/tmp/b', content: 'b' },
      causalContext('turn-b'),
    );
    await expect(rpc!({
      id: 'reused-request',
      turnId: 'turn-a',
      approved: true,
      decision: 'approved',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'reused-request',
    });
    expect(session.agentState.requests['reused-request']).toEqual(expect.objectContaining({ turnId: 'turn-b' }));

    await expect(rpc!({
      id: 'reused-request',
      turnId: 'turn-b',
      approved: true,
      decision: 'approved',
    })).resolves.toBeUndefined();
    await expect(turnB).resolves.toEqual(expect.objectContaining({ decision: 'approved' }));
  });

  it('keeps a claimed present-user answer nonauthorizing after handler reset', async () => {
    const session = new FakeSession();
    const original = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Original]' });
    original.setPermissionMode('safe-yolo');

    const originalWaiter = original.handleToolCall(
      'generation-transition-request',
      'Write',
      { path: '/tmp/x', content: 'hi' },
    );
    const originalOutcome = originalWaiter.then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await Promise.resolve();
    const claimedPresentUserAnswer = {
      version: 1,
      origin: 'presentUser',
      actor: {
        kind: 'accountUser',
        accountId: 'account-owner',
        relationship: 'owner',
      },
      decision: 'approved',
      scope: 'request',
    } satisfies PermissionResponseClaim;
    session.agentState.requests['generation-transition-request'].permissionResponseClaimV1 = claimedPresentUserAnswer;

    // Reset is a lifecycle cancellation boundary. Its Agent-state terminal
    // cancellation, not the in-flight answer claim, survives replacement.
    await original.reset();
    const replacement = new ProviderEnforcedPermissionHandler(session as any, { logPrefix: '[Replacement]' });
    replacement.setPermissionMode('safe-yolo');
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(rpc).toBeDefined();

    await expect(rpc!({
      id: 'generation-transition-request',
      approved: false,
      decision: 'denied',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'generation-transition-request',
    });
    expect(session.agentState.requests['generation-transition-request']).toBeUndefined();
    expect(session.agentState.completedRequests['generation-transition-request']).toEqual(expect.objectContaining({
      status: 'canceled',
      decision: 'abort',
      reason: 'Session reset',
    }));

    await expect(rpc!({
      id: 'generation-transition-request',
      approved: true,
      decision: 'approved',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'generation-transition-request',
    });
    expect(session.agentState.completedRequests['generation-transition-request']).toEqual(expect.objectContaining({
      status: 'canceled',
      decision: 'abort',
    }));

    const settledOriginal = await originalOutcome;
    expect(settledOriginal.status).toBe('rejected');
    expect(settledOriginal.status === 'rejected' ? settledOriginal.error : null).toEqual(
      expect.objectContaining({ message: 'Session reset' }),
    );
    await original.reset();
    await replacement.reset();
  });

});

const nativeChoicesFixture = {
  requirementId: 'native-requirement', source: 'native-test',
  origin: { sessionId: 'native-parent', subagentId: 'child' },
  choices: [
    { id: 'opaque-once', label: 'Run this operation', decision: 'approved', scope: 'once', allowsFeedback: true, response: { approved: true, decision: 'approved' } },
    { id: 'opaque-session', label: 'Allow this Session', decision: 'approved_for_session', scope: 'session', response: { approved: true, decision: 'approved_for_session' } },
    { id: 'opaque-save', label: 'Save local rule', decision: 'approved', scope: 'localPersistent', response: { approved: true, decision: 'approved' } },
    { id: 'opaque-stop', label: 'Stop native work', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } },
  ],
} as const satisfies NativePermissionChoicesV1;

class NativeChoicesHandler extends ProviderEnforcedPermissionHandler {
  requestNative(acknowledgeDecisionApplication?: (result: PermissionResult) => Promise<void>, nativeChoices: NativePermissionChoicesV1 = nativeChoicesFixture) {
    return this.handleToolCall('native-pending', 'NativeTool', {}, {
      nativeChoices, acknowledgeDecisionApplication,
    });
  }
}

function sharedApproverContext(sessionId: string) {
  return { signal: new AbortController().signal, authorization: {
    kind: 'session.permission.respond', sessionId,
    actor: { kind: 'accountUser', accountId: 'shared-user', relationship: 'sharedApprover' },
  } };
}

describe('native offered permission ingress', () => {
  it.each([
    { name: 'bash persistent', sessionId: 'cmwcukh1p008omcjqre7ahinv',
      requestId: 'call_01a1cd4c44ec7686b40259ad68a30416', approvalId: '01a1cd4c-483f-70f3-bc29-714e650316a2',
      turnId: 'native-turn-8381f964-b71e-4e72-9064-b7ebd2e04fee-1', tool: 'bash', mode: 'default',
      choiceId: 'allow_local_prefix', decision: 'approved_execpolicy_amendment', scope: 'localPersistent' },
    { name: 'Happier MCP Session', sessionId: 'cmwcupz7u00dvmcjqkn0r7wir',
      requestId: 'call_01a1cd4f877f765db523ac357e6446d8', approvalId: '01a1cd4f-8a1e-7fc0-8c39-c1dff893e381',
      turnId: 'native-turn-bdf1eb38-c2fc-4220-8d4a-e49bb19bf7de-1', tool: 'mcp__happier__action_spec_get', mode: 'safe-yolo',
      choiceId: 'allow_session', decision: 'approved_for_session', scope: 'session' },
  ] as const)('answers the R1112A $name Action without a turn override and rejoins its exact retry', async (sample) => {
    const session = new FakeSession();
    session.sessionId = sample.sessionId;
    session.rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(session.sessionId);
    const handler = new NativeChoicesHandler(session as never, { logPrefix: '[R1112A]' });
    handler.setPermissionMode(sample.mode);
    // QA exposes the native requirement object as an opaque JSON string at
    // the Action boundary. Keep it opaque through the real ingress owners.
    const nativeChoice = { requirementId: JSON.stringify({ approvalId: sample.approvalId, sourceIndex: 0 }),
      choiceId: sample.choiceId };
    const pending = handler.handleToolCall(sample.requestId, sample.tool, {}, {
      turnId: sample.turnId,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      nativeChoices: { requirementId: nativeChoice.requirementId, source: 'muse', choices: [{
        id: sample.choiceId, label: sample.name, decision: sample.decision, scope: sample.scope,
        response: { approved: true, decision: sample.decision },
      }] },
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(session.agentState.requests[sample.requestId]).toMatchObject({ turnId: sample.turnId }));
      const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
      const settings = ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'session.permission.respond': ['agent'] } });
      // Replace the authenticated Session network boundary only. Admission,
      // Action dispatch, RPC codec, pending/claim owners and policy stay real.
      const deps = {
        isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
        sessionPermissionRespond: async ({ requestId, turnId, nativeChoice: choice }) => {
          const result = await rpc(buildSessionPermissionRespondRpcParamsV1({ id: requestId ?? '',
            ...(turnId == null ? {} : { turnId }), ...(choice ? { nativeChoice: choice } : {}),
          }));
          return result ?? { ok: true };
        },
      } satisfies Pick<ActionExecutorDeps, 'isActionApprovalRequired' | 'sessionPermissionRespond'>;
      const executor = createActionExecutor(deps as ActionExecutorDeps);
      const answer = (overrides = {}) => executor.execute('session.permission.respond', {
        sessionId: sample.sessionId, requestId: sample.requestId, nativeChoice, ...overrides,
      }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        defaultSessionId: sample.sessionId });
      await expect(answer({ turnId: 'another-turn' })).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
      await expect(answer({ nativeChoice: { ...nativeChoice,
        requirementId: JSON.stringify({ approvalId: sample.approvalId, sourceIndex: 1 }) } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
      expect(session.agentState.requests[sample.requestId]).toBeDefined();
      await expect(answer()).resolves.toMatchObject({ ok: true });
      await expect(pending).resolves.toMatchObject({ decision: sample.decision, nativeChoice });
      expect(session.agentState.requests[sample.requestId]).toBeUndefined();
      expect(session.agentState.completedRequests[sample.requestId]).toMatchObject({ turnId: sample.turnId,
        decision: sample.decision, nativeChoice });
      await expect(answer()).resolves.toMatchObject({ ok: true });
      expect(session.permissionResponseClaimWriteCount).toBe(1);
    } finally { await handler.reset(); }
  });

  it('keeps the native offer pending when another request grants the same tool for the Session', async () => {
    const session = new FakeSession();
    const handler = new NativeChoicesHandler(session as never, { logPrefix: '[Native allowlist]' });
    const native = handler.requestNative();
    void native.catch(() => undefined);
    const legacy = handler.handleToolCall('legacy-grant', 'NativeTool', {});
    void legacy.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(session.agentState.requests['legacy-grant']).toBeDefined());
      const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
      await expect(rpc({ id: 'legacy-grant', approved: true, decision: 'approved_for_session', allowedTools: ['NativeTool'] }))
        .resolves.toBeUndefined();
      await expect(legacy).resolves.toMatchObject({ decision: 'approved_for_session' });
      await new Promise(resolve => setImmediate(resolve));
      expect(session.agentState.requests['native-pending']).toMatchObject({ nativeChoices: nativeChoicesFixture });
      expect(session.agentState.completedRequests['native-pending']).toBeUndefined();
      await expect(rpc({ id: 'native-pending', nativeChoice: { requirementId: 'native-requirement', choiceId: 'opaque-once' } }))
        .resolves.toBeUndefined();
      await expect(native).resolves.toMatchObject({ nativeChoice: { choiceId: 'opaque-once' } });
    } finally { await handler.reset(); }
  });
  it.each([
    { answer: { approved: true }, choiceId: 'opaque-once' },
    { answer: { approved: true, decision: 'approved_for_session' }, choiceId: 'opaque-session' },
    { answer: { approved: false, decision: 'denied' }, choiceId: 'opaque-stop' },
    { answer: { approved: false, decision: 'abort' }, choiceId: 'opaque-stop' },
  ] as const)('answers a native offer with the plain Action decision $answer through its one matching offered choice', async ({ answer, choiceId }) => {
    // `session.permission.respond` advertises Allow/Deny to CLI, Agent, MCP and voice callers.
    const session = new FakeSession();
    const handler = new NativeChoicesHandler(session as never, { logPrefix: '[Native plain]' });
    const native = handler.requestNative();
    void native.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(session.agentState.requests['native-pending']).toBeDefined());
      await expect(session.rpcHandlerManager.handlers.get('session.permission.respond')!({ id: 'native-pending', ...answer }))
        .resolves.toBeUndefined();
      await expect(native).resolves.toMatchObject({ nativeChoice: { requirementId: 'native-requirement', choiceId } });
      expect(Object.keys(session.agentState.completedRequests)).toEqual(['native-pending']);
    } finally { await handler.reset(); }
  });

  it('refuses a plain Action decision that matches more than one offered native choice', async () => {
    const session = new FakeSession();
    const handler = new NativeChoicesHandler(session as never, { logPrefix: '[Native plain]' });
    const native = handler.requestNative(undefined, { ...nativeChoicesFixture, choices: [...nativeChoicesFixture.choices,
      { id: 'opaque-once-2', label: 'Run with sandbox', decision: 'approved', scope: 'once', response: { approved: true, decision: 'approved' } }] });
    void native.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(session.agentState.requests['native-pending']).toBeDefined());
      await expect(session.rpcHandlerManager.handlers.get('session.permission.respond')!({ id: 'native-pending', approved: true }))
        .resolves.toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
      expect(Object.keys(session.agentState.completedRequests)).toEqual([]);
    } finally { await handler.reset(); }
  });

  it.each(['permission', 'session.permission.respond'])('requires a current offered answer on %s and keeps refusals pending', async (route) => {
    const session = new FakeSession();
    session.agentState.requests.pending = { tool: 'NativeTool', arguments: {}, createdAt: 1, nativeChoices: nativeChoicesFixture };
    new NativeChoicesHandler(session as never, { logPrefix: '[Native]' });
    const rpc = session.rpcHandlerManager.handlers.get(route)!;
    for (const nativeChoice of [undefined,
      { requirementId: 'old-requirement', choiceId: 'opaque-once' },
      { requirementId: 'native-requirement', choiceId: 'unoffered' }]) {
      // A plain grant that native choices cannot carry (a tool rule) is unoffered.
      await expect(rpc({ id: 'pending', ...(nativeChoice ? { nativeChoice } : { approved: true, allowedTools: ['NativeTool'] }) }))
        .resolves.toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
      expect(session.agentState.requests.pending).toBeDefined();
      expect(session.agentState.completedRequests.pending).toBeUndefined();
    }
  });

  it('does not downgrade malformed native metadata to legacy approval', async () => {
    const session = new FakeSession();
    session.agentState.requests.pending = { tool: 'NativeTool', arguments: {}, createdAt: 1,
      nativeChoices: { requirementId: 'broken' } };
    new NativeChoicesHandler(session as never, { logPrefix: '[Native]' });
    await expect(session.rpcHandlerManager.handlers.get('permission')!({ id: 'pending', approved: true }))
      .resolves.toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
    expect(session.agentState.requests.pending).toBeDefined();
  });

  it('uses the stored offered outcome for an opaque native answer', async () => {
    const session = new FakeSession();
    session.agentState.requests.pending = { tool: 'NativeTool', arguments: {}, createdAt: 1, nativeChoices: nativeChoicesFixture };
    new NativeChoicesHandler(session as never, { logPrefix: '[Native]' });
    await expect(session.rpcHandlerManager.handlers.get('permission')!({ id: 'pending',
      nativeChoice: { requirementId: 'native-requirement', choiceId: 'opaque-stop' },
      approved: true, decision: 'approved_for_session', mode: 'bypassPermissions', allowedTools: ['NativeTool'] })).resolves.toBeUndefined();
    expect(session.agentState.completedRequests.pending).toMatchObject({ status: 'denied', decision: 'abort' });
  });

  it.each(['opaque-once', 'opaque-session', 'opaque-save'])('enforces owner-only durable native scope for %s', async (choiceId) => {
    const session = new FakeSession();
    session.agentState.requests.pending = { tool: 'NativeTool', arguments: {}, createdAt: 1, nativeChoices: nativeChoicesFixture };
    new NativeChoicesHandler(session as never, { logPrefix: '[Native]' });
    const result = await session.rpcHandlerManager.handlers.get('session.permission.respond')!({ id: 'pending',
      nativeChoice: { requirementId: 'native-requirement', choiceId } }, sharedApproverContext(session.sessionId));
    if (choiceId === 'opaque-save') {
      expect(result).toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
      expect(session.agentState.requests.pending).toBeDefined();
    } else {
      expect(result).toBeUndefined();
      expect(session.agentState.requests.pending).toBeUndefined();
    }
  });

  it.each([
    { mode: 'acceptEdits' },
    { allowedTools: ['NativeTool'] },
    { updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }] },
    { execPolicyAmendment: { command: ['echo', 'hi'] } },
  ] as const)('requires the owner for a durable offered payload even at once scope: %j', async response => {
    const session = new FakeSession();
    const choices = { ...nativeChoicesFixture, choices: [{ id: 'durable', label: 'Grant',
      scope: 'once', decision: 'approved', response: { approved: true, decision: 'approved', ...response } }] };
    session.agentState.requests.pending = { tool: 'NativeTool', arguments: {}, createdAt: 1, nativeChoices: choices };
    new NativeChoicesHandler(session as never, { logPrefix: '[Native]' });
    const result = await session.rpcHandlerManager.handlers.get('session.permission.respond')!({ id: 'pending',
      nativeChoice: { requirementId: 'native-requirement', choiceId: 'durable' } }, sharedApproverContext(session.sessionId));
    expect(result).toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
    expect(session.agentState.requests.pending).toBeDefined();
    const ownerSession = new FakeSession();
    ownerSession.agentState.requests.pending = { tool: 'NativeTool', arguments: {}, createdAt: 1, nativeChoices: choices };
    new NativeChoicesHandler(ownerSession as never, { logPrefix: '[NativeOwner]' });
    await expect(ownerSession.rpcHandlerManager.handlers.get('session.permission.respond')!({ id: 'pending',
      nativeChoice: { requirementId: 'native-requirement', choiceId: 'durable' } })).resolves.toBeUndefined();
    expect(ownerSession.agentState.completedRequests.pending).toMatchObject({ decision: 'approved' });
  });

  it('publishes a replacement native offer on the existing pending request', async () => {
    const session = new FakeSession();
    const handler = new NativeChoicesHandler(session as never, { logPrefix: '[NativeReplacement]' });
    const original = handler.requestNative();
    void original.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(session.agentState.requests['native-pending']?.nativeChoices?.requirementId).toBe('native-requirement'));
      const replacement = handler.requestNative(undefined, { ...nativeChoicesFixture, requirementId: 'new-offer' });
      void replacement.catch(() => undefined);
      await vi.waitFor(() => expect(session.agentState.requests['native-pending']?.nativeChoices?.requirementId).toBe('new-offer'));
      const rpc = session.rpcHandlerManager.handlers.get('permission')!;
      await expect(rpc({ id: 'native-pending', nativeChoice: { requirementId: 'native-requirement', choiceId: 'opaque-once' } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
      await expect(rpc({ id: 'native-pending', nativeChoice: { requirementId: 'new-offer', choiceId: 'opaque-once' } }))
        .resolves.toBeUndefined();
      await expect(replacement).resolves.toMatchObject({ nativeChoice: { requirementId: 'new-offer' } });
    } finally { await handler.reset(); }
  });

  it('uses the replaced requirement after reconstruction and refuses feedback unless offered', async () => {
    const session = new FakeSession();
    const handler = new NativeChoicesHandler(session as never, { logPrefix: '[Native]' });
    let applications = 0;
    const pending = handler.requestNative(async () => { applications += 1; });
    await vi.waitFor(() => expect(session.agentState.requests['native-pending']).toBeDefined());
    session.agentState.requests['native-pending'] = { ...session.agentState.requests['native-pending'],
      nativeChoices: { ...nativeChoicesFixture, requirementId: 'replacement' } };
    const rpc = session.rpcHandlerManager.handlers.get('permission')!;
    for (const nativeChoice of [
      { requirementId: 'native-requirement', choiceId: 'opaque-once' },
      { requirementId: 'replacement', choiceId: 'opaque-session', feedback: 'unoffered feedback' },
    ]) {
      await expect(rpc({ id: 'native-pending', nativeChoice })).resolves.toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
    }
    expect(applications).toBe(0);
    expect(session.agentState.requests['native-pending']).toBeDefined();
    await expect(rpc({ id: 'native-pending', nativeChoice: { requirementId: 'replacement', choiceId: 'opaque-once' } }))
      .resolves.toBeUndefined();
    await expect(pending).resolves.toMatchObject({ nativeChoice: { requirementId: 'replacement' } });
    expect(applications).toBe(1);
    await handler.reset();
  });

  it('preserves the choice through publication and awaits native application, leaving native rejection pending', async () => {
    const session = new FakeSession();
    const handler = new NativeChoicesHandler(session as never, { logPrefix: '[Native]' });
    handler.setPermissionMode('yolo');
    let release!: () => void;
    let rejectApplication = true;
    const applied: PermissionResult[] = [];
    const pending = handler.requestNative(async result => {
      applied.push(result);
      if (rejectApplication) throw new Error('native refused');
      await new Promise<void>(resolve => { release = resolve; });
    });
    await vi.waitFor(() => expect(session.agentState.requests['native-pending']?.nativeChoices).toEqual(nativeChoicesFixture));
    const answer = { id: 'native-pending',
      nativeChoice: { requirementId: 'native-requirement', choiceId: 'opaque-once', feedback: 'apply this operation' } };
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    await expect(rpc(answer)).rejects.toThrow('native refused');
    expect(session.agentState.requests['native-pending']).toBeDefined();
    rejectApplication = false;
    let returned = false;
    const response = Promise.resolve(rpc(answer)).then(result => { returned = true; return result; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(returned).toBe(false);
    expect(session.agentState.completedRequests['native-pending']).toBeUndefined();
    release();
    await expect(response).resolves.toBeUndefined();
    await expect(pending).resolves.toMatchObject({ decision: 'approved', nativeChoice: answer.nativeChoice });
    expect(applied).toHaveLength(2);
    await handler.reset();
  });
});
