import { describe, expect, it } from 'vitest';
import { actionStartTargetUnavailableV1, admitActionAgentStartV1, resolveActionAgentStartContextV1, resolveActionAgentStartRequestsV1, resolveRunStartModelAndConfig, stampAgentStartSelectionV1 } from './agentStartAdmission.js';
import { SessionModelSelectionSchema } from '../../providers/selection/v2.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { ExecutionRunStartRequestSchema } from '../../execution/runs/startRequest.js';
import type { AgentStartContextV1 } from '../../account/settings/admitAgentStartV1.js';
import { markSessionListQueryResultV1 } from '../../sessions/awareness/action.js';
import { readActionCallerLedSubtreeSessionIds } from './sessionLedSubtree.js';
import { WorkflowActionFailureV1Schema } from '../../workflows/workflowProgressV1.js';
import { V2SessionRecordSchema } from '../../sessions/control/contract.js';
import type { ActionExecutorDeps } from './types.js';
import { createSessionMembershipReadFixture } from '../../sessions/read/sessionReadBatchV1.testkit.js';
import { resolveActionCurrentSessionScopeFailure } from './sessionListAccess.js';
import { createActionExecutor } from '../actionExecutor.js';

const nativeTarget = { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } };
const roleTarget = { kind: 'agent' as const, identity: { pluginId: 'role.agent', localId: 'agent' } };

