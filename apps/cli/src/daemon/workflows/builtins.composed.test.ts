import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { describe, expect, it } from 'vitest';
import {
  ActionIdSchema, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, buildBackendTargetKeyV2,
  createActionExecutor, freezeActionCompletionContractV1, type ActionExecutorDeps,
  type ActionExecutorContext, type JsonValue, StrictJsonValueSchema, ActionsSettingsV1Schema, type ActionsSettingsV1,
  isApprovalRequiredByActionsSettings,
  ReviewCommentV1Schema, type ReviewCommentV1,
  ResolvedRoleV1Schema,
  REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, REVIEW_FINDINGS_VERIFY_ONLY_INSTRUCTIONS_V1,
} from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol';
import {
  getWorkflowStarterExamplesV1, materializeWorkflowAcceptedSnapshotV1,
  resolveBuiltinWorkflowDefinitionV1, type WorkflowDefinitionV1, type WorkflowAcceptedAuthorizationV1,
} from '@happier-dev/protocol/workflows';
import {  type WorkflowStepExecutor } from './coordinator';
import { bindAutomationWorkflowInputs, WorkflowInputResolutionError, type WorkflowJsonValue } from './input';
import { createWorkflowSessionStepExecutor } from './sessionStepExecutor';
import { createWorkflowDetachedExecutionRunStepExecutor, createWorkflowStepExecutorDispatcher } from './executionRunStepExecutor';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { createCoordinatorWorkspaceResolver, verifyWorkflowWorkspaceCurrentness } from './resolveWorkflowWorkspace';

const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
const engine = buildBackendTargetKeyV2(agentTarget);
const otherEngine = buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } });
const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };
const credentials = { token: 'native-boundary-fixture', encryption: null };
// Persisted user choices at the Account-settings boundary, not an executor
// bypass or a mocked policy decision. Default confirmation is tested separately.
const allowedCommentActions = ActionsSettingsV1Schema.parse({ v: 1,
  approvalWaivedSurfaces: { 'reviews.comments.transition': ['agent'], 'reviews.comments.setDisposition': ['agent'] } });
const allowedPrAction = ActionsSettingsV1Schema.parse({ v: 1,
  approvalWaivedSurfaces: { 'scm.pullRequest.openOrReuse': ['agent'] } });

function builtin(id: string): WorkflowDefinitionV1 {
  const resolved = resolveBuiltinWorkflowDefinitionV1(id);
  if (!resolved) throw new Error(`Missing built-in ${id}`);
  return resolved.definition;
}

async function accepted(definition: WorkflowDefinitionV1, evidence: Record<string, WorkflowJsonValue> = {}, origin = true) {
  const inputs = bindAutomationWorkflowInputs({ definition, evidence });
  const result = await materializeWorkflowAcceptedSnapshotV1({ definition, context: {
    source: { kind: 'inline' }, inputs, machineId: workspace.machineId, executionTarget: { kind: 'session' },
    workspaceTarget: { project: workspace }, origin: { kind: 'direct', ...(origin ? { originSessionId: 'origin' } : {}) },
    authorization: { principal: { kind: 'host' } },
  }, roleSelection: { defaultEngine: { agentTargetKey: engine }, availableAgentTargetKeys: [engine, otherEngine] },
  admission: { kind: 'user' }, effects: {
    resolveTargetAvailability: async () => true, // native installed-engine inventory boundary
    readActionContract: async (id) => {
      const parsed = ActionIdSchema.safeParse(id);
      if (!parsed.success) return null;
      const spec = getActionSpec(parsed.data);
      const output = spec.completion?.terminalOutputSchema ?? spec.outputSchema;
      if (!output) return null;
      return { inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
        outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(output, { target: 'draft-7' })),
        ...(spec.completion ? { completion: StrictJsonValueSchema.parse(freezeActionCompletionContractV1(spec.completion)) } : {}) };
    },
  } });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return { ...result.snapshot, inputs };
}

