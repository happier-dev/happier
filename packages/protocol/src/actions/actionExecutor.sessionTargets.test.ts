import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { markSessionListQueryResultV1 } from '../sessions/awareness/action.js';
import { encodeV2SessionListCursorV2 } from '../sessions/listing/cursor.js';
import { projectSessionSummaryV1 } from '../sessions/control/listResult.js';
import { normalizeSessionListFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';
import { createSessionMembershipReadFixture } from '../sessions/read/sessionReadBatchV1.testkit.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';
import { resolveActionSessionTargets } from './executor/sessionTargets.js';
import { OpenedSessionFollowRuleV1Schema, SessionFollowActionOutputSchemasV1 } from '../sessions/follow/actions.js';
import { DiscussionParticipantsListResponseV1Schema } from '../discussions/participants.js';
import { DiscussionParticipantPolicySetRequestV1Schema } from '../discussions/participants.js';
import { SetSessionTagAssignmentsRequestSchema, SetSessionTagAssignmentsResponseSchema } from '../sessions/organization/mutations.js';
import { RoleActionInputSchemasV1 } from '../prompts/roles/roleActionsV1.js';
import type { ActionDefinitionV1 } from './actionDefinitionV1.js';
import { ApiTokenGrantV1Schema } from '../auth/apiTokenGrant.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';
import { createEmptyWorkflowActionHost } from './executor/emptyWorkflowActionHost.testkit.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';

const context: ActionExecutorContext = {
  serverId: 'home', defaultSessionId: 'parent', defaultSessionMachineId: 'machine', surface: 'cli', authority: 'present_user',
  actionCaller: { kind: 'host' }, actionRequestId: 'target-test',
};

function harness() {
  let workers = ['a', 'b'];
  let inaccessible: string | null = null;
  let incomplete = false;
  let stored: ApprovalRequest | null = null;
  const effects: Array<{ serverId?: string | null; sessionId: string; recipient?: unknown }> = [];
  const followEffects: unknown[] = [];
  const followHomeIds: Array<string | null | undefined> = [];
  // These are the authenticated Home/Artifact transport boundaries. Resolution,
  // preparation, approval transitions, leaf admission and projection stay real.
  const deps = {
    resolveSessionReference: async ({ sessionId, context }: Parameters<NonNullable<ActionExecutorDeps['resolveSessionReference']>>[0]) =>
      ({ kind: 'unique' as const, address: { serverId: context.serverId!, sessionId: sessionId! } }),
    sessionList: async ({ query }: Parameters<NonNullable<ActionExecutorDeps['sessionList']>>[0]) => markSessionListQueryResultV1({
      sessions: workers.map(id => ({ id, active: false, presence: 'offline', updatedAt: 1, manager: { sessionId: query?.underSessionId } })),
      // Incomplete means the list owner cannot provide its next page. A
      // perpetually repeated cursor instead models an endless page stream.
      nextCursor: null, hasNext: incomplete,
      attentionNextCursor: null, attentionHasNext: false,
    }),
    sessionRead: async ({ sessionIds }: Parameters<NonNullable<ActionExecutorDeps['sessionRead']>>[0]) =>
      createSessionMembershipReadFixture(sessionIds, workers),
    readSessionManager: async () => ({ kind: 'manager' as const, address: { serverId: 'home', sessionId: 'manager' } }),
    sessionSendMessage: async (args: Parameters<NonNullable<ActionExecutorDeps['sessionSendMessage']>>[0]) => {
      if (args.sessionId === inaccessible) return { ok: false, errorCode: 'permission_denied', error: 'permission_denied' };
      effects.push(args);
      return { status: 'accepted' as const, localId: `input-${args.sessionId}` };
    },
    sessionStatusGet: async ({ sessionId, serverId }: { sessionId: string; serverId?: string | null }) => ({
      session: projectSessionSummaryV1({ row: { id: sessionId, createdAt: 1, updatedAt: 1, active: false, activeAt: 1 },
        metadata: null, encryption: null }), serverId,
    }),
    sessionOpen: async (args: { sessionId: string; serverId: string }) => { effects.push(args); return {}; },
    sessionFollowAction: async (args: Parameters<NonNullable<ActionExecutorDeps['sessionFollowAction']>>[0]) => {
      followEffects.push(args.input);
      followHomeIds.push(args.serverId);
      return { changed: false };
    },
    isActionApprovalRequired: () => false,
    isApprovalExecutionOriginCurrent: async () => true,
    approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
      stored = ApprovalRequestV2Schema.parse(request);
      return { artifactId: 'targets-approval' };
    },
    approvalsGet: async () => stored,
    approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
      if (!stored) throw new Error('missing approval');
      const transition = decideApprovalRequestTransition(stored, request);
      if (!transition.ok) return transition;
      stored = ApprovalRequestV2Schema.parse(request);
      return { ok: true };
    },
  };
  return {
    deps, effects, followEffects, followHomeIds, executor: createActionExecutor(deps as unknown as ActionExecutorDeps),
    setWorkers: (ids: string[]) => { workers = ids; },
    deny: (id: string) => { inaccessible = id; },
    incomplete: () => { incomplete = true; },
    approval: () => stored,
    replaceApproval: (request: ApprovalRequest) => { stored = ApprovalRequestV2Schema.parse(request); },
  };
}

