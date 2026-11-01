import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';
import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { buildSessionPermissionRespondRpcParamsV1, SessionUserActionAnswerRpcParamsV1Schema, type SessionPermissionRespondRpcParamsV1 } from '../sessions/permissions/respondRpcParamsV1.js';
import { projectSessionBoardGetResultV1, SessionBoardGetInputV1Schema } from '../sessions/board/actions.js';
import { SessionSurfaceItemV1Schema } from '../sessions/board/item.js';
import { AutomationV3RunMutationResponseSchema } from '../automations/automationApiV3.js';

function context(ids: string[], sessions = ['s1']): ActionExecutorContext {
  return {
    surface: 'api', authority: 'account_automation', defaultSessionId: sessions[0],
    externalActionCredential: { accountId: 'a1', principalId: 't1', credentialId: 't1', grant: {
      v: 1, actions: { families: [], ids }, targets: { sessions, machines: [] }, approve: false,
      origins: [], models: null, permissionModes: null, create: null,
    } },
  };
}

describe('ActionExecutor API token grant admission', () => {
  it.each(['action.invoke', 'wait', 'account.security.get', 'approval.request.create'] as const)('refuses %s effects when Home-origin preparation is cancelled', async actionId => {
    const controller = new AbortController();
    let effects = 0;
    const settings = normalizeActionsSettingsV1({ v: 1,
      actions: { 'account.security.get': { approvalRequiredSurfaces: ['cli'] } } });
    const executor = createActionExecutor({
      // Authenticated Home lookup and contributed execution are host transport
      // boundaries; canonical origin construction and cancellation stay real.
      prepareApprovalExecutionOriginContext: async () => {
        await Promise.resolve();
        controller.abort();
        return { serverIdentityId: 'home' };
      },
      invokeContributedAction: async () => {
        effects += 1;
        return { ok: true, result: { disposition: 'matched' } };
      },
      isActionApprovalRequired: ((id, ctx) => isApprovalRequiredByActionsSettings(id, settings, ctx)) satisfies NonNullable<ActionExecutorDeps['isActionApprovalRequired']>,
      approvalsCreate: async () => { effects += 1; return { artifactId: 'unexpected' }; },
    } as unknown as ActionExecutorDeps);
    const input = actionId === 'action.invoke'
      ? { action: { pluginId: 'acme.checks', localId: 'wait/checks' }, input: {} }
      : actionId === 'wait'
        ? { target: { kind: 'plugin_source', serverId: 'home', pluginId: 'acme.checks', sourceId: 'source' },
            condition: { kind: 'plugin', actionLocalId: 'wait/checks', condition: 'checks_passed' } }
        : actionId === 'approval.request.create'
          ? { actionId: 'account.profile.get', actionArgs: {}, summary: 'Read Account profile', createdBy: { surface: 'cli' } } : {};
    const result = await executor.execute(actionId, input, { surface: 'cli', authority: 'present_user',
      serverId: 'home', actionRequestId: 'cancelled-origin', signal: controller.signal });
    expect(effects).toBe(0);
    expect(result).toMatchObject(actionId === 'wait'
      ? { ok: true, result: { disposition: 'cancelled' } }
      : { ok: false, errorCode: 'cancelled' });
  });

  it('checks the actual run-now Automation operand before reaching the workflow HTTP port', async () => {
    const admitted: string[] = [];
    const workflowAction: NonNullable<ActionExecutorDeps['workflowAction']> = async ({ actionId, input }) => {
      if (actionId !== 'workflow.trigger.run_now') throw new Error('Unexpected Action');
      admitted.push(input.automationId);
      return AutomationV3RunMutationResponseSchema.parse({ run: {
        id: 'run-brief', automationId: input.automationId, revision: 1, triggerId: null, triggerRetired: false,
        state: 'queued', cause: { kind: 'manual', invokedAt: 1 }, dueAt: 1,
        claimedAt: null, startedAt: null, finishedAt: null, claimedByMachineId: null, leaseExpiresAt: null,
        attempt: 0, errorCode: null, producedSessionId: null, executionDispatchState: null, executionAttempt: 0,
        replyHandoffState: 'none', replyHandoffAttempt: 0, replyHandoffDueAt: null, createdAt: 1, updatedAt: 1,
      } });
    };
    const executor = createActionExecutor({ workflowAction } as unknown as ActionExecutorDeps);
    const ctx = context(['workflow.trigger.run_now'], []);
    // This keeper isolates the grant ceiling at the real executor; the host's
    // already-admitted approval waiver is independent of that ceiling.
    ctx.bypassApprovals = true;
    ctx.externalActionTarget = { kind: 'machine', machineId: 'm1' };
    if (!ctx.externalActionCredential?.grant) throw new Error('Expected grant');
    ctx.externalActionCredential.grant.targets = { sessions: [], machines: ['m1'] };
    ctx.externalActionCredential.grant.automationIds = ['brief'];
    const allowed = await executor.execute('workflow.trigger.run_now', { automationId: 'brief' }, ctx);
    expect(allowed, JSON.stringify(allowed))
      .toMatchObject({ ok: true, result: { run: { automationId: 'brief', state: 'queued' } } });
    expect(await executor.execute('workflow.trigger.run_now', { automationId: 'other' }, ctx))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(admitted).toEqual(['brief']);
  });
  it('refuses cross-Session copy source reads outside the credential target grant', async () => {
    const sourceReads: string[] = [];
    // This port models authenticated Board HTTP failure, not the source grant evaluator.
    const sessionBoardAction: NonNullable<ActionExecutorDeps['sessionBoardAction']> = async ({ input }) => {
      sourceReads.push(String((input as Readonly<{ sessionId?: string }>).sessionId));
      return { ok: false, errorCode: 'session_board_forbidden', error: 'session_board_forbidden' };
    };
    const executor = createActionExecutor({ sessionBoardAction } as unknown as ActionExecutorDeps);
    const ctx = { ...context(['session.board.item.upsert']), serverId: 'home' };
    const result = await executor.execute('session.board.item.upsert', {
      sessionId: 's1', itemId: 'copied', expectedItemRevision: null,
      copySource: { serverId: 'home', sessionId: 's2', itemId: 'original', expectedItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
    }, ctx);
    expect(sourceReads).toEqual([]);
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });
  it('attributes the copy source through the same machine grant owner and rechecks frozen source scope at invocation', async () => {
    const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const sourceItem = SessionSurfaceItemV1Schema.parse({ v: 1, destination: 'transcript', title: 'Source', frame: 'card',
      height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative',
        document: { version: 1, root: { kind: 'markdown', text: 'Independent copy' } } } });
    const sourceReads: string[] = [];
    let writes = 0;
    let sourceMachine = 'm-source';
    const sessionBoardAction: NonNullable<ActionExecutorDeps['sessionBoardAction']> = async ({ actionId, input }) => {
      if (actionId === 'session.board.get') {
        const request = SessionBoardGetInputV1Schema.parse(input);
        if ('projection' in request) throw new Error('This boundary fixture serves item reads');
        sourceReads.push(request.sessionId!);
        return projectSessionBoardGetResultV1({ serverId: 'home', sessionId: request.sessionId!, layout: null,
          entries: [{ status: 'ready', itemId: 'original', revision, item: sourceItem }], incomplete: false,
          ...(request.itemIds ? { requestedItemIds: request.itemIds } : {}),
          capabilities: { readTranscript: true, editSessionRecords: false }, page: { cursor: null, hasNext: false } });
      }
      writes++;
      return { v: 1, serverId: 'home', sessionId: 's1', destination: null, itemDestination: 'transcript',
        result: { operation: 'upsert_item', itemId: 'copied', outcome: 'created', itemRevision: revision } };
    };
    const executor = createActionExecutor({ sessionBoardAction,
      // Authenticated host attribution, not copy-specific local permission.
      resolveApiTokenGrantSessionMachineId: async () => sourceMachine,
    } as unknown as ActionExecutorDeps);
    const ctx: ActionExecutorContext = { ...context(['session.board.item.upsert']), serverId: 'home', surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId: 'session.board.item.upsert' } };
    if (!ctx.externalActionCredential?.grant) throw new Error('Expected grant');
    ctx.externalActionCredential.grant.targets = { sessions: ['s1'], machines: ['m-source'] };
    const input = { sessionId: 's1', itemId: 'copied', expectedItemRevision: null, destination: 'transcript',
      copySource: { serverId: 'home', sessionId: 's2', itemId: 'original', expectedItemRevision: revision } };
    sourceMachine = 'm-other';
    expect(await executor.prepare('session.board.item.upsert', input, ctx))
      .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'credential_scope_denied' } });
    expect(sourceReads).toEqual([]);
    sourceMachine = 'm-source';
    const prepared = await executor.prepare('session.board.item.upsert', input, ctx);
    expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected frozen copy admission');
    expect(sourceReads).toEqual(['s2']);
    ctx.externalActionCredential.grant.targets = { sessions: ['s1'], machines: [] };
    expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(sourceReads).toEqual(['s2']);
    expect(writes).toBe(0);
  });
  it('admits machine-granted persisted Session reads only through authenticated source attribution', async () => {
    const sessionTranscriptGet = async () => ({ ok: true as const, sessionId: 's1', items: [], nextCursor: null, hasMore: false,
      diagnostics: { rawRowsScanned: 0, pagesFetched: 0, scanLimitReached: false, payloadTruncations: 0 } });
    const ctx = context(['session.transcript.get'], []);
    ctx.externalActionTarget = { kind: 'machine', machineId: 'm1' };
    if (!ctx.externalActionCredential?.grant) throw new Error('Expected grant');
    ctx.externalActionCredential.grant.targets = { sessions: [], machines: ['m1'] };
    // The host attribution port models authenticated HTTP, not the grant evaluator.
    let sourceMachineId = 'm1';
    const attributedSessions: string[] = [];
    const executor = createActionExecutor({ sessionTranscriptGet,
      resolveApiTokenGrantSessionMachineId: async ({ sessionId }: { sessionId: string }) => { attributedSessions.push(sessionId); return sourceMachineId; },
    } as unknown as ActionExecutorDeps);
    const read = await executor.execute('session.transcript.get', { sessionId: 's1' }, ctx);
    expect(read.ok ? null : read, JSON.stringify(attributedSessions)).toBeNull();
    const prepared = await executor.prepare('session.transcript.get', { sessionId: 's1' }, ctx);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected admitted read');
    expect(await prepared.invocation.run()).toMatchObject({ ok: true });
    const moved = await executor.prepare('session.transcript.get', { sessionId: 's1' }, ctx);
    if (moved.kind !== 'ready') throw new Error('Expected prepared read');
    sourceMachineId = 'm2';
    expect(await moved.invocation.run()).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    for (const machineId of ['m2', null]) {
      const denied = createActionExecutor({ sessionTranscriptGet,
        resolveApiTokenGrantSessionMachineId: async () => machineId,
      } as unknown as ActionExecutorDeps);
      expect(await denied.execute('session.transcript.get', { sessionId: 's1' }, ctx))
        .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      expect(await denied.prepare('session.transcript.get', { sessionId: 's1' }, ctx))
        .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'credential_scope_denied' } });
    }
    expect(await createActionExecutor({ sessionTranscriptGet } as unknown as ActionExecutorDeps)
      .execute('session.transcript.get', { sessionId: 's1' }, ctx))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await createActionExecutor({ sessionTranscriptGet,
      resolveApiTokenGrantSessionMachineId: async () => { throw new Error('Network unavailable'); },
    } as unknown as ActionExecutorDeps).execute('session.transcript.get', { sessionId: 's1' }, ctx))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });

  it('validates unknown execution policy amendments before producing a Session RPC carrier', () => {
    const amendment: unknown = { command: ['git', 'status'] };
    expect(buildSessionPermissionRespondRpcParamsV1({
      id: 'permission-one', decision: 'allow', execPolicyAmendment: amendment,
    })).toEqual({
      id: 'permission-one', approved: true, decision: 'approved_execpolicy_amendment',
      execPolicyAmendment: { command: ['git', 'status'] },
    });
    for (const invalid of [{ command: 'git status' }, { command: ['git'], unexpected: true }]) {
      expect(() => buildSessionPermissionRespondRpcParamsV1({
        id: 'permission-one', decision: 'allow', execPolicyAmendment: invalid,
      })).toThrow();
    }
  });

  it('admits pass-up without creating an approval or partial answer', () => {
    expect(SessionUserActionAnswerRpcParamsV1Schema.parse({ id: 'q1', disposition: 'pass_up' }))
      .toEqual({ id: 'q1', disposition: 'pass_up' });
    for (const forbidden of [{ approved: true }, { decision: 'approved' }, { answers: { branch: ['dev'] } },
      { updatedPermissions: {} }, { allowedTools: ['Bash'] }, { actor: { sessionId: 'fake' } }]) {
      expect(SessionUserActionAnswerRpcParamsV1Schema.safeParse({ id: 'q1', disposition: 'pass_up', ...forbidden }).success).toBe(false);
    }
  });

  it.each(['approved_for_session', 'abort'] as const)('preserves %s and response metadata at the Session RPC boundary', async (decision) => {
    const requests: SessionPermissionRespondRpcParamsV1[] = [];
    const sessionPermissionRespond: NonNullable<ActionExecutorDeps['sessionPermissionRespond']> = async (args) => {
      requests.push(buildSessionPermissionRespondRpcParamsV1({
        id: args.requestId, turnId: args.turnId,
        decision: args.decision,
        ...('mode' in args ? { mode: args.mode } : {}),
        ...('reason' in args ? { reason: args.reason } : {}),
      }));
      return { ok: true };
    };
    const executor = createActionExecutor({ sessionPermissionRespond } as unknown as ActionExecutorDeps);
    const ctx = context(['session.title.set']);
    if (!ctx.externalActionCredential?.grant) throw new Error('Expected grant');
    ctx.externalActionCredential.grant.approve = true;
    expect(await executor.execute('session.permission.respond', {
      sessionId: 's1', requestId: 'permission-one', turnId: 'turn-one', decision, mode: 'plan', reason: 'human choice',
    }, ctx)).toMatchObject({ ok: true });
    expect(requests).toEqual([{ id: 'permission-one', turnId: 'turn-one', approved: decision !== 'abort',
      decision, mode: 'plan', reason: 'human choice' }]);
  });

  it('checks the parsed spawn binding before dispatch and carries verified launch authorization', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ type: 'success' as const, disposition: 'created' as const,
      sessionId: 'new-session', executionTarget: { serverId: 'home', machineId: 'm1' },
      organizationPlacement: { folderId: 'leads', tagIds: ['inbound'] }, initialInput: { status: 'notRequested' as const } }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const spawnInput = {
      creationKey: 'create-one',
      directory: { kind: 'managed' as const }, agentTarget,
      organizationPlacement: { folderId: 'leads', tagIds: ['inbound'] },
    };
    const ctx = context(['session.spawn_new']);
    ctx.serverId = 'home';
    if (!ctx.externalActionCredential?.grant) throw new Error('expected grant');
    ctx.externalActionTarget = { kind: 'machine', machineId: 'm1' };
    ctx.externalActionCredential.grant.create = {
      machineId: 'm1', agentTargetKey: buildBackendTargetKeyV2(agentTarget), directory: 'managed',
      placement: spawnInput.organizationPlacement,
    };
    ctx.externalActionExecutionAuthorization = {
      v: 1, token: 'verified-creation-token', binding: {
        ...ctx.externalActionCredential, serverIdentityId: 'home', machineId: 'm1',
        actionId: 'session.spawn_new', requestId: 'request-one', requestEnvelopeDigest: 'a'.repeat(43),
        target: ctx.externalActionTarget,
      },
    };
    expect(await executor.execute('session.spawn_new', { ...spawnInput, directory: { kind: 'path', path: '/workspace/elsewhere' } }, ctx))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied', details: { reason: 'create_not_granted' } });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(await executor.execute('session.spawn_new', spawnInput, ctx)).toMatchObject({ ok: true });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationAuthorization: { token: 'verified-creation-token' },
    }));
  });

  it('requires the exact qualified contributed Action id rather than a family grant', async () => {
    const invokeContributedAction = vi.fn(async () => ({ ok: true as const, result: { done: true } }));
    const executor = createActionExecutor({ invokeContributedAction } as unknown as ActionExecutorDeps);
    const input = { action: { pluginId: 'acme.leads', localId: 'update' }, input: {} };
    const ctx = context(['action.invoke']);
    expect(await executor.execute('action.invoke', input, ctx)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(invokeContributedAction).not.toHaveBeenCalled();
    if (!ctx.externalActionCredential?.grant) throw new Error('expected grant');
    ctx.externalActionCredential.grant.actions = { families: [], ids: ['acme.leads/actions/update'] };
    expect(await executor.execute('action.invoke', input, ctx)).toMatchObject({ ok: true });
    expect(invokeContributedAction).toHaveBeenCalledOnce();
  });

  it('refuses a Session-restricted grant an omitted declared Session operand instead of substituting its routing target', async () => {
    // An omitted declared operand means an Account-wide read (for example every
    // Session↔PR relation). The routed Session target must not stand in for it.
    const invokeContributedAction = vi.fn(async () => ({ ok: true as const, result: { kind: 'relations', links: [] } }));
    const definition = {
      kindVersion: 1 as const, id: 'acme.links/actions/relations', title: 'Relations', description: 'Read relations',
      safety: 'safe' as const, placements: [], slash: null, bindings: null, examples: null,
      surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false, api: true, plugin: true },
      sessionTarget: { field: 'sessionId', cardinality: 'one' as const },
      inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, additionalProperties: false },
    };
    // The authenticated Home Session lookup is the host boundary that qualifies an exact operand.
    const resolveSessionReference: NonNullable<ActionExecutorDeps['resolveSessionReference']> = async ({ sessionId }) =>
      ({ kind: 'unique', address: { serverId: 'home', sessionId: sessionId ?? '' } });
    const executor = createActionExecutor({ invokeContributedAction, resolveSessionReference,
      listContributedActionDefinitions: () => [definition] } as unknown as ActionExecutorDeps);
    const ctx: ActionExecutorContext = { ...context([definition.id]), serverId: 'home',
      externalActionTarget: { kind: 'session', sessionId: 's1' } };
    const accountWide = { action: { pluginId: 'acme.links', localId: 'relations' }, input: {} };
    expect(await executor.execute('action.invoke', accountWide, ctx))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied', details: { reason: 'target_required' } });
    expect(invokeContributedAction).not.toHaveBeenCalled();
    // The same grant still reads its own granted Session; an unrestricted grant keeps the Account-wide read.
    expect(await executor.execute('action.invoke', { ...accountWide, input: { sessionId: 's1' } }, ctx)).toMatchObject({ ok: true });
    if (!ctx.externalActionCredential?.grant) throw new Error('expected grant');
    ctx.externalActionCredential.grant.targets = null;
    expect(await executor.execute('action.invoke', accountWide, ctx)).toMatchObject({ ok: true });
    expect(invokeContributedAction).toHaveBeenCalledTimes(2);
  });

  it('does not let generic plugin wait bypass the exact contributed Action grant', async () => {
    let admitted = false;
    const executor = createActionExecutor({ invokeContributedAction: async () => {
      if (!admitted) throw new Error('Unadmitted plugin handler reached');
      return { ok: true, result: { disposition: 'matched' } };
    } } as unknown as ActionExecutorDeps);
    const ctx = { ...context(['wait']), serverId: 'home' };
    const input = {
      target: { kind: 'plugin_source', serverId: 'home', pluginId: 'acme.checks', sourceId: 'source' },
      condition: { kind: 'plugin', actionLocalId: 'wait/checks', condition: 'checks_passed' },
    };
    expect(await executor.execute('wait', input, ctx)).toMatchObject({ ok: true, result: { disposition: 'permission_denied' } });
    if (!ctx.externalActionCredential?.grant) throw new Error('expected grant');
    ctx.externalActionCredential.grant.actions.ids.push('acme.checks/actions/wait/checks');
    admitted = true;
    expect(await executor.execute('wait', input, ctx)).toMatchObject({ ok: true, result: { disposition: 'matched' } });
  });

  it('refuses an ungranted action at prepare and execute before any host dependency', async () => {
    const sessionStateFieldSet = vi.fn(async () => ({}));
    // Dependencies model host transports. Unused required ports are unreachable in these slices.
    const executor = createActionExecutor({ sessionStateFieldSet } as unknown as ActionExecutorDeps);
    const ctx = context(['session.message.send']);
    expect(await executor.execute('session.title.set', { sessionId: 's1', title: 'hello' }, ctx))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.prepare('session.title.set', { sessionId: 's1', title: 'hello' }, ctx))
      .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'credential_scope_denied' } });
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
  });

  it('rechecks the credential grant when a prepared invocation starts', async () => {
    const sessionStateFieldSet = vi.fn(async () => ({ ok: true }));
    const executor = createActionExecutor({ sessionStateFieldSet } as unknown as ActionExecutorDeps);
    const ctx = context(['session.title.set']);
    const prepared = await executor.prepare('session.title.set', { sessionId: 's1', title: 'hello' }, ctx);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready' || !ctx.externalActionCredential?.grant) throw new Error('Expected prepared grant');
    ctx.externalActionCredential.grant.actions = { families: [], ids: ['session.message.send'] };
    expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(sessionStateFieldSet).not.toHaveBeenCalled();
  });

  it('filters discovery and refuses schemas and options for an ungranted action', async () => {
    const executor = createActionExecutor({} as ActionExecutorDeps);
    const ctx = context(['session.message.send']);
    const result = await executor.execute('action.spec.search', { query: 'session', limit: 100 }, ctx);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected discovery');
    expect(result.result).toMatchObject({ actionSpecs: expect.arrayContaining([expect.objectContaining({ id: 'session.message.send' })]) });
    expect(result.result).not.toMatchObject({ actionSpecs: expect.arrayContaining([expect.objectContaining({ id: 'session.title.set' })]) });
    expect(await executor.execute('action.spec.get', { id: 'session.message.send', includeOutputSchema: false }, ctx))
      .toMatchObject({ ok: true, result: { actionSpec: { id: 'session.message.send' } } });
    expect(await executor.execute('action.spec.get', { id: 'session.title.set' }, ctx))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('action.options.resolve', { actionId: 'session.spawn_new', fieldPath: 'permissionMode' }, ctx))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });

  it('refuses a permission mode outside the per-input grant before the setter', async () => {
    const sessionPermissionModeSet = vi.fn(async () => ({}));
    const executor = createActionExecutor({ sessionPermissionModeSet } as unknown as ActionExecutorDeps);
    const ctx = context(['session.permission_mode.set']);
    if (!ctx.externalActionCredential?.grant) throw new Error('expected grant');
    ctx.externalActionCredential.grant.permissionModes = ['default'];
    expect(await executor.execute('session.permission_mode.set', { sessionId: 's1', permissionMode: 'bypassPermissions' }, ctx))
      .toMatchObject({ ok: false, errorCode: 'permission_mode_not_granted' });
    expect(sessionPermissionModeSet).not.toHaveBeenCalled();
  });

  it('does not disclose dynamic options through an unbound source id', async () => {
    const agentsBackendsList = vi.fn(async () => ({ items: [] }));
    const executor = createActionExecutor({ agentsBackendsList } as unknown as ActionExecutorDeps);
    expect(await executor.execute('action.options.resolve', { optionsSourceId: 'agents.backends.enabled' }, context(['session.title.set'])))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('action.options.resolve', {
      optionsSourceId: 'agents.backends.enabled', fieldPath: 'agentTarget',
    }, context(['session.title.set'])))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('action.options.resolve', {
      actionId: 'session.title.set', fieldPath: 'title', optionsSourceId: 'agents.backends.enabled',
    }, context(['session.title.set'])))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(agentsBackendsList).not.toHaveBeenCalled();
  });
});