type NativeRun = { localInputId: string; value: JsonValue; intent: string };
type Fixtures = {
  checks?: readonly JsonValue[];
  opinion?: 'agree' | 'disagree' | 'uncertain';
  usage?: number; budget?: number;
  session?: (id: string, input: Parameters<WorkflowStepExecutor>[0]['input']) => JsonValue;
  reviewFailed?: boolean;
  reviewLaunchFailure?: boolean;
  comments?: () => readonly ReviewCommentV1[];
  panelCommentIds?: readonly string[];
  judgeVerdicts?: JsonValue[];
  commentWrite?: (actionId: string, input: unknown) => Promise<unknown>;
  actionsSettings?: ActionsSettingsV1;
};

/** Only native execution/session transports and persistent network reads are faked.
 * Admission, role selection, reference binding, both leaf adapters, Action
 * preparation/completion, loop bookkeeping and result decoding remain real. */
function harness(fixtures: Fixtures = {}) {
  const store = createInMemoryWorkflowCoordinatorStore();
  const events: string[] = [];
  const nativeRuns = new Map<string, NativeRun>();
  const launches: { sessionId: string | null | undefined; request: Record<string, unknown> }[] = [];
  const notifications: unknown[] = [];
  const goals: unknown[] = [];
  const removedTriggers: unknown[] = [];
  const scmRequests: unknown[] = [];
  let checkIndex = 0;
  let sessionStep: Parameters<WorkflowStepExecutor>[0] | undefined;
  let enqueueIndex = 0;
  let reviewLaunchRejected = false;
  const nativeDeps: Partial<ActionExecutorDeps> = {
    isActionApprovalRequired: (id, ctx) => isApprovalRequiredByActionsSettings(id,
      fixtures.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), ctx),
    executionRunCheckProtocolV2: async () => ({ ok: true }),
    executionRunStart: async (sessionId, request) => {
      if (request.intent === 'review' && fixtures.reviewLaunchFailure && !reviewLaunchRejected) {
        reviewLaunchRejected = true;
        throw Object.assign(new Error('native_review_launch_failed'), {
          code: 'native_review_launch_failed', details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        });
      }
      const runId = `native-${nativeRuns.size}`;
      launches.push({ sessionId, request });
      let value: JsonValue = 'native result';
      const instructions = typeof request.instructions === 'string' ? request.instructions : '';
      if (request.intent === 'agent') {
        if (instructions.includes('Before this goal') || instructions.includes('Is this change ready')) {
          events.push('second-opinion');
          value = { verdict: fixtures.opinion ?? 'agree', confidence: 0.8, risks: [], missingEvidence: [], nextStep: 'review' };
        } else if (instructions.includes('Return a document explaining')) {
          events.push('synthesis'); value = { document: 'A plan', proposal: { invalid: true } };
        } else if (instructions.includes('Rule only on disputed')) {
          events.push('judge'); value = { verdicts: fixtures.judgeVerdicts ?? [] };
        } else {
          events.push('check'); value = fixtures.checks?.[checkIndex++] ?? { verdict: 'converged' };
        }
      } else events.push(String(request.intent));
      nativeRuns.set(runId, { localInputId: typeof request.localInputId === 'string' ? request.localInputId : '',
        value, intent: typeof request.intent === 'string' ? request.intent : 'agent' });
      return { runId, callId: `call-${runId}`, sidechainId: `sidechain-${runId}` };
    },
    executionRunGet: async (_sessionId, input) => {
      const run = nativeRuns.get(input.runId);
      if (!run) throw new Error('Missing native run');
      return { run: { runId: input.runId, callId: `call-${input.runId}`, sidechainId: `sidechain-${input.runId}`,
        intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'workspace_write',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', status: 'running', startedAtMs: 1,
        inputTurns: { occurrenceId: `occurrence-${input.runId}`, last: {
          turnId: `turn-${run.localInputId}`, inputIds: [run.localInputId], state: 'completed',
          result: { kind: typeof run.value === 'string' ? 'text' : 'json', value: run.value },
        } } } };
    },
    reviewEnginesList: async () => ({ items: [engine, otherEngine].map((value) => ({ value, label: value })) }),
    agentsBackendsList: async () => ({ items: [engine, otherEngine].map((targetKey) => ({ targetKey, label: targetKey, enabled: true })) }),
    reviewCommentAction: async ({ actionId, input }) => {
      if (actionId !== 'reviews.comments.list') {
        events.push(actionId);
        if (!fixtures.commentWrite) throw new Error('Unexpected canonical comment write');
        return fixtures.commentWrite(actionId, input);
      }
      const request = input as { limit?: number; cursor?: string };
      const comments = fixtures.comments?.() ?? [];
      const offset = request.cursor ? Number(request.cursor) : 0;
      const limit = request.limit ?? 50;
      const items = comments.slice(offset, offset + limit);
      events.push('comments'); return { items, cursor: offset + limit < comments.length ? String(offset + limit) : null };
    },
    notificationsNotifyMe: async (input) => { notifications.push(input); return { attemptedChannels: 1, deliveredChannels: 1 }; },
    sessionGoalSet: async (input) => { goals.push(input); return { ok: true }; },
    workflowAction: async ({ actionId, input }) => {
      if (actionId !== 'session.trigger.remove') throw new Error('Unexpected native Workflow Action');
      removedTriggers.push(input); events.push('detach');
      return { set: { automationId: 'origin-automation', revision: 1, enabled: false, health: 'available', triggers: [] } };
    },
    scmActionExecute: async ({ input }) => { scmRequests.push(input); events.push('open-pr'); return { success: true, nextAction: { kind: 'none' }, pullRequest: {
      number: 1, title: 'PR', url: 'https://example.test/pr/1', state: 'open', draft: false,
      provider: { id: 'fixture', kind: 'github', displayName: 'Fixture', baseUrl: 'https://example.test' },
      baseBranch: 'main', headBranch: 'feature',
    } }; },
  };
  // This intentionally partial native-transport fixture fails loudly if a
  // built-in reaches a boundary not included in its recipe.
  const executor = createActionExecutor(nativeDeps as ActionExecutorDeps);
  const context = (params: { runId: string; authorization: WorkflowAcceptedAuthorizationV1; originSessionId?: string; workDepth?: number; role?: unknown }): ActionExecutorContext => {
    const role = ResolvedRoleV1Schema.safeParse(params.role);
    return {
    surface: 'agent', authority: 'account_automation', callerPermissionMode: params.authorization.admittedPermissionCeiling,
    actionCaller: { kind: 'workflowRun', runId: params.runId, authorization: params.authorization },
    ...(fixtures.actionsSettings ? { actionsSettings: fixtures.actionsSettings } : {}),
    defaultSessionId: params.originSessionId ?? null,
    sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
    agentStartContext: { caller: { kind: 'originless', runId: params.runId, runDepth: params.workDepth ?? 0,
      ...(params.originSessionId ? { runOriginSessionId: params.originSessionId } : {}) },
      baseline: { machineId: workspace.machineId, directory: workspace.directory }, ledSubtreeSessionIds: [],
      callerPermissionCeiling: params.authorization.admittedPermissionCeiling,
      roles: role.success ? { [role.data.roleId]: role.data } : {}, workDepthLimit: 4 },
    executionRunTargetMachineId: workspace.machineId,
    externalActionTarget: { kind: 'machine', machineId: workspace.machineId, project: { machineId: workspace.machineId, directory: workspace.directory } },
  }; };
  const session = createWorkflowSessionStepExecutor({ credentials,
    prepareConversation: async (params) => {
      sessionStep = params;
      return { kind: 'workflow_session_conversation', existing: { sessionId: 'origin', ...workspace },
        ...(params.execution.conversation?.kind === 'origin_session' ? { inputPath: 'origin_session' as const } : {}) };
    },

    materializeConversation: async () => ({ sessionId: 'origin', machineAdmissionTransport: async () => ({ status: 'accepted', localId: 'native-input' }) }),
    sessionInput: { enqueue: async () => ({ status: 'accepted', localId: `pending-${enqueueIndex++}` }),
      observe: async (request) => {
        if (!sessionStep) throw new Error('Missing native session input');
        await request.onInputMaterialized?.(1);
        const step = sessionStep;
        events.push(step.step.id);
        const value = fixtures.session?.(step.step.id, step.input) ?? 'session finished';
        return { ok: true, sessionId: request.sessionId, localId: request.localId,
          result: { kind: 'final_text', text: typeof value === 'string' ? value : JSON.stringify(value) } };
      },
    },
  });
  const detachedRun = createWorkflowDetachedExecutionRunStepExecutor({ actionExecutor: executor, workDepth: 0,
    resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
    buildActionContext: context,
  });
  const coordinator = () => createWorkflowCoordinator({ store,
    executeStep: createWorkflowStepExecutorDispatcher({ session, detachedRun }),
    resolveWorkspace: createCoordinatorWorkspaceResolver({ store, projectWorkspace: workspace, scm: {
      inspectLocation: async () => ({ inspection: { rootPath: workspace.checkoutRootPath } }),
      verifyRecordedWorkspace: async (descriptor, creationIntent) => verifyWorkflowWorkspaceCurrentness(descriptor, {
        creationIntent, pathIsDirectory: async () => true,
        inspectLocation: async () => ({ inspection: { rootPath: workspace.checkoutRootPath } }),
      }),
    } }), isAcceptedAuthorizationCurrent: async () => true,
    sessionContext: {
      resolveSessionContext: async () => ({ usage: { kind: 'unavailable' }, turns: [], truncated: false }),
      resolveSessionContextField: async (field) => {
        const value = field === 'usage.tokensUsed' ? fixtures.usage : fixtures.budget;
        if (value === undefined) throw new WorkflowInputResolutionError('missing_reference');
        return value;
      },
    }, action: { executor, buildContext: async (params) => context(params),
      observeRun: async (run) => fixtures.reviewFailed && nativeRuns.get(run.runId)?.intent === 'review'
        ? { kind: 'failed', code: 'native_review_failed' }
        : { kind: 'completed', result: {}, commentIds: [...(fixtures.panelCommentIds ?? fixtures.comments?.().map((comment) => comment.id) ?? [])],
          reviewedFingerprint: 'panel-fingerprint', materialization: { kind: 'complete' } },
    },
  });
  return { store, events, launches, notifications, goals, removedTriggers, scmRequests,
    run: async (definition: WorkflowDefinitionV1, evidence: Record<string, WorkflowJsonValue> = {}, origin = true) => {
      const snapshot = await accepted(definition, evidence, origin);
      const outcome = await coordinator().run({ ...snapshot, runId: 'builtin-run', ...(origin ? { originSessionId: 'origin' } : {}) });
      if (outcome.state === 'failed') throw new Error(JSON.stringify({ outcome,
        failures: store.list().filter((row) => row.lifecycle === 'failed').map((row) => ({ blockId: row.blockId, reason: row.reason,
          ...(row.validationIssues ? { validationIssues: row.validationIssues } : {}) })), events }));
      return outcome;
    },
  };
}