describe('SessionTarget at the Actions front door', () => {
  it('resolves tag and nested participant selectors before their exact Home storage boundaries', async () => {
    const h = harness();
    h.setWorkers(['worker']);
    const writes: unknown[] = [];
    const executor = createActionExecutor({ ...h.deps,
      homeDomainAction: async ({ actionId, input }: Parameters<NonNullable<ActionExecutorDeps['homeDomainAction']>>[0]) => {
        if (actionId !== 'session.tags.set') throw new Error('Unexpected Home mutation');
        const assignment = SetSessionTagAssignmentsResponseSchema.parse(input);
        SetSessionTagAssignmentsRequestSchema.parse({ tagIds: assignment.tagIds });
        writes.push(assignment);
        return assignment;
      },
      discussionAction: async ({ actionId, input }: Parameters<NonNullable<ActionExecutorDeps['discussionAction']>>[0]) => {
        if (actionId !== 'discussion.participant.policy.set') throw new Error('Unexpected Discussion mutation');
        const { discussionId, ...request } = input as Readonly<Record<string, unknown>>;
        const admitted = DiscussionParticipantPolicySetRequestV1Schema.parse(request);
        writes.push({ discussionId, ...admitted });
        return { discussionId, ownerAccountId: 'owner', access: null, grants: [], changed: true };
      },
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.tags.set', { sessionId: { selector: 'workers' }, tagIds: [] }, context))
      .toEqual({ ok: true, result: { sessionId: 'worker', tagIds: [] } });
    expect(await executor.execute('discussion.participant.policy.set', { discussionId: 'discussion',
      participant: { kind: 'session', sessionId: { selector: 'workers' } }, answerPolicy: 'reads_only',
    }, { ...context, bypassApprovals: true })).toMatchObject({ ok: true, result: { changed: true } });
    expect(writes).toEqual([{ sessionId: 'worker', tagIds: [] },
      { discussionId: 'discussion', participant: { kind: 'session', sessionId: 'worker' }, answerPolicy: 'reads_only' }]);
  });

  it.each([
    ['session.memory.set', { enabled: false }, 'intent.memoryEnabled', false],
    ['session.context.update', { intent: { kind: 'set_plan', entryId: null } }, 'intent.context', { kind: 'set_plan', entryId: null }],
  ] as const)('resolves %s once before its exact reviewed metadata write', async (actionId, mutation, fieldId, value) => {
    const h = harness();
    h.setWorkers(['worker']);
    const writes: unknown[] = [];
    // The metadata transport is the system boundary; admission, selection and
    // registered field validation run through their real production owners.
    const executor = createActionExecutor({ ...h.deps,
      sessionStateFieldSet: async (write: NonNullable<Parameters<NonNullable<ActionExecutorDeps['sessionStateFieldSet']>>[0]>) => {
        writes.push(write);
        return { updated: true };
      },
    } as unknown as ActionExecutorDeps);
    const result = await executor.execute(actionId, {
      sessionId: { selector: 'workers' }, serverId: 'home', expectedMetadataRevision: 7, ...mutation,
    }, context);
    expect(result).toEqual({ ok: true, result: { updated: true } });
    expect(writes).toEqual([expect.objectContaining({ sessionId: 'worker', serverId: 'home', expectedMetadataRevision: 7, fieldId, value })]);
    h.setWorkers(['a', 'b']);
    expect(await executor.execute(actionId, {
      sessionId: { selector: 'workers' }, serverId: 'home', expectedMetadataRevision: 7, ...mutation,
    }, context)).toMatchObject({ ok: false, errorCode: 'session_target_cardinality_mismatch' });
    expect(writes).toHaveLength(1);
  });

  it('qualifies contributed exact references without enumerating Sessions and fails ambiguous references closed', async () => {
    const h = harness();
    let inventoryReads = 0;
    let referenceReads = 0;
    const request = { actionId: 'action.invoke', declaration: { field: 'input.sessionId', cardinality: 'one' },
      input: { input: { sessionId: 'session-reference' } }, context } as const;
    const deps = { ...h.deps,
      sessionList: async () => { inventoryReads++; throw new Error('Exact reference admission must not enumerate Sessions'); },
      resolveSessionReference: async () => {
        referenceReads++;
        return { kind: 'unique' as const, address: { serverId: 'authorized-other-home', sessionId: 'exact-session' } };
      },
    };
    expect(await resolveActionSessionTargets(deps as unknown as ActionExecutorDeps, {
      ...request, input: { input: { kind: 'list' } },
    })).toBeNull();
    expect(referenceReads).toBe(0);
    expect(await resolveActionSessionTargets(deps as unknown as ActionExecutorDeps, request)).toEqual({
      actionId: 'action.invoke', field: 'input.sessionId',
      targets: [{ serverId: 'authorized-other-home', sessionId: 'exact-session' }], selector: false,
    });
    expect(referenceReads).toBe(1);
    expect(await resolveActionSessionTargets({ ...deps, resolveSessionReference: async () => ({ kind: 'ambiguous',
      candidates: [{ serverId: 'home', sessionId: 'a' }, { serverId: 'other-home', sessionId: 'b' }],
    }) } as unknown as ActionExecutorDeps, request))
      .toEqual({ ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable',
        details: { cause: 'session_id_ambiguous' } });
    expect(inventoryReads).toBe(0);
  });

  it.each(['agent', 'mcp', 'plugin'] as const)('admits a %s selector Goal write to one proved led child without widening exact writes or the subtree', async surface => {
    const h = harness();
    h.setWorkers(['a']);
    const effects: string[] = [];
    const executor = createActionExecutor({ ...h.deps,
      workflowAction: createEmptyWorkflowActionHost({ sessionRead: h.deps.sessionRead }),
      sessionGoalSet: async ({ sessionId }: { sessionId: string }) => {
        effects.push(sessionId);
        return { workState: null, metadata: {} };
      },
      sessionGoalClear: async ({ sessionId }: { sessionId: string }) => {
        effects.push(sessionId);
        return { workState: null, metadata: {} };
      },
    } as unknown as ActionExecutorDeps);
    const caller = { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 } as const;
    const restricted: ActionExecutorContext = { ...context, surface, authority: 'account_automation',
      callerPermissionMode: 'default', sessionListAccess: 'led_subtree', actionCaller: caller,
      sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      agentStartContext: { caller, baseline: { machineId: 'machine', directory: '/repo' }, roles: {},
        ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default' },
    };
    expect(await executor.execute('session.targets.resolve', {
      actionId: 'session.goal.set', target: { selector: 'self', of: 'a' },
    }, restricted)).toMatchObject({ ok: true, result: { coverage: 'complete', addresses: [{ sessionId: 'a' }] } });
    const result = await executor.execute('session.goal.set', {
      sessionId: { selector: 'self', of: 'a' }, objective: 'Finish the worker task',
    }, restricted);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(effects).toEqual(['a']);
    for (const [actionId, mutation] of [
      ['session.goal.set', { status: 'paused' }],
      ['session.goal.set', { objective: 'Keep working without resuming', resumeInactiveWithInitialGoal: false }],
      ['session.goal.clear', {}],
    ] as const) {
      const result = await executor.execute(actionId, { sessionId: { selector: 'self', of: 'a' }, ...mutation }, restricted);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    }
    expect(await executor.execute('session.goal.set', { sessionId: 'a', objective: 'Exact child' }, restricted))
      .toMatchObject({ ok: false, details: { cause: 'action_scope_restricted' } });
    expect(await executor.execute('session.goal.set', {
      sessionId: { selector: 'self', of: 'unrelated' }, objective: 'Outside subtree',
    }, restricted)).toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(await executor.execute('session.goal.clear', { sessionId: 'a' }, restricted))
      .toMatchObject({ ok: false, details: { cause: 'action_scope_restricted' } });
    expect(await executor.execute('session.goal.clear', {
      sessionId: { selector: 'self', of: 'unrelated' },
    }, restricted)).toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(await executor.execute('session.goal.set', {
      sessionId: { selector: 'self', of: 'a' }, objective: 'Restricted host',
    }, { ...restricted, sessionListAccess: 'current_session' })).toMatchObject({ ok: false });
    h.setWorkers(['a', 'b']);
    expect(await executor.execute('session.goal.set', {
      sessionId: { selector: 'workers' }, objective: 'Ambiguous worker',
    }, restricted)).toMatchObject({ ok: false, errorCode: 'session_target_cardinality_mismatch' });
    h.setWorkers(['a']);
    const prepared = await executor.prepare('session.goal.set', {
      sessionId: { selector: 'workers' }, objective: 'Recheck before effect',
    }, restricted);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected prepared selector Goal');
    h.setWorkers([]);
    expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(effects).toEqual(['a', 'a', 'a', 'a']);
  });

  it('binds restricted selector roots to the proved caller before enumerating workers', async () => {
    const h = harness();
    const caller = { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 } as const;
    const restricted = { ...context, surface: 'agent', sessionListAccess: 'current_session', actionCaller: caller,
      agentStartContext: { caller, baseline: { machineId: 'machine', directory: '/repo' }, roles: {},
        ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default' },
    } as const;
    const input = { actionId: 'session.messages.recent.get', target: { selector: 'workers' } };
    expect(await h.executor.execute('session.targets.resolve', input, restricted))
      .toMatchObject({ ok: true, result: { coverage: 'complete', addresses: [
        { serverId: 'home', sessionId: 'a' }, { serverId: 'home', sessionId: 'b' },
      ] } });
    // Focus is not authority: a contextual default cannot replace the host caller.
    expect(await h.executor.execute('session.targets.resolve', input, { ...restricted, defaultSessionId: 'other-root' }))
      .toMatchObject({ ok: true, result: { coverage: 'complete', addresses: [
        { serverId: 'home', sessionId: 'a' }, { serverId: 'home', sessionId: 'b' },
      ] } });
    for (const [target, callerContext] of [
      [input.target, { ...restricted, actionCaller: undefined, agentStartContext: undefined }],
      [{ selector: 'workers', of: 'other-root' }, { ...restricted, defaultSessionId: 'other-root' }],
      [input.target, { ...restricted, agentStartContext: { ...restricted.agentStartContext,
        caller: { ...caller, sessionId: 'other-root' } } }],
    ] as const) {
      expect(await h.executor.execute('session.targets.resolve', { ...input, target }, callerContext), JSON.stringify({ target, callerContext }))
        .toMatchObject({ ok: true, result: { coverage: 'unavailable', addresses: [] } });
    }
  });

  it('resolves operational selectors once before exact handler parsing, retaining manager CAS identities', async () => {
    const h = harness();
    const effects: unknown[] = [];
    let resolutions = 0;
    const executor = createActionExecutor({ ...h.deps,
      readSessionManager: async () => { resolutions += 1; return { kind: 'manager', address: { serverId: 'home', sessionId: 'manager' } }; },
      sessionManagerSet: async (args: unknown) => { effects.push(args); return { ok: true, sessionId: 'manager', managerSessionId: 'new-manager', attachedAt: 1 }; },
    } as unknown as ActionExecutorDeps);
    const result = await executor.execute('session.manager.set', {
      sessionId: { selector: 'manager' }, managerSessionId: 'new-manager', expectedManagerSessionId: 'self',
    }, { ...context, bypassApprovals: true });
    expect(result).toMatchObject({ ok: true });
    expect(resolutions).toBe(1);
    expect(effects).toEqual([expect.objectContaining({ sessionId: 'manager', managerSessionId: 'new-manager', expectedManagerSessionId: 'self' })]);
  });

  it('refuses Workflow report-copy before native preparation or recipient effects', async () => {
    const h = harness();
    const effects: unknown[] = [];
    const executor = createActionExecutor({ ...h.deps,
      roleActionExecute: async request => { effects.push(request); return { updatedSessionIds: ['child'] }; },
    });
    expect(await executor.execute('session.roles.apply_to_reports', { sessionId: 'parent' }, {
      ...context, surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
      actionCaller: { kind: 'workflowRun', runId: 'workflow-copy', authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'default',
      } },
    })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(effects).toEqual([]);
  });

  it.each([
    ['session.role.set', { roleId: 'orchestrator' }],
    ['session.roles.override.set', { roleId: 'orchestrator', workspaceWrites: 'deny' }],
    ['session.roles.override.clear', { roleId: 'orchestrator' }],
    ['session.roles.add', { roleId: 'scout', role: {
      name: 'Scout', instructions: 'Read and report.', runsAs: { kind: 'session' },
      workspaceWrites: 'deny', secondOpinion: 'off', enabled: true,
    } }],
    ['session.roles.remove', { roleId: 'scout' }],
    ['session.notes.set', { notes: 'Verify before reporting.' }],
    ['session.roles.apply_to_reports', {}],
  ] as const)('resolves %s through the front door before its exact role transport', async (actionId, mutation) => {
    const h = harness();
    h.setWorkers(['worker']);
    const effects: unknown[] = [];
    // This dependency crosses to the answering client's role/metadata transport;
    // the real catalog, input parsing, target resolution and leaf dispatch run here.
    const executor = createActionExecutor({ ...h.deps,
      roleActionExecute: async (args: Parameters<NonNullable<ActionExecutorDeps['roleActionExecute']>>[0]) => {
        const input = RoleActionInputSchemasV1[args.actionId].parse(args.input);
        effects.push({ actionId: args.actionId, input, serverId: args.context.serverId });
        return actionId === 'session.roles.apply_to_reports' ? { updatedSessionIds: ['child'] } : { updated: true };
      },
    } as unknown as ActionExecutorDeps);
    const expectedResult = actionId === 'session.roles.apply_to_reports' ? { updatedSessionIds: ['child'] } : { updated: true };
    for (const sessionId of [{ selector: 'manager' }, { selector: 'workers' }, 'exact-id'] as const) {
      expect(await executor.execute(actionId, { sessionId, ...mutation }, context))
        .toEqual({ ok: true, result: expectedResult });
    }
    expect(effects).toEqual(['manager', 'worker', 'exact-id'].map(sessionId => ({
      actionId, input: { sessionId, ...mutation }, serverId: 'home',
    })));
  });

  it.each([{ workers: [] }, { workers: ['a', 'b'] }])('refuses a Notes selector selecting $workers before the role transport', async ({ workers }) => {
    const h = harness();
    h.setWorkers(workers);
    const effects: unknown[] = [];
    const executor = createActionExecutor({ ...h.deps,
      roleActionExecute: async (args: unknown) => { effects.push(args); return { updated: true }; },
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.notes.set', {
      sessionId: { selector: 'workers' }, notes: 'Do not choose a target implicitly.',
    }, context)).toMatchObject({ ok: false, errorCode: 'session_target_cardinality_mismatch',
      details: { expected: 'one', actualCount: workers.length } });
    expect(effects).toEqual([]);
  });

  it('fans out lifecycle selectors through the real executor and preserves exact-id result shapes', async () => {
    const h = harness();
    const stopped: string[] = [];
    const executor = createActionExecutor({ ...h.deps, sessionStop: async ({ sessionId }: { sessionId: string }) => {
      stopped.push(sessionId); return { stopped: true };
    } } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.stop', { sessionId: { selector: 'workers' } }, context))
      .toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { sessionId: 'a' }, result: { ok: true } }, { target: { sessionId: 'b' }, result: { ok: true } },
      ] } });
    expect(await executor.execute('session.stop', { sessionId: 'exact' }, context)).toEqual({ ok: true, result: { stopped: true } });
    expect(stopped).toEqual(['a', 'b', 'exact']);
  });

  it('refuses unresolved operational targets with content-free canonical issues before effects', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps, readSessionManager: async () => { throw new Error('private session content'); } } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.goal.get', { sessionId: { selector: 'manager' } }, context))
      .toEqual({ ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable', details: { cause: 'target_read_failed' } });
  });

  it('keeps ambiguous exact-reference previews unavailable without disclosing candidate addresses', async () => {
    const h = harness();
    const ambiguous = createActionExecutor({ ...h.deps, resolveSessionReference: async () => ({ kind: 'ambiguous',
      candidates: [{ serverId: 'home', sessionId: 'a' }, { serverId: 'other-home', sessionId: 'a' }] }),
    } as unknown as ActionExecutorDeps);
    expect(await ambiguous.execute('session.targets.resolve', { actionId: 'session.message.send', target: 'a' }, context))
      .toEqual({ ok: true, result: { coverage: 'unavailable', addresses: [], error: 'session_target_unavailable', cause: 'session_id_ambiguous' } });
  });
  it('keeps a canceled exact-reference preview unavailable even when its reader returns an address', async () => {
    const h = harness();
    const controller = new AbortController();
    const canceled = createActionExecutor({ ...h.deps, resolveSessionReference: async () => {
      controller.abort();
      return { kind: 'unique', address: { serverId: 'home', sessionId: 'a' } };
    } } as unknown as ActionExecutorDeps);
    expect(await canceled.execute('session.targets.resolve', { actionId: 'session.message.send', target: 'a' }, { ...context, signal: controller.signal }))
      .toMatchObject({ ok: true, result: { coverage: 'unavailable', addresses: [], error: 'cancelled' } });
  });
  it('publishes authorized target inspection without sending and resolves a later invocation from its own current corpus', async () => {
    const h = harness();
    const preview = await h.executor.execute('session.targets.resolve', {
      actionId: 'session.message.send', target: { selector: 'workers' },
    }, context);
    expect(preview).toEqual({ ok: true, result: { coverage: 'complete', addresses: [
      { serverId: 'home', sessionId: 'a' }, { serverId: 'home', sessionId: 'b' },
    ], error: null } });
    expect(h.effects).toEqual([]);
    expect(await h.executor.execute('session.targets.resolve', {
      actionId: 'session.message.send', target: 'exact-session',
    }, context)).toEqual({ ok: true, result: { coverage: 'complete',
      addresses: [{ serverId: 'home', sessionId: 'exact-session' }], error: null } });
    expect(await h.executor.execute('session.targets.resolve', {
      actionId: 'artifact.get', target: { selector: 'workers' },
    }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    h.setWorkers(['c']);
    expect(await h.executor.execute('session.message.send', { sessionId: { selector: 'workers' }, message: 'hello' }, context))
      .toMatchObject({ ok: true });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['c']);
    h.setWorkers([]);
    expect(await h.executor.execute('session.targets.resolve', {
      actionId: 'session.message.send', target: { selector: 'workers' },
    }, context)).toEqual({ ok: true, result: { coverage: 'complete', addresses: [], error: null } });
    h.incomplete();
    expect(await h.executor.execute('session.targets.resolve', {
      actionId: 'session.message.send', target: { selector: 'workers' },
    }, context)).toMatchObject({ ok: true, result: { coverage: 'unavailable', addresses: [], error: 'session_target_unavailable' } });
  });
  const rule = (receiver: string | null, enabled = true) => OpenedSessionFollowRuleV1Schema.parse({
    ruleId: receiver ?? 'personal-rule', version: 1,
    receiver: receiver ? { kind: 'session', sessionId: receiver } : { kind: 'account' },
    definition: { v: 1, enabled, policy: { preset: 'important' },
      filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], show: 'sessions' }) },
  });
  const edge = (sourceSessionId: string, destinationSessionId: string) => ({
    sourceSessionId, destinationSessionId, policy: { preset: 'important' },
    deliveryState: 'eligible', hasPendingUpdates: false, relation: 'follower',
  });
  const preview = (sessionIds: string[]) => ({ coverage: 'complete', matchCount: sessionIds.length,
    matches: sessionIds.map(sessionId => ({ serverId: 'home', source: { kind: 'session', sessionId } })),
    unavailable: [], overlaps: [] });

  it('resolves Followers through complete Follow facts, including matched Session rules and excluding personal rules', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps,
      sessionFollowAction: async ({ actionId, input }: Parameters<NonNullable<ActionExecutorDeps['sessionFollowAction']>>[0]) => {
        expect({ actionId, input }).toEqual({ actionId: 'follow.list', input: { direction: 'followers',
          source: { kind: 'session', sessionId: 'parent' } } });
        return { follows: [], sources: [edge('parent', 'manager'), { ...edge('parent', 'manager'), relation: 'manager' }],
          rules: [], coverage: 'complete', peopleCount: 7 };
      },
      readSessionFollowRules: async () => ({ kind: 'complete', rules: [rule('manager'), rule('rule-receiver'), rule('parent'), rule(null), rule('off', false)] }),
      sessionFollowPreview: async (args: Parameters<NonNullable<ActionExecutorDeps['sessionFollowPreview']>>[0]) => {
        // A followers query must never request the full Session corpus.
        expect(args.sourceSessionId).toBe('parent');
        return preview(['parent']);
      },
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.message.send', { sessionId: { selector: 'followers' }, message: 'hello' }, context))
      .resolves.toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { serverId: 'home', sessionId: 'manager' } },
        { target: { serverId: 'home', sessionId: 'rule-receiver' } },
      ] } });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['manager', 'rule-receiver']);
  });

  it('resolves Following as Session sources plus current rule matches without inventing non-Session targets', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps,
      sessionFollowAction: async () => ({ follows: [], sources: [edge('explicit', 'parent')],
        rules: [rule('parent')], coverage: 'complete' }),
      sessionFollowPreview: async () => preview(['explicit', 'parent', 'rule-source']),
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.message.send', { sessionId: { selector: 'following' }, message: 'hello' }, context))
      .resolves.toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { sessionId: 'explicit' } }, { target: { sessionId: 'rule-source' } },
      ] } });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['explicit', 'rule-source']);
  });

  it('uses admitted Discussion participants and only already-bound model Sessions', async () => {
    const h = harness();
    // The authoritative roster was read on this Home; its saved launch alias belongs to its creator's device.
    const modelLaunch = { executionTarget: { serverId: 'creator-device-home', machineId: 'machine' },
      directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    const executor = createActionExecutor({ ...h.deps,
      discussionAction: async ({ actionId, input }: Parameters<NonNullable<ActionExecutorDeps['discussionAction']>>[0]) => {
        expect({ actionId, input }).toEqual({ actionId: 'discussion.participants.list', input: { discussionId: 'discussion' } });
        return DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'discussion', ownerAccountId: 'person',
          access: 'owner', grants: [], participants: [
            { participant: { kind: 'session', sessionId: 'a' }, answerPolicy: 'when_addressed', createdAt: 1 },
            { participant: { kind: 'model', participantSlotId: 'bound' }, launch: modelLaunch,
              sessionId: 'model-session', answerPolicy: 'when_addressed', createdAt: 1 },
            { participant: { kind: 'model', participantSlotId: 'unbound' }, launch: modelLaunch,
              sessionId: null, answerPolicy: 'when_addressed', createdAt: 1 },
          ] });
      },
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.message.send', { sessionId: { selector: 'discussion', discussionId: 'discussion' }, message: 'hello' }, context))
      .resolves.toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { serverId: 'home', sessionId: 'a' } }, { target: { serverId: 'home', sessionId: 'model-session' } },
      ] } });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a', 'model-session']);
  });

  it.each(['partial', 'rules_unavailable', 'rule_match_partial', 'wrong_source'] as const)(
    'refuses %s Follow facts before any target effect', async cause => {
      const h = harness();
      const executor = createActionExecutor({ ...h.deps,
        sessionFollowAction: async () => ({ follows: [], sources: [edge(cause === 'wrong_source' ? 'wrong' : 'parent', 'a')],
          rules: [], coverage: cause === 'partial' ? 'partial' : 'complete', peopleCount: 0 }),
        readSessionFollowRules: async () => cause === 'rules_unavailable' ? { kind: 'unavailable' }
          : { kind: 'complete', rules: [rule('b')] },
        sessionFollowPreview: async () => ({ ...preview(['parent']), coverage: cause === 'rule_match_partial' ? 'partial' : 'complete' }),
      } as unknown as ActionExecutorDeps);
      await expect(executor.execute('session.message.send', { sessionId: { selector: 'followers' }, message: 'hello' }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
      expect(h.effects).toEqual([]);
    });

  it.each(['followers', 'following', 'discussion'] as const)('replays %s only against the reviewed concrete list', async selector => {
    const h = harness();
    let members = ['a', 'b'];
    const executor = createActionExecutor({ ...h.deps,
      sessionFollowAction: async () => ({ follows: [], sources: members.map(member => selector === 'followers'
        ? edge('parent', member) : edge(member, 'parent')), rules: [], coverage: 'complete', peopleCount: 0 }),
      readSessionFollowRules: async () => ({ kind: 'complete', rules: [] }),
      discussionAction: async () => ({ discussionId: 'discussion', ownerAccountId: 'person', access: 'owner', grants: [],
        participants: members.map(sessionId => ({ participant: { kind: 'session', sessionId }, answerPolicy: 'when_addressed', createdAt: 1 })) }),
      isActionApprovalRequired: (id: string) => id === 'session.message.send',
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.message.send', { sessionId: selector === 'discussion'
      ? { selector, discussionId: 'discussion' } : { selector }, message: 'hello' }, context))
      .resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    members = ['b', 'c'];
    h.deny('b');
    await executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, context);
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a']);
    expect(h.approval()).toMatchObject({ execution: { result: { results: [
      { target: { sessionId: 'a' }, result: { ok: true } },
      { target: { sessionId: 'b' }, result: { ok: false, errorCode: 'permission_denied' } },
    ] } } });
  });

  it('refuses a rule receiver whose current Session access cannot be established', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps,
      resolveSessionReference: async ({ sessionId }: Parameters<NonNullable<ActionExecutorDeps['resolveSessionReference']>>[0]) => sessionId === 'lost-access'
        ? { kind: 'none' } : { kind: 'unique', address: { serverId: 'home', sessionId: sessionId! } },
      sessionFollowAction: async () => ({ follows: [], sources: [edge('parent', 'a')], rules: [], coverage: 'complete', peopleCount: 0 }),
      readSessionFollowRules: async () => ({ kind: 'complete', rules: [rule('lost-access')] }),
      sessionFollowPreview: async () => preview(['parent']),
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.message.send', { sessionId: { selector: 'followers' }, message: 'hello' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
    expect(h.effects).toEqual([]);
  });

  it('exhausts Follow continuation before dispatch and ignores non-Session sources', async () => {
    const h = harness();
    let continued = false;
    const firstPage = SessionFollowActionOutputSchemasV1['follow.list'].parse({ follows: [], sources: [edge('first', 'parent')],
      rules: [], coverage: 'partial', continuation: 'follow-next' });
    const secondPage = SessionFollowActionOutputSchemasV1['follow.list'].parse({ follows: [], sources: [edge('second', 'parent'), {
      source: { kind: 'discussion', discussionId: 'discussion' }, destinationSessionId: 'parent',
      policy: { preset: 'important' }, deliveryState: 'eligible', sourceAvailability: 'available', hasPendingUpdates: false, relation: 'follower',
    }], rules: [], coverage: 'complete' });
    const executor = createActionExecutor({ ...h.deps,
      sessionFollowAction: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['sessionFollowAction']>>[0]) => {
        if (!input.cursor) { continued = false; return firstPage; }
        if (!continued) { continued = true; return { ...firstPage, sources: [] }; }
        return secondPage;
      },
    } as unknown as ActionExecutorDeps);
    const result = await executor.execute('session.message.send', { sessionId: { selector: 'following' }, message: 'hello' }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { sessionId: 'first' } }, { target: { sessionId: 'second' } },
      ] } });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['first', 'second']);
  });

  it('resolves declaration-owned nested receivers and leaves an Account receiver without a Session target', async () => {
    const h = harness();
    const declaration = { field: 'receiver.sessionId', cardinality: 'one' as const };
    await expect(resolveActionSessionTargets(h.deps as unknown as ActionExecutorDeps, {
      actionId: 'follow.remove', declaration, context,
      input: { receiver: { kind: 'session', sessionId: { selector: 'manager' } }, source: { kind: 'session', sessionId: 'source' } },
    })).resolves.toMatchObject({ field: 'receiver.sessionId', targets: [{ serverId: 'home', sessionId: 'manager' }] });
    await expect(resolveActionSessionTargets(h.deps as unknown as ActionExecutorDeps, {
      actionId: 'follow.remove', declaration, context,
      input: { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'source' } },
    })).resolves.toBeNull();
  });

  it('resolves a Follow receiver once without changing its exact source or Account receiver', async () => {
    const h = harness();
    const source = { kind: 'session', sessionId: 'self' };
    for (const selector of ['self', 'manager'] as const) {
      await expect(h.executor.execute('follow.remove', { receiver: { kind: 'session', sessionId: { selector } }, source }, context))
        .resolves.toMatchObject({ ok: true, result: { changed: false } });
    }
    await expect(h.executor.execute('follow.remove', { receiver: { kind: 'account' }, source }, context))
      .resolves.toMatchObject({ ok: true, result: { changed: false } });
    expect(h.followEffects).toEqual([
      { receiver: { kind: 'session', sessionId: 'parent' }, source },
      { receiver: { kind: 'session', sessionId: 'manager' }, source },
      { receiver: { kind: 'account' }, source },
    ]);
    await expect(h.executor.execute('follow.remove', { receiver: { kind: 'session', sessionId: { selector: 'workers' } }, source }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'session_target_cardinality_mismatch' });
    expect(h.followEffects).toHaveLength(3);
  });

  it.each([
    { targetHome: 'home', replayHome: 'approving-device-home' },
    { targetHome: 'another-home', replayHome: 'another-home' },
  ])('replays the reviewed Follow receiver from $targetHome through $replayHome', async ({ targetHome, replayHome }) => {
    const h = harness();
    let manager = 'original-manager';
    const executor = createActionExecutor({ ...h.deps,
      readSessionManager: async () => ({ kind: 'manager', address: { serverId: targetHome, sessionId: manager } }),
      isActionApprovalRequired: (id: string) => id === 'follow.remove',
    } as unknown as ActionExecutorDeps);
    const originContext = { ...context, serverIdentityId: 'same-home-identity' };
    const input = { receiver: { kind: 'session', sessionId: { selector: 'manager' } }, source: { kind: 'session', sessionId: 'source-exact' } };
    await expect(executor.execute('follow.remove', input, originContext))
      .resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(h.approval()).toMatchObject({ executionOriginV1: { sessionTargetsV1: {
      field: 'receiver.sessionId', targets: [{ serverId: targetHome, sessionId: 'original-manager' }],
    } } });
    manager = 'replacement-manager';
    await expect(executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, {
      ...originContext, serverId: 'approving-device-home',
    }))
      .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(h.followEffects).toEqual([{ receiver: { kind: 'session', sessionId: 'original-manager' }, source: input.source }]);
    expect(h.followHomeIds).toEqual([replayHome]);
  });

  it('refuses nested Follow selector replay when its reviewed receiver snapshot is missing', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps,
      isActionApprovalRequired: (id: string) => id === 'follow.remove',
    } as unknown as ActionExecutorDeps);
    await executor.execute('follow.remove', {
      receiver: { kind: 'session', sessionId: { selector: 'manager' } },
      source: { kind: 'session', sessionId: 'source-exact' },
    }, context);
    const request = h.approval();
    if (!request || request.v !== 2) throw new Error('missing current approval');
    const { sessionTargetsV1: _snapshot, ...executionOriginV1 } = request.executionOriginV1;
    h.replaceApproval({ ...request, executionOriginV1 });
    await expect(executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, context))
      .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
    expect(h.followEffects).toEqual([]);
  });

  it('resolves manager/self for send and status without changing ordinary ID results', async () => {
    const h = harness();
    await expect(h.executor.execute('session.message.send', { sessionId: { selector: 'manager' }, message: 'hello' }, context))
      .resolves.toMatchObject({ ok: true, result: { status: 'accepted', localId: 'input-manager' } });
    await expect(h.executor.execute('session.status.get', { sessionId: 'self' }, context))
      .resolves.toMatchObject({ ok: true, result: { session: { id: 'parent' }, serverId: 'home' } });
    await expect(h.executor.execute('session.message.send', { sessionId: 'ordinary', message: 'hello' }, context))
      .resolves.toMatchObject({ ok: true, result: { status: 'accepted', localId: 'input-ordinary' } });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['manager', 'ordinary']);
  });

  it('returns every target outcome and preserves the exact nested recipient', async () => {
    const h = harness();
    h.deny('b');
    const recipient = { kind: 'execution_run', runId: 'run-exact' } as const;
    const result = await h.executor.execute('session.message.send', { sessionId: { selector: 'workers' }, message: 'hello', recipient }, context);
    expect(result).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
      { target: { serverId: 'home', sessionId: 'a' }, result: { ok: true, result: { status: 'accepted' } } },
      { target: { serverId: 'home', sessionId: 'b' }, result: { ok: false, errorCode: 'permission_denied' } },
    ] } });
    expect(h.effects).toMatchObject([{ sessionId: 'a', recipient }]);
  });

  it('evaluates group enablement once while admitting every concrete credential target', async () => {
    const h = harness();
    h.setWorkers(['a', 'b', 'c']);
    h.deny('b');
    let enabledReads = 0;
    let actionGrantReads = 0;
    const targetAdmissions: string[] = [];
    const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['session.message.send'] },
      targets: { sessions: [], machines: ['granted-machine'] }, approve: false,
      origins: [], models: null, permissionModes: null, create: null });
    // Observe the captured credential's Action ceiling without replacing the
    // grant evaluator. Each newly bound target still uses real grant admission.
    grant.actions = { families: [], get ids() { actionGrantReads++; return ['session.message.send']; } };
    const executor = createActionExecutor({ ...h.deps,
      isActionEnabled: () => { enabledReads++; return true; },
      // The authenticated Home resolves each Session's current Machine for
      // the real credential-target owner; no internal admission is mocked.
      resolveApiTokenGrantSessionMachineId: async ({ sessionId }: Parameters<NonNullable<ActionExecutorDeps['resolveApiTokenGrantSessionMachineId']>>[0]) => {
        targetAdmissions.push(sessionId);
        return 'granted-machine';
      },
    } as unknown as ActionExecutorDeps);
    const prepared = await executor.prepare('session.message.send', {
      sessionId: { selector: 'workers' }, message: 'hello',
    }, { ...context, bypassApprovals: true, externalActionCredential: {
      accountId: 'account', principalId: 'token', credentialId: 'token',
      grant,
    } });
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected admitted group send');
    const admittedActionGrantReads = actionGrantReads;
    expect(admittedActionGrantReads).toBeGreaterThan(0);
    expect(targetAdmissions).toEqual([]);
    const result = await prepared.invocation.run();
    expect(result).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
      { target: { sessionId: 'a' }, result: { ok: true } },
      { target: { sessionId: 'b' }, result: { ok: false, errorCode: 'permission_denied' } },
      { target: { sessionId: 'c' }, result: { ok: true } },
    ] } });
    expect(targetAdmissions).toEqual(['a', 'b', 'c']);
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a', 'c']);
    expect(enabledReads).toBe(1);
    expect(actionGrantReads - admittedActionGrantReads).toBe(0);
  });

  it('fills every remaining frozen target with cancellation after an accepted leaf', async () => {
    const h = harness();
    h.setWorkers(['a', 'b', 'c']);
    const controller = new AbortController();
    const executor = createActionExecutor({ ...h.deps,
      sessionSendMessage: async (args: Parameters<NonNullable<ActionExecutorDeps['sessionSendMessage']>>[0]) => {
        const accepted = await h.deps.sessionSendMessage(args);
        controller.abort();
        return accepted;
      },
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('session.message.send', {
      sessionId: { selector: 'workers' }, message: 'hello',
    }, { ...context, signal: controller.signal })).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
      { target: { serverId: 'home', sessionId: 'a' }, result: { ok: true } },
      { target: { serverId: 'home', sessionId: 'b' }, result: { ok: false, errorCode: 'cancelled' } },
      { target: { serverId: 'home', sessionId: 'c' }, result: { ok: false, errorCode: 'cancelled' } },
    ] } });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a']);
  });

  it('applies credential target scope to each concrete leaf and rechecks it at invocation', async () => {
    const h = harness();
    const grant = { v: 1 as const, actions: { families: [], ids: ['session.message.send'] },
      targets: { sessions: ['a'], machines: [] }, approve: false,
      origins: [], models: null, permissionModes: null, create: null };
    const ctx: ActionExecutorContext = { ...context, bypassApprovals: true,
      externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token', grant } };
    const prepared = await h.executor.prepare('session.message.send', {
      sessionId: { selector: 'workers' }, message: 'hello',
    }, ctx);
    expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('not ready');
    grant.targets.sessions = ['b'];
    expect(await prepared.invocation.run()).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
      { target: { sessionId: 'a' }, result: { ok: false, errorCode: 'credential_scope_denied' } },
      { target: { sessionId: 'b' }, result: { ok: true, result: { status: 'accepted' } } },
    ] } });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['b']);
  });

  it('rejects nested fanout outcomes instead of bypassing the declared leaf schema', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps,
      sessionSendMessage: async () => ({ kind: 'fanout', results: [{
        target: { serverId: 'home', sessionId: 'unexpected' },
        result: { ok: true, result: { kind: 'fanout', results: [{
          target: { serverId: 'home', sessionId: 'nested' },
          result: { ok: true, result: { status: 'accepted', localId: 'unexpected' } },
        }] } },
      }] }),
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.message.send', { sessionId: 'ordinary', message: 'hello' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('rejects one-resource cardinality, empty and incomplete groups before effects', async () => {
    const h = harness();
    await expect(h.executor.execute('session.open', { sessionId: { selector: 'workers' } }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'session_target_cardinality_mismatch' });
    h.setWorkers([]);
    await expect(h.executor.execute('session.message.send', { sessionId: { selector: 'workers' }, message: 'hi' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'session_target_empty' });
    h.setWorkers(['a']); h.incomplete();
    await expect(h.executor.execute('session.message.send', { sessionId: { selector: 'workers' }, message: 'hi' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
    expect(h.effects).toEqual([]);
  });

  it('freezes prepared targets and does not re-expand when relations change', async () => {
    const h = harness();
    const prepared = await h.executor.prepare('session.message.send', { sessionId: { selector: 'workers' }, message: 'hello' }, context);
    expect(prepared.kind).toBe('ready');
    h.setWorkers(['b', 'c']);
    if (prepared.kind !== 'ready') throw new Error('not ready');
    await prepared.invocation.run();
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a', 'b']);
  });

  it('freezes complete matching results in the existing approval origin and retains qualified identities', async () => {
    const h = harness();
    let selected = ['a', 'b'];
    const executor = createActionExecutor({ ...h.deps,
      sessionFollowPreview: async () => ({ coverage: 'complete', matchCount: selected.length,
        matches: selected.map(sessionId => ({ serverId: 'home', source: { kind: 'session', sessionId } })),
        unavailable: [], overlaps: [] }),
      isActionApprovalRequired: (id: string) => id === 'session.message.send',
    } as unknown as ActionExecutorDeps);
    const input = { sessionId: { selector: 'matching', filter: normalizeSessionListFilterV1({
      homeServerIds: ['home'], show: 'sessions', scope: 'all_accessible',
    }) }, message: 'hello' };
    await expect(executor.execute('session.message.send', input, context))
      .resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(h.approval()).toMatchObject({ executionOriginV1: { sessionTargetsV1: { targets: [
      { serverId: 'home', sessionId: 'a' }, { serverId: 'home', sessionId: 'b' },
    ] } } });
    selected = ['b', 'c'];
    h.deny('b');
    await executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, context);
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a']);
    expect(h.approval()).toMatchObject({ execution: { result: { kind: 'fanout', results: [
      { target: { sessionId: 'a' }, result: { ok: true } },
      { target: { sessionId: 'b' }, result: { ok: false, errorCode: 'permission_denied' } },
    ] } } });
  });

  it.each(['partial', 'unavailable', 'inconsistent', 'non_session'] as const)(
    'refuses %s matching coverage before fanout', async kind => {
      const h = harness();
      const executor = createActionExecutor({ ...h.deps,
        sessionFollowPreview: async () => ({ coverage: kind === 'partial' || kind === 'unavailable' ? kind : 'complete',
          matchCount: kind === 'inconsistent' ? 2 : 1,
          matches: [{ serverId: 'home', source: kind === 'non_session'
            ? { kind: 'discussion', discussionId: 'discussion' } : { kind: 'session', sessionId: 'a' } }],
          unavailable: [], overlaps: [] }),
      } as unknown as ActionExecutorDeps);
      await expect(executor.execute('session.message.send', { sessionId: { selector: 'matching',
        filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], show: 'sessions' }) }, message: 'hello' }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
      expect(h.effects).toEqual([]);
    },
  );

  it('matches Sessions from an explicitly scoped root caller without requiring a current Session', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps,
      sessionFollowPreview: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['sessionFollowPreview']>>[0]) => {
        expect(input.receiver).toEqual({ kind: 'account' });
        expect(input.filter.show).toBe('sessions');
        return { coverage: 'complete', matchCount: 1, matches: [
          { serverId: 'home', source: { kind: 'session', sessionId: 'a' } },
        ], unavailable: [], overlaps: [] };
      },
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.message.send', { sessionId: { selector: 'matching',
      filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], show: 'both' }) }, message: 'hello' },
    { ...context, defaultSessionId: undefined }))
      .resolves.toMatchObject({ ok: true, result: { kind: 'fanout', results: [{ target: { sessionId: 'a' } }] } });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a']);
  });

  it('does not turn a run-only filter into Session targets', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps,
      sessionFollowPreview: async () => { throw new Error('Run selection needs no Session corpus'); },
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.message.send', { sessionId: { selector: 'matching',
      filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], show: 'runs' }) }, message: 'hello' },
    { ...context, defaultSessionId: undefined }))
      .resolves.toMatchObject({ ok: false, errorCode: 'session_target_empty' });
    expect(h.effects).toEqual([]);
  });

  it('reads the canonical subtree to completion and distinguishes direct workers from recursive descendants', async () => {
    const h = harness();
    const nextCursor = encodeV2SessionListCursorV2({ sessionId: 'a', meaningfulActivityAt: 1 });
    const pages = new Map<string, number>();
    const executor = createActionExecutor({ ...h.deps,
      sessionList: async ({ query }) => {
        const storage = query?.storage ?? 'active';
        const page = query?.cursor ? (pages.get(storage) ?? 0) + 1 : 0;
        pages.set(storage, page);
        return markSessionListQueryResultV1({
          sessions: page === 2
            ? [{ id: 'grandchild', active: false, updatedAt: 1, presence: 'offline', manager: { sessionId: 'a' } }]
            : [{ id: 'a', active: false, updatedAt: 1, presence: 'offline', manager: { sessionId: 'parent' } }],
          // The list owner supplies continuation and completion; a repeated
          // opaque token must not make this consumer truncate the corpus.
          nextCursor: page === 2 ? null : nextCursor, hasNext: page !== 2,
          attentionNextCursor: null, attentionHasNext: false,
        });
      },
    } as unknown as ActionExecutorDeps);
    await executor.execute('session.message.send', { sessionId: { selector: 'workers' }, message: 'direct' }, context);
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a']);
    h.effects.length = 0;
    await executor.execute('session.message.send', { sessionId: { selector: 'workers', recursive: true }, message: 'all' }, context);
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a', 'grandchild']);
  });

  it('preserves qualified Home identity and refuses selectors without runnable backing', async () => {
    const h = harness();
    for (const serverId of ['home-a', 'home-b']) {
      await h.executor.execute('session.message.send', { sessionId: { selector: 'self', of: 'same-id' }, message: 'hello' }, { ...context, serverId });
    }
    expect(h.effects.map(({ sessionId, serverId }) => ({ sessionId, serverId }))).toEqual([
      { sessionId: 'same-id', serverId: 'home-a' }, { sessionId: 'same-id', serverId: 'home-b' },
    ]);
    const unsupported = await h.executor.execute('session.message.send', { sessionId: { selector: 'discussion', discussionId: 'discussion' }, message: 'no effect' }, context);
    expect(unsupported).toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
    expect(h.effects).toHaveLength(2);
  });

  it('captures the canonical explicit base before preparation instead of retaining a mutable prefix', async () => {
    const h = harness();
    let resolvedId = 'original';
    const executor = createActionExecutor({ ...h.deps,
      resolveSessionReference: async () => ({ kind: 'unique', address: { serverId: 'home', sessionId: resolvedId } }),
    } as unknown as ActionExecutorDeps);
    const input = { sessionId: { selector: 'self', of: 'prefix' }, message: 'hello' };
    const prepared = await executor.prepare('session.message.send', input, context, { reviewOnly: true });
    expect(prepared.kind).toBe('ready');
    expect(prepared).toMatchObject({ operation: { actionId: 'session.message.send', summary: expect.any(String),
      normalizedInput: input,
      sessionTargetsV1: { actionId: 'session.message.send', field: 'sessionId', selector: false,
        targets: [{ serverId: 'home', sessionId: 'original' }] } } });
    expect(h.effects).toEqual([]);
    resolvedId = 'replacement';
    const changed = await executor.prepare('session.message.send', input, context, { reviewOnly: true });
    if (prepared.kind !== 'ready' || !prepared.operation || changed.kind !== 'ready' || !changed.operation) throw new Error('not ready');
    expect(prepared.operation.inputDigest).not.toBe(changed.operation.inputDigest);
    expect(prepared.operation.inputDigest).not.toBe(computeActionInputApprovalDigestV1('session.message.send', input));
    await prepared.invocation.run();
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['original']);
  });

  it('returns unavailable before effects when a target fact read fails', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps,
      readSessionManager: async () => { throw new Error('Home disconnected'); },
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.message.send', { sessionId: { selector: 'manager' }, message: 'hello' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
    expect(h.effects).toEqual([]);
  });

  it('includes archived children while their canonical manager relation remains attached', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps,
      sessionList: async ({ query }) => markSessionListQueryResultV1({
        sessions: [{ id: query?.storage === 'archived' ? 'archived-child' : 'active-child',
          active: false, updatedAt: 1, presence: 'offline', manager: { sessionId: 'parent' } }],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }),
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.status.get', { sessionId: { selector: 'workers' } }, context))
      .resolves.toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { sessionId: 'active-child' } }, { target: { sessionId: 'archived-child' } },
      ] } });
  });

  it('replays the approved concrete list through strict Artifact custody and fresh access checks', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps, isActionApprovalRequired: (id: string) => id === 'session.message.send' } as unknown as ActionExecutorDeps);
    const requested = await executor.execute('session.message.send', { sessionId: { selector: 'workers' }, message: 'hello' }, context);
    expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(h.effects).toEqual([]);
    expect(h.approval()).toMatchObject({ executionOriginV1: { sessionTargetsV1: { targets: [
      { serverId: 'home', sessionId: 'a' }, { serverId: 'home', sessionId: 'b' },
    ] } } });
    h.setWorkers(['b', 'c']); h.deny('b');
    const replay = await executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, context);
    expect(replay).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a']);
    expect(h.approval()).toMatchObject({ execution: { result: { kind: 'fanout', results: [
      { target: { sessionId: 'a' }, result: { ok: true } }, { target: { sessionId: 'b' }, result: { ok: false } },
    ] } } });
  });

  it('refuses selector approval replay without its reviewed concrete snapshot', async () => {
    const h = harness();
    const executor = createActionExecutor({ ...h.deps, isActionApprovalRequired: (id: string) => id === 'session.message.send' } as unknown as ActionExecutorDeps);
    await executor.execute('session.message.send', { sessionId: { selector: 'workers' }, message: 'hello' }, context);
    const request = h.approval();
    if (!request || request.v !== 2) throw new Error('missing current approval');
    const { sessionTargetsV1: _snapshot, ...executionOriginV1 } = request.executionOriginV1;
    h.replaceApproval({ ...request, executionOriginV1 });
    h.setWorkers(['replacement']);
    const replay = await executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, context);
    expect(replay).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
    expect(h.effects).toEqual([]);
  });

  it('captures the same concrete targets through explicit approval-request creation', async () => {
    const h = harness();
    const created = await h.executor.execute('approval.request.create', {
      actionId: 'session.message.send', actionArgs: { sessionId: { selector: 'workers' }, message: 'hello' },
      summary: 'Review group send', createdBy: { surface: 'cli' },
    }, context);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    expect(h.approval()).toMatchObject({ executionOriginV1: { sessionTargetsV1: { targets: [
      { serverId: 'home', sessionId: 'a' }, { serverId: 'home', sessionId: 'b' },
    ] } } });
    h.setWorkers(['replacement']);
    await h.executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, context);
    expect(h.effects.map(effect => effect.sessionId)).toEqual(['a', 'b']);
  });

  it.each([false, true])('replays an explicitly approved one-target Goal against the reviewed manager (manager changed: %s)', async changed => {
    const h = harness();
    let manager = 'manager';
    const goals: unknown[] = [];
    const executor = createActionExecutor({ ...h.deps,
      readSessionManager: async () => ({ kind: 'manager', address: { serverId: 'home', sessionId: manager } }),
      sessionGoalSet: async (args: Parameters<NonNullable<ActionExecutorDeps['sessionGoalSet']>>[0]) => {
        goals.push({ sessionId: args.sessionId, objective: args.objective });
        return { updated: true };
      },
    } as unknown as ActionExecutorDeps);
    const created = await executor.execute('approval.request.create', {
      actionId: 'session.goal.set', actionArgs: { sessionId: { selector: 'manager' }, objective: 'Ship controls' },
      summary: 'Review manager goal', createdBy: { surface: 'cli' },
    }, context);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    expect(goals).toEqual([]);
    if (changed) manager = 'replacement';
    const replay = await executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, context);
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(goals).toEqual([{ sessionId: 'manager', objective: 'Ship controls' }]);
  });

  it('captures an external Action wrapper target during explicit approval instead of selecting again at replay', async () => {
    const h = harness();
    let manager = 'reviewed';
    const effects: unknown[] = [];
    const definition: ActionDefinitionV1 = {
      kindVersion: 1, id: 'com.acme.targets/actions/change', title: 'Change', description: 'Change selected Session',
      safety: 'safe', sideEffectClass: 'write', placements: [], slash: null, bindings: null, examples: null,
      surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false, api: true, plugin: true },
      sessionTarget: { field: 'sessionId', cardinality: 'one' },
      inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
    };
    const executor = createActionExecutor({ ...h.deps,
      listContributedActionDefinitions: () => [definition],
      readSessionManager: async () => ({ kind: 'manager', address: { serverId: 'home', sessionId: manager } }),
      invokeContributedAction: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['invokeContributedAction']>>[0]) => {
        effects.push(input);
        return { ok: true, result: input };
      },
    } as unknown as ActionExecutorDeps);
    const created = await executor.execute('approval.request.create', { actionId: 'action.invoke',
      actionArgs: { action: { pluginId: 'com.acme.targets', localId: 'change' }, input: { sessionId: { selector: 'manager' } } },
      summary: 'Review external target', createdBy: { surface: 'cli' },
    }, context);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    expect(effects).toEqual([]);
    manager = 'replacement';
    const replay = await executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, context);
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(effects).toEqual([{ sessionId: 'reviewed' }]);
  });

  it.each(['follow.remove', 'discussion.invite'] as const)('keeps the reviewed nested %s operand through explicit approval', async actionId => {
    const h = harness();
    let manager = 'reviewed';
    const writes: unknown[] = [];
    const executor = createActionExecutor({ ...h.deps,
      readSessionManager: async () => ({ kind: 'manager', address: { serverId: 'home', sessionId: manager } }),
      sessionFollowAction: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['sessionFollowAction']>>[0]) => {
        writes.push(input); return { changed: false };
      },
      discussionAction: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['discussionAction']>>[0]) => {
        writes.push(input); return { discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [], changed: true };
      },
    } as unknown as ActionExecutorDeps);
    const selector = { kind: 'session', sessionId: { selector: 'manager' } };
    const actionArgs = actionId === 'follow.remove'
      ? { receiver: selector, source: { kind: 'session', sessionId: 'source-exact' } }
      : { discussionId: 'discussion', participant: selector };
    expect(await executor.execute('approval.request.create', { actionId, actionArgs,
      summary: 'Review nested target', createdBy: { surface: 'cli' } }, context)).toMatchObject({ ok: true });
    expect(writes).toEqual([]);
    manager = 'replacement';
    const replay = await executor.execute('approval.request.decide', { artifactId: 'targets-approval', decision: 'approve' }, context);
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(writes).toEqual([actionId === 'follow.remove'
      ? { receiver: { kind: 'session', sessionId: 'reviewed' }, source: { kind: 'session', sessionId: 'source-exact' } }
      : { discussionId: 'discussion', participant: { kind: 'session', sessionId: 'reviewed' } }]);
  });
});
