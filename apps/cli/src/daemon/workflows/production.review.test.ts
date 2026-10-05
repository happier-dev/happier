import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { describe, expect, it } from 'vitest';
import {
  WorkflowCheckpointEnvelopeV1Schema, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1, openWorkflowCheckpointStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  type AvailableAutomationAccountEncryptionV1,
  type WorkflowDefinitionV1,
} from '@happier-dev/protocol';
import { DurableWorkflowCoordinatorStore, createProductionWorkflowRunCoordinator } from './production';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import {  workflowInvocationKey } from './coordinator';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { createWorkflowAcceptedAuthorizationCurrentness } from './daemonRuntime';


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
  it.each(['narrower_controller', 'revoked_authority', 'narrowed_during_preparation'] as const)('reholds Generate with typed authority refusal before input (%s)', async denial => {
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
    await h.store.ensureIntent({ blockKind: 'step', key, recordId: '33333333-3333-4333-8333-333333333333', runId, blockId: 'draft', memberOrdinal: '0',
      path: { blockId: 'draft', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await h.store.commitFact({ key, lifecycle: 'waiting_for_review', result: 'prior', workspace: { descriptor: workspace },
      execution: { kind: 'session', sessionId: 'conversation', localInputId: 'prior-input' },
      review: { decision: { kind: 'generate', requestedFromContentRevision: '0' } } });
    let callerPermissionMode: 'default' | 'safe-yolo' = denial === 'narrower_controller' ? 'default' : 'safe-yolo';
    let admittedInput = false;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine', storage: h.storage,
      // Filesystem/SCM boundary: the retained fixture checkout exists at its exact recorded path.
      workspaceScm: { verifyRecordedWorkspace: async descriptor => descriptor.directory === workspace.directory ? 'available' : 'missing' },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      resolveControllerContext: async () => ({ surface: 'ui', authority: 'present_user',
        callerPermissionMode }),
      isAcceptedAuthorizationCurrent: async () => denial !== 'revoked_authority', onCommittedTransition: async () => {}, onReviewEntered: async () => {},
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',

        machineAdmissionTransport: async () => { throw new Error('denied_generate_cannot_admit'); },
        resolveExistingSessionConversation: async ({ sessionId }) => {
          if (denial !== 'narrowed_during_preparation') throw new Error('denied_generate_cannot_prepare');
          callerPermissionMode = 'default';
          return { sessionId, machineId: 'machine', directory: '/repo', agentTarget: generationAgentTarget };
        },
        sessionInput: { enqueue: async () => { admittedInput = true; return { status: 'accepted', localId: 'forbidden-input' }; },
          observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId,
            result: { kind: 'final_text', text: 'forbidden result' } }) },
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) } } });
    const outcome = await coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope, accountCurrentness: encryption.witness });
    expect(admittedInput).toBe(false);
    expect(await (await h.load()).readCurrent({ runId, blockId: 'draft', scope: [], memberOrdinal: '0' }))
      .toMatchObject({ lifecycle: 'waiting_for_review', reason: 'run_access_denied', reasonMessage: "Couldn't generate: run_access_denied" });
    if (denial === 'narrowed_during_preparation') expect(callerPermissionMode).toBe('default');
    expect(outcome).toMatchObject({ state: 'waiting_for_review' });
    expect(await (await h.load()).readByLogicalInvocation('33333333-3333-4333-8333-333333333333'))
      .toMatchObject({ result: 'prior', execution: { localInputId: 'prior-input' } });
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
    let callerPermissionMode: 'safe-yolo' | 'default' = 'safe-yolo';
    let narrowDuringPreparation = true;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine',
      // Filesystem/SCM boundary; continuation/admission and all authority decisions stay real.
      workspaceScm: { verifyRecordedWorkspace: async descriptor => descriptor.directory === workspace.directory ? 'available' : 'missing' },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode }),
      isAcceptedAuthorizationCurrent: async () => true, onCommittedTransition: async () => {},
      onReviewEntered: async () => { entries++; }, storage: h.storage,
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',

        machineAdmissionTransport: async () => { admittedInput = true; throw new Error('missing_session_must_not_admit_input'); },
        resolveExistingSessionConversation: async ({ sessionId }) => {
          if (!restored) return null;
          if (narrowDuringPreparation) callerPermissionMode = 'default';
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
      acceptedEnvelope, accountCurrentness: encryption.witness })).toMatchObject({ state: 'waiting_for_review' });
    expect(admittedInput).toBe(false);
    const deniedStore = await h.load();
    const denied = (await deniedStore.readCurrent({ runId, blockId: 'draft', scope: [], memberOrdinal: '0' }))!;
    expect(denied).toMatchObject({ lifecycle: 'waiting_for_review', attempt: 2, reason: 'run_access_denied' });
    expect(denied.execution).toBeUndefined();
    callerPermissionMode = 'safe-yolo';
    narrowDuringPreparation = false;
    await deniedStore.commitFact({ key: denied.key, lifecycle: 'waiting_for_review',
      review: { decision: { kind: 'generate', requestedFromContentRevision: denied.contentRevision! } } });
    await h.storage.execute({ operation: 'transition', runId, parentAttempt: 0, expectedRevision: h.storage.run().revision,
      state: 'claimed', checkpointEnvelope: h.storage.checkpointEnvelope()! });
    expect(await coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope, accountCurrentness: encryption.witness })).toMatchObject({ state: 'succeeded' });
    expect(admittedInput).toBe(true);
    expect(await (await h.load()).readCurrent({ runId, blockId: 'draft', scope: [], memberOrdinal: '0' }))
      .toMatchObject({ lifecycle: 'completed', result: 'generated', attempt: 3,
        execution: { sessionId: 'missing-session', localInputId: 'second-generation-input' } });
    expect(await (await h.load()).readByLogicalInvocation('33333333-3333-4333-8333-333333333333'))
      .toMatchObject({ lifecycle: 'superseded', result: 'prior', execution: { localInputId: 'prior-input' } });
  });

  it.each(['default', 'safe-yolo'] as const)('checks live controller dominance only for recorded boundary Resume (%s)', async (callerPermissionMode) => {
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        authoredDefinition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: 'human', kind: 'wait',
          selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
        authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      } }));
    const h = await harness(acceptedEnvelope, true);
    const boundary = h.storage;
    await boundary.execute({ operation: 'transition', runId, parentAttempt: 0, expectedRevision: boundary.run().revision,
      state: 'paused', checkpointEnvelope: boundary.checkpointEnvelope()! });
    await boundary.execute({ operation: 'resume', runId, expectedRevision: boundary.run().revision });
    const workflowResumeRequestedRevision = boundary.run().revision;
    let resumeCheckCompleted = false;
    let entries = 0;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine',
      resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
      resolveControllerContext: async () => {
        if (resumeCheckCompleted) throw new Error('resume_marker_already_consumed');
        resumeCheckCompleted = true;
        return { surface: 'cli', authority: 'account_automation', callerPermissionMode };
      },
      isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId,
        listAccountApiTokens: async () => { throw new Error('host has no token principal'); },
        resolveCurrentPluginOccurrenceId: async () => { throw new Error('host has no plugin principal'); },
        resolveCurrentPluginSourceCustody: async () => { throw new Error('host has no plugin custody'); },
        isMediatedSourceCurrent: async () => { throw new Error('host has no source mediator'); },
      }), onCommittedTransition: async () => {}, onReviewEntered: async () => { entries++; }, storage: boundary,
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',

        machineAdmissionTransport: async () => { throw new Error('denied claim cannot admit input'); },
        resolveExistingSessionConversation: async () => { throw new Error('denied claim cannot prepare conversation'); },
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
      } });
    const result = await coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
      workflowResumeRequestedRevision, acceptedEnvelope, accountCurrentness: encryption.witness });
    expect(resumeCheckCompleted).toBe(true);
    if (callerPermissionMode === 'safe-yolo') {
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

  it('keeps opened Workflow authorization current across Account sequence writes but refuses a content-mode change', async () => {
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
    let current: AvailableAutomationAccountEncryptionV1 = { kind: 'available', witness: encryption.witness };
    let registeredCheck: ((signal?: AbortSignal) => Promise<boolean>) | undefined;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: 'machine',
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'default' }),
      resolveAccountEncryption: async () => current,
      isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId,
        listAccountApiTokens: async () => { throw new Error('host admission has no API token'); },
        resolveCurrentPluginOccurrenceId: async () => { throw new Error('host admission has no plugin mediator'); },
        resolveCurrentPluginSourceCustody: async () => { throw new Error('host admission has no plugin custody'); },
        isMediatedSourceCurrent: async () => { throw new Error('host admission has no mediated source'); },
      }), onCommittedTransition: async () => {}, onReviewEntered: async () => {},
      storage: { observeChanges: boundary.observeChanges, execute: async (operation, options) => {
        const result = await boundary.execute(operation, options);
        // The real server initialization publishes an Account change. Model
        // that network boundary's new cursor without replacing internal auth.
        if (operation.operation === 'initialize') current = { kind: 'available', witness: { ...encryption.witness, version: 2 } };
        return result;
      } }, execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',

        machineAdmissionTransport: async () => { throw new Error('Wait cannot admit input'); },
        resolveExistingSessionConversation: async () => null,
        detachedRun: { actionExecutor: createActionExecutor({} as ActionExecutorDeps),
          buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
      } });
    expect(await coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: encryption.witness,
      registerAuthorizationCurrentnessCheck: (check) => { registeredCheck = check; },
    })).toMatchObject({ state: 'waiting_for_review' });
    expect(registeredCheck).toBeTypeOf('function');
    current = { kind: 'available', witness: { ...encryption.witness, version: 3 } };
    expect(await registeredCheck!()).toBe(true);
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(1) } });
    current = { kind: 'available', witness: { mode: 'e2ee', version: 4,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) }, material };
    expect(await registeredCheck!()).toBe(false);
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
      rootInvocationRecordId: rootId, isAcceptedAuthorizationCurrent: async () => true,
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
    const { store, storage } = await harness();
    const intent = await store.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId: 'draft', scope: [], attempt: 0 }),
      recordId: '33333333-3333-4333-8333-333333333333', runId, blockId: 'draft', memberOrdinal: '0',
      path: { blockId: 'draft', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'running' });
    await store.commitFact({ key: intent.key, lifecycle: 'waiting_for_review', result: 'Prior',
      execution: { kind: 'session', sessionId: 'session', localInputId: 'prior-input' }, workspace: { descriptor: workspace },
      review: { resultSource: { kind: 'execution_input' }, decision: { kind: 'generate', requestedFromContentRevision: '1' } } });
    const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId,
      isAcceptedAuthorizationCurrent: async () => true, resolveWorkspace: async () => ({ ok: true, workspace }),
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
    expect(storage.calls.filter((call) => call.operation === 'invocations.admit' &&
      (call.invocations as readonly { replaces?: unknown }[]).some((row) => row.replaces))).toHaveLength(1);
  });
});