describe('built-ins through accepted materialization and native leaf adapters', () => {
  it.each(['keep-going', 'review-and-converge'])('refuses %s without an origin before native effects', async (id) => {
    const h = harness();
    await expect(h.run(builtin(id), { engines: [engine] }, false)).rejects.toThrow('invalid_input');
    expect(h.launches).toEqual([]); expect(h.goals).toEqual([]);
  });
  it.skipIf(!ActionIdSchema.safeParse('session.trigger.remove').success)('checks first, continues only from round two, completes the origin goal, and returns its recorded stop arm', async () => {
    const h = harness({ checks: [{ verdict: 'progress' }, { verdict: 'done' }] });
    expect(await h.run(builtin('keep-going'))).toMatchObject({ state: 'succeeded', finalOutput: { kind: 'stop_condition', arm: 0 } });
    expect(h.events).toEqual(['check', 'continue', 'check']);
    expect(h.goals).toEqual([{ sessionId: 'origin', status: 'complete' }]);
  });
  it.skipIf(!ActionIdSchema.safeParse('session.trigger.remove').success)('detaches only the named originating trigger after completing the origin goal', async () => {
    const h = harness({ checks: [{ verdict: 'done' }] });
    expect(await h.run(builtin('keep-going'), { triggerId: 'firing-trigger' })).toMatchObject({ state: 'succeeded' });
    expect(h.goals).toEqual([{ sessionId: 'origin', status: 'complete' }]);
    expect(h.removedTriggers).toEqual([{ sessionId: 'origin', triggerId: 'firing-trigger' }]);
    expect(h.events).toEqual(['check', 'detach']);
  });
  it.skipIf(!ActionIdSchema.safeParse('session.trigger.remove').success).each(['disagree', 'uncertain'] as const)('notifies without completing or parking on second-opinion %s', async (opinion) => {
    const h = harness({ checks: [{ verdict: 'done' }], opinion });
    expect(await h.run(builtin('keep-going'), { secondOpinion: true })).toMatchObject({ state: 'succeeded', finalOutput: { kind: 'stop_condition', arm: 0 } });
    expect(h.goals).toEqual([]); expect(h.notifications).toHaveLength(1);
    expect(h.store.list().some((row) => row.lifecycle === 'waiting_for_review')).toBe(false);
  });
  it.skipIf(!ActionIdSchema.safeParse('session.trigger.remove').success).each([
    { checks: [{ verdict: 'progress' }], usage: 10, budget: 10, arm: 1 },
    { checks: [{ verdict: 'no_progress' }, { verdict: 'no_progress' }], arm: 2 },
  ])('stops without goal writes on budget or trailing strikes $arm', async ({ arm, ...fixtures }) => {
    const h = harness(fixtures);
    expect(await h.run(builtin('keep-going'), { strikes: 2 })).toMatchObject({ state: 'succeeded', finalOutput: { kind: 'stop_condition', arm } });
    expect(h.goals).toEqual([]);
  });
  it.skipIf(!ActionIdSchema.safeParse('session.trigger.remove').success)('resets trailing strikes on progress and honors a non-default round cap', async () => {
    const h = harness({ checks: [{ verdict: 'no_progress' }, { verdict: 'progress' }, { verdict: 'no_progress' }] });
    expect(await h.run(builtin('keep-going'), { strikes: 2, maxRounds: 3 })).toMatchObject({ state: 'succeeded', finalOutput: { kind: 'exhausted', rounds: 3 } });
    expect(h.goals).toEqual([]);
  });
  it('runs default Review without missing Judge results and verifies before the second panel', async () => {
    let comments = [ReviewCommentV1Schema.parse({ v: 1, id: 'finding-1', accountId: 'account', projectId: 'project',
      sessionId: 'origin', anchor: { kind: 'line', filePath: 'a.ts', line: 1 }, snapshot: { kind: 'none', capturedAt: 1 },
      body: 'A material finding', bodyVersion: 1, edits: [], author: { kind: 'workflow', runId: 'builtin-run' },
      state: 'open', flags: {}, dispositions: {}, threadId: 'finding-1', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 })];
    const h = harness({ comments: () => comments, checks: [{ verdict: 'continue' }, { verdict: 'converged' }], session: (id, input) => {
      expect(id).toBe('verify'); expect(input.text).toContain(REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1);
      expect(input.values).toHaveLength(1); expect(JSON.stringify(input.values)).toContain('finding-1');
      comments = []; return 'verified and fixed';
    } });
    expect(await h.run(builtin('review-and-converge'), { engines: [engine, otherEngine] })).toMatchObject({ state: 'succeeded', finalOutput: { kind: 'stop_condition', arm: 0 } });
    expect(h.events).not.toContain('judge');
    expect(h.events.indexOf('verify')).toBeGreaterThan(h.events.indexOf('check'));
    expect(h.events.slice(h.events.indexOf('verify') + 1).filter((event) => event === 'review')).toHaveLength(2);
    expect(h.launches.filter(({ request }) => request.intent === 'review').every(({ request, sessionId }) =>
      sessionId === 'origin' && request.instructions === 'Review the changes made in this session.')).toBe(true);
    expect(String(h.launches.find(({ request }) => request.intent === 'agent')?.request.instructions)).toContain('A material finding');
  });
  it('reports once without fixing or another panel, with Judge off', async () => {
    const h = harness({ checks: [{ verdict: 'continue' }], session: (id, input) => {
      expect(id).toBe('report'); expect(input.text).toContain(REVIEW_FINDINGS_VERIFY_ONLY_INSTRUCTIONS_V1);
      expect(input.values).toHaveLength(1); return 'verified only';
    } });
    expect(await h.run(builtin('review-and-converge'), { engines: [engine, otherEngine], apply: 'report' })).toMatchObject({ state: 'succeeded', finalOutput: { kind: 'stop_condition', arm: 1 } });
    expect(h.events.filter((event) => event === 'review')).toHaveLength(2); expect(h.events).not.toContain('verify');
  });
  it('notifies after non-convergence without parking or leaving the next run blocked', async () => {
    const h = harness({ checks: [{ verdict: 'continue' }] });
    expect(await h.run(builtin('review-and-converge'), { engines: [engine, otherEngine], maxRounds: 1 })).toMatchObject({ state: 'succeeded', finalOutput: { kind: 'exhausted', rounds: 1 } });
    expect(h.notifications).toHaveLength(1); expect(h.store.list().some((row) => row.lifecycle === 'waiting_for_review')).toBe(false);
  });
  it('retains a failed reviewer as check evidence rather than losing the round', async () => {
    const h = harness({ checks: [{ verdict: 'continue' }], reviewFailed: true });
    expect(await h.run(builtin('review-and-converge'), { engines: [engine, otherEngine], maxRounds: 1 }))
      .toMatchObject({ state: 'succeeded', finalOutput: { kind: 'exhausted', rounds: 1 } });
    expect(String(h.launches.find(({ request }) => request.intent === 'agent')?.request.instructions)).toContain('native_review_failed');
    expect(h.notifications).toHaveLength(1);
  });
  it('collects a reviewer that provably launched no run while preserving its successful sibling', async () => {
    const h = harness({ checks: [{ verdict: 'continue' }], reviewLaunchFailure: true });
    expect(await h.run(builtin('review-and-converge'), { engines: [engine, otherEngine], maxRounds: 1 }))
      .toMatchObject({ state: 'succeeded', finalOutput: { kind: 'exhausted', rounds: 1 } });
    expect(h.store.list().some((row) => row.blockKind === 'action' && row.lifecycle === 'failed'
      && row.reason === 'native_review_launch_failed')).toBe(true);
    expect(h.launches.filter(({ request }) => request.intent === 'review')).toHaveLength(1);
    expect(h.notifications).toHaveLength(1);
  });
  it.each([
    { verdict: 'dismiss', project: true }, { verdict: 'dismiss', project: false },
    { verdict: 'uphold', project: true }, { verdict: 'uphold', project: false },
  ] as const)('applies $verdict through the canonical scoped CAS Action (project: $project)', async ({ verdict, project }) => {
    const scope: Record<string, JsonValue> = project ? { projectId: 'project' } : { workspace: { machineId: 'machine', path: '/repo' } };
    let comment = ReviewCommentV1Schema.parse({ v: 1, id: 'finding-1', accountId: 'account', ...scope,
      sessionId: 'origin', anchor: { kind: 'line', filePath: 'a.ts', line: 1 }, snapshot: { kind: 'none', capturedAt: 1 },
      body: 'A disputed finding', bodyVersion: 1, edits: [], author: { kind: 'workflow', runId: 'builtin-run' },
      state: 'open', flags: { disputed: true }, dispositions: {}, threadId: 'finding-1', transitions: [],
      createdAt: 1, updatedAt: 1, serverRevision: 2 });
    const writes: unknown[] = [];
    const h = harness({ actionsSettings: allowedCommentActions, comments: () => [comment], judgeVerdicts: [{ commentId: comment.id, verdict,
      reason: 'Concrete evidence', expectedServerRevision: comment.serverRevision, expectedState: comment.state,
      clientMutationId: 'judge-finding-1-r2', ...scope,
      ...(verdict === 'dismiss' && project ? { evidence: [{ kind: 'reasoning', message: 'Proof' }] } : {}) }],
      checks: [{ verdict: verdict === 'dismiss' ? 'converged' : 'continue' }],
      commentWrite: async (actionId, input) => {
        writes.push(input);
        expect(actionId).toBe(verdict === 'dismiss' ? 'reviews.comments.transition' : 'reviews.comments.setDisposition');
        comment = { ...comment, serverRevision: 3, ...(verdict === 'dismiss' ? { state: 'dismissed' as const }
          : { dispositions: { 'workflow:builtin-run': 'blocking' as const } }) };
        return { comment };
      },
    });
    expect(await h.run(builtin('review-and-converge'), { engines: [engine], useJudge: true, maxRounds: 1 })).toMatchObject({ state: 'succeeded' });
    expect(writes).toEqual([expect.objectContaining({ ...scope, commentId: 'finding-1', expectedServerRevision: 2,
      clientMutationId: 'judge-finding-1-r2', ...(verdict === 'dismiss' ? { expectedState: 'open', toState: 'dismissed', reason: 'Concrete evidence',
        ...(project ? { evidence: [{ kind: 'reasoning', message: 'Proof' }] } : {}) }
        : { disposition: 'blocking' }) })]);
    const check = h.launches.find(({ request }) => typeof request.instructions === 'string' && request.instructions.includes('Check convergence'));
    expect(String(check?.request.instructions)).toContain(verdict === 'dismiss' ? 'dismissed' : 'blocking');
  });
  it('keeps a rejected CAS verdict unresolved and reaches the persisted convergence check', async () => {
    const comment = ReviewCommentV1Schema.parse({ v: 1, id: 'finding-1', accountId: 'account', projectId: 'project',
      sessionId: 'origin', anchor: { kind: 'line', filePath: 'a.ts', line: 1 }, snapshot: { kind: 'none', capturedAt: 1 },
      body: 'Unresolved after concurrent edit', bodyVersion: 1, edits: [], author: { kind: 'workflow', runId: 'builtin-run' },
      state: 'open', flags: { disputed: true }, dispositions: {}, threadId: 'finding-1', transitions: [],
      createdAt: 1, updatedAt: 1, serverRevision: 3 });
    const h = harness({ actionsSettings: allowedCommentActions, judgeVerdicts: [{ commentId: 'finding-1', verdict: 'dismiss', reason: 'Evidence',
      expectedServerRevision: 2, expectedState: 'open', clientMutationId: 'judge-r2', projectId: 'project' }],
      comments: () => [comment], checks: [{ verdict: 'continue' }],
      commentWrite: async () => ({ ok: false, errorCode: 'review_comment_conflict', error: 'review_comment_conflict' }),
    });
    await expect(h.run(builtin('review-and-converge'), { engines: [engine], useJudge: true, maxRounds: 1 }))
      .resolves.toMatchObject({ state: 'succeeded', completedWithFailures: true, finalOutput: { kind: 'exhausted', rounds: 1 } });
    expect(h.events).toContain('check');
    const check = h.launches.find(({ request }) => typeof request.instructions === 'string' && request.instructions.includes('Check convergence'));
    expect(String(check?.request.instructions)).toContain('Unresolved after concurrent edit');
    expect(comment.state).toBe('open');
    expect(h.store.list().find((row) => row.blockId === 'dismiss-project'))
      .toMatchObject({ lifecycle: 'failed', reason: 'review_comment_conflict' });
    expect(h.notifications).toHaveLength(1);
  });
  it('reads all 51 current findings across comment pages alongside unrelated session comments', async () => {
    const comments = Array.from({ length: 52 }, (_, index) => ReviewCommentV1Schema.parse({ v: 1,
      id: `finding-${index}`, accountId: 'account', projectId: 'project', sessionId: 'origin',
      anchor: { kind: 'line', filePath: 'a.ts', line: index + 1 }, snapshot: { kind: 'none', capturedAt: 1 },
      body: `Persisted finding body ${index}`, bodyVersion: 1, edits: [], author: { kind: 'workflow', runId: index === 0 ? 'other-run' : 'builtin-run' },
      state: 'resolved', flags: {}, dispositions: {}, threadId: `finding-${index}`, transitions: [],
      createdAt: 1, updatedAt: 1, serverRevision: 1 }));
    const h = harness({ comments: () => comments, panelCommentIds: comments.slice(1).map((comment) => comment.id) });
    await expect(h.run(builtin('review-and-converge'), { engines: [engine], maxRounds: 1 }))
      .resolves.toMatchObject({ state: 'succeeded', finalOutput: { kind: 'stop_condition', arm: 0 } });
    const check = h.launches.find(({ request }) => typeof request.instructions === 'string' && request.instructions.includes('Check convergence'));
    for (const comment of comments.slice(1)) expect(String(check?.request.instructions)).toContain(comment.body);
  });
  it('refuses an undeclared apply mode before launching any reviewer or verification turn', async () => {
    const h = harness();
    await expect(h.run(builtin('review-and-converge'), { engines: [engine], apply: 'anything' })).rejects.toThrow('invalid_input');
    expect(h.launches).toEqual([]);
    expect(h.events).toEqual([]);
  });
  it('retains default human confirmation for Judge writes before the native mutation', async () => {
    const h = harness({ judgeVerdicts: [{ commentId: 'finding-1', verdict: 'dismiss', reason: 'Evidence',
      expectedServerRevision: 2, expectedState: 'open', clientMutationId: 'judge-r2', projectId: 'project' }],
      checks: [{ verdict: 'continue' }],
      commentWrite: async () => { throw new Error('Unapproved comment mutation'); },
    });
    await expect(h.run(builtin('review-and-converge'), { engines: [engine], useJudge: true, maxRounds: 1 }))
      .resolves.toMatchObject({ state: 'succeeded', completedWithFailures: true, finalOutput: { kind: 'exhausted', rounds: 1 } });
    expect(h.events).not.toContain('reviews.comments.transition');
    expect(h.events).toContain('check');
    expect(h.store.list().find((row) => row.blockId === 'dismiss-project'))
      .toMatchObject({ lifecycle: 'failed', reason: 'approvals_not_supported' });
  });
  it.each([false, true])('plans with two detached engines and pauses synthesis (origin: %s)', async (origin) => {
    const h = harness();
    const result = await h.run(builtin('plan-with-a-panel'), { request: 'Plan it', engines: [engine, otherEngine] }, origin);
    expect(result, JSON.stringify({ result, events: h.events, rows: h.store.list().filter((row) => row.lifecycle === 'failed') })).toMatchObject({ state: 'waiting_for_review' });
    expect(h.launches.every(({ sessionId }) => sessionId === null)).toBe(true);
    expect(h.store.list().find((row) => row.blockId === 'synthesis')).toMatchObject({ lifecycle: 'waiting_for_review', result: { document: 'A plan' } });
  });
  it('plans with request alone and no manufactured Session or planner leaves', async () => {
    const h = harness();
    expect(await h.run(builtin('plan-with-a-panel'), { request: 'Plan it' }, false)).toMatchObject({ state: 'waiting_for_review' });
    expect(h.events).toEqual(['synthesis']); expect(h.launches[0]?.sessionId).toBeNull();
  });
  it.each(['disagree', 'uncertain'] as const)('holds the PR effect on %s', async (opinion) => {
    const h = harness({ opinion });
    expect(await h.run(builtin('open-a-pull-request'), { base: 'main', title: 'PR' }, false)).toMatchObject({ state: 'waiting_for_review' });
    expect(h.events).toEqual(['second-opinion']);
  });
  it('opens a PR on agreement with the exact bound workspace and returns the native SCM output', async () => {
    const h = harness({ opinion: 'agree', actionsSettings: allowedPrAction });
    expect(await h.run(builtin('open-a-pull-request'), { base: 'main', title: 'PR', body: 'Details' }, false))
      .toMatchObject({ state: 'succeeded', finalOutput: { success: true, pullRequest: { url: 'https://example.test/pr/1' } } });
    expect(h.scmRequests).toEqual([expect.objectContaining({ cwd: '/repo', base: 'main', title: 'PR', body: 'Details' })]);
  });
  it('repairs through Builder session turns and preserves the final check behind the Wait', async () => {
    const seed = getWorkflowStarterExamplesV1().find((item) => item.key === 'repair-until-it-passes');
    if (!seed) throw new Error('Missing repair seed');
    let checks = 0;
    const h = harness({ session: (id) => id === 'check' ? { passed: ++checks === 2, failures: checks === 2 ? '' : 'test failure' } : 'fix' });
    expect(await h.run(seed.definition, { request: 'Repair it', maxAttempts: 4 }, false)).toMatchObject({ state: 'waiting_for_review' });
    expect(h.events).toEqual(['fix', 'check', 'fix', 'check']);
    expect(h.store.list().filter((row) => row.blockId === 'check').map((row) => row.result)).toEqual([
      { passed: false, failures: 'test failure' }, { passed: true, failures: '' },
    ]);
  });
});