describe('canonical Action agent-start adapter', () => {
  it('keeps the retained V1 control on the same Workflow Action projection path', () => {
    const modelSelection = SessionModelSelectionSchema.parse({ v: 1, updatedAt: 5, ref: {
      agentTargetKey: 'agent:native.agent/agent', modelId: 'selected-model', providerConnectionId: null,
    } });
    const resolved = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new',
      input: { executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' } },
      context: {}, baseline: { machineId: 'machine', directory: '/repo' },
      effectiveSelection: { selection: { agentTarget: nativeTarget, modelSelection }, overrideEngine: true } });
    expect(resolved).toMatchObject({ ok: true, effectiveInput: { modelSelection: { v: 1, ref: modelSelection.ref } } });
  });
  it.each(['native', 'account_provider_connection', 'team_resource'] as const)(
    'preserves the %s model source through Workflow Action admission and dispatch projection', source => {
      const agentTargetKey = 'agent:native.agent/agent';
      const modelSelection = SessionModelSelectionSchema.parse({ v: 2, updatedAt: 5, ref: {
        source, agentTargetKey, modelId: 'selected-model',
        ...(source === 'account_provider_connection' ? { providerConnectionId: 'connection' } : {}),
        ...(source === 'team_resource' ? { teamId: 'team', resourceId: 'resource', expectedResourceRevision: 2, deliveryMode: 'direct' } : {}),
      } });
      const baseline = { machineId: 'machine', directory: '/repo', configuration: { agentTarget: nativeTarget, modelSelection } };
      for (const actionId of ['session.spawn_new', 'execution.run.start'] as const) {
        const resolved = resolveActionAgentStartRequestsV1({ actionId, input: actionId === 'session.spawn_new'
          ? { executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' } }
          : { intent: 'task', instructions: 'Work', permissionMode: 'no_tools', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' },
          context: {}, baseline, effectiveSelection: { selection: { agentTarget: nativeTarget, modelSelection }, overrideEngine: true } });
        if (!resolved.ok) throw new Error(resolved.errorCode);
        const request = resolved.requests[0];
        if (!request || (request.kind !== 'spawn_new' && request.kind !== 'execution_run')) throw new Error('Expected Agent start');
        expect(request.facts.modelSelection).toEqual(modelSelection);
        if (actionId === 'session.spawn_new') {
          expect(resolved.effectiveInput.modelSelection).toEqual(modelSelection);
          expect(SessionModelSelectionSchema.safeParse(resolved.effectiveInput.modelSelection).success).toBe(true);
        } else {
          expect(ExecutionRunStartRequestSchema.safeParse(resolved.effectiveInput).success).toBe(true);
          if (source === 'team_resource') {
            expect(resolved.effectiveInput).not.toHaveProperty('modelSelection');
            expect(resolved.effectiveInput.teamCredentialModel).toEqual({ kind: 'team_credential_provider_model',
              teamId: 'team', resourceId: 'resource', expectedResourceRevision: 2, deliveryMode: 'direct', agentTargetKey, modelId: 'selected-model' });
          } else {
            expect(resolved.effectiveInput.modelSelection).toEqual({ agentTargetKey, modelId: 'selected-model',
              providerConnectionId: source === 'native' ? null : 'connection' });
          }
        }
      }
    },
  );
  it('admits an unstamped Workflow Action Session birth through the ordinary Agent-start owner', async () => {
    let births = 0;
    const executor = createActionExecutor({ sessionSpawnNew: async () => { births++; return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }; } });
    expect(await executor.execute('session.spawn_new', {
      creationKey: 'ordinary-workflow-action', executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'path', path: '/repo' }, organizationPlacement: { sectionId: null, tagIds: [] }, agentTarget: nativeTarget,
    }, { surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
      serverId: 'home', executionRunWorkflowRunId: 'workflow',
      actionCaller: { kind: 'workflowRun', runId: 'workflow', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
    })).toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'agent_start_context_unavailable' } });
    expect(births).toBe(0);
  });
  it.each(['lead', 'another-manager'])('retains the direct-manager Resume boundary for %s', async managerSessionId => {
    const response = createSessionMembershipReadFixture(['child']);
    const detail = response.results[0]?.detail;
    if (!detail || detail.status !== 200) throw new Error('Expected the owned Session fixture');
    const session = V2SessionRecordSchema.parse({ ...detail.body.session, manager: { sessionId: managerSessionId } });
    const failure = await resolveActionCurrentSessionScopeFailure('session.open', { sessionId: 'child', intent: 'resume' },
      { surface: 'agent', defaultSessionId: 'lead', sessionListAccess: 'led_subtree', agentStartContext: {
        caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default',
        ledSubtreeSessionIds: [], workDepthLimit: 4,
      } }, { sessionId: 'current_session' }, { sessionList: async () => { throw new Error('Unexpected inventory read'); },
        sessionRead: async () => ({ results: [{ sessionId: 'child', detail: { status: 200, body: { session } } }] }) });
    expect(failure).toEqual(managerSessionId === 'lead' ? null : expect.objectContaining({ ok: false,
      details: { cause: 'action_scope_restricted' } }));
  });
  it.each(['missing', 'duplicate', 'mismatched', 'cancelled'] as const)('fails exact membership closed for %s evidence', async scenario => {
    const controller = new AbortController();
    const response = createSessionMembershipReadFixture(['child']);
    const row = response.results[0]!;
    const read = async () => {
      if (scenario === 'cancelled') controller.abort();
      return { results: scenario === 'missing' ? [] : scenario === 'duplicate' ? [row, row]
        : scenario === 'mismatched' ? [{ ...row, sessionId: 'other' }] : [row] };
    };
    expect(await readActionCallerLedSubtreeSessionIds({ sessionRead: read },
      { defaultSessionId: 'lead', signal: controller.signal }, undefined, ['child'])).toBeNull();
    expect(await readActionCallerLedSubtreeSessionIds({ sessionRead: async () => response },
      { defaultSessionId: 'lead' }, undefined, ['child'])).toEqual(new Set(['child']));
  });
  it('WF44 proves an exact target without paging unrelated active or archived led Sessions', async () => {
    const agentStartContext: AgentStartContextV1 = {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default',
      ledSubtreeSessionIds: ['removed'], workDepthLimit: 4,
    };
    const context = { agentStartContext, defaultSessionId: 'lead', sessionListAccess: 'led_subtree' as const };
    const ids = Array.from({ length: 1_000 }, (_, i) => `child-${i}`);
    const records = new Map(ids.map((id, i) => [id, V2SessionRecordSchema.parse({ id, seq: 0, createdAt: 1, updatedAt: 1,
      active: false, activeAt: 1, metadata: '{}', metadataVersion: 0, encryptionMode: 'plain', dataEncryptionKey: null,
      agentState: null, agentStateVersion: 0, archivedAt: i >= 600 ? 1 : null })]));
    const members = new Set(ids);
    let pages = 0;
    const exactReads: string[][] = [];
    let unavailable = false;
    const deps = {
      sessionList: async ({ query }) => {
        pages++;
        const partition = ids.slice(query?.storage === 'archived' ? 600 : 0, query?.storage === 'archived' ? 1_000 : 600)
          .filter(id => members.has(id));
        const start = Number(query?.cursor ?? 0);
        const end = start + (query?.limit ?? 200);
        return markSessionListQueryResultV1({ sessions: partition.slice(start, end).map(id => ({ id, active: false, presence: 'offline', updatedAt: 1 })),
          hasNext: end < partition.length, nextCursor: end < partition.length ? String(end) : null,
          attentionNextCursor: null, attentionHasNext: false });
      },
      sessionRead: async ({ sessionIds, underSessionId }) => {
        // The HTTP boundary supplies the Home's exact managed-subtree result.
        exactReads.push([...sessionIds]);
        expect(underSessionId).toBe('lead');
        return { results: sessionIds.map(sessionId => ({ sessionId, detail: unavailable
          ? { status: 503, body: { error: 'session_read_unavailable' } }
          : !members.has(sessionId) ? { status: 404, body: { error: 'not_found' } }
          : { status: 200, body: { session: records.get(sessionId) } } })) };
      },
    } satisfies Pick<ActionExecutorDeps, 'sessionList' | 'sessionRead'>;
    const admit = async (targetSessionId: string) => admitActionAgentStartV1(context,
      { kind: 'session_target', targetSessionId }, await resolveActionAgentStartContextV1(deps, context, targetSessionId));
    expect(await admit(ids[0]!)).toMatchObject({ ok: true });
    expect({ pages, exactReads }).toEqual({ pages: 0, exactReads: [[ids[0]]] });
    expect(await admit(ids[999]!)).toMatchObject({ ok: true });
    members.delete(ids[0]!);
    expect(await admit(ids[0]!)).toMatchObject({ ok: false, refusal: { code: 'subtree_denied' } });
    members.add(ids[0]!);
    expect(await admit(ids[0]!)).toMatchObject({ ok: true });
    unavailable = true;
    expect(await admit(ids[0]!)).toMatchObject({ ok: false, refusal: { code: 'subtree_denied' } });
    expect(await admit('lead')).toMatchObject({ ok: true });
    expect(pages).toBe(0);
    expect(exactReads).toHaveLength(5);
    unavailable = false;
    const both = await resolveActionAgentStartContextV1(deps, context, [ids[0]!, ids[999]!]);
    expect(both).toMatchObject({ ledSubtreeSessionIds: [ids[0], ids[999]] });
    expect(exactReads.at(-1)).toEqual([ids[0], ids[999]]);
  });
  it.each(['missing_context', 'invalid_policy'] as const)('emits a public-readable refusal for %s', scenario => {
    const ready: AgentStartContextV1 = {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo' }, roles: {},
      callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit: 4,
    };
    const admitted = admitActionAgentStartV1(scenario === 'invalid_policy'
      ? { sessionAgentSpawnPolicyV1: { v: 999 } } : {},
      { kind: 'session_target', targetSessionId: 'lead' }, scenario === 'missing_context' ? null : ready);
    if (admitted.ok) throw new Error('Expected refusal');
    expect(WorkflowActionFailureV1Schema.safeParse(admitted.error).success).toBe(true);
    expect(admitted.error.details).toEqual({ code: 'target_unavailable',
      reason: scenario === 'missing_context' ? 'agent_start_context_unavailable' : 'spawn_policy_invalid' });
  });

  it('preserves a context refusal before caller validation and start admission', async () => {
    const refusal = actionStartTargetUnavailableV1(undefined, 'agent_start_context', 'role_source_incomplete');
    const context = { actionCaller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 0, turnDepth: 0 } };
    const resolved = await resolveActionAgentStartContextV1({ resolveAgentStartContext: async () => refusal }, context);
    expect(resolved).toEqual(refusal);
    expect(admitActionAgentStartV1(context, { kind: 'session_target', targetSessionId: 'lead' }, resolved))
      .toMatchObject({ ok: false, error: refusal });
  });

  it('does not mistake a scope-only context refusal for a caller witness', async () => {
    let listReads = 0;
    const refusal = actionStartTargetUnavailableV1(undefined, 'agent_start_context', 'caller_depth_unavailable');
    const ids = await readActionCallerLedSubtreeSessionIds({
      resolveAgentStartContext: async () => refusal,
      sessionList: async () => { listReads += 1; throw new Error('unexpected scope read'); },
    }, { defaultSessionId: 'lead', sessionListAccess: 'current_session' });
    expect(ids).toBeNull();
    expect(listReads).toBe(0);
  });

  it.each([false, true])('inherits Session credentials and Launch Profile with only a model ref: role=%s', role => {
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'acme.auth/subscription': { source: 'connected' as const, selection: 'profile' as const, profileId: 'parent-account' },
    } };
    const context: AgentStartContextV1 = {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo', configuration: {
        agentTarget: nativeTarget, profileId: 'parent-launch', connectedServices,
      } },
      roles: { approval_reviewer: { roleId: 'approval_reviewer', name: 'Reviewer', instructions: 'Review',
        engine: { agentTargetKey: 'agent:native.agent/agent', modelId: 'review-model' },
        runsAs: { kind: 'background_run', intent: 'task' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true } },
      ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    };
    const input = { backendTarget: nativeTarget, intent: role ? 'task' : 'delegate',
      ...(role ? { roleId: 'approval_reviewer' } : { modelSelection: {
        agentTargetKey: 'agent:native.agent/agent', providerConnectionId: null, modelId: 'explicit-model',
      } }), instructions: 'Do the work', permissionMode: 'no_tools',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' };
    const resolved = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start', input, context: {}, baseline: context.baseline });
    if (!resolved.ok || !resolved.requests[0]) throw new Error('expected_start');
    const admission = admitActionAgentStartV1({}, resolved.requests[0], context);
    if (!admission.ok) throw new Error(admission.refusal.code);
    const bound = stampAgentStartSelectionV1(resolved.effectiveInput, admission.stamped, 'execution_run', context);
    expect(ExecutionRunStartRequestSchema.parse(bound)).toMatchObject({
      connectedServices, launchProfileId: 'parent-launch', modelSelection: {
        modelId: role ? 'review-model' : 'explicit-model', providerConnectionId: null,
      },
    });
    const explicit = { ...input, launchProfileId: 'child-launch', connectedServices: null };
    expect(stampAgentStartSelectionV1(explicit, admission.stamped, 'execution_run', context))
      .toMatchObject({ launchProfileId: 'child-launch', connectedServices: null });
    const otherAgent = stampAgentStartSelectionV1({ ...input, backendTarget: roleTarget },
      { workDepth: 1 }, 'execution_run', context);
    expect(otherAgent).not.toHaveProperty('connectedServices');
    expect(otherAgent).not.toHaveProperty('launchProfileId');
    const otherMachine = stampAgentStartSelectionV1({ ...input, machineId: 'other-machine' },
      { workDepth: 1 }, 'execution_run', context);
    expect(otherMachine).not.toHaveProperty('connectedServices');
    expect(otherMachine).not.toHaveProperty('launchProfileId');
    for (const explicitSource of [{ modelSelection: null }, { childSelection: 'agentDefault' },
      { connectedServicesDefaultServiceIds: ['acme.auth/subscription'] }]) {
      expect(stampAgentStartSelectionV1({ ...input, ...explicitSource }, { workDepth: 1 }, 'execution_run', context))
        .not.toHaveProperty('connectedServices');
    }
  });

  it('refuses inherited direct Team custody before it becomes an explicit child binding', () => {
    const context: AgentStartContextV1 = {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo', configuration: { agentTarget: nativeTarget,
        connectedServices: { v: 2, bindingsByServiceId: { 'acme.auth/subscription': {
          source: 'team_resource', resourceId: 'resource', deliveryMode: 'direct',
          disclosedMember: { service: { pluginId: 'acme.auth', localId: 'subscription' }, accountId: 'member' },
        } } },
      } }, roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    };
    expect(() => stampAgentStartSelectionV1({ backendTarget: nativeTarget,
      modelSelection: { agentTargetKey: 'agent:native.agent/agent', providerConnectionId: null, modelId: 'model' },
    }, { workDepth: 1 }, 'execution_run', context))
      .toThrow(expect.objectContaining({ code: 'execution_run_child_choice_required' }));
  });

  it('keeps current-Session start authority narrower than a readable led Session', async () => {
    const agentStartContext: AgentStartContextV1 = {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default',
      ledSubtreeSessionIds: ['child'], workDepthLimit: 4,
    };
    const child = V2SessionRecordSchema.parse({ id: 'child', seq: 0, createdAt: 1, updatedAt: 1,
      active: false, activeAt: 1, metadata: '{}', metadataVersion: 0, encryptionMode: 'plain', dataEncryptionKey: null,
      agentState: null, agentStateVersion: 0 });
    const deps = { sessionRead: async () => ({ results: [{ sessionId: 'child', detail: { status: 200, body: { session: child } } }] }),
      sessionList: async () => markSessionListQueryResultV1({
      sessions: [{ id: 'child', active: false, presence: 'offline', updatedAt: 1 }],
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    }) };
    for (const sessionListAccess of ['current_session', 'led_subtree', 'unavailable'] as const) {
      const context = { agentStartContext, sessionListAccess, defaultSessionId: 'lead' };
      const resolved = await resolveActionAgentStartContextV1(deps, context, 'child');
      expect(admitActionAgentStartV1(context, { kind: 'session_target', targetSessionId: 'child' }, resolved))
        .toMatchObject(sessionListAccess === 'led_subtree' ? { ok: true } : { ok: false, refusal: { code: 'subtree_denied' } });
      const own = await resolveActionAgentStartContextV1(deps, context, 'lead');
      expect(admitActionAgentStartV1(context, { kind: 'session_target', targetSessionId: 'lead' }, own)).toMatchObject({ ok: true });
    }
  });

  it('admits real managed-acquire continuations before spend while bare compute has no Agent request', () => {
    const baseline = { machineId: 'machine', directory: '/repo', configuration: { agentTarget: nativeTarget } };
    const resolve = (input: Readonly<Record<string, unknown>>) => resolveActionAgentStartRequestsV1({
      actionId: 'machines.managed.acquire', input, context: {}, baseline,
    });
    expect(resolve({})).toMatchObject({ ok: true, requests: [] });
    const result = resolve({ agentStart: { creationKey: 'continuation-1', directory: { kind: 'path', path: '/repo' },
      agentTarget: nativeTarget, initialInput: { text: 'Continue my work' } } });
    expect(result).toMatchObject({ ok: true, requests: [{ kind: 'spawn_new', facts: {
      machineId: { kind: 'new_machine' }, directory: '/repo', agentTarget: nativeTarget,
    } }] });
    if (!result.ok || !result.requests[0]) throw new Error('expected_managed_agent_start');
    const context: AgentStartContextV1 = {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 }, baseline,
      roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    };
    expect(admitActionAgentStartV1({}, result.requests[0], context)).toMatchObject({ ok: true, stamped: { workDepth: 1 } });
    expect(admitActionAgentStartV1({ sessionAgentSpawnPolicyV1: {
      ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowCrossMachine: false,
    } }, result.requests[0], context)).toMatchObject({ ok: false, refusal: {
      code: 'policy_denied_field', field: 'executionTarget.machineId',
    } });
    expect(admitActionAgentStartV1({}, result.requests[0], { ...context,
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 4, turnDepth: 0 },
    })).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
    const actualStart = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: {
      executionTarget: { serverId: 'home', machineId: 'enrolled-machine' },
      directory: { kind: 'path', path: '/repo' }, agentTarget: nativeTarget,
    }, context: {}, baseline });
    if (!actualStart.ok || !actualStart.requests[0]) throw new Error('expected_enrolled_agent_start');
    expect(admitActionAgentStartV1({ sessionAgentSpawnPolicyV1: {
      ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowCrossMachine: false,
    } }, actualStart.requests[0], context)).toMatchObject({ ok: false, refusal: {
      code: 'policy_denied_field', field: 'executionTarget.machineId',
    } });
    expect(resolve({ agentStart: { directory: { kind: 'path', path: '/repo' }, agentTarget: nativeTarget,
      executionTarget: { serverId: 'home', machineId: 'forged' } } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(resolve({ agentStart: { directory: { kind: 'path', path: '/repo' }, agentTarget: nativeTarget,
      environmentVariables: { TOKEN: 'not-public' } } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it.each(['session.spawn_new', 'machines.managed.acquire'] as const)(
    'admits the target-owned managed directory intent through %s without waiving custom-directory policy', actionId => {
      const context: AgentStartContextV1 = {
        caller: { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 2 },
        baseline: { machineId: 'machine', directory: '/repo', configuration: { agentTarget: nativeTarget } },
        roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
      };
      const authoring = { directory: { kind: 'managed' }, agentTarget: nativeTarget };
      const resolved = resolveActionAgentStartRequestsV1({ actionId,
        input: actionId === 'session.spawn_new'
          ? { ...authoring, executionTarget: { serverId: 'home', machineId: 'guest' } }
          : { agentStart: authoring },
        context: {}, baseline: context.baseline,
      });
      if (!resolved.ok || !resolved.requests[0]) throw new Error('expected_managed_directory_start');
      expect(admitActionAgentStartV1({}, resolved.requests[0], context))
        .toMatchObject({ ok: true, stamped: { workDepth: 3 } });
      expect(admitActionAgentStartV1({ sessionAgentSpawnPolicyV1: {
        ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowCustomDirectory: false,
      } }, resolved.requests[0], context)).toMatchObject({ ok: false, refusal: {
        code: 'policy_denied_field', field: 'directory',
      } });
      expect(admitActionAgentStartV1({}, resolved.requests[0], { ...context, workDepthLimit: 2 }))
        .toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
    },
  );

  it('keeps an unresolved directory unavailable instead of treating it as a managed allocation', () => {
    const context: AgentStartContextV1 = {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo', configuration: { agentTarget: nativeTarget } },
      roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    };
    const resolved = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: {
      executionTarget: { serverId: 'home', machineId: 'guest' },
      directory: { kind: 'unresolved' }, agentTarget: nativeTarget,
    }, context: {}, baseline: context.baseline });
    if (!resolved.ok || !resolved.requests[0]) throw new Error('expected_unresolved_directory_start');
    expect(admitActionAgentStartV1({}, resolved.requests[0], context))
      .toMatchObject({ ok: false, refusal: { code: 'target_unavailable' } });
  });

  it('binds a task role engine and Launch Profile through real execution-run admission', () => {
    const context: AgentStartContextV1 = {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo', configuration: { agentTarget: nativeTarget } },
      roles: { approval_reviewer: { roleId: 'approval_reviewer', name: 'Approval reviewer', instructions: 'Role review instructions',
        engine: { agentTargetKey: 'agent:role.agent/agent', modelId: 'review-model', effort: 'high' },
        profileId: 'review-launch-profile', runsAs: { kind: 'background_run', intent: 'task' },
        workspaceWrites: 'deny', secondOpinion: 'off', enabled: true } },
      ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    };
    const requested = { roleId: 'approval_reviewer', backendTarget: nativeTarget, intent: 'task',
      instructions: 'Assess this pending tool request.', permissionMode: 'no_tools',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' };
    const resolved = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start',
      input: requested, context: {}, baseline: context.baseline });
    if (!resolved.ok) throw new Error(resolved.errorCode);
    const request = resolved.requests[0];
    if (!request) throw new Error('expected_execution_start');
    const admitted = admitActionAgentStartV1({}, request, context);
    if (!admitted.ok) throw new Error(admitted.refusal.code);
    const bound = stampAgentStartSelectionV1(resolved.effectiveInput, admitted.stamped, 'execution_run', context);
    expect(ExecutionRunStartRequestSchema.safeParse(bound).success).toBe(true);
    expect(bound).toMatchObject({ roleId: 'approval_reviewer', backendTarget: roleTarget,
      modelId: 'review-model', launchProfileId: 'review-launch-profile', permissionMode: 'no_tools',
      sessionConfigOptionOverrides: { overrides: { reasoning_effort: { value: 'high' } } },
      instructions: requested.instructions });
    expect(bound).not.toHaveProperty('profileId');
    expect(admitted.stamped).toMatchObject({ workDepth: 1, workspaceWrites: 'deny' });
  });

  it('normalizes shorthand scalar configuration through the shared alias contract', () => {
    expect(resolveRunStartModelAndConfig({ modelId: '  model  ', configOptions: {
      text: 'value', count: 3, enabled: false, unset: null,
    } })).toMatchObject({ ok: true, options: { modelId: 'model', sessionConfigOptionOverrides: {
      overrides: { text: { value: 'value' }, count: { value: 3 }, enabled: { value: false }, unset: { value: null } },
    } } });
    for (const value of [NaN, Infinity, undefined, {}]) {
      expect(resolveRunStartModelAndConfig({ configOptions: { invalid: value } })).toEqual({ ok: true, options: {} });
    }
    expect(resolveRunStartModelAndConfig({ configOptions: { text: 'alias' },
      sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { text: { updatedAt: 1, value: 'canonical' } } },
    })).toMatchObject({ ok: false, error: { errorCode: 'invalid_parameters', details: {
      issues: [{ code: 'conflicting_selection', path: ['configOptions', 'text'] }],
    } } });
  });
  it('passes deferred workflow selection to the owner and returns a typed frozen-depth child refusal', () => {
    const request = { kind: 'workflow_run_leaf', selection: 'deferred', leaf: {
      blockId: 'panel', kind: 'action', actionId: 'subagents.plan.start',
      runsAs: { kind: 'background_run', intent: 'plan' }, workspaceWrites: 'deny',
      facts: { agentTarget: { kind: 'unresolved' } },
    } } as const;
    const context = { caller: { kind: 'session', sessionId: 'lead', starterDepth: 3, turnDepth: 0 },
      baseline: { machineId: 'run-machine', directory: '/repo' }, roles: {},
      ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    } as const;
    const result = admitActionAgentStartV1({}, request, context);
    expect(result).toEqual({ ok: true, stamped: { workDepth: 4 } });
    if (!result.ok) throw new Error(result.refusal.code);
    expect(admitActionAgentStartV1({}, { kind: 'workflow_run_leaf', leaf: {
      ...request.leaf, facts: { agentTarget: nativeTarget },
    } }, { ...context, caller: { kind: 'originless', runId: 'frozen-run', runDepth: result.stamped.workDepth } }))
      .toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' },
        error: { errorCode: 'work_depth_exceeded', details: { code: 'work_depth_exceeded' } } });
  });

  it.each([{ FEATURE_FLAG: 'enabled' }, {}])('keeps explicit spawn environments subject to the single admission owner: %j', (environmentVariables) => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: {
      executionTarget: { serverId: 'server', machineId: 'run-machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: nativeTarget, environmentVariables,
    }, context: {}, baseline: { machineId: 'run-machine', directory: '/repo' } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    const request = result.requests[0];
    if (!request) throw new Error('expected_spawn_request');
    expect(admitActionAgentStartV1({ sessionAgentSpawnPolicyV1: {
      ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowEnvironmentVariables: false,
    } }, request, {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'run-machine', directory: '/repo', configuration: { agentTarget: nativeTarget } },
      roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    })).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'environmentVariables' },
      error: { errorCode: 'policy_denied_field', details: { field: 'environmentVariables' } } });
  });

  it('preserves a typed ORC refusal for shared materializer admission', () => {
    expect(admitActionAgentStartV1({}, { kind: 'session_target', targetSessionId: 'target' }, null))
      .toMatchObject({ ok: false, refusal: { code: 'target_unavailable', reason: 'agent_start_context_unavailable' },
        error: { errorCode: 'target_unavailable', details: { reason: 'agent_start_context_unavailable' } } });
  });

  it.each([false, true])('projects frozen selection while respecting explicit native Action targets: role=%s', (overrideEngine) => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start',
      input: { backendTarget: nativeTarget, intent: 'delegate', modelId: 'native-model', profileId: 'native-execution-profile' }, context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' },
      effectiveSelection: { overrideEngine, selection: { agentTarget: roleTarget, profileId: 'portable-profile',
        modelSelection: { v: 1, updatedAt: 0, ref: { agentTargetKey: 'agent:role.agent/agent', providerConnectionId: null, modelId: 'role-model' } } } },
    });
    expect(result).toMatchObject({ ok: true, requests: [{ kind: 'execution_run', backendTargets: [overrideEngine ? roleTarget : nativeTarget],
      facts: { agentTarget: overrideEngine ? roleTarget : nativeTarget, profileId: 'portable-profile',
        modelSelection: { modelId: overrideEngine ? 'role-model' : 'native-model' } } }] });
    expect(result).toMatchObject({ ok: true, effectiveInput: { backendTarget: overrideEngine ? roleTarget : nativeTarget,
      profileId: 'native-execution-profile', launchProfileId: 'portable-profile', modelId: overrideEngine ? 'role-model' : 'native-model' } });
  });

  it('supplies a missing native spawn target from the frozen selection', () => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: {
      executionTarget: { serverId: 'server', machineId: 'run-machine' }, directory: { kind: 'path', path: '/repo' },
    }, context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' }, effectiveSelection: { selection: { agentTarget: roleTarget } } });
    expect(result).toMatchObject({ ok: true, requests: [{ kind: 'spawn_new', facts: { agentTarget: roleTarget } }] });
  });

  it('uses authored targets for keyed connections even when the Action target is inherited', () => {
    const request = { backendTarget: nativeTarget, instructions: 'Review the changes', connectedServices: 'openai:profile-root' };
    const resolve = (input: Readonly<Record<string, unknown>>) => resolveActionAgentStartRequestsV1({
      actionId: 'review.start', input, context: {}, baseline: { machineId: 'run-machine', directory: '/repo' },
      effectiveSelection: { selection: { agentTarget: roleTarget } },
    });
    const baseline = resolve(request);
    const keyed = resolve({ ...request, connectedServicesByBackendTargetKey: { 'agent:role.agent/agent': 'anthropic:profile-keyed' } });
    expect(baseline.ok).toBe(true);
    expect(keyed.ok).toBe(true);
    if (!baseline.ok || !keyed.ok) throw new Error('expected_inherited_review_target');
    expect(keyed.requests).toEqual(baseline.requests);
    expect(keyed.effectiveInput).toMatchObject({ engineIds: ['agent:role.agent/agent'] });
    expect(keyed.effectiveInput).not.toHaveProperty('backendTarget');
  });

  it('admits known spawn policy facts while its nonauthority initial input remains dynamic', () => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: {
      executionTarget: { serverId: 'server', machineId: 'run-machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: nativeTarget, initialInput: { text: { kind: 'input', name: 'task' } },
    }, context: {}, baseline: { machineId: 'run-machine', directory: '/repo' } });
    expect(result).toMatchObject({ ok: true, requests: [{ kind: 'spawn_new', facts: {
      agentTarget: nativeTarget, machineId: 'run-machine', directory: '/repo',
    } }], effectiveInput: { initialInput: { text: { kind: 'input', name: 'task' } } } });
  });

  it.each([false, true])('inherits effort only for the Workflow Agent and preserves other options: same=%s', same => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start',
      input: { backendTarget: same ? roleTarget : nativeTarget, intent: 'delegate' }, context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' }, effectiveSelection: { selection: {
        agentTarget: roleTarget, sessionConfigOptionOverrides: { v: 1, updatedAt: 0, overrides: {
          reasoning_effort: { value: 'high', updatedAt: 0 }, verbosity: { value: 'brief', updatedAt: 0 },
        } },
      } },
    });
    if (!result.ok) throw new Error(result.errorCode);
    const request = result.requests[0];
    if (!request || request.kind !== 'execution_run') throw new Error('expected_execution_start');
    expect(request.facts.configOptions).toEqual({ verbosity: { value: 'brief', updatedAtMs: 0 },
      ...(same ? { reasoning_effort: { value: 'high', updatedAtMs: 0 } } : {}),
    });
    expect(result.effectiveInput.sessionConfigOptionOverrides).toEqual({ v: 1, updatedAt: 0, overrides: {
      verbosity: { value: 'brief', updatedAt: 0 }, ...(same ? { reasoning_effort: { value: 'high', updatedAt: 0 } } : {}),
    } });
  });

  it('does not borrow a Workflow default model from another explicit Action Agent', () => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start',
      input: { backendTarget: nativeTarget, intent: 'delegate' }, context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' }, effectiveSelection: { selection: {
        agentTarget: roleTarget, modelSelection: { v: 1, updatedAt: 0,
          ref: { agentTargetKey: 'agent:role.agent/agent', providerConnectionId: null, modelId: 'other-agent-model' } },
      } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    expect(result.requests[0]).toMatchObject({ facts: { agentTarget: nativeTarget } });
    const request = result.requests[0];
    if (!request || request.kind !== 'execution_run') throw new Error('expected_execution_start');
    expect(request.facts.modelSelection).toBeUndefined();
    expect(result.effectiveInput.modelSelection).toBeUndefined();
  });

  it('freezes a native-compatible flat execution Action model from the Workflow selection', () => {
    const model = { agentTargetKey: 'agent:native.agent/agent', providerConnectionId: null, modelId: 'workflow-model' };
    const result = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start',
      input: { backendTarget: nativeTarget, intent: 'delegate' }, context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' },
      effectiveSelection: { selection: { agentTarget: nativeTarget, modelSelection: { v: 1, updatedAt: 0, ref: model } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    expect(ProviderBoundModelRefSchema.safeParse(result.effectiveInput.modelSelection).success).toBe(true);
    expect(result.effectiveInput.modelSelection).toEqual(model);
    expect(result.requests[0]).toMatchObject({ facts: { modelSelection: model } });
  });

  it('refuses a role fanout whose distinct keyed connections cannot survive its target projection', () => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'subagents.delegate.start', context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' },
      input: { backendTargetKeys: ['agent:native.agent/agent', 'agent:other.agent/agent'],
        connectedServicesByBackendTargetKey: { 'agent:native.agent/agent': 'openai:profile-a',
          'agent:other.agent/agent': 'anthropic:profile-b' } },
      effectiveSelection: { overrideEngine: true, selection: { agentTarget: roleTarget } },
    });
    expect(result).toEqual({ ok: false, errorCode: 'target_unavailable' });
  });
});
