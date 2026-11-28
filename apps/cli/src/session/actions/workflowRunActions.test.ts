import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import {
  API_TOKEN_FULL_GRANT_V1,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  openWorkflowCheckpointStoredEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowFinalResultStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  validateWorkflowDefinition,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1,
  materializeWorkflowAcceptedSnapshotV1,
  type WorkflowRunRecipientCensusResponseV1,
} from '@happier-dev/protocol';

import { createWorkflowRunActionOwner as createRunOwner } from './workflowRunActions';
import { doesWorkflowImmediateEligibleStepTargetSession } from '@/daemon/workflows/coordinator';
import type { WorkflowProgressEnvelopeV1, WorkflowRunInvocationIndexV1, WorkflowWorkspaceProgressV1 } from '@happier-dev/protocol/workflows';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { prepareApprovalRequest } from '@happier-dev/protocol/actions/executor/approvalPreparation';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { DelegateStartInputSchema } from '@happier-dev/protocol/actions/specs/executionRuns';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { WorkflowPluginSourceV1Schema } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';

const definition = {
  version: 1 as const,
  defaults: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
  blocks: ['work'],
};

// Account/session reads and machine catalogs are external host boundaries. The
// real materializer and ORC admission logic remain underneath these opened facts.
function plainRunKeyCensus(runId: string, version = 1): WorkflowRunRecipientCensusResponseV1 {
  // Same plain owner census as workflowRunStorage.testkit: no client keys.
  return { runId, ownerAccountId: 'account-1',
    ownerAccountCurrentness: { mode: 'plain', version, contentKeyFingerprint: null },
    encryptionMode: 'plain', access: 'owner', visibleTeamId: null,
    dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
  };
}

function createWorkflowRunActionOwner(deps: Parameters<typeof createRunOwner>[0]) {
  return createRunOwner({
    resolveRunReportPolicy: async () => ({ preset: 'important' }),
    resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    resolveAgentStartContext: async () => ({
      caller: { kind: 'session', sessionId: 'calling-session', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine-1', directory: '/repo', configuration: {
        agentTarget: definition.defaults.agentTarget, permissionMode: 'default',
      } },
      workDepthLimit: 8, callerPermissionCeiling: 'safe-yolo', roles: {}, ledSubtreeSessionIds: [],
    }),
    ...deps,
    // Complete the genuine storage boundary response shape while preserving
    // each test's stored bytes, rows, explicit census and transport behavior.
    storage: { execute: async (operation, options) => {
      const response = await deps.storage.execute(operation, options);
      if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
      if ((operation.operation === 'get' || operation.operation === 'wait')
        && 'run' in response && response.run && typeof response.run === 'object'
        && 'id' in response.run && typeof response.run.id === 'string') {
        return { ...response, ...('keyCensus' in response ? {} : { keyCensus: plainRunKeyCensus(response.run.id) }) };
      }
      if (operation.operation === 'list' && 'runs' in response && Array.isArray(response.runs)) {
        const keyCensusByRunId = Object.fromEntries(response.runs.flatMap((run: unknown) =>
          run && typeof run === 'object' && 'id' in run && typeof run.id === 'string' ? [[run.id, plainRunKeyCensus(run.id)]] : []));
        return { ...response, ...('keyCensusByRunId' in response ? {} : { keyCensusByRunId }) };
      }
      return response;
    } },
  });
}

const STORED_ROOT_ID = '66666666-6666-4666-8666-666666666666';

/**
 * A recorded leaf is current only below its Run's stored root frame, which
 * every real Run admits first. The root is a genuine stored row beside each
 * test's leaves; the storage boundary stays the caller's.
 */
function withStoredRoot(runId: string, execute: Parameters<typeof createRunOwner>[0]['storage']['execute']): typeof execute {
  const index = { id: STORED_ROOT_ID, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
    contentRevision: '0', lifecycle: 'completed' as const, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: STORED_ROOT_ID,
      sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
      attempt: '0', logicalInvocationRecordId: STORED_ROOT_ID },
  }));
  return async (operation, options) => {
    if (operation.operation === 'invocations.get' && operation.invocationId === STORED_ROOT_ID) {
      return { invocation: { index, contentEnvelope, parentRevision: 0 } };
    }
    const response = await execute(operation, options);
    if (operation.operation !== 'invocations.list' || !response || typeof response !== 'object'
      || !('invocations' in response) || !Array.isArray(response.invocations)) return response;
    return { ...response, invocations: [index, ...response.invocations] };
  };
}

