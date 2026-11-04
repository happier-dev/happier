import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { describe, expect, it } from 'vitest';
import {
  ActionIdSchema, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, buildBackendTargetKeyV2,
  createActionExecutor, type ActionExecutorDeps,
  type ActionExecutorContext, type JsonValue, StrictJsonValueSchema, ActionsSettingsV1Schema, type ActionsSettingsV1,
  isApprovalRequiredByActionsSettings,
  ReviewCommentV1Schema, type ReviewCommentV1,
  ResolvedRoleV1Schema,
  REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, REVIEW_FINDINGS_VERIFY_ONLY_INSTRUCTIONS_V1,
} from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol';
import {
  getWorkflowStarterExamplesV1, materializeWorkflowAcceptedSnapshotV1,
  resolveBuiltinWorkflowDefinitionV1, type WorkflowDefinitionV1, type WorkflowAcceptedAuthorizationV1, type WorkflowStep,
} from '@happier-dev/protocol/workflows';
import { workflowInvocationKey, type WorkflowStepExecutor } from './coordinator';
import { bindAutomationWorkflowInputs, WorkflowInputResolutionError, type WorkflowJsonValue } from './input';
import { createWorkflowSessionStepExecutor } from './sessionStepExecutor';
import { createWorkflowDetachedExecutionRunStepExecutor, createWorkflowStepExecutorDispatcher } from './executionRunStepExecutor';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { createCoordinatorWorkspaceResolver, verifyWorkflowWorkspaceCurrentness } from './resolveWorkflowWorkspace';
import { AgentProfile } from '@/agent/executionRuns/profiles/agent/AgentProfile';
import { ExecutionRunResultContractV1Schema } from '@happier-dev/protocol/execution/runs/resultContractV1';
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { SessionGoalSetRequestV1Schema, type SessionGoalSetRequestV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { createWorkflowTriggerActions, type WorkflowTriggerActionsDependencies } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import type { AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationTriggerDetailSchema } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import type { SessionMessageReplyOutcomeV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { DiscussionReadResultV1Schema } from '@happier-dev/protocol/discussions/actions';

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

async function accepted(definition: WorkflowDefinitionV1, evidence: Record<string, WorkflowJsonValue> = {}, origin = true, discussion = false) {
  const inputs = bindAutomationWorkflowInputs({ definition, evidence });
  const result = await materializeWorkflowAcceptedSnapshotV1({ definition, context: {
    source: { kind: 'inline' }, inputs, machineId: workspace.machineId, executionTarget: { kind: 'session' },
    workspaceTarget: { project: workspace }, origin: { kind: 'direct', ...(origin && !discussion ? { originSessionId: 'origin' } : {}),
      ...(discussion ? { discussion: { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 2 } } : {}) },
    authorization: { principal: { kind: 'host' } },
  }, roleSelection: { defaultEngine: { agentTargetKey: engine }, availableAgentTargetKeys: [engine, otherEngine] },
  admission: { kind: 'user' }, effects: {
    resolveSessionTarget: async (value) => {
      const address = typeof value === 'string' ? { serverId: 'home', sessionId: value } : value;
      return address && typeof address === 'object' && !Array.isArray(address)
        && address.serverId === 'home' && typeof address.sessionId === 'string'
        ? { address: { serverId: address.serverId, sessionId: address.sessionId }, machineId: workspace.machineId } : null;
    }, // authorized Session metadata/transport boundary
    resolveTargetAvailability: async () => true, // native installed-engine inventory boundary
    readActionContract: async (id) => {
      const parsed = ActionIdSchema.safeParse(id);
      if (!parsed.success) return null;
      const spec = getActionSpec(parsed.data);
      return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(spec));
    },
  } });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.snapshot;
}

type NativeRun = { localInputId: string; value: JsonValue; intent: string; failed?: boolean };
type Fixtures = {
  happierGoal?: boolean;
  checks?: readonly JsonValue[];
  rawAgentOutput?: (value: JsonValue) => string;
  agentResult?: JsonValue;
  opinion?: 'agree' | 'disagree' | 'uncertain';
  usage?: number; budget?: number;
  session?: (id: string, input: Parameters<WorkflowStepExecutor>[0]['input']) => JsonValue;
  reply?: (sessionId: string, stepId: string) => SessionMessageReplyOutcomeV1;
  discussionRead?: NonNullable<ActionExecutorDeps['discussionAction']>;
  reviewFailed?: boolean;
  reviewLaunchFailure?: boolean;
  comments?: () => readonly ReviewCommentV1[];
  panelCommentIds?: readonly string[];
  judgeVerdicts?: JsonValue[];
  commentWrite?: (actionId: string, input: unknown) => Promise<unknown>;
  actionsSettings?: ActionsSettingsV1;
  workflowAction?: ActionExecutorDeps['workflowAction'];
  reviewSessionAccess?: (observation: number) => boolean;
};

/** Only native execution/session transports and persistent network reads are faked.
 * Admission, role selection, reference binding, both leaf adapters, Action
 * preparation/completion, loop bookkeeping and result decoding remain real. */
function harness(fixtures: Fixtures = {}) {
  let store = createInMemoryWorkflowCoordinatorStore();
  const snapshots = new Map<string, string>();
  const retainSnapshot = (runId: string, snapshot: Awaited<ReturnType<typeof accepted>>) => snapshots.set(runId,
    serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account', runId }, acceptedSnapshot: snapshot })));
  const keyCensus = (runId: string) => WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: 'account', visibleTeamId: null,
    encryptionMode: 'plain', access: 'owner', ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
    dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] });
  const runOwner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => 'account',
    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    normalizeAbsolutePath: path => path.startsWith('/') ? path : null,
    randomBytes: () => { throw new Error('plain_account_needs_no_keys'); },
    definitions: { get: async () => { throw new Error('unexpected_definition_read'); } },
    storage: { execute: async operation => {
      if (operation.operation === 'invocations.list') {
        const rows = await Promise.all(store.list().filter(row => row.runId === operation.runId)
          .map(row => store.readInvocationBindingRow(row.recordId)));
        const root = await store.readInvocationBindingRow(workflowInvocationKey({ runId: operation.runId, blockId: '$root', scope: [], attempt: 0 }));
        if (root && !rows.some(row => row?.index.id === root.index.id)) rows.unshift(root);
        const parentRecordIds = Array.isArray(operation.parentRecordIds) ? new Set(operation.parentRecordIds.map(String)) : undefined;
        // The storage selection contract: one exact record, one parent's members, one member slot or a batch of parents.
        const selected = rows.flatMap(row => row && (operation.invocationId === undefined || row.index.id === operation.invocationId)
          && (operation.parentRecordId === undefined || row.index.parentRecordId === operation.parentRecordId)
          && (operation.memberOrdinal === undefined || row.index.memberOrdinal === operation.memberOrdinal)
          && (!parentRecordIds || row.index.parentRecordId !== null && parentRecordIds.has(row.index.parentRecordId)) ? [row] : []);
        return { invocations: selected.map(row => row.index), parentRevision: 1,
          ...(operation.progressEnvelopes === true ? { keyCensus: keyCensus(operation.runId), progressEnvelopesByInvocationId: Object.fromEntries(selected.map(row => [
            row.index.id, serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
              binding: { v: 1, purpose: 'invocation_progress', accountId: 'account', runId: row.index.runId,
                recordId: row.index.id, sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
                memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt }, progress: row.progress })),
          ])) } : {}) };
      }
      if (operation.operation === 'invocations.get') {
        const row = await store.readInvocationBindingRow(String(operation.invocationId));
        if (!row || row.index.runId !== operation.runId) throw new Error('unexpected_invocation_read');
        return { invocation: { index: row.index, parentRevision: 1,
          contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'invocation_progress', accountId: 'account', runId: row.index.runId,
              recordId: row.index.id, sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
              memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt }, progress: row.progress })) } };
      }
      const retained = snapshots.get(String(operation.runId));
      if (operation.operation !== 'get' || !retained) throw new Error('unexpected_run_read');
      const runId = String(operation.runId);
      return { run: WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null, ownerAccountId: 'account', visibleTeamId: null,
        origin: { kind: 'direct' }, state: 'running', revision: 1, machineId: workspace.machineId,
        workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
        acceptedEnvelope: retained,
        checkpointEnvelope: null, resultEnvelope: null,
        keyCensus: keyCensus(runId) };
    } },
  });
  const events: string[] = [];
  const nativeRuns = new Map<string, NativeRun>();
  const launches: { sessionId: string | null | undefined; request: Record<string, unknown> }[] = [];
  const notifications: unknown[] = [];
  const goals: unknown[] = [];
  let goalMetadata: Record<string, unknown> = { machineId: 'machine', path: '/repo',
    runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: { definitionId: 'configured-test' } },
    acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'configured-test', title: 'Configured Agent' } };
  const goalControl = (operation: 'get' | 'set', request?: SessionGoalSetRequestV1) => routeSessionGoalControl({
    token: credentials.token, credentials, sessionId: 'origin',
    rawSession: createSessionRecordFixture({ id: 'origin', active: false, machineId: 'machine', path: '/repo', encryptionMode: 'plain' }),
    metadata: goalMetadata, currentMachineId: 'machine', mode: 'plain', ctx: null, operation,
    ...(request ? { request } : {}), callLiveSessionRpc: async () => { throw new Error('inactive Session has no RPC'); },
    // Session persistence is the transport boundary; Goal routing/merge/custody remain real.
    stageWorkStateMutation: async mutation => { goalMetadata = { ...goalMetadata,
      sessionWorkStateV1: mutation.op.kind === 'set' ? mutation.op.value : null }; },
  });
  const removedTriggers: unknown[] = [];
  const reviewReads: string[] = [];
  const sessionTargets: string[] = [];
  const scmRequests: unknown[] = [];
  let checkIndex = 0;
  let sessionStep: Parameters<WorkflowStepExecutor>[0] | undefined;
  const sessionSteps = new Map<string, Parameters<WorkflowStepExecutor>[0]>();
  const sessionInputs: { sessionId: string; stepId: string; text: string }[] = [];
  let enqueueIndex = 0;
  let reviewLaunchRejected = false;
  let sessionAccessObservations = 0;
  const nativeDeps: Partial<ActionExecutorDeps> = {
    ...(fixtures.discussionRead ? { discussionAction: fixtures.discussionRead } : {}),
    resolveSessionReference: async ({ sessionId }) => sessionId && (fixtures.reviewSessionAccess?.(++sessionAccessObservations) ?? true)
      ? { kind: 'unique', address: { serverId: 'home', sessionId } } : { kind: 'none' },
    isActionApprovalRequired: (id, ctx) => isApprovalRequiredByActionsSettings(id,
      fixtures.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), ctx),
    executionRunCheckProtocolV2: async () => ({ ok: true }),
    executionRunStart: async (sessionId, request) => {
      if (request.intent === 'review' && fixtures.reviewLaunchFailure && !reviewLaunchRejected) {
        reviewLaunchRejected = true;
        // The native start boundary returns a typed pre-creation refusal;
        // arbitrary thrown error codes are intentionally normalized upstream.
        return { ok: false, code: 'execution_run_target_unavailable',
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
      }
      const runId = `native-${nativeRuns.size}`;
      launches.push({ sessionId, request });
      let value: JsonValue = 'native result';
      const instructions = typeof request.instructions === 'string' ? request.instructions : '';
      if (request.intent === 'agent') {
        if (fixtures.agentResult !== undefined) {
          value = fixtures.agentResult;
        } else if (instructions.includes('Before this goal') || instructions.includes('Is this change ready')) {
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
      const decoded = fixtures.rawAgentOutput && request.intent === 'agent' ? AgentProfile.onBoundedComplete({
        start: { sessionId: null, runId, callId: `call-${runId}`, sidechainId: `sidechain-${runId}`,
          intent: 'agent', backendId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions, resultContract: ExecutionRunResultContractV1Schema.parse(request.resultContract),
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
          ioMode: 'request_response', startedAtMs: 1 },
        rawText: fixtures.rawAgentOutput(value), finishedAtMs: 2,
      }) : undefined;
      nativeRuns.set(runId, { localInputId: typeof request.localInputId === 'string' ? request.localInputId : '',
        value: decoded ? StrictJsonValueSchema.parse(decoded.toolResultOutput) : value,
        ...(decoded ? { failed: decoded.status === 'failed' } : {}),
        intent: typeof request.intent === 'string' ? request.intent : 'agent' });
      return { runId, callId: `call-${runId}`, sidechainId: `sidechain-${runId}` };
    },
    executionRunGet: async (_sessionId, input) => {
      const run = nativeRuns.get(input.runId);
      if (!run) throw new Error('Missing native run');
      return { run: { runId: input.runId, callId: `call-${input.runId}`, sidechainId: `sidechain-${input.runId}`,
        intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'workspace_write',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', status: 'running', startedAtMs: 1,
        inputTurns: { occurrenceId: `occurrence-${input.runId}`, last: {
          turnId: `turn-${run.localInputId}`, inputIds: [run.localInputId], state: run.failed ? 'failed' : 'completed',
          ...(!run.failed ? { result: { kind: typeof run.value === 'string' ? 'text' : 'json', value: run.value } } : {}),
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
      const request = input as { limit?: number; cursor?: string; sessionId?: string };
      if (request.sessionId) reviewReads.push(request.sessionId);
      const comments = fixtures.comments?.() ?? [];
      const offset = request.cursor ? Number(request.cursor) : 0;
      const limit = request.limit ?? 50;
      const items = comments.slice(offset, offset + limit);
      events.push('comments'); return { items, cursor: offset + limit < comments.length ? String(offset + limit) : null };
    },
    notificationsNotifyMe: async (input) => { notifications.push(input); return { attemptedChannels: 1, deliveredChannels: 1 }; },
    sessionGoalSet: async (input) => {
      goals.push({ sessionId: input.sessionId, status: input.status });
      if (fixtures.happierGoal) {
        expect(input.sessionId).toBe('origin');
        return await goalControl('set', SessionGoalSetRequestV1Schema.parse({
          objective: input.objective, status: input.status, tokenBudget: input.tokenBudget,
        }));
      }
      return { ok: true };
    },
    workflowAction: async args => {
      if (args.actionId === 'workflow.run.get' || args.actionId === 'workflow.run.invocations.get'
        || args.actionId === 'workflow.run.invocations.list') {
        return runOwner.execute(args);
      }
      if (fixtures.workflowAction) return fixtures.workflowAction(args);
      const { actionId, input } = args;
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
    surface: 'agent', serverId: 'home', authority: 'account_automation', callerPermissionMode: params.authorization.admittedPermissionCeiling,
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
      const sessionId = params.execution.conversation?.kind === 'existing_session' ? params.execution.conversation.sessionId : 'origin';
      sessionTargets.push(sessionId);
      sessionSteps.set(sessionId, params);
      return { kind: 'workflow_session_conversation', existing: { sessionId, ...workspace },
        ...(params.execution.conversation?.kind === 'origin_session' ? { inputPath: 'origin_session' as const } : {}) };
    },

    materializeConversation: async (params) => ({ sessionId: params.existing?.sessionId ?? 'origin', machineAdmissionTransport: async () => ({ status: 'accepted', localId: 'native-input' }) }),
    sessionInput: { enqueue: async () => ({ status: 'accepted', localId: `pending-${enqueueIndex++}` }),
      observe: async (request) => {
        const currentStep = sessionSteps.get(request.sessionId) ?? sessionStep;
        if (!currentStep) throw new Error('Missing native session input');
        await request.onInputMaterialized?.(1);
        const step = currentStep;
        sessionInputs.push({ sessionId: request.sessionId, stepId: step.step.id, text: step.input.text });
        events.push(step.step.id);
        const value = fixtures.session?.(step.step.id, step.input) ?? 'session finished';
        const replyOutcome = fixtures.reply?.(request.sessionId, step.step.id);
        return { ok: true, sessionId: request.sessionId, localId: request.localId,
          ...(replyOutcome ? { replyOutcome } : {}),
          result: replyOutcome && replyOutcome.kind !== 'answer' ? { kind: 'fulfilled', outcome: replyOutcome }
            : { kind: 'final_text', text: typeof value === 'string' ? value : JSON.stringify(value) } };
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
  let goalInitialized = false;
  return { get store() { return store; }, events, launches, notifications, goals, removedTriggers, scmRequests, reviewReads, sessionTargets, sessionInputs, readGoal: () => goalControl('get'),
    runAccepted: async (snapshot: Awaited<ReturnType<typeof accepted>>, origin = true, runId = 'builtin-run') => {
      retainSnapshot(runId, snapshot);
      return coordinator().run({ ...snapshot, runId, ...(origin ? { originSessionId: 'origin' } : {}) });
    },
    run: async (definition: WorkflowDefinitionV1, evidence: Record<string, WorkflowJsonValue> = {}, origin = true, runId = 'builtin-run') => {
      store = createInMemoryWorkflowCoordinatorStore();
      if (fixtures.happierGoal && !goalInitialized) {
        await goalControl('set', { objective: 'Finish the objective' });
        goalInitialized = true;
      }
      const snapshot = await accepted(definition, evidence, origin, fixtures.discussionRead !== undefined);
      retainSnapshot(runId, snapshot);
      const outcome = await coordinator().run({ ...snapshot, runId, ...(origin ? { originSessionId: 'origin' } : {}) });
      if (outcome.state === 'failed') throw new Error(JSON.stringify({ outcome,
        failures: store.list().filter((row) => row.lifecycle === 'failed').map((row) => ({ blockId: row.blockId, reason: row.reason,
          ...(row.validationIssues ? { validationIssues: row.validationIssues } : {}) })), events }));
      return outcome;
    },
  };
}

describe('built-ins through accepted materialization and native leaf adapters', () => {
  const participants = ['one', 'two'].map(sessionId => ({ kind: 'session' as const, session: { serverId: 'home', sessionId } }));
  it('runs Fresh opinions independently and skips synthesis when every participant passes', async () => {
    const h = harness({ reply: () => ({ kind: 'pass' }) });
    expect(await h.run(builtin('fresh-opinions'), { question: 'Compare', participants, synthesis: true })).toMatchObject({ state: 'succeeded' });
    expect(h.sessionInputs.map(input => input.stepId)).toEqual(['answer', 'answer']);
    expect(h.sessionInputs.every(input => !input.text.includes('session finished'))).toBe(true);
  });
  it('synthesizes successful and failed Fresh opinions without retrying the failed participant', async () => {
    const h = harness({ session: id => id === 'answer' ? 'FAST-ANSWER' : 'SYNTHESIS',
      reply: (sessionId, stepId) => sessionId === 'two' && stepId === 'answer' ? { kind: 'failed' }
        : { kind: 'answer', result: { sessionId, messageId: 'answer' } } });
    expect(await h.run(builtin('fresh-opinions'), { question: 'Compare', participants, synthesis: true }))
      .toMatchObject({ state: 'succeeded', completedWithFailures: true, finalOutput: { allPassed: false,
        outcomeReferences: expect.arrayContaining([expect.objectContaining({ kind: 'failed' }), expect.objectContaining({ kind: 'answer', result: 'FAST-ANSWER' })]) } });
    expect(h.sessionInputs.filter(input => input.stepId === 'answer')).toHaveLength(2);
    expect(h.sessionInputs.filter(input => input.stepId === 'answer').every(input => !input.text.includes('FAST-ANSWER'))).toBe(true);
    expect(h.sessionInputs.find(input => input.stepId === 'synthesis')?.text).toContain('FAST-ANSWER');
    expect(h.sessionInputs.find(input => input.stepId === 'synthesis')?.text).toContain('failed');
  });
  it('reviews the exact first answer through a typed reviewer and does not review a pass', async () => {
    const h = harness({ session: id => id === 'answer' ? 'EXACT-FIRST-ANSWER' : 'reviewed' });
    expect(await h.run(builtin('answer-and-review'), { question: 'Compare', answerer: participants[0]!, reviewer: participants[1]! }))
      .toMatchObject({ state: 'succeeded' });
    expect(h.sessionInputs.find(input => input.stepId === 'review')?.text).toContain('EXACT-FIRST-ANSWER');
    expect(h.sessionInputs.find(input => input.stepId === 'review')?.text).toContain('<happier_discussion_context>');
    const pass = harness({ reply: () => ({ kind: 'pass' }) });
    await pass.run(builtin('answer-and-review'), { question: 'Compare', answerer: participants[0]!, reviewer: participants[1]! });
    expect(pass.sessionInputs.map(input => input.stepId)).toEqual(['answer']);
  });
  it('ends Debate on typed all-pass before another round or digest call', async () => {
    const h = harness({ reply: () => ({ kind: 'pass' }) });
    expect(await h.run(builtin('debate'), { question: 'Compare', participants, rounds: 4 })).toMatchObject({ state: 'succeeded' });
    expect(h.sessionInputs).toHaveLength(2);
    expect(h.sessionInputs.every(input => input.stepId === 'reply')).toBe(true);
  });
  it('ends a Debate with no eligible speakers without treating a failure as pass or retrying it', async () => {
    const h = harness({ reply: sessionId => sessionId === 'two' ? { kind: 'failed' } : { kind: 'pass' } });
    expect(await h.run(builtin('debate'), { question: 'Compare', participants, rounds: 3 }))
      .toMatchObject({ state: 'succeeded', completedWithFailures: true });
    expect(h.sessionInputs).toHaveLength(2);
    expect(h.store.list().find(row => row.blockId === 'outcomes')?.result).toMatchObject({ allPassed: false, hasNext: false });
  });
  it('uses the explicitly selected Debate digest author through the ordinary participant owner', async () => {
    const h = harness({ reply: sessionId => ({ kind: 'answer', result: { sessionId, messageId: 'answer' } }) });
    const digestAuthor = { kind: 'session', session: { serverId: 'home', sessionId: 'scribe' } };
    expect(await h.run(builtin('debate'), { question: 'Compare', participants, rounds: 1, digestAuthor })).toMatchObject({ state: 'succeeded' });
    expect(h.sessionInputs.find(input => input.stepId.includes('digest'))?.sessionId).toBe('scribe');
  });
  it('gives Debate round two the previous digest and removes an unaddressed passer', async () => {
    const h = harness({ reply: sessionId => sessionId === 'two' ? { kind: 'pass' }
      : { kind: 'answer', result: { sessionId, messageId: 'answer' } },
      session: id => id.endsWith('digest') ? 'PREVIOUS-ROUND-DIGEST' : 'answer' });
    expect(await h.run(builtin('debate'), { question: 'Compare', participants, rounds: 2 })).toMatchObject({ state: 'succeeded' });
    const later = h.sessionInputs.filter(input => input.stepId === 'reply').slice(2);
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ sessionId: 'one' });
    expect(later[0]?.text).toContain('PREVIOUS-ROUND-DIGEST');
  });
  it('runs Panel planners as typed participants and refuses contradictory engine choices', async () => {
    const h = harness();
    expect(await h.run(builtin('plan-with-a-panel'), { request: 'Plan it', participants })).toMatchObject({ state: 'waiting_for_review' });
    expect(h.sessionInputs.filter(input => input.stepId === 'participant-plan')).toHaveLength(2);
    expect(h.launches.find(launch => String(launch.request.instructions).includes('Produce the requested plan'))?.request.instructions)
      .toContain('"sessionId":"one"');
    expect(h.events).not.toContain('plan');
    await expect(h.run(builtin('plan-with-a-panel'), { request: 'Plan it', participants, engines: [otherEngine] })).rejects.toThrow('invalid_input');
  });
  it.each([false, true])('captures human context once per Debate round; only explicit addressing restores a passer (watcher: %s)', async watcher => {
    let reads = 0;
    const h = harness({ reply: sessionId => sessionId === 'two' ? { kind: 'pass' }
      : { kind: 'answer', result: { sessionId, messageId: 'answer' } }, session: id => id.endsWith('digest') ? 'DIGEST' : 'PEER-ANSWER',
      discussionRead: async args => {
        if (args.actionId !== 'discussion.read') throw new Error('unexpected_discussion_action');
        const before = args.input.beforeSeq;
        const initial = reads++ === 0;
        const seq = before === undefined ? 4 : 3;
        return DiscussionReadResultV1Schema.parse({ v: 1, serverId: 'home', discussionId: 'discussion', messageSeq: initial ? 2 : 4,
          hasMoreOlder: !initial && before === undefined, incomplete: false, messages: initial ? [] : [{
            id: `human-${seq}`, discussionId: 'discussion', localId: null, seq, authorAccountId: null, accountActor: null, producerV1: null,
            createdAt: seq, mentionedAccountIds: [], content: { v: 1, parts: [{ t: 'text', text: seq === 4 ? 'NEW-HUMAN-CONTEXT' : 'READDRESS-TWO' }] },
            addressingV1: { throughSeq: seq, participantSessionIds: seq === 3 ? ['two'] : [], ...(watcher && seq === 3 ? { watcherSessionIds: ['two'] } : {}) },
            messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: `human-${seq}` },
          }] });
      } });
    expect(await h.run(builtin('debate'), { question: 'Compare', participants, rounds: 2 })).toMatchObject({ state: 'succeeded' });
    const turns = h.sessionInputs.filter(input => input.stepId === 'reply');
    expect(turns).toHaveLength(watcher ? 3 : 4);
    expect(turns.slice(0, 2).every(input => !input.text.includes('NEW-HUMAN-CONTEXT') && !input.text.includes('PEER-ANSWER'))).toBe(true);
    expect(turns.slice(2).every(input => input.text.includes('NEW-HUMAN-CONTEXT') && input.text.includes('READDRESS-TWO'))).toBe(true);
    expect(reads).toBe(3);
  });
  it('refuses a foreign-Home Debate context page before any participant turn', async () => {
    const h = harness({ discussionRead: async () => DiscussionReadResultV1Schema.parse({
      v: 1, serverId: 'foreign-home', discussionId: 'discussion', messageSeq: 2, hasMoreOlder: false, incomplete: false, messages: [],
    }) });
    await expect(h.run(builtin('debate'), { question: 'Compare', participants, rounds: 2 })).rejects.toThrow('content_unavailable');
    expect(h.sessionInputs).toHaveLength(0);
  });
  it('dispatches input-bound scalar engines and replays the accepted selections after authored defaults change', async () => {
    const alternateTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const choices = {
      answerer: { agentTarget, modelSelection: { v: 1 as const, updatedAt: 0,
        ref: { agentTargetKey: engine, providerConnectionId: null, modelId: 'answer-model' } } },
      reviewer: { agentTarget: alternateTarget, modelSelection: { v: 1 as const, updatedAt: 0,
        ref: { agentTargetKey: otherEngine, providerConnectionId: null, modelId: 'review-model' } } },
    };
    const definition: WorkflowDefinitionV1 = { version: 1,
      inputs: [{ name: 'choices', valueType: 'json', required: true }],
      defaults: { agentTarget: alternateTarget }, blocks: ['answerer', 'reviewer'].map((name): WorkflowStep => ({
        kind: 'step', id: name, document: { text: `Ask ${name}`, references: [], attachments: [] }, input: [], result: { kind: 'text' },
        execution: { engine: { kind: 'input', name: 'choices', path: [name] }, executionTarget: { kind: 'detached_run' },
          conversation: { kind: 'fresh' }, permissionMode: 'read-only' },
      })) };
    const snapshot = await accepted(definition, { choices });
    // Mutable authoring data is not restart authority. Each coordinator instance
    // consumes the admitted snapshot while the native transport keeps its runs.
    choices.answerer.modelSelection.ref.modelId = 'changed-after-admission';
    definition.defaults.agentTarget = agentTarget;
    const h = harness({ agentResult: 'An independent answer' });
    expect(await h.runAccepted(snapshot)).toMatchObject({ state: 'succeeded' });
    expect(h.launches.map(({ request, sessionId }) => ({ sessionId, target: request.backendTarget,
      model: request.modelId }))).toEqual([
      { sessionId: null, target: agentTarget, model: 'answer-model' },
      { sessionId: null, target: alternateTarget, model: 'review-model' },
    ]);
    const executionIds = h.store.list().filter(row => row.execution).map(row => row.recordId);
    expect(await h.runAccepted(snapshot)).toMatchObject({ state: 'succeeded' });
    expect(h.store.list().filter(row => row.execution).map(row => row.recordId)).toEqual(executionIds);
    expect(h.launches).toHaveLength(2);
  });
  it('dispatches every item-bound engine to its own native target through the accepted loop binding', async () => {
    const alternateTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const definition: WorkflowDefinitionV1 = { version: 1,
      inputs: [{ name: 'engines', valueType: 'json', required: true }], defaults: { agentTarget },
      blocks: [{ kind: 'loop', id: 'opinions', repetition: { kind: 'items', items: { kind: 'input', name: 'engines' },
        execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [{
        kind: 'step', id: 'opinion', document: { text: 'Give an independent opinion', references: [], attachments: [] },
        input: [], result: { kind: 'text' }, execution: { engine: { kind: 'item', field: 'value' },
          executionTarget: { kind: 'detached_run' }, conversation: { kind: 'fresh' }, permissionMode: 'read-only' },
      }] }] };
    const h = harness({ agentResult: 'An independent opinion' });
    expect(await h.run(definition, { engines: [{ agentTarget }, { agentTarget: alternateTarget }] }))
      .toMatchObject({ state: 'succeeded' });
    expect(h.launches.map(({ request, sessionId }) => ({ sessionId, target: request.backendTarget })))
      .toEqual(expect.arrayContaining([{ sessionId: null, target: agentTarget }, { sessionId: null, target: alternateTarget }]));
    expect(h.launches).toHaveLength(2);
    expect(h.store.list().filter(row => row.blockId === 'opinion').map(row => row.lifecycle)).toEqual(['completed', 'completed']);
  });
  it('FIX80 settles both done occurrences while removing only their claim-bound firing trigger once', async () => {
    // Only Home persistence/authorized Run reads are substituted. The trigger
    // owner, family registration, executor, Goal router and coordinator are real.
    const rows = new Map<string, AutomationDefinitionDetail>();
    const removals: string[] = [];
    const claims = new Map<string, { sessionId: string; triggerId: string; automationId: string }>();
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected persistence operation'); };
    const deps: WorkflowTriggerActionsDependencies = {
      newId: (kind) => kind === 'automation' ? 'firing-automation' : 'firing-trigger',
      resolveWorkflow: async () => builtin('keep-going'),
      resolveSession: async () => ({ project: { machineId: workspace.machineId, directory: workspace.directory }, nativeGoalOwner: false }),
      resolveRunTrigger: async (runId) => claims.get(runId) ?? null,
      openContext: async (row) => row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain'
        ? row.executionRecipe.workflow.v : null,
      sealContext: async ({ templateVersion, context }) => ({ v: 2, templateVersion,
        workflow: { t: 'plain', v: context }, triggerEvidence: null }),
      automations: {
        list: async () => ({ automations: [...rows.values()], nextCursor: null }),
        listDetails: async () => ({ automations: [...rows.values()], nextCursor: null }),
        get: async (id) => rows.get(id) ?? null,
        create: async (input) => {
          const row: AutomationDefinitionDetail = { id: input.automationId, name: input.name, description: null,
            enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1,
            lastRunAt: null, createdAt: 1, updatedAt: 1, workflowDefinitionId: input.workflowDefinitionId,
            scopeSessionId: input.scopeSessionId, executionRecipe: input.executionRecipe,
            assignments: [{ machineId: workspace.machineId, enabled: true, priority: 0, updatedAt: 1 }],
            triggers: input.triggers.map(({ triggerId, trigger }) => AutomationTriggerDetailSchema.parse({ ...trigger,
              id: triggerId, revision: 0, createdAt: 1, updatedAt: 1, remainingOccurrences: 1,
              status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null })),
          };
          rows.set(row.id, row); return row;
        },
        reconcile: async (id, input, _current, beforeWrite) => {
          await beforeWrite?.();
          const row = rows.get(id);
          if (!row) throw new Error('Missing Automation');
          removals.push(...input.removedTriggers.map((item) => item.triggerId));
          const next = { ...row, triggers: row.triggers.filter((trigger) =>
            !input.removedTriggers.some((item) => item.triggerId === trigger.id)) };
          rows.set(id, next); return next;
        },
        delete: unexpected,
      },
    };
    const triggers = createWorkflowTriggerActions(deps);
    const added = await triggers.sessionAdd({ sessionId: 'origin', target: { kind: 'workflow', ref: 'builtin:keep-going' },
      trigger: { kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'origin', events: ['parentTurnCompleted'],
        policy: { kind: 'everyMatch' } } });
    if (!added.triggerId) throw new Error('Missing firing trigger');
    const firing = { sessionId: 'origin', triggerId: added.triggerId, automationId: added.set.automationId };
    claims.set('first-occurrence', firing);
    claims.set('coalesced-occurrence', firing);
    const definitions = createWorkflowDefinitionActions({ artifactStore: { list: async () => ({ items: [] }), read: async () => null,
      create: unexpected, update: unexpected, delete: unexpected }, encodeListCursor: (row) => row.artifactId,
      assertDefinitionWriteAllowed: async () => undefined });
    const workflowAction = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, triggers,
      runs: { execute: unexpected } });
    const h = harness({ happierGoal: true, checks: [{ verdict: 'done' }, { verdict: 'done' }, { verdict: 'done' }], workflowAction });
    const evidence = { triggerId: firing.triggerId };
    expect(await h.run(builtin('keep-going'), evidence, true, 'first-occurrence')).toMatchObject({ state: 'succeeded' });
    const completedGoal = { nativeGoalOwner: false, workState: { primaryItemId: 'goal:derived:happier:session-goal',
      items: [{ id: 'goal:derived:happier:session-goal', origin: 'happier', title: 'Finish the objective', status: 'complete' }] } };
    expect(await h.readGoal()).toMatchObject(completedGoal);
    expect(await h.run(builtin('keep-going'), evidence, true, 'coalesced-occurrence')).toMatchObject({ state: 'succeeded' });
    // Goal writes may refresh updatedAt; completion succeeds on the same Goal
    // without reopening it or replacing its objective.
    expect(await h.readGoal()).toMatchObject(completedGoal);
    expect(h.goals).toEqual([{ sessionId: 'origin', status: 'complete' }, { sessionId: 'origin', status: 'complete' }]);
    expect(removals).toEqual([firing.triggerId]);
    expect(rows.get(firing.automationId)?.triggers).toEqual([]);
    // A caller-supplied id without the corresponding claim must still fail,
    // even after the legitimate trigger has gone.
    await expect(h.run(builtin('keep-going'), { triggerId: 'unrelated-trigger' }, true, 'coalesced-occurrence'))
      .rejects.toThrow('run_access_denied');
    expect(removals).toEqual([firing.triggerId]);
  });
  it('FIX75 completes the Happier-owned configured-Agent Goal before detaching its firing trigger', async () => {
    const h = harness({ happierGoal: true, checks: [{ verdict: 'progress' }, { verdict: 'done' }] });
    expect(await h.run(builtin('keep-going'), { triggerId: 'firing-trigger' })).toMatchObject({ state: 'succeeded' });
    await expect(h.readGoal()).resolves.toMatchObject({ nativeGoalOwner: false,
      workState: { items: [expect.objectContaining({ origin: 'happier', title: 'Finish the objective', status: 'complete' })] } });
    expect(h.removedTriggers).toEqual([{ sessionId: 'origin', triggerId: 'firing-trigger' }]);
    expect(h.events).toEqual(['check', 'continue', 'check', 'detach']);
  });
  it.each(['keep-going', 'review-and-converge'])('refuses %s without an origin before native effects', async (id) => {
    const h = harness();
    await expect(h.run(builtin(id), { engines: [engine] }, false)).rejects.toThrow('invalid_input');
    expect(h.launches).toEqual([]); expect(h.goals).toEqual([]);
  });
  it('uses the admitted reviewSession for real review Actions, comment reads and verify input instead of the origin', async () => {
    const h = harness({ checks: [{ verdict: 'continue' }, { verdict: 'converged' }], session: (id) => {
      expect(id).toBe('verify'); return 'verified';
    } });
    expect(await h.run(builtin('review-and-converge'), {
      engines: [engine], reviewSession: { serverId: 'home', sessionId: 'review-target' },
    })).toMatchObject({ state: 'succeeded', finalOutput: { kind: 'stop_condition', arm: 0 } });
    expect(h.launches.filter(({ request }) => request.intent === 'review').map(({ sessionId }) => sessionId))
      .toEqual(['review-target', 'review-target']);
    expect(h.reviewReads).toEqual(['review-target', 'review-target', 'review-target', 'review-target']);
    expect(h.sessionTargets).toEqual(['review-target']);
  });
  it('refuses a different Action Session operand even when its Workflow admits an accessible reviewSession', async () => {
    const h = harness();
    const definition: WorkflowDefinitionV1 = { version: 1, defaults: {},
      inputs: [{ name: 'reviewSession', valueType: 'json', required: true, inputType: { hostType: 'session' } }],
      blocks: [{ kind: 'action', id: 'read', actionId: 'reviews.comments.list',
        input: { sessionId: { kind: 'literal', value: 'other-session' } } }] };
    await expect(h.run(definition, { reviewSession: { serverId: 'home', sessionId: 'review-target' } }))
      .rejects.toThrow('unsupported_action');
    expect(h.reviewReads).toEqual([]);
    expect(h.launches).toEqual([]);
  });
  it('rechecks admitted reviewSession access after preparation and refuses revocation before comment transport', async () => {
    const h = harness({ reviewSessionAccess: observation => observation === 1 });
    const definition: WorkflowDefinitionV1 = { version: 1, defaults: {},
      inputs: [{ name: 'reviewSession', valueType: 'json', required: true, inputType: { hostType: 'session' } }],
      blocks: [{ kind: 'action', id: 'read', actionId: 'reviews.comments.list',
        input: { sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] } } }] };
    await expect(h.run(definition, { reviewSession: { serverId: 'home', sessionId: 'review-target' } }))
      .rejects.toThrow('unsupported_action');
    expect(h.launches).toEqual([]);
    expect(h.reviewReads).toEqual([]);
    expect(h.sessionTargets).toEqual([]);
  });
  it.each(['raw', 'fenced'])('checks first with %s Judge output, continues only from round two, completes the origin goal, and returns its recorded stop arm', async (encoding) => {
    const h = harness({ checks: [{ verdict: 'progress' }, { verdict: 'done' }],
      rawAgentOutput: (value) => encoding === 'fenced' ? `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` : JSON.stringify(value) });
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
    expect(h.store.list().map(({ blockKind, lifecycle, reason }) => ({ blockKind, lifecycle, reason })))
      .toContainEqual({ blockKind: 'action', lifecycle: 'failed', reason: 'execution_run_target_unavailable' });
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
  it.each(['uphold', 'dismiss'] as const)('retains default human confirmation for Judge %s before the native mutation', async verdict => {
    const h = harness({ judgeVerdicts: [{ commentId: 'finding-1', verdict, reason: 'Evidence',
      expectedServerRevision: 2, expectedState: 'open', clientMutationId: 'judge-r2', projectId: 'project' }],
      checks: [{ verdict: 'continue' }],
      commentWrite: async () => { throw new Error('Unapproved comment mutation'); },
    });
    await expect(h.run(builtin('review-and-converge'), { engines: [engine], useJudge: true, maxRounds: 1 }))
      .resolves.toMatchObject({ state: 'succeeded', completedWithFailures: true, finalOutput: { kind: 'exhausted', rounds: 1 } });
    expect(h.events).not.toContain(verdict === 'uphold' ? 'reviews.comments.setDisposition' : 'reviews.comments.transition');
    expect(h.events).toContain('check');
    expect(h.store.list().find((row) => row.blockId === `${verdict}-project`))
      .toMatchObject({ lifecycle: 'failed', reason: 'approvals_not_supported' });
  });
  it.each([false, true])('plans with two detached engines and pauses synthesis (origin: %s)', async (origin) => {
    const h = harness();
    const result = await h.run(builtin('plan-with-a-panel'), { request: 'Plan it', engines: [engine, otherEngine] }, origin);
    expect(result, JSON.stringify({ result, events: h.events, rows: h.store.list().filter((row) => row.lifecycle === 'failed') })).toMatchObject({ state: 'waiting_for_review' });
    expect(h.launches.every(({ sessionId }) => sessionId === null)).toBe(true);
    expect(h.store.list().filter((row) => row.blockId === 'plan')).toHaveLength(2);
    expect(h.store.list().find((row) => row.blockId === 'synthesis')).toMatchObject({ lifecycle: 'waiting_for_review',
      result: { document: 'A plan' }, resultContract: { kind: 'json' } });
  });
  it('plans with request alone and no manufactured Session or planner leaves', async () => {
    const h = harness();
    expect(await h.run(builtin('plan-with-a-panel'), { request: 'Plan it' }, false)).toMatchObject({ state: 'waiting_for_review' });
    expect(h.events).toEqual(['synthesis']); expect(h.launches[0]?.sessionId).toBeNull();
  });
  it('keeps the previous round context in the held Panel plan through ordinary input materialization', async () => {
    const h = harness();
    const previousRoundContext = { outcomes: [{ status: 'completed', answer: 'prior-plan-sentinel' },
      { status: 'failed', reason: 'previous planner unavailable' }] };
    expect(await h.run(builtin('plan-with-a-panel'), { request: 'Refine it', previousRoundContext }, false))
      .toMatchObject({ state: 'waiting_for_review' });
    expect(h.launches.find(({ request }) => request.intent === 'agent')?.request.instructions)
      .toContain('prior-plan-sentinel');
    expect(h.launches.find(({ request }) => request.intent === 'agent')?.request.instructions)
      .toContain('previous planner unavailable');
    expect(h.store.list().find((row) => row.blockId === 'synthesis'))
      .toMatchObject({ lifecycle: 'waiting_for_review', result: { document: 'A plan' } });
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
