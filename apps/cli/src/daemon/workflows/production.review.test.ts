import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowCheckpointEnvelopeV1Schema, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1, openWorkflowCheckpointStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  prepareWorkflowRunDataKeyV1,
  type AvailableAutomationAccountEncryptionV1,
  type WorkflowDefinitionV1,
  buildBackendTargetKeyV2,
  materializeWorkflowAcceptedSnapshotV1,
  resolveBuiltinWorkflowDefinitionV1,
  createWorkflowAccountRunActionOwner,
  WorkflowResultContractSchema,
  ActionIdSchema, getActionSpec,
} from '@happier-dev/protocol';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { decodeExecutionRunResultObservation } from '@happier-dev/protocol/execution/runs/resultContract';
import { DurableWorkflowCoordinatorStore, createProductionWorkflowRunCoordinator } from './production';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { classifyWorkflowAbort, workflowInvocationKey } from './coordinator';
import { executeClaimedRun } from '../automation/automationRunExecutor';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { createWorkflowAcceptedAuthorizationCurrentness } from './daemonRuntime';
import { bindAutomationWorkflowInputs } from './input';


const runId = '11111111-1111-4111-8111-111111111111';
const rootId = '22222222-2222-4222-8222-222222222222';
const accountId = 'account-1';
const encryption = { witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' as const } };
const step = { kind: 'step' as const, id: 'draft', pauseForReview: true,
  document: { text: 'Draft', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } };
const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };
const generationAgentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

async function harness(acceptedEnvelope = 'opaque', paused = false) {
  const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', origin: { kind: 'direct' }, acceptedEnvelope, state: 'claimed' });
  const checkpoint = WorkflowCheckpointEnvelopeV1Schema.parse({ kind: 'happier.workflow-checkpoint.v1',
    rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused } });
  await storage.execute({ operation: 'initialize', runId, parentAttempt: 0, expectedRevision: 0,
    checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint })),
    rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId, sequence: '0',
        parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress: { kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } })) } });
  const load = () => DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
    storage, encryption, rootRecordId: rootId, checkpoint, revision: storage.run().revision,  });
  return { storage, load, store: await load() };
}

