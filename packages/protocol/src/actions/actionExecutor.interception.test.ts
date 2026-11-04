import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import * as authority from './decisionAuthority.js';
import * as credentials from '../auth/apiTokenGrant.js';
import * as callerContext from './executor/callerContext.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}),
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
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({ sessions: [] }),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

describe('createActionExecutor execution interception', () => {
  it('observes an admitted pending deployment without evaluating its grant again', async () => {
    const grants = vi.spyOn(credentials, 'evaluateApiTokenGrantV1');
    const grant = { ...credentials.API_TOKEN_FULL_GRANT_V1 };
    const credential = { accountId: 'account', principalId: 'token', credentialId: 'token', grant };
    const input = { serverId: 'home', environmentId: 'environment', requestKey: 'deploy', targetLinkId: 'link' };
    const executor = createExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ observePendingOperation: async () => ({ ok: true,
        result: { ok: true, environmentId: 'environment', revision: 4, kind: 'pending', actionOperationId: 'operation' } }) }),
    });
    try {
      const prepared = await executor.prepare('deployments.deploy', input, {
        surface: 'api', authority: 'account_automation', serverId: 'home', bypassApprovals: true,
        externalActionCredential: credential, externalActionTarget: { kind: 'machine', machineId: 'machine' },
        externalActionExecutionAuthorization: { v: 1, token: 'signed', binding: {
          ...credential, serverIdentityId: 'home', custodianAccountId: 'account', installationId: 'installation',
          actionId: 'deployments.deploy', machineId: 'machine', target: { kind: 'machine', machineId: 'machine' },
          requestId: 'deploy', requestEnvelopeDigest: 'A'.repeat(43), environmentId: 'environment',
        } },
      });
      expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Expected admitted pending operation');
      grants.mockClear();
      await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
      expect(grants).not.toHaveBeenCalled();
    } finally { grants.mockRestore(); }
  });
  it('admits discussion participants once and spends the prepared machine-target grant at dispatch', async () => {
    const targets = vi.spyOn(credentials, 'isApiTokenGrantTargetMemberV1');
    const machineReads = vi.fn(async () => 'machine');
    const executor = createExecutor({
      resolveApiTokenGrantSessionMachineId: machineReads,
      discussionAction: async () => ({ v: 1, serverId: 'home', discussion: {
        id: 'discussion', ownerAccountId: 'account', title: 'Review', encryptionMode: 'plain',
        anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'review',
        latestMessage: { id: 'first', localId: 'first', seq: 1, authorAccountId: 'account',
          accountActor: { v: 1, accountId: 'account', profile: null }, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0,
        recentAuthorAccountIds: [], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
          sendToSession: true, manageAccess: true, leave: false },
      }, firstMessage: { id: 'first', localId: 'first', seq: 1, authorAccountId: 'account',
        accountActor: { v: 1, accountId: 'account', profile: null }, producerV1: null, createdAt: 1,
        discussionId: 'discussion', content: { v: 1, parts: [{ t: 'text', text: 'Review' }] }, mentionedAccountIds: [],
        messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'first' },
      } }),
    });
    try {
      const prepared = await executor.prepare('discussion.create', {
        title: 'Review', creationLocalId: 'review', firstMessage: { localId: 'first', content: {
          v: 1, parts: [{ t: 'text', text: 'Review' }],
        } }, participants: [{ kind: 'session', sessionId: 'allowed' }],
      }, { surface: 'ui', authority: 'present_user', serverId: 'home', bypassApprovals: true,
        externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token', grant: {
          v: 1, actions: { families: [], ids: ['discussion.create'] }, targets: { sessions: [], machines: ['machine'] },
          approve: false, origins: [], models: null, permissionModes: null, create: null,
        } },
      });
      expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Expected admitted discussion');
      expect(machineReads).toHaveBeenCalledOnce();
      // The next request sees an unavailable lookup; this admitted invocation finishes.
      machineReads.mockRejectedValue(new Error('Machine lookup unavailable after admission'));
      const admissionEvaluations = targets.mock.calls.length;
      machineReads.mockClear();
      await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true });
      expect(targets).toHaveBeenCalledTimes(admissionEvaluations);
      expect(machineReads).not.toHaveBeenCalled();
    } finally { targets.mockRestore(); }
  });
  it.each(['cli', 'agent', 'mcp'] as const)('evaluates authority and credential scope once for a hook-wired %s Action request', async surface => {
    // Call-through instrumentation measures real admission, not a replacement policy.
    const admissions = vi.spyOn(authority, 'resolveCredentialActionAdmissionV1');
    const grants = vi.spyOn(credentials, 'evaluateApiTokenGrantV1');
    const normalizations = vi.spyOn(callerContext, 'normalizeActionCallerContext');
    const attestations = vi.spyOn(callerContext, 'sessionAttestedContextCallerFailure');
    const executor = createExecutor({
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      observeActionExecution: async () => undefined,
      sessionStateFieldSet: async () => ({ updated: true }),
    });
    try {
      expect(await executor.execute('session.title.set', { sessionId: 'allowed', title: 'Title' }, {
        surface, authority: 'account_automation', defaultSessionId: 'allowed', bypassApprovals: true,
        externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token', grant: {
          v: 1, actions: { families: [], ids: ['session.title.set'] }, targets: { sessions: ['allowed'], machines: [] },
          approve: false, origins: [], models: null, permissionModes: null, create: null,
        } },
      })).toMatchObject({ ok: true });
      expect(admissions).toHaveBeenCalledTimes(1);
      expect(grants).toHaveBeenCalledTimes(1);
      expect(normalizations).toHaveBeenCalledTimes(1);
      expect(attestations).toHaveBeenCalledTimes(1);
    } finally { admissions.mockRestore(); grants.mockRestore(); normalizations.mockRestore(); attestations.mockRestore(); }
  });
  it.each([
    { actionId: 'session.title.set', input: { sessionId: 'session-1', title: 'Title' } },
    { actionId: 'session.manager.set', input: { sessionId: 'session-1', managerSessionId: null, expectedManagerSessionId: null } },
  ] as const)('passes admitted $actionId input into its domain without another parse', async ({ actionId, input }) => {
    const schema = getActionSpec(actionId).inputSchema;
    const safeParses = vi.spyOn(schema, 'safeParse');
    const parses = vi.spyOn(schema, 'parse');
    const executor = createExecutor({
      sessionStateFieldSet: async () => ({ updated: true }),
      sessionManagerSet: async () => ({ ok: true, sessionId: 'session-1', managerSessionId: null, attachedAt: null }),
    });
    try {
      const prepared = await executor.prepare(actionId, input, { surface: 'cli', bypassApprovals: true });
      expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Expected admitted Session action');
      safeParses.mockClear();
      parses.mockClear();
      await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true });
      expect(safeParses).not.toHaveBeenCalled();
      expect(parses).not.toHaveBeenCalled();
    } finally {
      safeParses.mockRestore();
      parses.mockRestore();
    }
  });

  it.each(['direct', 'observed', 'unchanged hook'] as const)('admits an unchanged %s input once and adds no parses on run', async mode => {
    const schema = getActionSpec('session.list').inputSchema;
    // Instrument the real parser without replacing its validation behavior.
    const parses = vi.spyOn(schema, 'safeParse');
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const executor = createExecutor({ sessionList,
      ...(mode === 'observed' ? { observeActionExecution: async () => undefined } : {}),
      ...(mode === 'unchanged hook' ? { interceptActionExecution: async ({ input }) => ({ status: 'continue' as const, input }) } : {}),
    });
    try {
      const prepared = await executor.prepare('session.list', {}, { surface: 'cli' });
      expect(prepared.kind).toBe('ready');
      // A hook can mutate its operand in place, so its return remains an ingress.
      expect(parses).toHaveBeenCalledTimes(mode === 'unchanged hook' ? 2 : 1);
      if (prepared.kind !== 'ready') throw new Error('Expected admitted list');
      parses.mockClear();
      await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true, result: { sessions: [] } });
      expect(parses).not.toHaveBeenCalled();
      expect(sessionList).toHaveBeenCalledOnce();
    } finally {
      parses.mockRestore();
    }
  });

  it.each(['replacement', 'in place'] as const)('refuses a transformed target beyond the admitted credential grant (%s)', async transform => {
    const sessionStateFieldSet = vi.fn(async () => ({ updated: true }));
    const executor = createExecutor({ sessionStateFieldSet,
      interceptActionExecution: async ({ input }) => {
        if (transform === 'in place') {
          if (!input || typeof input !== 'object' || !('sessionId' in input)) throw new Error('Expected Session operand');
          input.sessionId = 'outside';
          return { status: 'continue', input };
        }
        return { status: 'continue', input: { ...input as object, sessionId: 'outside' } };
      },
    });
    const result = await executor.execute('session.title.set', { sessionId: 'allowed', title: 'Title' }, {
      surface: 'cli', authority: 'account_automation', defaultSessionId: 'allowed',
      externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token', grant: {
        v: 1, actions: { families: [], ids: ['session.title.set'] }, targets: { sessions: ['allowed'], machines: [] },
        approve: false, origins: [], models: null, permissionModes: null, create: null,
      } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
  });

  it.each([false, true])('diagnoses invalid generic Action inputs before interception (observed=%s)', async observed => {
    const interceptActionExecution = vi.fn(async () => ({ status: 'continue' as const, input: {} }));
    const executor = createExecutor(observed ? { interceptActionExecution } : {});
    expect(await executor.execute('session.title.set', { sessionId: 'session-1', title: 42 }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: [{
        code: 'invalid_type', path: ['title'], expected: 'string',
      }] } });
    expect(interceptActionExecution).not.toHaveBeenCalled();
  });

  const runStartInput = {
    sessionId: 'session-1',
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    instructions: 'do it',
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
  } as const;

  it('revalidates transformed input and executes once before observational after', async () => {
    const sequence: string[] = [];
    const sessionStateFieldSet = vi.fn(async (_args: unknown) => {
      sequence.push('execute');
      return { updated: true };
    });
    const interceptActionExecution = vi.fn(async (request: { input: unknown }) => {
      sequence.push('before');
      return {
        status: 'continue' as const,
        input: { ...(request.input as object), title: 'transformed' },
      };
    });
    const observeActionExecution = vi.fn(async () => {
      sequence.push('after');
      throw new Error('observer failure must not replace the action result');
    });
    const executor = createExecutor({
      sessionStateFieldSet,
      interceptActionExecution,
      observeActionExecution,
    });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'original' },
      {
        surface: 'cli',
        actionCaller: { kind: 'plugin', pluginId: 'caller.plugin' },
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sequence).toEqual(['before', 'execute', 'after']);
    expect(sessionStateFieldSet).toHaveBeenCalledOnce();
    expect(sessionStateFieldSet).toHaveBeenCalledWith({
      context: { surface: 'cli', actionCaller: { kind: 'plugin', pluginId: 'caller.plugin' } },
      actionId: 'session.title.set', fieldId: 'display.title',
      sessionId: 'session-1', value: 'transformed',
    });
    expect(interceptActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.title.set',
      input: { sessionId: 'session-1', title: 'original' },
      caller: { kind: 'plugin', pluginId: 'caller.plugin' },
    }));
    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.title.set',
      input: { sessionId: 'session-1', title: 'transformed' },
      caller: { kind: 'plugin', pluginId: 'caller.plugin' },
      result: expect.objectContaining({ ok: true }),
    }));
  });

  it('distinguishes explicit rejection from a hook failure and never executes', async () => {
    const sessionStateFieldSet = vi.fn(async () => ({}));
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createExecutor({
      sessionStateFieldSet,
      observeActionExecution,
      interceptActionExecution: async () => ({
        status: 'rejected',
        code: 'policy_denied',
        message: 'Denied by policy',
      }),
    });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'original' },
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'action_interception_rejected',
      details: { code: 'policy_denied' },
    });
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalled();
  });

  it('rejects malformed transformed input before rights, approval, or action effects', async () => {
    const sessionStateFieldSet = vi.fn(async () => ({}));
    const isActionApprovalRequired = vi.fn(() => true);
    const executor = createExecutor({
      sessionStateFieldSet,
      isActionApprovalRequired,
      interceptActionExecution: async () => ({
        status: 'continue',
        input: { sessionId: 'session-1', title: 42 },
      }),
    });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'original' },
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: [{
      code: 'invalid_type', path: ['title'], expected: 'string',
    }] } });
    expect(isActionApprovalRequired).not.toHaveBeenCalled();
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'invalid initial input',
      input: {},
      interceptActionExecution: vi.fn(async () => ({ status: 'continue' as const, input: runStartInput })),
      expectedErrorCode: 'invalid_parameters',
    },
    {
      name: 'throwing hook',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => {
        throw new Error('hook failed');
      }),
      expectedErrorCode: 'action_interception_failed',
    },
    {
      name: 'rejected hook',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => ({ status: 'rejected' as const, code: 'policy_denied' })),
      expectedErrorCode: 'action_interception_rejected',
    },
    {
      name: 'failed hook',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => ({ status: 'failed' as const, code: 'plugin_hook_handler_failed' })),
      expectedErrorCode: 'action_interception_failed',
    },
    {
      name: 'invalid transformed input',
      input: runStartInput,
      interceptActionExecution: vi.fn(async () => ({ status: 'continue' as const, input: {} })),
      expectedErrorCode: 'invalid_parameters',
    },
  ])('classifies $name as owner-proven pre-dispatch failure for execution.run.start', async ({
    input,
    interceptActionExecution,
    expectedErrorCode,
  }) => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
    }));
    const executor = createExecutor({ executionRunStart, interceptActionExecution });

    const result = await executor.execute(
      'execution.run.start' as any,
      input,
      { surface: 'cli', actionCaller: { kind: 'host' } },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: expectedErrorCode,
    });
    expect(result).toHaveProperty('details', {
      executionRunStart: { v: 1, runCreation: 'noRunCreated' },
      ...(expectedErrorCode === 'invalid_parameters' ? { issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_value', path: ['retentionPolicy'],
          acceptedValues: ['ephemeral', 'resumable'] }),
      ]) } : {}),
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('classifies an invalid Plugin caller before interception as noRunCreated for execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
    }));
    const interceptActionExecution = vi.fn(async () => ({ status: 'continue' as const, input: runStartInput }));
    const executor = createExecutor({ executionRunStart, interceptActionExecution });

    await expect(executor.execute(
      'execution.run.start' as any,
      runStartInput,
      { surface: 'plugin', actionCaller: { kind: 'host' } },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(interceptActionExecution).not.toHaveBeenCalled();
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('disables interception for one explicitly nested execution', async () => {
    const interceptActionExecution = vi.fn(async () => ({ status: 'rejected' as const }));
    const observeActionExecution = vi.fn(async () => undefined);
    const sessionStateFieldSet = vi.fn(async () => ({ updated: true }));
    const executor = createExecutor({ interceptActionExecution, observeActionExecution, sessionStateFieldSet });

    const result = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'nested' },
      {
        surface: 'cli',
        actionCaller: { kind: 'plugin', pluginId: 'hook.plugin' },
        bypassActionInterception: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(sessionStateFieldSet).toHaveBeenCalledOnce();
    expect(interceptActionExecution).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalled();
  });

  it('publishes the target after event only when a deferred approved action actually executes', async () => {
    let storedRequest: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    const sessionStateFieldSet = vi.fn(async () => ({ updated: true }));
    const interceptActionExecution = vi.fn(async (request: { input: unknown }) => ({
      status: 'continue' as const,
      input: request.input,
    }));
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createExecutor({
      sessionStateFieldSet,
      interceptActionExecution,
      observeActionExecution,
      isActionApprovalRequired: (actionId) => actionId === 'session.title.set',
      approvalsCreate: async ({ request }) => {
        storedRequest = request;
        return { artifactId: 'approval-1' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = request;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });

    const deferred = await executor.execute(
      'session.title.set',
      { sessionId: 'session-1', title: 'deferred' },
      {
        surface: 'plugin',
        serverId: 'server-1',
        defaultSessionMachineId: 'machine-1',
        actionRequestId: 'deferred-title-1',
        actionCaller: {
          kind: 'plugin',
          pluginId: 'caller.plugin',
          contributionLocalId: 'title-hook',
          sourceCustody: { kind: 'development', registeredRootId: 'root-1' },
        },
      },
    );
    expect(deferred).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });
    expect(observeActionExecution.mock.calls.filter(([event]) => event.actionId === 'session.title.set')).toHaveLength(0);

    const decision = await executor.execute(
      'approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } },
    );
    expect(decision).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });

    expect(sessionStateFieldSet).toHaveBeenCalledOnce();
    expect(observeActionExecution.mock.calls.filter(([event]) => event.actionId === 'session.title.set'))
      .toEqual([[expect.objectContaining({
        input: { sessionId: 'session-1', title: 'deferred' },
        caller: {
          kind: 'plugin',
          pluginId: 'caller.plugin',
          contributionLocalId: 'title-hook',
          sourceCustody: { kind: 'development', registeredRootId: 'root-1' },
          startedBy: 'trigger',
        },
        result: expect.objectContaining({ ok: true }),
      })]]);
  });
});