describe('workflow Run Actions', () => {

  it.each(['same-invocation', 'unchanged-replay', 'changed-replay'] as const)(
    'discloses effective child Team sources in parent review before storing exact child consent: %s', async mode => {
    const runId = '72111111-1111-4111-8111-111111111111';
    const child = { actionId: 'subagents.delegate.start' as const, input: DelegateStartInputSchema.parse({
      backendTargetKeys: ['agent:happier.agent.test/test'], instructions: 'Review the code',
      teamCredentialModel: { kind: 'team_credential_provider_model', teamId: 'team', resourceId: 'credential',
        expectedResourceRevision: 3, agentTargetKey: 'agent:happier.agent.test/test', modelId: 'model', deliveryMode: 'brokered' },
    }) };
    const workflowDefinition = {
      version: 1, defaults: {}, inputs: [], blocks: [{ kind: 'action', id: 'spawn', actionId: child.actionId,
        input: Object.fromEntries(Object.entries(child.input).map(([key, value]) => [key, { kind: 'literal', value }])) }],
    };
    const workflow = formatWorkflowDefinitionRefV1({ kind: 'plugin', contribution: { pluginId: 'happier.fixture', localId: 'review' } });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId, source: mode === 'same-invocation'
      ? { kind: 'inline', definition: workflowDefinition } : { kind: 'catalog', workflow } });
    let changed = false;
    const sources = [{ teamId: 'team', resourceId: 'credential', teamName: 'Engineering', accountName: 'Coding account' }];
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home', serverIdentityId: 'home-identity',
      actionCaller: { kind: 'host' as const }, runtimeAccountId: 'account-1',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'workflow.run.start': { approvalRequiredSurfaces: ['cli'] },
      } }),
      actionRequestId: 'parent-request', callerPermissionMode: 'default' as const,
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1',
        project: { machineId: 'machine-1', directory: '/repo' } },
      teamCredentialPresentation: { serverId: 'home', sources },
    };
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine-1', origin: { kind: 'direct' } });
    let materializations = 0;
    const owner = createWorkflowRunActionOwner({ storage, resolveAccountId: async () => 'account-1',
      definitions: { get: async () => { throw new Error('fixture_has_no_saved_artifact_source'); } },
      readPluginWorkflows: () => [WorkflowPluginSourceV1Schema.parse({ workflow, pluginId: 'happier.fixture',
        version: changed ? '2' : '1', title: 'Review',
        definition: changed ? { ...workflowDefinition, blocks: [{ ...workflowDefinition.blocks[0], input: {
          ...workflowDefinition.blocks[0]!.input, teamCredentialModel: { kind: 'literal', value: {
            ...child.input.teamCredentialModel!, resourceId: 'changed-credential' } },
        } }] } : workflowDefinition })],
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
        machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => { materializations++; return { effects: {
        resolveTargetAvailability: async () => true,
        readActionContract: async () => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(child.actionId))),
      } }; },
    });
    const preparation: { value?: Awaited<ReturnType<typeof owner.prepareStartApproval>> } = {};
    let capturedPreview: unknown;
    let storedApproval: ApprovalRequest | null = null;
    const actions = createActionExecutor({
      prepareHostReviewedChildren: async request => {
        if (request.actionId !== 'workflow.run.start') return null;
        preparation.value = await owner.prepareStartApproval({ actionId: request.actionId,
          input: WorkflowRunStartRequestV1Schema.parse(request.input), context: request.context }, {});
        return preparation.value;
      },
      approvalsCreate: async ({ request }) => { capturedPreview = request.preview;
        storedApproval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'parent-approval' }; },
      approvalsGet: async () => storedApproval,
      approvalsUpdate: async ({ request, expectedStatus }) => {
        if (!storedApproval) throw new Error('missing_approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(storedApproval, next, { expectedStatus });
        if (!transition.ok) return transition;
        storedApproval = next;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const initial = await actions.execute('workflow.run.start', input, context);
    if (!initial.ok) throw new Error(JSON.stringify(initial));
    expect(initial).toMatchObject({ ok: true });
    expect(capturedPreview).toMatchObject({ teamCredentialSources: sources });
    const prepared = preparation.value;
    if (!prepared) throw new Error('workflow_not_prepared');
    expect(storage.acceptedEnvelope()).toBeNull();
    const review = await prepareApprovalRequest({ deps: {}, actionId: 'workflow.run.start', input, actionArgs: input,
      context, hostReviewedContent: prepared.approvalPreview });
    expect(review).toMatchObject({ preview: { teamCredentialSources: sources } });
    const approved = { ...context, bypassApprovals: true,
      approvedActionReplay: { artifactId: 'parent-approval', hostReviewedChildren: { children: prepared.children } }, presentUserApproval: {
      artifactId: 'parent-approval', actionId: 'workflow.run.start' as const, requestId: 'parent-request',
      inputDigest: computeActionInputApprovalDigestV1('workflow.run.start', input), decidingAccountId: 'account-1',
    } };
    changed = mode === 'changed-replay';
    const result = mode === 'same-invocation'
      ? await prepared.executeAdmittedAction!({ actionId: 'workflow.run.start', input, context: approved,
        execute: async () => { throw new Error('prepared_run_must_not_materialize_twice'); } })
      : await actions.execute('approval.request.decide', { artifactId: 'parent-approval', decision: 'approve' }, context);
    if (mode === 'changed-replay') {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } } });
      expect(storage.acceptedEnvelope()).toBeNull();
      expect(materializations).toBe(2);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject(mode === 'same-invocation' ? { ok: true, result: { admission: 'created' } }
      : { ok: true, result: { status: 'executed', execution: { ok: true, result: { admission: 'created' } } } });
    expect(materializations).toBe(mode === 'same-invocation' ? 1 : 2);
    const envelope = storage.acceptedEnvelope();
    if (!envelope) throw new Error('accepted_snapshot_not_stored');
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(envelope) });
    if (opened.kind !== 'available') throw new Error('accepted_snapshot_not_readable');
    expect(opened.content.approvedOperation?.steps).toEqual([child]);
    expect(resolveActionApprovalRouting({ actionId: child.actionId, spec: getActionSpec(child.actionId), input: child.input,
      context: { surface: 'agent', authority: 'account_automation' },
      approvedOperation: opened.content.approvedOperation }).required).toBe(false);
  });

  it.each([true, false])('stores exact child consent only with witnessed parent approval: %s', async approved => {
    const runId = '71111111-1111-4111-8111-111111111111';
    const child = { actionId: 'machines.setup.apply' as const,
      input: { homeId: 'home', machineId: 'target', targets: [{
        homeId: 'home', machineId: 'target', desiredRevision: 0, recipePlans: [], sources: [
        { kind: 'accountPresetOpaque', presetId: 'preset', presetRevision: 1, contentEncryptionMode: 'plain' as const },
        { kind: 'direct', setup: { scripts: [{ body: 'echo retained', affects: 'none' }] } },
      ] }] } };
    const input = WorkflowRunStartRequestV1Schema.parse({ runId, executionTarget: { kind: 'session' },
      source: { kind: 'inline', definition: { version: 1, defaults: {}, inputs: [], blocks: [
        { kind: 'action', id: 'setup', actionId: child.actionId,
          input: Object.fromEntries(Object.entries(child.input).map(([key, value]) => [key, { kind: 'literal', value }])) },
      ] } } });
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine-1', origin: { kind: 'direct' } });
    const owner = createWorkflowRunActionOwner({ storage, resolveAccountId: async () => 'account-1',
      definitions: { get: async () => { throw new Error('inline_workflow_has_no_saved_definition'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
        machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
        readActionContract: async () => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(child.actionId))) } }),
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context: {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: 'parent-request', callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
      // The incumbent approval decision is an external boundary in this owner
      // test. The cross-package composed case exercises its real Artifact path.
      ...(approved ? { approvedActionReplay: { artifactId: 'parent-approval' }, presentUserApproval: {
        artifactId: 'parent-approval', actionId: 'workflow.run.start', requestId: 'parent-request',
        inputDigest: computeActionInputApprovalDigestV1('workflow.run.start', input), decidingAccountId: 'account-1',
      } } : {}),
    } })).resolves.toMatchObject({ admission: 'created' });
    const stored = storage.acceptedEnvelope();
    if (!stored) throw new Error('accepted_snapshot_not_stored');
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(stored) });
    if (opened.kind !== 'available') throw new Error('accepted_snapshot_not_readable');
    if (approved) expect(opened.content.approvedOperation).toEqual({ parent: { actionId: 'workflow.run.start', input },
      approvedBy: { accountId: 'account-1' }, steps: [child] });
    else expect(opened.content.approvedOperation).toBeUndefined();
  });

  it.each(['present_user', 'agent', 'nested'] as const)('admits a %s built-in through the real Run owner and freezes its catalog source', async (caller) => {
    const runId = '91111111-1111-4111-8111-111111111111';
    let acceptedEnvelope = '';
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1',
      storage: { execute: async (operation) => {
        if (operation.operation === 'get') throw Object.assign(new Error('not found'), { response: { status: 404 } });
        if (operation.operation === 'admit') {
          if (typeof operation.acceptedEnvelope !== 'string') throw new Error('Expected accepted snapshot envelope');
          acceptedEnvelope = operation.acceptedEnvelope;
          return { kind: 'created', run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
            attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
            id: runId, origin: operation.origin, state: 'queued', revision: 0,
            machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
            availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          } };
        }
        throw new Error(`unexpected:${operation.operation}`);
      } },
      definitions: { get: async () => { throw new Error('builtin_must_not_read_artifact'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({
        roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.test/test' }, availableAgentTargetKeys: ['agent:happier.agent.test/test'] },
        // The exact machine's Action schemas and readiness are external boundaries.
        effects: { resolveTargetAvailability: async () => true,
          readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
      }),
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId,
      source: caller === 'nested' ? { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'workflow', id: 'nested',
        workflowRef: 'builtin:open-a-pull-request', input: {
          base: { kind: 'literal', value: 'main' }, title: { kind: 'literal', value: 'Change' },
        } }] } } : { kind: 'catalog', workflow: 'builtin:open-a-pull-request' },
      inputs: caller === 'nested' ? {} : { base: 'main', title: 'Change' },
    }, context: {
      surface: caller === 'agent' ? 'agent' : 'ui', authority: caller === 'agent' ? undefined : 'present_user',
      defaultSessionId: 'calling-session', callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
    } })).resolves.toMatchObject({ admission: 'created', run: { id: runId, state: 'queued' } });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope),
    });
    expect(opened).toMatchObject({ kind: 'available', content: caller === 'nested'
      ? { source: { kind: 'inline' }, frozenChildren: { 'builtin:open-a-pull-request': { blocks: expect.arrayContaining([expect.objectContaining({ kind: 'action', id: 'open-pr', actionId: 'scm.pullRequest.openOrReuse' })]) } } }
      : { source: { kind: 'catalog', ref: 'builtin:open-a-pull-request', version: 1 },
        workDepth: caller === 'agent' ? 1 : 0 } });
  });

  const checkpointEnvelope = (runId: string, rootRecordId: string, nextSequence: string) =>
    serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId: 'account-1', runId },
      checkpoint: {
        kind: 'happier.workflow-checkpoint.v1', rootRecordId, nextSequence,
        frontier: { nextBlockOrdinal: Number(nextSequence), paused: false },
      },
    }));

  it('projects the exact final-output producer retained by the encrypted result owner', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const normalizedDefinition = validateWorkflowDefinition({
      ...definition,
      blocks: [{
        kind: 'step', id: 'work',
        document: { text: 'work', references: [], attachments: [] },
        input: [], result: { kind: 'text' },
      }],
      finalOutput: {
        kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [],
      },
    }).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition,
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      },
    }));
    const resultEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'final_result', accountId: 'account-1', runId },
      finalResult: {
        kind: 'happier.workflow-final-result.v1',
        result: { kind: 'text', value: 'done' },
        producerInvocation: { recordId: 'inv-final' },
      },
    }));
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: runId, origin: { kind: 'direct' as const }, state: 'succeeded' as const, revision: 2,
      machineId: 'machine-1', workflowCustodyState: 'settled' as const, originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,
          restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    };
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1',
      storage: { execute: async () => ({ run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope }) },
      definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    await expect(owner.execute({
      actionId: 'workflow.run.get', input: { runId }, context: {},
    })).resolves.toMatchObject({ result: 'done', finalOutputInvocationId: 'inv-final' });
  });

  it('recomputes exact Run usage from every private invocation page after owner restart', async () => {
    const runId = '12111111-1111-4111-8111-111111111111';
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition,
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      },
    }));
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: runId, origin: { kind: 'direct' as const }, state: 'interrupted' as const, revision: 5,
      machineId: 'machine-1', workflowCustodyState: 'settled' as const, originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,
          restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    };
    const invocation = (
      id: string,
      sequence: string,
      lifecycle: 'completed' | 'failed' | 'cancelled' | 'skipped',
      usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined,
      admitted = true,
    ) => {
      const index = {
        id, runId, sequence, parentRecordId: null, memberOrdinal: sequence, attempt: '0', contentRevision: '0', lifecycle,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
      } as const;
      const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain',
        binding: {
          v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
          recordId: id, sequence, parentRecordId: null, memberOrdinal: sequence, attempt: '0',
        },
        progress: {
          kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
          blockKind: 'step', attempt: '0', logicalInvocationRecordId: id,
          ...(admitted ? { execution: { kind: 'session' as const, sessionId: `session-${sequence}`, localInputId: `input-${sequence}` } } : {}),
          ...(usage ? { usage } : {}),
        },
      }));
      return { index, contentEnvelope };
    };
    const completed = invocation('22111111-1111-4111-8111-111111111111', '1', 'completed', { inputTokens: 10, outputTokens: 5, costUsd: 0.1 });
    const failed = invocation('32111111-1111-4111-8111-111111111111', '2', 'failed', { inputTokens: 3, outputTokens: 2, costUsd: 0.03 });
    const cancelled = invocation('42111111-1111-4111-8111-111111111111', '3', 'cancelled', { inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    const skipped = invocation('52111111-1111-4111-8111-111111111111', '4', 'skipped', undefined, false);
    // Storage returns each page's private progress envelopes only in the
    // same-page sidecar requested by the internal flag; per-row detail reads
    // would make usage cost one round trip per invocation.
    const page = (rows: readonly (typeof completed)[], nextCursor?: string) => ({
      invocations: rows.map((row) => row.index),
      progressEnvelopesByInvocationId: Object.fromEntries(rows.map((row) => [row.index.id, row.contentEnvelope])),
      ...(nextCursor ? { nextCursor } : {}),
      parentRevision: 5,
    });
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') return { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null };
      if (operation.operation === 'invocations.list' && operation.progressEnvelopes === true && operation.cursor === undefined) {
        return page([completed], 'page-2');
      }
      if (operation.operation === 'invocations.list' && operation.progressEnvelopes === true && operation.cursor === 'page-2') {
        return page([failed, cancelled, skipped]);
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const deps = {
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true as const, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    };

    await expect(createWorkflowRunActionOwner(deps).execute({
      actionId: 'workflow.run.get', input: { runId }, context: {},
    })).resolves.toMatchObject({ usage: { inputTokens: 14, outputTokens: 8, costUsd: 0.14 } });
    await expect(createWorkflowRunActionOwner(deps).execute({
      actionId: 'workflow.run.get', input: { runId }, context: {},
    })).resolves.toMatchObject({ usage: { inputTokens: 14, outputTokens: 8, costUsd: 0.14 } });
    // O(pages): two storage pages per read, never one detail read per row.
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.list')).toHaveLength(4);
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.get')).toHaveLength(0);

    // The first usage page needs no fact from the exact Run read: both leave in
    // one storage wave, and decryption still waits for the opened Run key.
    execute.mockClear();
    let releaseRun!: () => void;
    const runRead = new Promise<void>(resolve => { releaseRun = resolve; });
    const overlapped = createWorkflowRunActionOwner({ ...deps, storage: { execute: async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') await runRead;
      return await execute(operation);
    } } }).execute({ actionId: 'workflow.run.get', input: { runId }, context: {} });
    await vi.waitFor(() => expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.list')).toBe(true));
    releaseRun();
    await expect(overlapped).resolves.toMatchObject({ usage: { inputTokens: 14, outputTokens: 8, costUsd: 0.14 } });

    // A caller that discards usage never pays for the scan.
    execute.mockClear();
    await expect(createWorkflowRunActionOwner(deps).execute({
      actionId: 'workflow.run.get', input: { runId, includeUsage: false }, context: {},
    })).resolves.not.toHaveProperty('usage');
    expect(execute.mock.calls.map(([operation]) => operation.operation)).toEqual(['get']);
  });

  it('fails Run usage closed when a same-page private progress envelope is missing, malformed or bound to another row', async () => {
    const runId = '14111111-1111-4111-8111-111111111111';
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      },
    }));
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: runId, origin: { kind: 'direct' as const }, state: 'succeeded' as const, revision: 2,
      machineId: 'machine-1', workflowCustodyState: 'settled' as const, originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,
          restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    };
    const [first, second] = ['24111111-1111-4111-8111-111111111111', '34111111-1111-4111-8111-111111111111'].map((id, position) => {
      const sequence = String(position + 1);
      return {
        index: { id, runId, sequence, parentRecordId: null, memberOrdinal: sequence, attempt: '0', contentRevision: '0', lifecycle: 'completed' as const,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' },
        contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
          mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
            recordId: id, sequence, parentRecordId: null, memberOrdinal: sequence, attempt: '0' },
          progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step',
            attempt: '0', logicalInvocationRecordId: id, execution: { kind: 'session', sessionId: `session-${sequence}`, localInputId: `input-${sequence}` },
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } },
        })),
      };
    });
    for (const sidecar of [
      { [first!.index.id]: first!.contentEnvelope },
      { [first!.index.id]: first!.contentEnvelope, [second!.index.id]: 'not-an-envelope' },
      // A genuine envelope replayed onto a neighbouring row fails the exact binding.
      { [first!.index.id]: first!.contentEnvelope, [second!.index.id]: first!.contentEnvelope },
    ]) {
      const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
        if (operation.operation === 'get') return { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null };
        if (operation.operation === 'invocations.list' && operation.progressEnvelopes === true) {
          return { invocations: [first!.index, second!.index], progressEnvelopesByInvocationId: sidecar, parentRevision: 2 };
        }
        throw new Error(`unexpected:${String(operation.operation)}`);
      });
      const owner = createWorkflowRunActionOwner({
        resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      });

      await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} }))
        .rejects.toMatchObject({ code: 'content_unavailable' });
      expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.get')).toBe(false);
    }
  });

  it('keeps private progress envelopes out of the public invocation list request and response', async () => {
    const runId = '15111111-1111-4111-8111-111111111111';
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.list') return { invocations: [], parentRevision: 0 };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    await expect(owner.execute({ actionId: 'workflow.run.invocations.list', input: { runId }, context: {} }))
      .resolves.toEqual({ invocations: [], parentRevision: 0 });
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('progressEnvelopes');
  });

  it('does not turn an unreported invocation usage dimension into zero', async () => {
    const runId = '13111111-1111-4111-8111-111111111111';
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      },
    }));
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: runId, origin: { kind: 'direct' as const }, state: 'succeeded' as const, revision: 2,
      machineId: 'machine-1', workflowCustodyState: 'settled' as const, originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,
          restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    };
    const entries = [
      { id: '23111111-1111-4111-8111-111111111111', sequence: '1', usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 } },
      { id: '33111111-1111-4111-8111-111111111111', sequence: '2', usage: { inputTokens: 6 } },
    ].map(({ id, sequence, usage }) => {
      const index = { id, runId, sequence, parentRecordId: null, memberOrdinal: sequence, attempt: '0', contentRevision: '0', lifecycle: 'completed' as const,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
      const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
          recordId: id, sequence, parentRecordId: null, memberOrdinal: sequence, attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step',
          attempt: '0', logicalInvocationRecordId: id, execution: { kind: 'session', sessionId: `session-${sequence}`, localInputId: `input-${sequence}` }, usage },
      }));
      return { index, contentEnvelope };
    });
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') return { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null };
      if (operation.operation === 'invocations.list' && operation.progressEnvelopes === true) return {
        invocations: entries.map(({ index }) => index),
        progressEnvelopesByInvocationId: Object.fromEntries(entries.map(({ index, contentEnvelope }) => [index.id, contentEnvelope])),
        parentRevision: 2,
      };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    const result = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} });
    expect(result).toMatchObject({ usage: { inputTokens: 10 } });
    expect((result as { usage?: unknown }).usage).not.toHaveProperty('outputTokens');
    expect((result as { usage?: unknown }).usage).not.toHaveProperty('costUsd');
  });

  it.each(['revision_changed', 'source_deleted', 'run_absent', 'different_request'] as const)(
    'rechecks the immutable saved admission once after mutable source resolution: %s', async (scenario) => {
      const runId = '11111111-1111-4111-8111-111111111111';
      const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
      const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
        acceptedSnapshot: {
          startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
          definition: normalizedDefinition, source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null },
          inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
          origin: { kind: 'direct', originSessionId: 'origin-1' },
          authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
        },
      }));
      let reads = 0;
      const storage = { execute: vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
        if (operation.operation !== 'get') throw new Error('must_not_repeat_effect');
        reads += 1;
        if (reads === 1 || scenario === 'run_absent') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        return {
          run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'queued', revision: 0,
            attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
            machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
            availability: { pause: true, resumeBoundary: false,
               restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
          acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null,
        };
      }) };
      const prepareWorkspace = vi.fn();
      const owner = createWorkflowRunActionOwner({
        resolveAccountId: async () => 'account-1', storage,
        definitions: { get: async () => {
          if (scenario === 'source_deleted') throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
          return { definitionId: 'def-1', revision: { headerVersion: 2, bodyVersion: 2 }, definition: normalizedDefinition, metadata: { title: 'Changed' } };
        } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        prepareWorkspace,
      });
      const result = owner.execute({ actionId: 'workflow.run.start', input: {
        runId, source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } },
      }, context: {
        defaultSessionId: scenario === 'different_request' ? 'origin-2' : 'origin-1',
        externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
      } });
      if (scenario === 'run_absent' || scenario === 'different_request') {
        await expect(result).rejects.toMatchObject({ code: 'currentness_conflict' });
      } else {
        await expect(result).resolves.toMatchObject({ admission: 'existing', run: { id: runId } });
      }
      expect(reads).toBe(2);
      expect(prepareWorkspace).not.toHaveBeenCalled();
    },
  );

  it('rejoins an existing caller-id admission before resolving a mutable saved definition', async () => {
    const canonicalProjectDirectory = `${homedir()}/repo`;
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: '11111111-1111-4111-8111-111111111111' },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {},
        definition: normalizedDefinition, metadata: { title: 'Frozen saved title' }, source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null },
        inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-1', directory: canonicalProjectDirectory, checkoutRootPath: canonicalProjectDirectory } },
        origin: { kind: 'direct', originSessionId: 'deleted-session' },
        authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      },
    }));
    const getDefinition = vi.fn(async () => { throw new Error('must_not_resolve_mutable_source'); });
    const execute = vi.fn(async (
      operation: Readonly<Record<string, unknown>>,
      _options?: Readonly<{ signal?: AbortSignal; publisherMachineId?: string }>,
    ) => {
      if (operation.operation === 'invocations.list') {
        return { invocations: [], nextCursor: undefined, parentRevision: 0 };
      }
      if (operation.operation !== 'get') throw new Error('must_not_readmit');
      return {
        run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: '11111111-1111-4111-8111-111111111111', origin: { kind: 'direct' }, state: 'queued', revision: 0,
          attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
          machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
          availability: { pause: true, resumeBoundary: false,
             restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null,
      };
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: getDefinition },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    const result = await owner.execute({ actionId: 'workflow.run.start', input: {
      runId: '11111111-1111-4111-8111-111111111111', source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } },
    }, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '~/repo' } },
      // Rejoin is an authorized read of the already accepted effect. The
      // originating turn and Session may no longer exist, so current transient
      // caller authority must not be substituted for their frozen provenance.
      callerPermissionMode: 'default',
    } });

    expect(result).toMatchObject({ admission: 'existing', run: { id: '11111111-1111-4111-8111-111111111111' } });
    expect(getDefinition).not.toHaveBeenCalled();

    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId: '11111111-1111-4111-8111-111111111111',
      source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } },
      executionTarget: { kind: 'detached_run' },
    }, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '~/repo' } },
      callerPermissionMode: 'default',
    } })).rejects.toMatchObject({ code: 'currentness_conflict' });

    const publicRun = await owner.execute({
      actionId: 'workflow.run.get',
      input: { runId: '11111111-1111-4111-8111-111111111111' },
      context: {},
    });
    expect(publicRun).toMatchObject({
      acceptedContext: {
        source: { kind: 'saved', definitionId: 'def-1' },
        metadata: { title: 'Frozen saved title' },
        inputs: {},
        machineId: 'machine-1',
        executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: canonicalProjectDirectory } },
        origin: { kind: 'direct', originSessionId: 'deleted-session' },
      },
    });
    expect(JSON.stringify(publicRun)).not.toContain('admittedPermissionCeiling');
    expect(JSON.stringify(publicRun)).not.toContain('authorization');
  });

  it('projects frozen private metadata beside structural list rows and preserves unreadable rows', async () => {
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const run = (id: string) => ({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id, origin: { kind: 'direct' as const }, state: 'running' as const, revision: 1,
      machineId: 'machine-1', workflowCustodyState: 'pending' as const, originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false,
          restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const availableId = '11111111-1111-4111-8111-111111111111';
    const unavailableId = '22222222-2222-4222-8222-222222222222';
    const untitledId = '44444444-4444-4444-8444-444444444444';
    const sealAccepted = (runId: string, metadata?: { title: string; description?: string }) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
        acceptedSnapshot: {
          startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {},
          definition: normalizedDefinition, metadata: metadata ?? null,
          source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
          origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        },
      }));
    const acceptedEnvelope = sealAccepted(availableId, { title: 'Frozen inline title', description: 'Frozen summary' });
    const untitledEnvelope = sealAccepted(untitledId);
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'list') return {
        runs: [run(availableId), run(unavailableId), run(untitledId)],
        acceptedEnvelopesByRunId: {
          [availableId]: acceptedEnvelope,
          [unavailableId]: 'not-an-envelope',
          [untitledId]: untitledEnvelope,
        },
        nextCursor: 'next-page',
      };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    const page = await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} });
    expect(page).toMatchObject({
      runs: [{ id: availableId }, { id: unavailableId }, { id: untitledId }],
      metadataByRunId: {
        [availableId]: { kind: 'available', value: { title: 'Frozen inline title', description: 'Frozen summary' } },
        [unavailableId]: { kind: 'unavailable' },
        [untitledId]: { kind: 'available', value: { title: 'work' } },
      },
      nextCursor: 'next-page',
    });
    // A readable snapshot without authored metadata gets its frozen step title.
    expect(page).not.toHaveProperty('acceptedEnvelopesByRunId');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('routes an exact-Run list selection to storage without detail or history reads', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'list') return { runs: [], acceptedEnvelopesByRunId: {} };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    await owner.execute({ actionId: 'workflow.run.list', input: { runId }, context: {} });

    // The exact selection travels inside the existing list request to the
    // lean storage page. Background refresh must never fall back to the
    // history-proportional detail read (`get`) or invocation scans here.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ operation: 'list', request: { runId } });
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'get')).toBe(false);
    expect(execute.mock.calls.some(([operation]) => typeof operation.operation === 'string'
      && operation.operation.startsWith('invocations.'))).toBe(false);
  });

  it('shortens after private projection at the exact Action response-byte boundary', async () => {
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const ids = Array.from({ length: 110 }, (_, index) => `33333333-3333-4333-8333-${index.toString().padStart(12, '0')}`);
    const run = (id: string) => ({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id, origin: { kind: 'direct' as const }, state: 'running' as const, revision: 1,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      machineId: 'machine-1', workflowCustodyState: 'pending' as const, originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false,
         restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const description = 'x'.repeat(240_000);
    const envelopes = new Map(ids.map((runId) => [runId, serializeWorkflowStoredContentEnvelopeV1(
      sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
        acceptedSnapshot: {
          startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {},
          definition: normalizedDefinition, metadata: { title: 'Boundary', description },
          source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
          origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } } },
      }),
    )]));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'list') {
        const request = operation.request as { limit?: number };
        // The storage owner already byte-bounds the private same-page sidecar.
        const selected = request.limit === undefined ? ids.slice(0, 90) : ids.slice(0, request.limit);
        return {
          runs: selected.map(run),
          acceptedEnvelopesByRunId: Object.fromEntries(selected.map((runId) => [runId, envelopes.get(runId)])),
          ...(selected.length < ids.length ? { nextCursor: 'replay-cursor' } : {}),
        };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({ resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });
    const result = await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} });
    expect(result).toMatchObject({ nextCursor: 'replay-cursor' });
    expect((result as { runs: unknown[] }).runs.length).toBeGreaterThan(0);
    expect((result as { runs: unknown[] }).runs.length).toBeLessThan(ids.length);
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(result))
      .toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'list')).toHaveLength(1);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'get')).toBe(false);
  });

  it('rejoins a concurrent semantically identical admission after the storage create loses the race', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const semanticDefinition = {
      ...definition,
      inputs: [{ name: 'options', valueType: 'json' as const, required: false, default: { alpha: 1, beta: { first: true, second: false } } }],
    };
    const normalizedDefinition = validateWorkflowDefinition(semanticDefinition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition,
        source: { kind: 'inline' },
        inputs: { options: { alpha: 1, beta: { first: true, second: false } } },
        machineId: 'machine-1',
        executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }));
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: runId, origin: { kind: 'direct' }, state: 'queued', revision: 0,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false,
         restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const execute = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }))
      .mockRejectedValueOnce(Object.assign(new Error('race'), {
        response: { status: 409, data: { error: 'currentness_conflict' } },
      }))
      .mockResolvedValueOnce({ run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1',
      storage: { execute },
      definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    await expect(owner.execute({
      actionId: 'workflow.run.start',
      input: {
        runId,
        source: { kind: 'inline', definition: {
          ...semanticDefinition,
          inputs: [{ name: 'options', valueType: 'json', required: false, default: { beta: { second: false, first: true }, alpha: 1 } }],
        } },
        inputs: { options: { beta: { second: false, first: true }, alpha: 1 } },
      },
      context: {
        externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
        callerPermissionMode: 'default',
      },
    })).resolves.toEqual({ run, admission: 'existing' });
    expect(execute.mock.calls.map(([operation]) => operation.operation)).toEqual(['get', 'admit', 'get']);
  });

  it('preserves explicit JSON null through admission and same-id rejoin', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const semanticDefinition = {
      ...definition,
      inputs: [
        { name: 'requiredValue', valueType: 'json' as const, required: true },
        { name: 'defaultedValue', valueType: 'json' as const, required: false, default: { fallback: true } },
      ],
    };
    let acceptedEnvelope = '';
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: runId, origin: { kind: 'direct' }, state: 'queued', revision: 0,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false,
         restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    let admitted = false;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get' && !admitted) throw Object.assign(new Error('not found'), { response: { status: 404 } });
      if (operation.operation === 'admit') {
        acceptedEnvelope = String(operation.acceptedEnvelope);
        admitted = true;
        return { kind: 'created', run };
      }
      if (operation.operation === 'get') return { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });
    const request = {
      actionId: 'workflow.run.start' as const,
      input: {
        runId,
        source: { kind: 'inline' as const, definition: semanticDefinition },
        inputs: { requiredValue: null, defaultedValue: null },
      },
      context: { externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } }, callerPermissionMode: 'default' },
    };

    await expect(owner.execute(request)).resolves.toMatchObject({ admission: 'created' });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope)!,
    });
    expect(opened).toMatchObject({
      kind: 'available',
      content: { inputs: { requiredValue: null, defaultedValue: null } },
    });
    await expect(owner.execute(request)).resolves.toEqual({ run, admission: 'existing' });
  });

  it('rejects prompt-only non-Session inline admission before any storage or decryption', async () => {
    const execute = vi.fn();
    const resolveEncryption = vi.fn();
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: vi.fn(),
      storage: { execute },
      definitions: { get: vi.fn() },
      resolveEncryption,
      prepareWorkspace: vi.fn(),
    });

    await expect(owner.execute({
      actionId: 'workflow.run.start',
      input: {
        runId: '22222222-2222-4222-8222-222222222222',
        source: { kind: 'inline', definition: { blocks: ['work'] } },
      },
      context: {
        surface: 'cli',
        externalActionTarget: {
          kind: 'machine',
          machineId: 'machine-1',
          project: { machineId: 'machine-1', directory: '/repo' },
        },
      },
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(execute).not.toHaveBeenCalled();
    expect(resolveEncryption).not.toHaveBeenCalled();
  });

  it('refuses agent start of inline and saved steps whose model override is forbidden', async () => {
    const selected = validateWorkflowDefinition({
      ...definition,
      blocks: [{ kind: 'parallel', id: 'fanout', failurePolicy: 'fail_stop', branches: [{
        id: 'branch', blocks: [{
          kind: 'step', id: 'work', document: { text: 'work', references: [], attachments: [] },
          input: [], result: { kind: 'text' },
          execution: { modelSelection: {
            v: 1,
            ref: { agentTargetKey: 'agent:happier.agent.test/test', providerConnectionId: null, modelId: 'model-1' },
            updatedAt: 1,
          } },
        }],
      }] }],
    }).normalizedDefinition!;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') throw Object.assign(new Error('not found'), { response: { status: 404 } });
      if (operation.operation === 'admit') return { kind: 'created', run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        id: '22222222-2222-4222-8222-222222222222', origin: { kind: 'direct' }, state: 'queued', revision: 0,
        machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false,
           restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      } };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const prepareWorkspace = vi.fn(async () => ({ ok: true as const, workspaceTarget: {
      project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
    } }));
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute },
      definitions: { get: async () => ({ definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, definition: selected, metadata: { title: 'Saved' } }) },
      resolveEncryption: async () => ({ kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace,
    });
    const context = {
      surface: 'agent' as const, callerPermissionMode: 'default',
      sessionAgentSpawnPolicyV1: { v: 1 as const, allowModelOverride: false },
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
    };
    for (const source of [
      { kind: 'inline' as const, definition: { ...selected, inputs: [...selected.inputs], blocks: [...selected.blocks] } },
      { kind: 'saved' as const, definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } },
    ]) {
      await expect(owner.execute({ actionId: 'workflow.run.start', input: {
        runId: '22222222-2222-4222-8222-222222222222', source,
      }, context })).rejects.toMatchObject({ code: 'definition_exceeds_authority', details: {
        cause: { code: 'policy_denied_field' } } });
    }
    expect(execute.mock.calls.every(([operation]) => operation.operation === 'get')).toBe(true);
  });

  it.each(['review.start', 'subagents.plan.start'] as const)('refuses a known forbidden %s fan-out member before storing a Run with a future target', async (actionId) => {
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') throw Object.assign(new Error('not found'), { response: { status: 404 } });
      return { kind: 'created', run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        id: '22222222-2222-4222-8222-222222222222', origin: { kind: 'direct' }, state: 'queued', revision: 0,
        machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      } };
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
        // The Machine's Action schema is an external catalog boundary; binding and admission stay real.
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) } }),
      resolveAgentStartContext: async () => ({
        caller: { kind: 'session', sessionId: 'calling-session', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-1', directory: '/repo', configuration: {
          agentTarget: definition.defaults.agentTarget, permissionMode: 'default',
        } },
        workDepthLimit: 8, callerPermissionCeiling: 'safe-yolo', roles: {}, ledSubtreeSessionIds: [],
        allowLists: { v: 1, allowedRoleIds: null, allowedAgentTargetKeys: ['agent:happier.agent.test/test'] },
      }),
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId: '22222222-2222-4222-8222-222222222222', source: { kind: 'inline', definition: {
        version: 1, defaults: definition.defaults, blocks: [
          { kind: 'step', id: 'choose', document: { text: 'Choose the next engine', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
          { kind: 'action', id: 'fanout', actionId, input: {
            instructions: { kind: 'literal', value: 'Examine the change' },
            [actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys']: { kind: 'list', items: [
              { kind: 'literal', value: 'agent:forbidden.agent/agent' },
              { kind: 'result', producer: { blockId: 'choose', scope: { kind: 'current' } }, path: [] },
            ] },
          } },
        ],
      } },
    }, context: { surface: 'agent', callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
    } })).rejects.toMatchObject({ code: 'definition_exceeds_authority', details: { blockId: 'fanout',
      cause: { code: 'policy_denied_field', field: 'agentTarget' } } });
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'admit')).toBe(false);
  });

  it.each(['yolo', 'read-only'] as const)('admits mixed deferred and concrete leaves through canonical permission checks: %s', async permissionMode => {
    const runId = '22222222-2222-4222-8222-222222222222';
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') throw Object.assign(new Error('not found'), { response: { status: 404 } });
      if (operation.operation !== 'admit') throw new Error(`unexpected:${String(operation.operation)}`);
      return { kind: 'created', run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        id: runId, origin: operation.origin, state: 'queued', revision: 0,
        machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      } };
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
        // Machine catalog IO is external; materialization and admission remain real.
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) } }),
    });
    const starting = owner.execute({ actionId: 'workflow.run.start', input: {
      runId, source: { kind: 'inline', definition: {
        version: 1, defaults: definition.defaults, inputs: [{ name: 'engines', valueType: 'json', required: false }],
        blocks: [
          { kind: 'loop', id: 'planners', onlyWhen: { kind: 'exists', value: { kind: 'input', name: 'engines', path: [] } },
            repetition: { kind: 'items', items: { kind: 'input', name: 'engines', path: [] },
              execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [
              { kind: 'action', id: 'plan', actionId: 'subagents.plan.start', input: {
                instructions: { kind: 'literal', value: 'Plan' },
                backendTargetKeys: { kind: 'list', items: [{ kind: 'item', field: 'value', path: [] }] },
                permissionMode: { kind: 'literal', value: 'read_only' },
              } },
            ] },
          { kind: 'step', id: 'synthesis', execution: { executionTarget: { kind: 'detached_run' }, permissionMode },
            document: { text: 'Synthesize', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ],
      } },
    }, context: { surface: 'agent', callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
    } });
    if (permissionMode === 'yolo') {
      await expect(starting).rejects.toMatchObject({ code: 'definition_exceeds_authority', details: {
        blockId: 'synthesis', cause: { code: 'permission_exceeds_ceiling' } } });
      expect(execute.mock.calls.some(([operation]) => operation.operation === 'admit')).toBe(false);
    } else {
      await expect(starting).resolves.toMatchObject({ admission: 'created', run: { id: runId } });
      expect(execute.mock.calls.some(([operation]) => operation.operation === 'admit')).toBe(true);
    }
  });

  it('semantically validates saved definitions before preparing a run', async () => {
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') throw Object.assign(new Error('not found'), { response: { status: 404 } });
      if (operation.operation === 'admit') return { kind: 'created', run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        id: '22222222-2222-4222-8222-222222222222', origin: { kind: 'direct' }, state: 'queued', revision: 0,
        machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false,
           restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      } };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const prepareWorkspace = vi.fn(async () => ({ ok: true as const, workspaceTarget: {
      project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
    } }));
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute },
      definitions: { get: async () => ({ definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 },
        definition: { version: 1, inputs: [], defaults: definition.defaults, blocks: [{
          kind: 'step', id: 'work', document: { text: 'work', references: [], attachments: [] },
          input: [{ kind: 'result', producer: { blockId: 'missing', scope: { kind: 'current' } }, path: [] }],
          result: { kind: 'text' },
        }] } as never, metadata: { title: 'Saved' } }) },
      resolveEncryption: async () => ({ kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } }), prepareWorkspace,
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId: '22222222-2222-4222-8222-222222222222',
      source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } },
    }, context: { callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } } } }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(prepareWorkspace).not.toHaveBeenCalled();
  });

  it('does not admit an agent workflow above the Account start permission ceiling', async () => {
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') throw Object.assign(new Error('not found'), { response: { status: 404 } });
      if (operation.operation === 'admit') return { kind: 'created', run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        id: '22222222-2222-4222-8222-222222222222', origin: { kind: 'direct' }, state: 'queued', revision: 0,
        machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false,
           restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      } };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true as const, workspaceTarget: { project: {
        machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo',
      } } }),
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId: '22222222-2222-4222-8222-222222222222', source: { kind: 'inline', definition },
    }, context: {
      surface: 'agent', callerPermissionMode: 'yolo',
      sessionAgentSpawnPolicyV1: { v: 1, permissionCeiling: 'read-only' },
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
    } })).rejects.toMatchObject({ code: 'definition_exceeds_authority', details: {
      code: 'definition_exceeds_authority', cause: { code: 'policy_denied_field', field: 'permissionMode' },
    } });
    expect(execute.mock.calls.every(([operation]) => operation.operation === 'get')).toBe(true);
  });

  it('freezes trusted workspace and causal authorization into a direct admission', async () => {
    const attribution = { requestRef: 'accepted-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'release-bot' }, origin: null };
    const admittedRunId = '11111111-1111-4111-8111-111111111111';
    const accountCurrentness = { mode: 'plain' as const, version: 7, contentKeyFingerprint: null };
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: admittedRunId, origin: { kind: 'direct', originSessionId: 'session-1' }, state: 'queued', revision: 0,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: 0,
      availability: { pause: true, resumeBoundary: false,
        restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const execute = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }))
      .mockResolvedValueOnce({ kind: 'created', run });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: accountCurrentness }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    await owner.execute({ actionId: 'workflow.run.start', input: {
      runId: admittedRunId, source: { kind: 'inline', definition: {
        ...definition,
        defaults: { ...definition.defaults, permissionMode: 'read-only' as const },
      } },
      metadata: { title: 'Agent-created frozen title' },
      executionTarget: { kind: 'detached_run' },
      onComplete: { kind: 'originating_session' },
    }, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
      defaultSessionId: 'session-1', callerPermissionMode: 'yolo',
      actionRequestAttributionV1: attribution,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    } });

    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: 'admit', runId: admittedRunId, machineId: 'machine-1',
      origin: { kind: 'direct', originSessionId: 'session-1' },
      accountCurrentness,
      acceptedEnvelope: expect.any(String),
    }), expect.anything());
    const admitted = execute.mock.calls.at(-1)?.[0];
    const envelope = parseWorkflowStoredContentEnvelopeV1(admitted?.acceptedEnvelope);
    expect(envelope).not.toBeNull();
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: admittedRunId },
      envelope: envelope!,
    })).toMatchObject({
      kind: 'available',
      content: {
        metadata: { title: 'Agent-created frozen title' },
        origin: { kind: 'direct', originSessionId: 'session-1', actionRequestAttributionV1: attribution },
        executionTarget: { kind: 'detached_run' },
        resultDelivery: {
          kind: 'originating_session',
          originSessionId: 'session-1',
        },
      },
    });
    // The exact read and its first usage page leave together.
    execute.mockImplementation(async (operation: Readonly<Record<string, unknown>>) => operation.operation === 'get'
      ? { run, acceptedEnvelope: admitted.acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null,
        keyCensus: plainRunKeyCensus(admittedRunId, 7) }
      : { invocations: [], progressEnvelopesByInvocationId: {} });
    const observed = await owner.execute({ actionId: 'workflow.run.get', input: { runId: admittedRunId }, context: {} });
    expect(observed).toMatchObject({ acceptedContext: { origin: { kind: 'direct', originSessionId: 'session-1' } } });
    expect(observed).not.toHaveProperty('acceptedContext.origin.actionRequestAttributionV1');
  });

  it('records boundary Resume through the shared key-free control owner', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation !== 'resume') throw new Error('boundary_resume_must_not_read_private_content');
      return { run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        id: runId, origin: { kind: 'direct' }, state: 'queued', revision: 5,
        machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false,
           restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }, intent: 'resumed' };
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => { throw new Error('run_key_unavailable'); },
      isAcceptedAuthorizationCurrent: async () => { throw new Error('private_authority_is_checked_by_claiming_worker'); },
    });
    await expect(owner.execute({
      actionId: 'workflow.run.resume', input: { mode: 'boundary', runId, expectedRevision: 4 },
      context: { surface: 'ui', authority: 'present_user' },
    })).resolves.toMatchObject({ intent: 'resumed', run: { state: 'queued', revision: 5 } });
    expect(execute.mock.calls.map(([operation]) => operation)).toEqual([{ operation: 'resume', runId, expectedRevision: 4 }]);
  });

  it.each(['lost', 'conflict'] as const)('rejoins the exact retry replacement after committed %s response', async (response) => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const logicalId = '22222222-2222-4222-8222-222222222220';
    const priorId = '22222222-2222-4222-8222-222222222222';
    const normalizedDefinition = validateWorkflowDefinition({
      ...definition,
      blocks: [{
        kind: 'step', id: 'work',
        document: { text: 'work', references: [], attachments: [] },
        input: [], result: { kind: 'text' },
      }],
    }).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' },
        inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }));
    const priorProgressEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: priorId, sequence: '5', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '1' },
      progress: {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step',
        attempt: '1', logicalInvocationRecordId: logicalId, previousAttemptRecordId: logicalId,
        execution: { kind: 'session_ready', sessionId: 'retained-work-session' },
        input: {
          document: { text: 'work', references: [], attachments: [] },
          input: ['recorded context'],
        },
        uncertainPriorEffects: { activity: 'stopped' },
        workspace: { descriptor: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
      },
    }));
    const possiblyActiveProgressEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: priorId, sequence: '5', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '1' },
      progress: {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step',
        attempt: '1', logicalInvocationRecordId: logicalId, previousAttemptRecordId: logicalId,
        execution: { kind: 'session_ready', sessionId: 'retained-work-session' },
        workspace: { descriptor: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
      },
    }));
    const runRow = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'interrupted', revision: 1,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,    restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const priorIndex = { id: priorId, runId, sequence: '5', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '1', contentRevision: '0', lifecycle: 'needs_attention', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const checkpoint = checkpointEnvelope(runId, priorId, '6');
    let committedRetry: Readonly<Record<string, unknown>> | null = null;
    let provenStopped = false;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') return committedRetry
        ? { run: { ...runRow, revision: 2, state: 'queued' }, acceptedEnvelope, checkpointEnvelope: committedRetry.checkpointEnvelope, resultEnvelope: null,
          keyCensus: plainRunKeyCensus(runId, accountCurrentness.version) }
        : { run: runRow, acceptedEnvelope, checkpointEnvelope: checkpoint, resultEnvelope: null,
          keyCensus: plainRunKeyCensus(runId, accountCurrentness.version) };
      if (operation.operation === 'invocations.list') return {
        invocations: [
          { ...priorIndex, ...(committedRetry ? { contentRevision: (BigInt(priorIndex.contentRevision) + 1n).toString() } : {}),
            lifecycle: committedRetry ? 'superseded' : provenStopped ? 'needs_attention' : 'outcome_uncertain' },
          ...(committedRetry ? [{ ...priorIndex, id: committedRetry.newInvocationId, sequence: '6', attempt: '2', lifecycle: 'pending' }] : []),
        ],
      };
      if (operation.operation === 'invocations.get') {
        if (operation.invocationId === priorId) return { invocation: { index: { ...priorIndex,
          ...(committedRetry ? { contentRevision: (BigInt(priorIndex.contentRevision) + 1n).toString() } : {}),
          lifecycle: committedRetry ? 'superseded' : provenStopped ? 'needs_attention' : 'outcome_uncertain' }, contentEnvelope: provenStopped ? priorProgressEnvelope : possiblyActiveProgressEnvelope, parentRevision: committedRetry ? 2 : 1 } };
        if (committedRetry && operation.invocationId === committedRetry.newInvocationId) return { invocation: { index: { ...priorIndex, id: committedRetry.newInvocationId, sequence: '6', attempt: '2', lifecycle: 'pending' }, contentEnvelope: committedRetry.contentEnvelope, parentRevision: 2 } };
        throw Object.assign(new Error('not found'), { response: { status: 404 } });
      }
      if (operation.operation === 'invocations.recover') {
        const recovery = (operation.recoveries as readonly Readonly<Record<string, unknown>>[])[0]!;
        committedRetry = { ...operation, ...recovery };
        if (response === 'conflict') throw Object.assign(new Error('concurrent_commit'), { response: { data: { error: 'conflict' } } });
        throw new Error('response lost after commit');
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const accountCurrentness = { mode: 'plain' as const, version: 8, contentKeyFingerprint: null };
    const resolveEncryption = vi.fn(async () => ({ kind: 'available' as const, witness: accountCurrentness }));
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute: withStoredRoot(runId, execute) }, definitions: { get: vi.fn() },
      resolveEncryption,
      observeRecovery: async () => ({ activity: provenStopped ? 'not_active' : 'unknown', canReattach: false, canContinueConversation: provenStopped }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    await expect(owner.execute({
      actionId: 'workflow.run.invocations.retry',
      input: { runId, expectedRevision: 1, invocation: { recordId: priorId }, causalInvocationIds: [priorId], conversation: 'same_conversation', input: { kind: 'original' }, acknowledgeUncertainPriorEffects: true },
      context: { callerPermissionMode: 'default', actionRequestId: 'retry-request-1' },
    })).rejects.toMatchObject({ code: 'ineligible_state' });
    provenStopped = true;
    await expect(owner.execute({
      actionId: 'workflow.run.invocations.retry',
      input: { runId, expectedRevision: 1, invocation: { recordId: priorId }, causalInvocationIds: [priorId], conversation: 'same_conversation', input: { kind: 'original' } },
      context: { callerPermissionMode: 'default', actionRequestId: 'retry-request-1' },
    })).rejects.toMatchObject({ code: 'workflow_outcome_unresolved' });
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.recover')).toBe(false);

    const result = await owner.execute({
      actionId: 'workflow.run.invocations.retry',
      input: { runId, expectedRevision: 1, invocation: { recordId: priorId }, causalInvocationIds: [priorId], conversation: 'same_conversation', input: { kind: 'original' }, acknowledgeUncertainPriorEffects: true },
      context: { callerPermissionMode: 'default', actionRequestId: 'retry-request-1' },
    });
    expect(result).toMatchObject({ disposition: 'accepted' });
    await expect(owner.execute({
      actionId: 'workflow.run.invocations.retry',
      input: { runId, expectedRevision: 1, invocation: { recordId: priorId }, causalInvocationIds: [priorId], conversation: 'same_conversation', input: { kind: 'original' }, acknowledgeUncertainPriorEffects: true },
      context: { callerPermissionMode: 'default', actionRequestId: 'retry-request-1' },
    })).resolves.toMatchObject({ disposition: 'accepted' });
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.recover')).toHaveLength(1);
    const retryCall = execute.mock.calls.find(([op]) => op.operation === 'invocations.recover')?.[0] as Record<string, unknown>;
    expect(retryCall).toMatchObject({ runId, expectedRevision: 1, accountCurrentness,
      recoveries: [expect.objectContaining({ invocationId: priorId })] });
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.list')).toBe(true);
    const retryRecovery = (retryCall.recoveries as readonly Record<string, unknown>[])[0]!;
    expect(typeof retryRecovery.newInvocationId).toBe('string');
    expect(retryCall).not.toHaveProperty('newSequence');
    const retryEnvelope = parseWorkflowStoredContentEnvelopeV1(retryRecovery.contentEnvelope);
    expect(retryEnvelope).not.toBeNull();
    const opened = openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: String(retryRecovery.newInvocationId), sequence: '6', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '2' },
      envelope: retryEnvelope!,
    });
    expect(opened).toMatchObject({
      kind: 'available',
      content: {
        attempt: '2',
        logicalInvocationRecordId: logicalId,
        previousAttemptRecordId: priorId,
        input: {
          document: { text: 'work', references: [], attachments: [] },
          input: ['recorded context'],
        },
        workspace: { descriptor: { machineId: 'machine-1', directory: '/repo' } },
        recovery: {
          conversation: 'same_conversation',
          input: {
            kind: 'replacement',
            value: {
              document: { text: 'work', references: [], attachments: [] },
              input: ['recorded context'],
            },
          },
        },
      },
    });
    const retryCheckpoint = parseWorkflowStoredContentEnvelopeV1(retryCall.checkpointEnvelope);
    expect(retryCheckpoint).not.toBeNull();
    expect(openWorkflowCheckpointStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId: 'account-1', runId },
      envelope: retryCheckpoint!,
    })).toMatchObject({ kind: 'available', content: { nextSequence: '7' } });
  });

  it.each(['lost', 'conflict'] as const)('rejoins the exact recovery batch after committed %s response', async (response) => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const priorId = '33333333-3333-4333-8333-333333333333';
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' },
        inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }));
    const priorProgressEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: priorId, sequence: '4', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: priorId },
    }));
    const runRow = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'interrupted', revision: 2,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,    restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const priorIndex = { id: priorId, runId, sequence: '4', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'failed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const checkpoint = checkpointEnvelope(runId, priorId, '5');
    let committedRecovery: Readonly<Record<string, unknown>> | null = null;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') return committedRecovery
        ? { run: { ...runRow, revision: 3, state: 'queued' }, acceptedEnvelope, checkpointEnvelope: committedRecovery.checkpointEnvelope, resultEnvelope: null,
          keyCensus: plainRunKeyCensus(runId, accountCurrentness.version) }
        : { run: runRow, acceptedEnvelope, checkpointEnvelope: checkpoint, resultEnvelope: null,
          keyCensus: plainRunKeyCensus(runId, accountCurrentness.version) };
      if (operation.operation === 'invocations.list') return { invocations: [{ ...priorIndex,
        ...(committedRecovery ? { lifecycle: 'superseded', contentRevision: (BigInt(priorIndex.contentRevision) + 1n).toString() } : {}),
      }] };
      if (operation.operation === 'invocations.get') {
        if (operation.invocationId === priorId) return { invocation: { index: { ...priorIndex,
          ...(committedRecovery ? { lifecycle: 'superseded', contentRevision: (BigInt(priorIndex.contentRevision) + 1n).toString() } : {}),
        }, contentEnvelope: priorProgressEnvelope, parentRevision: committedRecovery ? 3 : 2 } };
        const replacement = committedRecovery
          ? (committedRecovery.recoveries as Array<Readonly<Record<string, unknown>>>).find((item) => item.newInvocationId === operation.invocationId)
          : undefined;
        if (replacement) return { invocation: { index: { ...priorIndex, id: replacement.newInvocationId, sequence: '5', attempt: '1', lifecycle: 'pending' }, contentEnvelope: replacement.contentEnvelope, parentRevision: 3 } };
        throw Object.assign(new Error('not found'), { response: { status: 404 } });
      }
      if (operation.operation === 'invocations.recover') {
        committedRecovery = operation;
        if (response === 'conflict') throw Object.assign(new Error('concurrent_commit'), { response: { data: { error: 'conflict' } } });
        throw new Error('response lost after commit');
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const accountCurrentness = { mode: 'plain' as const, version: 9, contentKeyFingerprint: null };
    const resolveEncryption = vi.fn(async () => ({ kind: 'available' as const, witness: accountCurrentness }));
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute: withStoredRoot(runId, execute) }, definitions: { get: vi.fn() },
      resolveEncryption,
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      // Native observation is the process boundary; missing correspondence
      // alone cannot establish that the prior attempt is inactive.
      observeRecovery: async () => ({ activity: 'not_active', canReattach: false, canContinueConversation: false }),
    });

    const result = await owner.execute({
      actionId: 'workflow.run.resume',
      input: { mode: 'recover', runId, expectedRevision: 2, invocations: [{ kind: 'continue', invocation: { recordId: priorId }, conversation: 'fresh_agent', input: { document: { text: 'Retry', references: [], attachments: [] }, input: [] } }] },
      context: { callerPermissionMode: 'default', actionRequestId: 'recover-request-1' },
    });
    expect(result).toMatchObject({ intent: expect.any(String) });
    await expect(owner.execute({
      actionId: 'workflow.run.resume',
      input: { mode: 'recover', runId, expectedRevision: 2, invocations: [{ kind: 'continue', invocation: { recordId: priorId }, conversation: 'fresh_agent', input: { document: { text: 'Retry', references: [], attachments: [] }, input: [] } }] },
      context: { callerPermissionMode: 'default', actionRequestId: 'recover-request-1' },
    })).resolves.toMatchObject({ intent: 'resumed' });
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.recover')).toHaveLength(1);
    const recoverCall = execute.mock.calls.find(([op]) => op.operation === 'invocations.recover')?.[0] as Record<string, unknown>;
    expect(recoverCall).toMatchObject({ runId, expectedRevision: 2, accountCurrentness });
    expect(resolveEncryption).toHaveBeenCalledTimes(3);
    const recoveries = recoverCall.recoveries as Array<Record<string, unknown>>;
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).not.toHaveProperty('newSequence');
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.list')).toBe(true);
  });

  it('lets a narrower authorized reader reattach without creating or superseding an attempt', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const priorId = '33333333-3333-4333-8333-333333333333';
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }));
    const priorProgressEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: priorId, sequence: '4', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: priorId,
        execution: { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' } },
    }));
    const runRow = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'interrupted', revision: 2,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,    restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const priorIndex = { id: priorId, runId, sequence: '4', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') return { run: runRow, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null };
      if (operation.operation === 'invocations.get') return { invocation: { index: priorIndex, contentEnvelope: priorProgressEnvelope, parentRevision: 2 } };
      if (operation.operation === 'invocations.list') return { invocations: [priorIndex] };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute: withStoredRoot(runId, execute) }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      observeRecovery: async () => ({ activity: 'unknown', canReattach: true, canContinueConversation: false }),
      reattachInvocation: async () => {},
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    await expect(owner.execute({
      actionId: 'workflow.run.resume',
      input: { mode: 'recover', runId, expectedRevision: 2, invocations: [{ kind: 'reattach', invocation: { recordId: priorId } }] },
      context: { callerPermissionMode: 'read-only' },
    })).resolves.toMatchObject({ intent: 'recovery_required', run: runRow });
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.recover')).toBe(false);
  });

  it.each(['available', 'throws', 'unknown', 'stopped'] as const)('checks workspace on the accepted Machine before recovery: %s', async (scenario) => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const priorId = '33333333-3333-4333-8333-333333333333';
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
        executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }));
    const workspace = {
      creationIntent: {
        kind: 'git_worktree' as const, sourceDirectory: '/repo', baseRef: 'a'.repeat(40),
        displayName: 'workflow-run-work', branchMode: 'new' as const,
      },
      descriptor: {
        machineId: 'machine-1', directory: '/repo/.worktrees/workflow-run-work',
        checkoutRootPath: '/repo/.worktrees/workflow-run-work',
        checkout: { kind: 'git_worktree' as const, branchName: 'workflow-run-work' },
      },
    };
    const priorProgressEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: priorId, sequence: '4', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '0' },
      progress: {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '0', logicalInvocationRecordId: priorId,
        input: {
          document: { text: 'work', references: [], attachments: [] },
          input: ['recorded context'],
        },
        workspace, reason: { code: 'workspace_unavailable' },
        ...(scenario === 'unknown' || scenario === 'stopped' ? { execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'input-1' } } : {}),
      },
    }));
    const runRow = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: runId, origin: { kind: 'direct' }, state: 'interrupted', revision: 2,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: {
        pause: false, resumeBoundary: false,
         restoreWorkspace: true, cancel: true, inspectExecution: true, disabledReasons: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const priorIndex = {
      id: priorId, runId, sequence: '4', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const effects: string[] = [];
    const execute = vi.fn(async (
      operation: Readonly<Record<string, unknown>>,
      _options?: Readonly<{ signal?: AbortSignal; publisherMachineId?: string }>,
    ) => {
      if (operation.operation === 'get') return {
        run: runRow, acceptedEnvelope, checkpointEnvelope: checkpointEnvelope(runId, priorId, '5'), resultEnvelope: null,
      };
      if (operation.operation === 'invocations.get') return {
        invocation: { index: priorIndex, contentEnvelope: priorProgressEnvelope, parentRevision: 2 },
      };
      if (operation.operation === 'invocations.list') return { invocations: [priorIndex] };
      if (operation.operation === 'invocations.recover') {
        effects.push('publish');
        return { run: { ...runRow, state: 'running', revision: 3 } };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const workspaceInspectionFailure = Object.assign(new Error('workspace_inspection_failed'), { code: 'EIO' });
    const restoreWorkspace = vi.fn(async () => {
      if (scenario === 'throws') throw workspaceInspectionFailure;
      effects.push('restore');
      return { ok: true as const };
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute: withStoredRoot(runId, execute) }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      restoreWorkspace,
      observeRecovery: async () => ({ activity: scenario === 'unknown' ? 'unknown' : 'not_active', canReattach: false, canContinueConversation: false }),
    });
    const input = {
      mode: 'recover' as const, runId, expectedRevision: 2,
      invocations: [{
        kind: 'restore_workspace' as const, invocation: { recordId: priorId },
        conversation: 'fresh_agent' as const, input: { kind: 'original' as const },
        ...(scenario === 'unknown' || scenario === 'stopped' ? { acknowledgeUncertainPriorEffects: true as const } : {}),
      }],
    };

    const recoveryRequest = {
      actionId: 'workflow.run.resume', input,
      context: {
        callerPermissionMode: 'default', actionRequestId: 'restore-request-1',
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
      },
    } as const;
    if (scenario === 'throws' || scenario === 'unknown') {
      if (scenario === 'throws') await expect(owner.execute(recoveryRequest)).rejects.toBe(workspaceInspectionFailure);
      else await expect(owner.execute(recoveryRequest)).rejects.toMatchObject({ code: 'ineligible_state' });
      expect(effects).toEqual([]);
      return;
    }
    await expect(owner.execute(recoveryRequest)).resolves.toMatchObject({ intent: 'resumed', run: { revision: 3 } });
    expect(effects).toEqual(['restore', 'publish']);
    expect(restoreWorkspace).toHaveBeenCalledWith(workspace);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ publisherMachineId: 'machine-1' });
    const recoverCall = execute.mock.calls.find(([operation]) => operation.operation === 'invocations.recover')?.[0] as Record<string, unknown>;
    const recovery = (recoverCall.recoveries as Array<Record<string, unknown>>)[0]!;
    const openedRecovery = openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: String(recovery.newInvocationId), sequence: '5', parentRecordId: STORED_ROOT_ID,
        memberOrdinal: '0', attempt: '1',
      },
      envelope: parseWorkflowStoredContentEnvelopeV1(String(recovery.contentEnvelope))!,
    });
    expect(openedRecovery).toMatchObject({
      kind: 'available',
      content: {
        input: {
          document: { text: 'work', references: [], attachments: [] },
          input: ['recorded context'],
        },
        recovery: {
          conversation: 'fresh_agent',
          input: {
            kind: 'replacement',
            value: {
              document: { text: 'work', references: [], attachments: [] },
              input: ['recorded context'],
            },
          },
        },
      },
    });

    restoreWorkspace.mockClear();
    await expect(owner.execute({
      actionId: 'workflow.run.resume', input,
      context: {
        callerPermissionMode: 'default', actionRequestId: 'wrong-machine-request',
        externalActionTarget: { kind: 'machine', machineId: 'machine-2' },
      },
    })).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(restoreWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    { target: 'leaf', missingDefault: false },
    { target: 'frame', missingDefault: false },
    { target: 'frame', missingDefault: true },
  ] as const)('restores the qualified child default and its required frame project: $target/$missingDefault', async ({ target, missingDefault }) => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
    const childRef = 'builtin:workspace-child';
    const child = validateWorkflowDefinition({ version: 1, defaults: { ...definition.defaults,
      workspace: { kind: 'new_worktree', source: { kind: 'workflow' } } }, blocks: [{ kind: 'step', id: 'work',
        document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] }).normalizedDefinition!;
    const root = validateWorkflowDefinition({ version: 1, defaults: definition.defaults, blocks: ['first', 'second'].map(id => ({
      kind: 'workflow', id, workflowRef: childRef, input: {},
    })) }).normalizedDefinition!;
    const workspace = (name: string): WorkflowWorkspaceProgressV1 => ({
      creationIntent: { kind: 'git_worktree', sourceDirectory: '/repo', baseRef: 'a'.repeat(40), displayName: name, branchMode: 'new' },
      descriptor: { machineId: 'machine-1', directory: `/repo/${name}`, checkoutRootPath: `/repo/${name}`,
        checkout: { kind: 'git_worktree', branchName: name } },
    });
    const selectedProject = workspace('second-project');
    const childDefault = workspace('second-default');
    const rows = [
      { blockKind: 'root', blockId: '$root', parent: null, ordinal: '0', fields: { workspace: workspace('root-default') } },
      { blockKind: 'workflow', blockId: 'first', parent: ids[0]!, ordinal: '0', fields: { workspace: workspace('first-default') } },
      { blockKind: 'workflow', blockId: 'second', parent: ids[0]!, ordinal: '1', fields: {
        workspace: childDefault, container: { kind: 'body', nextBlockOrdinal: '0', frameInputs: {}, frameProjectWorkspace: selectedProject },
      } },
      { blockKind: 'step', blockId: 'work', parent: ids[2]!, ordinal: '0', fields: {} },
    ] satisfies readonly { blockKind: WorkflowProgressEnvelopeV1['blockKind']; blockId: string; parent: string | null;
      ordinal: string; fields: Partial<WorkflowProgressEnvelopeV1> }[];
    const priorId = ids[target === 'frame' ? 2 : 3]!;
    const indices: WorkflowRunInvocationIndexV1[] = rows.map((row, position) => ({
      id: ids[position]!, runId, sequence: String(position), parentRecordId: row.parent, memberOrdinal: row.ordinal,
      attempt: '0', contentRevision: '0', lifecycle: ids[position] === priorId ? 'failed' : 'completed',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    const envelopes = rows.map((row, position) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: ids[position]!,
        sequence: String(position), parentRecordId: row.parent, memberOrdinal: row.ordinal, attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: row.blockKind, invocationPath: { blockId: row.blockId,
        scope: position === 3 ? [{ kind: 'workflow', blockId: 'second' }] : [] },
        attempt: '0', logicalInvocationRecordId: ids[position]!, ...row.fields,
        ...(ids[position] === priorId ? { reason: { code: 'workspace_unavailable' },
          input: { document: { text: 'work', references: [], attachments: [] }, input: [] } } : {}) },
    })));
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
      definition: root, admission: { kind: 'user' },
      // The saved child definition and Machine readiness are external boundaries.
      effects: { readWorkflowDefinition: async () => ({ definition: child, sourceKey: childRef }),
        resolveTargetAvailability: async () => true },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(materialized.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        ...materialized.snapshot, startedBy: 'user',
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
    }));
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'interrupted', revision: 2, machineId: 'machine-1',
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,
         restoreWorkspace: true, cancel: true, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const restored: WorkflowWorkspaceProgressV1[] = [];
    let published = false;
    const owner = createWorkflowRunActionOwner({ resolveAccountId: async () => 'account-1', definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      observeRecovery: async () => ({ activity: 'not_active', canReattach: false, canContinueConversation: false }),
      restoreWorkspace: async pair => {
        restored.push(pair);
        return missingDefault && pair.descriptor?.directory === childDefault.descriptor?.directory
          ? { ok: false, code: 'workflow_workspace_restore_unavailable' } : { ok: true };
      },
      storage: { execute: async operation => {
        if (operation.operation === 'get') return { run, acceptedEnvelope, checkpointEnvelope: checkpointEnvelope(runId, ids[0]!, '4'), resultEnvelope: null };
        if (operation.operation === 'invocations.list') return { invocations: indices };
        if (operation.operation === 'invocations.get') {
          const position = ids.indexOf(String(operation.invocationId));
          if (position < 0) throw new Error('missing invocation');
          return { invocation: { index: indices[position], contentEnvelope: envelopes[position], parentRevision: 2 } };
        }
        if (operation.operation === 'invocations.recover') { published = true; return { run: { ...run, state: 'running', revision: 3 } }; }
        throw new Error(`unexpected:${String(operation.operation)}`);
      } },
    });
    await expect(owner.execute({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId: priorId }, context: {} }))
      .resolves.toMatchObject({ invocation: { recoveryAvailability: { restoreWorkspace: { kind: 'available' } } } });
    const recovery = owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
      invocations: [{ kind: 'restore_workspace', invocation: { recordId: priorId }, conversation: 'fresh_agent', input: { kind: 'original' } }] },
      context: { callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: 'machine-1' } } });
    if (missingDefault) await expect(recovery).rejects.toMatchObject({ code: 'workflow_workspace_restore_unavailable' });
    else await expect(recovery).resolves.toMatchObject({ intent: 'resumed', run: { revision: 3 } });
    expect(restored).toEqual(target === 'frame' ? [selectedProject, childDefault] : [childDefault]);
    expect(published).toBe(!missingDefault);
  });

  it('checks every active-invocation page before allowing an agent to wait', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const invocationId = '55555555-5555-4555-8555-555555555555';
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition,
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(materialized.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: materialized.snapshot,
    }));
    const index = {
      id: invocationId, runId, sequence: '8', parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '0',
      lifecycle: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: invocationId, sequence: '8', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      },
      progress: {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '0', logicalInvocationRecordId: invocationId,
        execution: { kind: 'session', sessionId: 'calling-session', localInputId: 'input-1' },
      },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') return {
        run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'running', revision: 3,
          attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
          machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
          availability: { pause: true, resumeBoundary: false,
              restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] },
          createdAt: index.createdAt, updatedAt: index.updatedAt },
        acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null,
      };
      if (operation.operation === 'invocations.list' && operation.cursor === undefined) {
        return { invocations: [], nextCursor: 'page-2', parentRevision: 3 };
      }
      if (operation.operation === 'invocations.list' && operation.cursor === 'page-2') {
        return { invocations: [index], nextCursor: undefined, parentRevision: 3 };
      }
      if (operation.operation === 'invocations.get') {
        return { invocation: { index, contentEnvelope, parentRevision: 3 } };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });

    await expect(owner.execute({
      actionId: 'workflow.run.wait', input: { runId, timeoutSeconds: 1 },
      context: { surface: 'agent', defaultSessionId: 'calling-session' },
    })).rejects.toMatchObject({ code: 'workflow_wait_self_dependency' });
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.list'))
      .toHaveLength(2);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'wait')).toBe(false);
  });

  it('rechecks exact self-dependency after the structural wait observes a revision change', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const invocationId = '55555555-5555-4555-8555-555555555555';
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
        executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }));
    const index = { id: invocationId, runId, sequence: '1', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'cancel_requested', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as const;
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: invocationId, sequence: '1', parentRecordId: STORED_ROOT_ID, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: invocationId, execution: { kind: 'session', sessionId: 'calling-session', localInputId: 'input-1' } },
    }));
    let listed = 0;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.list') return { invocations: listed++ === 0 ? [] : [index], parentRevision: listed };
      if (operation.operation === 'invocations.get') return { invocation: { index, contentEnvelope, parentRevision: 1 } };
      if (operation.operation === 'get') return { run: { attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null, sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'running', revision: 0, machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null, availability: { pause: true, resumeBoundary: false,    restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null };
      if (operation.operation === 'wait') return { observation: 'changed', run: { revision: 1 } };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({ resolveAccountId: async () => 'account-1', storage: { execute: withStoredRoot(runId, execute) }, definitions: { get: vi.fn() }, resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }), doesImmediateEligibleStepTargetSession: () => false });
    // An agent wait without an authored deadline is one exact terminal read; only a bounded wait observes and rechecks.
    await expect(owner.execute({ actionId: 'workflow.run.wait', input: { runId, timeoutSeconds: 30 }, context: { surface: 'agent', defaultSessionId: 'calling-session' } })).rejects.toMatchObject({ code: 'workflow_wait_self_dependency', details: { runId } });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'wait', afterRevision: 0 }), expect.anything());
  });

  it('propagates caller abort while waiting without an authored deadline', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const reason = new Error('caller stopped waiting');
    const controller = new AbortController();
    const execute = vi.fn(async (
      operation: Readonly<Record<string, unknown>>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
      expect(operation).toEqual({ operation: 'wait', runId });
      expect(options?.signal).toBe(controller.signal);
      if (options?.signal?.aborted) throw options.signal.reason;
      return await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });
    const waiting = owner.execute({
      actionId: 'workflow.run.wait', input: { runId }, context: { signal: controller.signal },
    });
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { siblingCanContinue: true, completedFailStopReason: false, target: 'failed' },
    { siblingCanContinue: false, completedFailStopReason: false, target: 'failed' },
    { siblingCanContinue: true, completedFailStopReason: true, target: 'failed' },
    { siblingCanContinue: true, completedFailStopReason: false, target: 'cancelled' },
  ])('derives the full private fail-stop causal closure: $siblingCanContinue/$completedFailStopReason/$target', async ({ siblingCanContinue, completedFailStopReason, target }) => {
    const runId = '31111111-1111-4111-8111-111111111111';
    const parentId = '32222222-2222-4222-8222-222222222220';
    const failedId = '32222222-2222-4222-8222-222222222221';
    const siblingId = '32222222-2222-4222-8222-222222222222';
    const completedId = '32222222-2222-4222-8222-222222222223';
    const selectedId = target === 'cancelled' ? siblingId : failedId;
    const normalizedDefinition = validateWorkflowDefinition({
      ...definition,
      blocks: [{ kind: 'parallel', id: 'parallel-1', failurePolicy: 'fail_stop', branches: [
        { id: 'a', blocks: [{ kind: 'step', id: 'work-a', document: { text: 'a', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] },
        { id: 'b', blocks: [{ kind: 'step', id: 'work-b', document: { text: 'b', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] },
        { id: 'c', blocks: [{ kind: 'step', id: 'work-c', document: { text: 'c', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] },
      ] }],
    }).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }));
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: runId, origin: { kind: 'direct' as const }, state: 'interrupted' as const, revision: 1,
      machineId: 'machine-1', workflowCustodyState: 'settled' as const, originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    };
    const index = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string, lifecycle: 'failed' | 'cancelled' | 'needs_attention' | 'completed') => ({
      id, runId, sequence, parentRecordId, memberOrdinal, attempt: '0', contentRevision: '0', lifecycle,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    });
    const rows = [
      { index: index(parentId, '1', STORED_ROOT_ID, '0', 'needs_attention'), progress: {
        kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'parallel-1', scope: [] }, blockKind: 'parallel' as const,
        attempt: '0', logicalInvocationRecordId: parentId, container: { kind: 'parallel' as const, nextBranchOrdinal: '2' }, reason: { code: 'step_failed' },
      } },
      { index: index(failedId, '2', parentId, '0', 'failed'), progress: {
        kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'work-a', scope: [] }, blockKind: 'step' as const,
        attempt: '0', logicalInvocationRecordId: failedId, input: { document: { text: 'a', references: [], attachments: [] }, input: [] }, reason: { code: 'step_failed' },
        execution: { kind: 'session_ready' as const, sessionId: 'failed-step-session' },
      } },
      { index: index(siblingId, '3', parentId, '1', 'cancelled'), progress: {
        kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'work-b', scope: [] }, blockKind: 'step' as const,
        attempt: '0', logicalInvocationRecordId: siblingId, input: { document: { text: 'b', references: [], attachments: [] }, input: [] }, reason: { code: `container_fail_stop:${parentId}` },
        execution: { kind: 'session_ready' as const, sessionId: 'cancelled-step-session' },
      } },
      { index: index(completedId, '4', parentId, '2', 'completed'), progress: {
        kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'work-c', scope: [] }, blockKind: 'step' as const,
        attempt: '0', logicalInvocationRecordId: completedId, result: 'retained success',
        ...(completedFailStopReason ? { reason: { code: `container_fail_stop:${parentId}` } } : {}),
      } },
    ];
    const details = new Map(rows.map((row) => [row.index.id, {
      invocation: {
        index: row.index,
        parentRevision: 1,
        contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
          mode: 'plain', binding: {
            v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
            recordId: row.index.id, sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
            memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt,
          }, progress: row.progress,
        })),
      },
    }]));
    let recoverOperation: Readonly<Record<string, unknown>> | null = null;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') return { run, acceptedEnvelope, checkpointEnvelope: checkpointEnvelope(runId, parentId, '5'), resultEnvelope: null };
      if (operation.operation === 'invocations.list') return { invocations: rows.map((row) => row.index) };
      if (operation.operation === 'invocations.get') return details.get(String(operation.invocationId));
      if (operation.operation === 'invocations.recover') {
        recoverOperation = operation;
        const recoveries = operation.recoveries as readonly Readonly<{ newInvocationId: string }>[];
        return {
          disposition: 'accepted', run: { ...run, revision: 2, state: 'queued' },
          invocations: recoveries.map((recovery, position) => ({
            ...rows[position]!.index,
            id: recovery.newInvocationId,
            sequence: String(position + 5),
            parentRecordId: position === 0 ? STORED_ROOT_ID : recoveries[0]!.newInvocationId,
            attempt: '1', lifecycle: 'pending',
          })),
        };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute: withStoredRoot(runId, execute) }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      observeRecovery: async ({ index }) => ({ activity: 'not_active', canReattach: false,
        canContinueConversation: index.id !== siblingId || siblingCanContinue }),
    });
    await expect(owner.execute({
      actionId: 'workflow.run.invocations.get', input: { runId, invocationId: selectedId }, context: {},
    })).resolves.toMatchObject({ invocation: { recoveryAvailability: { continueSameConversation: {
      kind: siblingCanContinue ? 'available' : 'unavailable',
    }, retry: {
      kind: 'available', causalInvocationIds: [parentId, failedId, siblingId],
    } } } });
    if (!siblingCanContinue) {
      await expect(owner.execute({ actionId: 'workflow.run.invocations.retry',
        input: { runId, expectedRevision: 1, invocation: { recordId: selectedId }, causalInvocationIds: [parentId, failedId, siblingId], conversation: 'same_conversation', input: { kind: 'original' } },
        context: { callerPermissionMode: 'default', actionRequestId: 'unavailable-sibling-conversation' },
      })).rejects.toMatchObject({ code: 'ineligible_state' });
      expect(recoverOperation).toBeNull();
    }
    await expect(owner.execute({ actionId: 'workflow.run.resume',
      input: { mode: 'recover', runId, expectedRevision: 1, invocations: [{ kind: 'continue',
        invocation: { recordId: selectedId }, conversation: 'fresh_agent',
        input: { document: { text: 'Retry the reviewed objective', references: [], attachments: [] }, input: [] } }] },
      context: { callerPermissionMode: 'default', actionRequestId: 'incomplete-prepared-causal-review' },
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(recoverOperation).toBeNull();
    await expect(owner.execute({
      actionId: 'workflow.run.invocations.retry',
      input: { runId, expectedRevision: 1, invocation: { recordId: selectedId }, causalInvocationIds: [selectedId], conversation: 'fresh_agent', input: { kind: 'original' } },
      context: { callerPermissionMode: 'default', actionRequestId: 'incomplete-causal-review' },
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.recover')).toBe(false);
    await expect(owner.execute({
      actionId: 'workflow.run.invocations.retry',
      input: { runId, expectedRevision: 1, invocation: { recordId: selectedId }, causalInvocationIds: [parentId, failedId, siblingId], conversation: 'fresh_agent', input: { kind: 'original' } },
      context: { callerPermissionMode: 'default', actionRequestId: 'complete-causal-review' },
    })).resolves.toMatchObject({ disposition: 'accepted', invocation: { id: expect.any(String) } });
    expect(recoverOperation).toMatchObject({
      operation: 'invocations.recover',
      recoveries: [
        expect.objectContaining({ invocationId: parentId }),
        expect.objectContaining({ invocationId: failedId }),
        expect.objectContaining({ invocationId: siblingId }),
      ],
    });
  });
  it.each(['session', 'detached_run'] as const)('rejects an agent wait before rows exist when the frozen immediate Session step targets the caller under a %s default', async (defaultTarget) => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const normalizedDefinition = validateWorkflowDefinition({
      ...definition,
      blocks: [
        {
          kind: 'step', id: 'completed', document: { text: 'completed', references: [], attachments: [] },
          execution: { conversation: { kind: 'existing_session', sessionId: 'another-session', machineId: 'machine-1' } },
          input: [], result: { kind: 'text' },
        },
        {
          kind: 'step', id: 'work', document: { text: 'work', references: [], attachments: [] },
          execution: { conversation: { kind: 'existing_session', sessionId: 'calling-session', machineId: 'machine-1' } },
          input: [], result: { kind: 'text' },
        },
      ],
    }).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
        executionTarget: { kind: defaultTarget },
        materializedLeaves: normalizedDefinition.blocks.flatMap((block) => block.kind === 'step' ? [{
          sourceKey: '$root', blockId: block.id, kind: 'step' as const,
          authoredWorkspace: { kind: 'inherit' as const },
          selection: block.execution ?? {}, executionTarget: { kind: 'session' as const },
        }] : []),
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: 'calling-session' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.list') return { invocations: [], parentRevision: 0 };
      if (operation.operation === 'get') return {
        run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
          attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
          id: runId, origin: { kind: 'direct' }, state: 'queued', revision: 0, machineId: 'machine-1',
          workflowCustodyState: 'pending', originDeliveryAckRevision: null,
          availability: { pause: true, resumeBoundary: false,
              restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
        acceptedEnvelope, checkpointEnvelope: checkpointEnvelope(runId, 'root-record', '1'), resultEnvelope: null,
      };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const owner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
      doesImmediateEligibleStepTargetSession: doesWorkflowImmediateEligibleStepTargetSession,
    });

    const outcome: unknown = await owner.execute({
      actionId: 'workflow.run.wait', input: { runId, timeoutSeconds: 1 },
      context: { surface: 'agent', defaultSessionId: 'calling-session' },
    }).catch((error: unknown) => error);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'wait')).toBe(false);
    expect(outcome).toMatchObject({ code: 'workflow_wait_self_dependency' });
  });

  it('refuses a narrower controller before mutation and preserves typed storage codes', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const priorId = '44444444-4444-4444-8444-444444444444';
    const normalizedDefinition = validateWorkflowDefinition(definition).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: {
        startedBy: 'user', authoredDefinition: normalizedDefinition, workDepth: 0, materializedLeaves: [], frozenChildren: {}, metadata: null,
        definition: normalizedDefinition, source: { kind: 'inline' },
        inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      },
    }));
    const runRow = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'failed', revision: 1,
      attentionRequired: true, failureUnseen: true, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,    restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const getExecute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') return { run: runRow, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const narrowOwner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute: getExecute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });
    await expect(narrowOwner.execute({
      actionId: 'workflow.run.invocations.retry',
      input: { runId, expectedRevision: 1, invocation: { recordId: priorId }, causalInvocationIds: [priorId], conversation: 'same_conversation', input: { kind: 'original' } },
      context: { callerPermissionMode: 'read-only' },
    })).rejects.toMatchObject({ code: 'run_access_denied' });
    expect(getExecute).toHaveBeenCalledTimes(1);

    const deniedExecute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'get') return { run: runRow, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null };
      if (operation.operation === 'invocations.get') throw Object.assign(new Error('ineligible'), { response: { status: 422, data: { error: 'ineligible_state' } } });
      if (operation.operation === 'invocations.list') return { invocations: [{
        id: priorId, runId, sequence: '5', parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'failed',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }], nextCursor: undefined, parentRevision: 1 };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const deniedOwner = createWorkflowRunActionOwner({
      resolveAccountId: async () => 'account-1', storage: { execute: deniedExecute }, definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
    });
    await expect(deniedOwner.execute({
      actionId: 'workflow.run.invocations.retry',
      input: { runId, expectedRevision: 1, invocation: { recordId: priorId }, causalInvocationIds: [priorId], conversation: 'same_conversation', input: { kind: 'original' } },
      context: { callerPermissionMode: 'default' },
    })).rejects.toMatchObject({ code: 'ineligible_state' });
  });
});