describe('durable review coordinator', () => {
  it('round-trips a Panel contract from production admission into the Account review reader', async () => {
    const definition = resolveBuiltinWorkflowDefinitionV1('plan-with-a-panel')!.definition;
    const inputs = bindAutomationWorkflowInputs({ definition, evidence: { request: 'A text-only plan' } });
    const engine = buildBackendTargetKeyV2(generationAgentTarget);
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition, context: {
      source: { kind: 'inline' }, inputs, machineId: 'machine', executionTarget: { kind: 'detached_run' },
      workspaceTarget: { project: workspace }, origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } },
    }, roleSelection: { defaultEngine: { agentTargetKey: engine }, availableAgentTargetKeys: [engine] },
    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
      readActionContract: async id => {
        const spec = getActionSpec(ActionIdSchema.parse(id));
        return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(spec));
      } } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot }));
    const boundary = createWorkflowRunStorageTestkit({ runId, accountId, machineId: 'machine', origin: { kind: 'direct' },
      acceptedEnvelope, state: 'claimed' });
    const value = { document: 'A plan with risks and open questions.' };
    let localInputId = '';
    const nativeRunId = 'panel-native-run';
    // Only the native execution transport is replaced; Action admission, the
    // production coordinator, durable store, crypto and Account reader are real.
    const nativeBoundary: Partial<ActionExecutorDeps> = {
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunStart: async (_sessionId, request) => {
        if (typeof request.localInputId !== 'string') throw new Error('Missing native input identity');
        localInputId = request.localInputId;
        return { runId: nativeRunId, callId: 'call', sidechainId: 'sidechain' };
      },
      executionRunGet: async () => ({ run: { runId: nativeRunId, callId: 'call', sidechainId: 'sidechain',
        intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', status: 'running', startedAtMs: 1,
        inputTurns: { occurrenceId: 'occurrence', last: { turnId: 'turn', inputIds: [localInputId], state: 'completed',
          result: { kind: 'json', value } } } } }),
    };
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine', storage: boundary,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      isAcceptedAuthorizationCurrent: async () => true, onReviewEntered: async () => {}, onCommittedTransition: async () => {},
      workspaceScm: { inspectLocation: async () => ({ inspection: { rootPath: '/repo' } }), verifyRecordedWorkspace: async () => 'available' },
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',
        machineAdmissionTransport: async () => { throw new Error('Panel must stay detached'); },
        resolveExistingSessionConversation: async () => null,
        detachedRun: {
          // Unused native ports deliberately remain absent at this transport fixture.
          actionExecutor: createActionExecutor(nativeBoundary as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }),
        } },
    });
    expect(await coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
      acceptedEnvelope, accountCurrentness: encryption.witness })).toMatchObject({ state: 'waiting_for_review' });
    const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId,
      resolveEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('Plain Account needs no keys'); },
      definitions: { get: async () => { throw new Error('Accepted Panel needs no definition lookup'); } }, storage: boundary });
    const page = await reader.execute({ actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true },
      context: { surface: 'ui', authority: 'present_user' } });
    const held = WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].parse(page).invocationDetails
      ?.find(row => row.progress.invocationPath.blockId === 'synthesis');
    expect(held?.index.lifecycle).toBe('waiting_for_review');
    if (!held) throw new Error('Missing Panel synthesis');
    if (held.progress.result === undefined) throw new Error('Missing Panel result');
    const synthesis = definition.blocks.find(block => block.id === 'synthesis');
    if (synthesis?.kind !== 'step') throw new Error('Missing synthesis definition');
    expect(held.progress.resultContract).toEqual(synthesis.result);
    const contract = WorkflowResultContractSchema.parse(held.progress.resultContract);
    // These are the exact typed contract and decoder used by the review card.
    expect(decodeExecutionRunResultObservation({ encoding: 'typed', value: held.progress.result }, contract))
      .toMatchObject({ ok: true, value });
    // Mis-wiring the reader to an absent/text contract reproduces the live
    // rejection: matching JSON bytes alone cannot make a result reviewable.
    expect(decodeExecutionRunResultObservation({ encoding: 'typed', value: held.progress.result }, undefined))
      .toMatchObject({ ok: false, reason: 'not_text' });
  });
  it.each(['transport', 'revoked'] as const)('renews admitted custody without re-reading accepted authority (%s)', async outcome => {
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } },
    ] };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        authoredDefinition: definition, definition, startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: 'human', kind: 'wait', selection: {},
          authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'default', principal: {
          kind: 'api', accountId, principalId: accountId, credentialId: 'missing-token',
        } },
      } }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', origin: { kind: 'direct' }, acceptedEnvelope, state: 'claimed' });
    let entered!: () => void;
    let release!: () => void;
    const initialized = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<void>(resolve => { release = resolve; });
    let executionSignal: AbortSignal | undefined;
    let authorityReads = 0;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine',
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'default' }),
      resolveAccountEncryption: async signal => { executionSignal = signal; return { kind: 'available', witness: encryption.witness }; },
      isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId,
        listAccountApiTokens: async () => { authorityReads++; if (outcome === 'transport') throw new Error('transport disconnected'); return { tokens: [] }; },
        resolveCurrentPluginOccurrenceId: async () => null,
        isMediatedSourceCurrent: async () => false,
      }), onCommittedTransition: async () => {}, onReviewEntered: async () => {},
      storage: { observeChanges: boundary.observeChanges, execute: async (operation, options) => {
        // Delay one genuine Home response while the real claim lease renews.
        if (operation.operation === 'initialize') { entered(); await response; }
        return boundary.execute(operation, options);
      } }, execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',
        machineAdmissionTransport: async () => { throw new Error('Wait cannot admit input'); },
        resolveExistingSessionConversation: async () => null,
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
      } });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const execution = executeClaimedRun({ machineId: 'machine', heartbeatMs: 1_000, leaseDurationMs: 10_000,
        claimClient: { heartbeatRun: async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs, failRun: async () => { throw new Error('Must not settle unknown custody'); } },
        coordinateWorkflowRun: coordinate, claimed: { protocol: 'v3', automation: null, accountCurrentness: encryption.witness,
          run: { id: runId, automationId: null, attempt: 0, leaseExpiresAt: Date.now() + 10_000, revision: 0, triggerId: null,
            origin: { kind: 'direct' }, workflowAcceptedSnapshotEnvelope: acceptedEnvelope } },
      });
      await initialized;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(classifyWorkflowAbort(executionSignal)).toBe('none');
      expect(authorityReads).toBe(0);
      release();
      await execution;
      expect(boundary.run()).toMatchObject({ state: 'waiting_for_review' });
      expect(boundary.rows()).toHaveLength(2);
    } finally { release(); vi.useRealTimers(); }
  });
  it('reholds an offline generation request when production preparation cannot reach the retained Session', async () => {
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        authoredDefinition: { version: 1, inputs: [], defaults: { agentTarget: generationAgentTarget }, blocks: [step] },
        startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: 'draft', kind: 'step',
          selection: { agentTarget: generationAgentTarget }, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        definition: { version: 1, inputs: [], defaults: { agentTarget: generationAgentTarget }, blocks: [step] },
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      } }));
    const h = await harness(acceptedEnvelope);
    const key = workflowInvocationKey({ runId, blockId: 'draft', scope: [], attempt: 0 });
    await h.store.ensureIntent({ blockKind: 'step', key, recordId: '33333333-3333-4333-8333-333333333333',
      runId, blockId: 'draft', memberOrdinal: '0', path: { blockId: 'draft', scope: [] },
      attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await h.store.commitFact({ key, lifecycle: 'waiting_for_review', result: 'prior', workspace: { descriptor: workspace },
      execution: { kind: 'session', sessionId: 'missing-session', localInputId: 'prior-input' },
      review: { decision: { kind: 'generate', requestedFromContentRevision: '0' } } });
    let entries = 0;
    let admittedInput = false;
    let restored = false;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine',
      // Filesystem/SCM boundary; continuation/admission and all authority decisions stay real.
      workspaceScm: { verifyRecordedWorkspace: async descriptor => descriptor.directory === workspace.directory ? 'available' : 'missing' },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'safe-yolo' }),
      isAcceptedAuthorizationCurrent: async () => true, onCommittedTransition: async () => {},
      onReviewEntered: async () => { entries++; }, storage: h.storage,
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',

        machineAdmissionTransport: async () => { admittedInput = true; throw new Error('missing_session_must_not_admit_input'); },
        resolveExistingSessionConversation: async ({ sessionId }) => {
          if (!restored) return null;
          return { sessionId, machineId: 'machine', directory: '/repo', agentTarget: generationAgentTarget };
        },
        // External Session network ports, beneath the real production conversation/admission owners.
        sessionInput: { enqueue: async () => { admittedInput = true; return { status: 'accepted', localId: 'second-generation-input' }; },
          observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId,
            result: { kind: 'final_text', text: 'generated' } }) },
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
      } });
    expect(await coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope, accountCurrentness: encryption.witness })).toMatchObject({ state: 'waiting_for_review' });
    expect(admittedInput).toBe(false);
    expect(entries).toBe(1);
    const store = await h.load();
    expect(await store.readByLogicalInvocation('33333333-3333-4333-8333-333333333333'))
      .toMatchObject({ lifecycle: 'superseded', result: 'prior' });
    expect(await store.readCurrent({ runId, blockId: 'draft', scope: [], memberOrdinal: '0' }))
      .toMatchObject({ lifecycle: 'waiting_for_review', reason: 'workflow_conversation_unavailable', attempt: 1 });
    const held = (await store.readCurrent({ runId, blockId: 'draft', scope: [], memberOrdinal: '0' }))!;
    expect(held.execution).toBeUndefined();
    restored = true;
    await store.commitFact({ key: held.key, lifecycle: 'waiting_for_review',
      review: { decision: { kind: 'generate', requestedFromContentRevision: held.contentRevision! } } });
    // The opaque network boundary models the claimed wake after the explicit decision.
    await h.storage.execute({ operation: 'transition', runId, parentAttempt: 0, expectedRevision: h.storage.run().revision,
      state: 'claimed', checkpointEnvelope: h.storage.checkpointEnvelope()! });
    expect(await coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope, accountCurrentness: encryption.witness })).toMatchObject({ state: 'succeeded' });
    expect(admittedInput).toBe(true);
    expect(await (await h.load()).readCurrent({ runId, blockId: 'draft', scope: [], memberOrdinal: '0' }))
      .toMatchObject({ lifecycle: 'completed', result: 'generated', attempt: 2,
        execution: { sessionId: 'missing-session', localInputId: 'second-generation-input' } });
    expect(await (await h.load()).readByLogicalInvocation('33333333-3333-4333-8333-333333333333'))
      .toMatchObject({ lifecycle: 'superseded', result: 'prior', execution: { localInputId: 'prior-input' } });
  });

  it.each([false, true])('checks original source currentness only for recorded boundary Resume (%s)', async (sourceCurrent) => {
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        authoredDefinition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: 'human', kind: 'wait',
          selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' }, sourceAuthority: {
          mediatorPluginId: 'com.happier.resume-source', sourceRef: 'message-1', sourceRevisionOrEpoch: '1', remoteApprovalMaxScope: 'request',
        } },
      } }));
    const h = await harness(acceptedEnvelope, true);
    const boundary = h.storage;
    await boundary.execute({ operation: 'transition', runId, parentAttempt: 0, expectedRevision: boundary.run().revision,
      state: 'paused', checkpointEnvelope: boundary.checkpointEnvelope()! });
    await boundary.execute({ operation: 'resume', runId, expectedRevision: boundary.run().revision });
    const workflowResumeRequestedRevision = boundary.run().revision;
    let sourceReads = 0;
    let entries = 0;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine',
      resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      resolveControllerContext: async () => { throw new Error('controller_was_admitted_at_action'); },
      isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId,
        listAccountApiTokens: async () => { throw new Error('host has no token principal'); },
        resolveCurrentPluginOccurrenceId: async () => 'installed-source',
        isMediatedSourceCurrent: async () => { sourceReads++; return sourceCurrent; },
      }), onCommittedTransition: async () => {}, onReviewEntered: async () => { entries++; }, storage: boundary,
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',

        machineAdmissionTransport: async () => { throw new Error('denied claim cannot admit input'); },
        resolveExistingSessionConversation: async () => { throw new Error('denied claim cannot prepare conversation'); },
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
      } });
    const result = await coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
      workflowResumeRequestedRevision, acceptedEnvelope, accountCurrentness: encryption.witness });
    expect(sourceReads).toBe(1);
    if (sourceCurrent) {
      expect(result).toMatchObject({ state: 'waiting_for_review' });
      expect(entries).toBe(1);
      const opened = openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
        envelope: parseWorkflowStoredContentEnvelopeV1(boundary.checkpointEnvelope()),
        binding: { v: 1, purpose: 'checkpoint', accountId, runId } });
      expect(opened).toMatchObject({ kind: 'available', content: { frontier: { paused: false } } });
      // A new claim after the server consumed the Resume marker is an ordinary
      // review wake/reclaim. It must not repeat D3 or a Resume disposition.
      expect(await coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
        acceptedEnvelope, accountCurrentness: encryption.witness })).toMatchObject({ state: 'waiting_for_review' });
      expect(sourceReads).toBe(1);
    } else {
      expect(result).toMatchObject({ state: 'paused', reason: 'run_access_denied' });
      expect(boundary.run()).toMatchObject({ state: 'paused', workflowCustodyState: 'pending' });
      const root = boundary.rows().find(row => row.index.parentRecordId === null)!;
      const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(root.contentEnvelope),
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: root.index.id, sequence: root.index.sequence,
          parentRecordId: null, memberOrdinal: root.index.memberOrdinal, attempt: root.index.attempt } });
      expect(opened).toMatchObject({ kind: 'available', content: { reason: { code: 'run_access_denied', message: "Couldn't resume: run_access_denied" } } });
      expect(boundary.rows()).toHaveLength(1);
      expect(entries).toBe(0);
    }
  });

  it.each([false, true, 'terminal_child'] as const)('settles only resolved child custody on denied Resume when Stop is %s', async (stop) => {
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget: generationAgentTarget }, blocks: [step] };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        authoredDefinition: definition, definition, startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: step.id, kind: 'step', selection: { agentTarget: generationAgentTarget },
          authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' }, sourceAuthority: {
          mediatorPluginId: 'com.happier.resume-source', sourceRef: 'message-1', sourceRevisionOrEpoch: '1', remoteApprovalMaxScope: 'request',
        } },
      } }));
    const h = await harness(acceptedEnvelope, true);
    const childId = '33333333-3333-4333-8333-333333333333';
    const key = workflowInvocationKey({ runId, blockId: step.id, scope: [], attempt: 0 });
    await h.store.ensureIntent({ key, recordId: childId, runId, blockId: step.id, blockKind: 'step',
      path: { blockId: step.id, scope: [] }, memberOrdinal: '0', attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await h.store.commitFact({ key, lifecycle: 'running', workspace: { descriptor: workspace },
      execution: { kind: 'session', sessionId: 'unresolved-session', localInputId: 'unresolved-input' } });
    await h.storage.execute({ operation: 'transition', runId, parentAttempt: 0, expectedRevision: h.storage.run().revision,
      state: 'paused', checkpointEnvelope: h.storage.checkpointEnvelope()! });
    await h.storage.execute({ operation: 'resume', runId, expectedRevision: h.storage.run().revision });
    const workflowResumeRequestedRevision = h.storage.run().revision;
    let resumedEffect = false;
    let childSettled = false;
    const storage = { ...h.storage, execute: async (...args: Parameters<typeof h.storage.execute>) => {
      const result = await h.storage.execute(...args);
      const request = args[0];
      if (stop === 'terminal_child' && !childSettled && request.operation === 'invocations.list'
        && request.lifecycles?.length === 2 && request.lifecycles.includes('cancel_requested')) {
        childSettled = true;
        // Native recovery commits terminal evidence while cancellation drains
        // structural rows from its earlier page. The final custody read owns it.
        await h.store.commitFact({ key, lifecycle: 'failed', reason: 'execution_run_protocol_unsupported' });
      }
      return result;
    } };
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine', storage,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      resolveControllerContext: async () => { throw new Error('controller_was_admitted_at_action'); },
      // Source lookup is an external boundary. A concurrent human Stop reaches
      // storage before the coordinator reads control after that lookup.
      isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId,
        listAccountApiTokens: async () => { throw new Error('host has no token principal'); },
        resolveCurrentPluginOccurrenceId: async () => 'installed-source',
        isMediatedSourceCurrent: async () => {
          if (stop) h.storage.requestControl('cancel_requested');
          return false;
        },
      }), onCommittedTransition: async () => {}, onReviewEntered: async () => {},
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',
        machineAdmissionTransport: async () => { resumedEffect = true; throw new Error('denied_resume_cannot_admit'); },
        resolveExistingSessionConversation: async () => { resumedEffect = true; throw new Error('denied_resume_cannot_prepare'); },
        sessionInput: {
          enqueue: async () => { resumedEffect = true; throw new Error('denied_resume_cannot_enqueue'); },
          observe: async () => { resumedEffect = true; throw new Error('denied_resume_cannot_observe'); },
        },
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
      } });
    expect(await coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      workflowResumeRequestedRevision, acceptedEnvelope, accountCurrentness: encryption.witness }))
      .toMatchObject({ state: stop ? 'cancelled' : 'interrupted', reason: 'run_access_denied' });
    expect(h.storage.run()).toMatchObject({ state: stop ? 'cancelled' : 'interrupted', workflowCustodyState: stop === 'terminal_child' ? 'settled' : 'pending' });
    expect(h.storage.rowById(rootId)?.index.lifecycle).toBe(stop ? 'cancelled' : 'pending');
    expect(await (await h.load()).readByLogicalInvocation(childId)).toMatchObject({
      lifecycle: stop === 'terminal_child' ? 'failed' : stop ? 'cancel_requested' : 'running',
      execution: { sessionId: 'unresolved-session', localInputId: 'unresolved-input' },
    });
    expect(resumedEffect).toBe(false);
  });

  it('does not apply Resume dominance to an initial claim or a review wake', async () => {
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        authoredDefinition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: 'human', kind: 'wait',
          selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      } }));
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', origin: { kind: 'direct' }, acceptedEnvelope, state: 'claimed' });
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine', storage,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      resolveControllerContext: async () => { throw new Error('not_a_recorded_resume'); },
      isAcceptedAuthorizationCurrent: async () => true, onCommittedTransition: async () => {}, onReviewEntered: async () => {},
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',

        machineAdmissionTransport: async () => { throw new Error('Wait cannot admit input'); },
        resolveExistingSessionConversation: async () => null,
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) } } });
    for (let claim = 0; claim < 2; claim++) {
      expect(await coordinate({ runId, attempt: 0, expectedRevision: storage.run().revision, acceptedEnvelope,
        accountCurrentness: encryption.witness })).toMatchObject({ state: 'waiting_for_review' });
    }
  });

  it.each(['plain', 'e2ee'] as const)('initializes a claimed Workflow across Account sequence writes but refuses changed content identity (%s)', async mode => {
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
    const accountEncryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: encryption.witness }
      : { kind: 'available', witness: { mode, version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) }, material };
    const prepared = prepareWorkflowRunDataKeyV1({ accountId, encryption: accountEncryption,
      randomBytes: length => new Uint8Array(length).fill(3) });
    const ownerEnvelope = prepared.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
    const sealMode = prepared.runCrypto.mode === 'plain' ? prepared.runCrypto
      : { ...prepared.runCrypto, randomBytes: (length: number) => new Uint8Array(length).fill(4) };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      ...sealMode,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        authoredDefinition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: 'human', kind: 'wait',
          selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      } }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', origin: { kind: 'direct' },
      acceptedEnvelope, state: 'claimed', keyCensus: { runId, ownerAccountId: accountId, access: 'owner', visibleTeamId: null,
        encryptionMode: mode, ownerAccountCurrentness: accountEncryption.witness, dataEncryptionKey: ownerEnvelope,
        callerDataEncryptionKey: ownerEnvelope, recipients: [] } });
    // Another Session/Run can publish after the claim response and before the
    // coordinator opens it. Account.seq is not the content's encryption identity.
    let current = structuredClone(accountEncryption);
    current.witness.version = 2;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine',
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'default' }),
      resolveAccountEncryption: async () => current,
      isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId,
        listAccountApiTokens: async () => { throw new Error('host admission has no API token'); },
        resolveCurrentPluginOccurrenceId: async () => { throw new Error('host admission has no plugin mediator'); },
        isMediatedSourceCurrent: async () => { throw new Error('host admission has no mediated source'); },
      }), onCommittedTransition: async () => {}, onReviewEntered: async () => {},
      storage: { observeChanges: boundary.observeChanges, execute: async (operation, options) => {
        const result = await boundary.execute(operation, options);
        // The real server initialization publishes an Account change. Model
        // that network boundary's new cursor without replacing internal auth.
        if (operation.operation === 'initialize') current.witness.version = 3;
        return result;
      } }, execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',

        machineAdmissionTransport: async () => { throw new Error('Wait cannot admit input'); },
        resolveExistingSessionConversation: async () => null,
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
      } });
    expect(await coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: accountEncryption.witness,
    })).toMatchObject({ state: 'waiting_for_review' });
    expect(boundary.checkpointEnvelope()).not.toBeNull();
    expect(boundary.rows()).toEqual(expect.arrayContaining([expect.objectContaining({ index: expect.objectContaining({ lifecycle: 'waiting_for_review' }) })]));
    current.witness.version = 4;
    expect(await coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
      accountCurrentness: accountEncryption.witness, acceptedEnvelope })).toMatchObject({ state: 'waiting_for_review' });
    const changedMaterial = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(1) } });
    current = { kind: 'available', witness: { mode: 'e2ee', version: 4,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(changedMaterial.contentPublicKeyFingerprint) }, material: changedMaterial };
    const contentBeforeRefusal = boundary.checkpointEnvelope();
    expect(await coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
      accountCurrentness: accountEncryption.witness, acceptedEnvelope })).toMatchObject({ state: 'failed', reason: 'content_unavailable' });
    expect(boundary.checkpointEnvelope()).toBe(contentBeforeRefusal);
  });
  it.each(['unchanged', 'committed'] as const)('reconciles review park transport failure from the actual parent (%s)', async (parent) => {
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        authoredDefinition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: 'human', kind: 'wait',
          selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      } }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', origin: { kind: 'direct' },
      acceptedEnvelope, state: 'claimed' });
    const lostTransport = new Error('transport_unavailable');
    let parks = 0;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine',
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'default' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      isAcceptedAuthorizationCurrent: async () => true, onCommittedTransition: async () => {}, onReviewEntered: async () => {},
      storage: { observeChanges: boundary.observeChanges, execute: async (operation, options) => {
        if (operation.operation === 'transition' && operation.state === 'waiting_for_review') {
          parks++;
          if (parent === 'committed') await boundary.execute(operation, options);
          // A second transport attempt models an intervening control, so an
          // incorrect retry cannot hang this failure-path regression forever.
          if (parks === 2) boundary.requestControl('cancelled');
          throw lostTransport;
        }
        return await boundary.execute(operation, options);
      } }, execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',

        machineAdmissionTransport: async () => { throw new Error('Wait cannot admit input'); },
        resolveExistingSessionConversation: async () => null,
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
      } });
    const result = coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: encryption.witness });
    if (parent === 'committed') await expect(result).resolves.toMatchObject({ state: 'waiting_for_review' });
    else await expect(result).rejects.toBe(lostTransport);
    expect(boundary.run().state).toBe(parent === 'committed' ? 'waiting_for_review' : 'running');
    expect(parks).toBe(1);
  });
  it('parks a Wait leaf and reconstructs its held row without executing or re-emitting entry', async () => {
    const { store, storage, load } = await harness();
    let entries = 0;
    const create = (current: DurableWorkflowCoordinatorStore) => createWorkflowCoordinator({ store: current,
      rootInvocationRecordId: rootId,
      onReviewEntered: async () => { entries += 1; },
      prepareStep: async () => { throw new Error('wait_must_not_prepare'); },
      resolveWorkspace: async () => { throw new Error('wait_must_not_resolve_workspace'); },
      executeStep: async () => { throw new Error('wait_must_not_execute'); } });
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human',
      document: { text: 'Confirm', references: [], attachments: [] } }] };
    const params = { runId, definition, inputs: {}, executionTarget: { kind: 'session' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } } };
    const parked = await create(store).run(params);
    expect(parked.state).toBe('waiting_for_review');
    const checkpointEnvelope = storage.checkpointEnvelope();
    await storage.execute({ operation: 'transition', runId, parentAttempt: 0, expectedRevision: parked.parkRevision,
      state: 'waiting_for_review', checkpointEnvelope });
    expect(storage.run().workflowCustodyState).toBe('pending');
    expect(await create(await load()).run(params)).toMatchObject({ state: 'waiting_for_review' });
    expect(entries).toBe(1);
    const row = storage.rows().find((candidate) => candidate.index.parentRecordId === rootId)!;
    expect(row.index).toMatchObject({ lifecycle: 'waiting_for_review', contentRevision: '1' });
    const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id, sequence: row.index.sequence,
        parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
    expect(opened).toMatchObject({ kind: 'available', content: { blockKind: 'wait' } });
    const getIndex = storage.calls.findIndex((call) => call.operation === 'get');
    expect(storage.calls.slice(getIndex + 1).some((call) => call.operation === 'invocations.get' && call.invocationId === row.index.id)).toBe(true);
  });

  it('uses row CAS to retain concurrently published value/source when committing an initial hold', async () => {
    const { store, storage } = await harness();
    const intent = await store.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId: 'draft', scope: [], attempt: 0 }),
      recordId: '33333333-3333-4333-8333-333333333333', runId, blockId: 'draft', memberOrdinal: '0',
      path: { blockId: 'draft', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'running' });
    const row = storage.rowById(intent.recordId)!;
    const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId,
      recordId: row.index.id, sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
      memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt };
    const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding, envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
    if (opened.kind !== 'available') throw new Error('fixture_unavailable');
    await storage.execute({ operation: 'invocations.fact', runId, parentAttempt: 0,
      invocationId: intent.recordId, invocationAttempt: '0', expectedLifecycle: 'running', expectedContentRevision: row.index.contentRevision,
      lifecycle: 'running', contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
        progress: { ...opened.content, result: 'Published draft', review: { resultSource: { kind: 'published', by: 'agent' } } } })) });
    const held = await store.commitFact({ key: intent.key, lifecycle: 'waiting_for_review', result: 'Terminal prose',
      review: { resultSource: { kind: 'execution_input' } } });
    expect(held).toMatchObject({ lifecycle: 'waiting_for_review', result: 'Published draft',
      review: { resultSource: { kind: 'published', by: 'agent' } }, contentRevision: '3' });
  });

  it('consumes a Generate intent through the existing durable replacement path and preserves the prior row', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-11T10:00:00.000Z'));
    try {
      const { store, storage } = await harness();
      const progressOf = (row: NonNullable<ReturnType<typeof storage.rowById>>) => {
        const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
          binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id, sequence: row.index.sequence,
            parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
        if (opened.kind !== 'available') throw new Error('step_timing_unavailable');
        return opened.content;
      };
      const intent = await store.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId: 'draft', scope: [], attempt: 0 }),
        recordId: '33333333-3333-4333-8333-333333333333', runId, blockId: 'draft', memberOrdinal: '0',
        path: { blockId: 'draft', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'running' });
      expect(progressOf(storage.rowById(intent.recordId)!)).toMatchObject({ blockKind: 'step',
        timing: { startedAt: '2026-10-11T10:00:00.000Z' } });
      await store.commitFact({ key: intent.key, lifecycle: 'waiting_for_review', result: 'Prior',
        execution: { kind: 'session', sessionId: 'session', localInputId: 'prior-input' }, workspace: { descriptor: workspace },
        review: { resultSource: { kind: 'execution_input' }, decision: { kind: 'generate', requestedFromContentRevision: '1' } } });
      clock.mockReturnValue(Date.parse('2026-10-11T10:05:00.000Z'));
      const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId, resolveWorkspace: async () => ({ ok: true, workspace }),
        executeStep: async (params) => {
          expect(params.recoveryPreviousExecution).toMatchObject({ sessionId: 'session', localInputId: 'prior-input' });
          await params.beforeInputAdmission();
          await params.onInputAccepted({ kind: 'session', sessionId: 'session', localInputId: 'generated-input' });
          return { kind: 'completed', result: 'Generated' };
        } });
      expect(await coordinator.run({ runId, definition: { version: 1, inputs: [], defaults: { agentTarget: generationAgentTarget }, blocks: [step] },
        inputs: {}, executionTarget: { kind: 'session' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } } }))
        .toMatchObject({ state: 'succeeded' });
      expect(storage.rowById(intent.recordId)?.index.lifecycle).toBe('superseded');
      const replacement = storage.rows().find((row) => row.index.attempt === '1')!;
      expect(replacement.index.lifecycle).toBe('completed');
      expect(progressOf(replacement)).toMatchObject({ timing: {
        startedAt: '2026-10-11T10:05:00.000Z', finishedAt: '2026-10-11T10:05:00.000Z',
      } });
      expect(storage.calls.filter((call) => call.operation === 'invocations.admit' &&
        (call.invocations as readonly { replaces?: unknown }[]).some((row) => row.replaces))).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
});
