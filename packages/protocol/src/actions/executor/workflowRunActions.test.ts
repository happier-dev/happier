import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as base64 from '../../crypto/base64.js';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '../../crypto/accountScopedCipher.js';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '../../account/encryptionKeyFingerprintV1.js';
import type { AvailableAutomationAccountEncryptionV1 } from '../../automations/automationAccountCurrentnessV1.js';
import { prepareWorkflowRunDataKeyV1, resolveWorkflowRunDataKeyV1 } from '../../workflows/workflowRunDataKeyV1.js';

import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import { materializeWorkflowAcceptedSnapshotV1 } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { WorkflowRunGetResultV1Schema, WorkflowRunStartRequestV1Schema, WorkflowRunWaitRequestV1Schema, WorkflowRunListRequestV1Schema, WorkflowRunSummariesRequestV1Schema } from '../../workflows/actionsV1.js';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '../../workflows/workflowStoredContentV1.js';
import { WorkflowRunSummaryV1Schema, WorkflowRunInvocationIndexV1Schema, WorkflowProgressEnvelopeV1Schema } from '../../workflows/workflowProgressV1.js';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '../../workflows/workflowStoredContentV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from './workflowRunActions.js';
import { createWorkflowActionExecutor, normalizeWorkflowActionThrownError } from './workflowAccountActions.js';
import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { WorkflowRunRecipientCensusResponseV1Schema, WorkflowRunRecipientKeyEnvelopesV1Schema } from '../../workflows/workflowRunKeyV1.js';
import { WorkflowAcceptedSnapshotV1Schema, type WorkflowAcceptedSnapshotV1 } from '../../workflows/workflowDefinitionV1.js';
import { measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../externalActionLimits.js';
import { REVIEW_AND_CONVERGE_WORKFLOW_V1 } from '../../workflows/builtins/reviewAndConverge.js';
import { PLAN_WITH_A_PANEL_WORKFLOW_V1 } from '../../workflows/builtins/planWithAPanel.js';
import { getActionSpec } from '../actionSpecs.js';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '../actionCatalog.js';
import { ActionIdSchema } from '../actionIds.js';
import { resolveActionCurrentSessionScopeFailure } from './sessionListAccess.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { markSessionListQueryResultV1 } from '../../sessions/awareness/action.js';
import { createActionExecutor } from '../actionExecutor.js';
import { resolveWorkflowAcceptedStepSelectionV1 } from '../../workflows/workflowStepSelectionV1.js';
import { ActionsSettingsV1Schema } from '../actionSettings.js';

const runId = '11111111-1111-4111-8111-111111111111';
const definition = validateWorkflowDefinition({
  version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
  blocks: ['work'],
}).normalizedDefinition!;

const acceptedSnapshotResult = await materializeWorkflowAcceptedSnapshotV1({
  definition,
  context: {
    source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null },
    inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
    workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
    origin: { kind: 'direct', originSessionId: 'origin-1' },
    authorization: { principal: { kind: 'host' } },
  },
  admission: { kind: 'user' },
  effects: { resolveTargetAvailability: async () => true },
});

function runSnapshot() {
  if (!acceptedSnapshotResult.ok) throw new Error(`snapshot_fixture_failed: ${acceptedSnapshotResult.error.code}`);
  const run = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
    id: runId, origin: { kind: 'direct' }, state: 'queued', revision: 0,
    machineId: 'machine-a', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
    availability: { pause: true, resumeBoundary: false,
       restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  return {
    run,
    acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: acceptedSnapshotResult.snapshot,
    })),
    checkpointEnvelope: null, resultEnvelope: null,
    keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({
      runId, ownerAccountId: 'account-1', visibleTeamId: null, encryptionMode: 'plain', access: 'owner',
      ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
    }),
  };
}

function ownerDeps(storage: WorkflowAccountRunActionDeps['storage']): WorkflowAccountRunActionDeps {
  return {
    resolveAccountId: async () => 'account-1', storage,
    definitions: { get: async () => ({ definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, definition, metadata: { title: 'Work' } }) },
    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    resolveRunReportPolicy: async () => ({ preset: 'important' }),
    normalizeAbsolutePath: (directory) => directory.startsWith('/') ? directory : null,
    randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
  };
}

function storedRootInvocation(snapshot: ReturnType<typeof runSnapshot>) {
  const id = '66666666-6666-4666-8666-666666666666';
  const index = WorkflowRunInvocationIndexV1Schema.parse({ id, runId, sequence: '0', parentRecordId: null,
    memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'completed',
    createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt });
  const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
    blockKind: 'root', invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: id });
  return { index, progress, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
      recordId: id, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress })) };
}

describe('shared Account workflow run owner', () => {
  it('admits only the listed facts of each accepted program on a Run list page', async () => {
    // Every list page and background Run refresh re-reads every listed Run's
    // accepted snapshot. The page shows names, origin, place and starter, so
    // the work must not scale with the frozen program's size.
    const objectsAdmittedForListing = async (steps: number) => {
      const sized = validateWorkflowDefinition({ ...definition, blocks: Array.from({ length: steps }, (_, index) => `work ${index}`) })
        .normalizedDefinition!;
      const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: sized, context: {
        source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null },
        inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: 'origin-1' }, authorization: { principal: { kind: 'host' } },
      }, admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
      if (!materialized.ok) throw new Error('snapshot_fixture_failed');
      // E2EE is the product read: the stored envelope is one opaque string.
      const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
      const encryption: AvailableAutomationAccountEncryptionV1 = { kind: 'available', material,
        witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: material.contentPublicKeyFingerprint } };
      const prepared = prepareWorkflowRunDataKeyV1({ accountId: 'account-1', encryption, randomBytes });
      if (prepared.runCrypto.mode !== 'e2ee') throw new Error('run_key_fixture_failed');
      const snapshot = runSnapshot();
      snapshot.keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ ...snapshot.keyCensus,
        encryptionMode: 'e2ee', ownerAccountCurrentness: encryption.witness,
        dataEncryptionKey: prepared.recipientKeyEnvelopes[0]!.encryptedDataKey,
        callerDataEncryptionKey: prepared.recipientKeyEnvelopes[0]!.encryptedDataKey });
      snapshot.acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'e2ee', runDataKey: prepared.runCrypto.runDataKey, randomBytes,
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: materialized.snapshot,
      }));
      const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async () => ({ runs: [snapshot.run],
        acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope }, keyCensusByRunId: { [runId]: snapshot.keyCensus } }) }),
      resolveEncryption: async () => encryption });
      await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} });
      // Every structural JSON walk and strict copy registers each object it
      // visits in a WeakSet, so this counts the objects a page admits.
      const add = vi.spyOn(WeakSet.prototype, 'add');
      try {
        const page = await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} });
        expect(page.runs[0]).toMatchObject({ id: runId, startedBy: 'user', where: { machineId: 'machine-a', directory: '/repo' },
          origin: { kind: 'direct', originSessionId: 'origin-1' } });
        return add.mock.calls.length;
      } finally {
        add.mockRestore();
      }
    };
    expect(await objectsAdmittedForListing(40)).toBe(await objectsAdmittedForListing(1));
  });

  it('projects frozen source authorship without reading the current definition or Run detail', async () => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    for (const savedBy of [
      { kind: 'person', accountId: 'account-1' },
      { kind: 'person', accountId: 'earlier-editor' },
      { kind: 'agent', accountId: 'account-1', sessionId: 'author-session' },
      null,
    ] as const) {
      const snapshot = runSnapshot();
      const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...acceptedSnapshotResult.snapshot,
        source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy } });
      snapshot.acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: accepted,
      }));
      const reads: string[] = [];
      const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
        reads.push(operation.operation);
        if (operation.operation !== 'list') throw new Error('unexpected_detail_read');
        return { runs: [snapshot.run], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
          keyCensusByRunId: { [runId]: snapshot.keyCensus } };
      } }), definitions: { get: async () => { throw new Error('mutable_source_read'); } } });
      const page = await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} });
      expect(page.runs[0]).toMatchObject(savedBy === null ? { id: runId }
        : { sourceSavedBy: { kind: savedBy.kind, accountId: savedBy.accountId } });
      if (savedBy === null) expect(page.runs[0]).not.toHaveProperty('sourceSavedBy');
      expect(reads).toEqual(['list']);
    }
  });

  it('keeps membership private facts unrequested and rejects mismatched storage projection modes', async () => {
    const snapshot = runSnapshot();
    let projection: unknown = 'membership';
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async () => ({
      runs: [snapshot.run], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, rootProgressByRunId: {},
      heldProgressByRunId: {}, ...(projection === undefined ? {} : { projection }), nextCursor: 'next',
    }) }), resolveEncryption: async () => { throw new Error('membership_must_not_resolve_private_encryption'); } });
    const input = WorkflowRunListRequestV1Schema.parse({ attention: 'required', projection: 'membership' });
    expect(await owner.execute({ actionId: 'workflow.run.list', input, context: {} })).toEqual({
      projection: 'membership', runs: [snapshot.run], metadataByRunId: {}, nextCursor: 'next',
    });
    for (const invalid of [undefined, 'full', null]) {
      projection = invalid;
      await expect(owner.execute({ actionId: 'workflow.run.list', input, context: {} }))
        .rejects.toMatchObject({ code: 'content_unavailable' });
    }
    projection = 'membership';
    await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }))
      .rejects.toMatchObject({ code: 'content_unavailable' });
    await expect(owner.execute({ actionId: 'workflow.run.list', input, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    } })).rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it.each([401, 403])('preserves an untyped HTTP %s history refusal as access denied during Another round', async status => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const rounds = { ...definition, inputs: [{ name: 'previousRoundContext', valueType: 'json' as const, required: false }] };
    const original = runSnapshot();
    original.run.state = 'cancelled';
    original.acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: { ...acceptedSnapshotResult.snapshot, definition: rounds, authoredDefinition: rounds },
    }));
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') return original;
      if (operation.operation === 'invocations.list') throw Object.assign(new Error('HTTP refusal'), {
        code: 'ERR_BAD_REQUEST', response: { status, data: null },
      });
      throw new Error('refused_history_must_not_admit');
    } }));
    try {
      await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({
        runId: '22222222-2222-4222-8222-222222222222', source: { kind: 'inline', definition: rounds,
          replay: { runId, intent: 'another_round' } },
      }), context: { surface: 'ui', authority: 'present_user' } });
      expect.fail('The refused source history must prevent admission');
    } catch (error) {
      expect(normalizeWorkflowActionThrownError(error)).toMatchObject({ ok: false, errorCode: 'run_access_denied' });
    }
  });
  it('discovers Discussion runs after an irrelevant first page without forwarding a private origin filter to storage', async () => {
    const first = runSnapshot();
    const targetId = '22222222-2222-4222-8222-222222222222';
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const continuationDefinition = validateWorkflowDefinition({ ...definition, inputs: [
      { name: 'previousRoundContext', valueType: 'json', required: false },
    ] }).normalizedDefinition!;
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...acceptedSnapshotResult.snapshot,
      definition: continuationDefinition, authoredDefinition: continuationDefinition,
      origin: { kind: 'direct', discussion: { discussion: { serverId: 'home', discussionId: 'discussion-1' },
        messageId: 'question-1', throughSeq: 7 } } });
    const targetEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: targetId }, acceptedSnapshot: accepted }));
    const requests: unknown[] = [];
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'list') throw new Error('unexpected_storage_operation');
      requests.push(operation.request);
      const next = (operation.request as { cursor?: string }).cursor === 'next-page';
      const run = next ? { ...first.run, id: targetId } : first.run;
      return { runs: [run], acceptedEnvelopesByRunId: { [run.id]: next ? targetEnvelope : first.acceptedEnvelope },
        keyCensusByRunId: { [run.id]: { ...first.keyCensus, runId: run.id } }, ...(next ? {} : { nextCursor: 'next-page' }) };
    } }));
    const page = await owner.execute({ actionId: 'workflow.run.list', input: { originDiscussionId: 'discussion-1' },
      context: { surface: 'ui', serverId: 'home' } });
    expect(page).toMatchObject({ runs: [{ id: targetId, origin: accepted.origin }], supportsAnotherRoundByRunId: { [targetId]: true },
      callerAccessByRunId: { [targetId]: { canEdit: true } } });
    expect(requests).toEqual([{}, { cursor: 'next-page' }]);
    await expect(owner.execute({ actionId: 'workflow.run.list', input: { originDiscussionId: 'discussion-1' },
      context: { surface: 'ui', serverId: 'other-home' } })).resolves.toMatchObject({ runs: [] });
  });
  it.each([
    { name: 'a lost admission reply', failure: Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }), code: 'workflow_outcome_unresolved' },
    { name: 'a received storage refusal', failure: Object.assign(new Error('HTTP 503'), { response: { status: 503, data: { error: 'storage_unavailable' } } }), code: 'storage_unavailable' },
  ])('reports $name as $code, so only an unconfirmed admission is rejoined instead of claiming failure', async ({ failure, code }) => {
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
      throw failure;
    } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
      machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    await expect(owner.execute({ actionId: 'workflow.run.start',
      input: WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition } }),
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default',
        externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } },
    })).rejects.toMatchObject({ code });
  });
  it.each([
    { delivers: true, home: 'home', bound: false, contextBinding: false },
    { delivers: false, home: 'home', bound: false, contextBinding: false },
    { delivers: true, home: 'stack_qa', bound: true, contextBinding: false },
    { delivers: false, home: 'stack_qa', bound: true, contextBinding: true },
  ])('freezes an authorized Discussion question across lost-start rejoin and accepted projection ($home, delivery: $delivers)', async ({ delivers, home, bound, contextBinding }) => {
    const discussion = { serverId: bound ? 'srv_qa' : 'home', discussionId: 'discussion-1' };
    const origin = { kind: 'discussion' as const, discussion, addressingMessageId: 'question-1' };
    let mayRead = true;
    let committed: ReturnType<typeof runSnapshot> | undefined;
    const invocationId = '33333333-3333-4333-8333-333333333333';
    const admitted: Array<Readonly<Record<string, unknown>>> = [];
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'list' && committed) return { runs: [committed.run],
        acceptedEnvelopesByRunId: { [runId]: committed.acceptedEnvelope },
        keyCensusByRunId: { [runId]: committed.keyCensus } };
      if (operation.operation === 'invocations.list') return { invocations: [] };
      if (operation.operation === 'invocations.get') {
        const index = { id: invocationId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
          contentRevision: '0', lifecycle: 'completed', createdAt: runSnapshot().run.createdAt, updatedAt: runSnapshot().run.updatedAt };
        return { invocation: { index, parentRevision: 0, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(
          sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'invocation_progress',
            accountId: 'account-1', runId, recordId: invocationId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
          progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
            blockKind: 'step', attempt: '0', logicalInvocationRecordId: invocationId } })) } };
      }
      if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
      admitted.push(operation);
      committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
      return { kind: 'created', run: committed.run };
    } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
      machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
        readActionContract: async actionId => {
          const spec = getActionSpec(ActionIdSchema.parse(actionId));
          return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(spec));
        } } }),
      // The host's established local-profile/portable-Home binding.
      resolveServerProfileScopeId: identifier => !contextBinding && ['stack_qa', 'srv_qa'].includes(identifier) ? 'srv_qa' : null,
      // Authorized Discussion transport is the genuine resource boundary.
      resolveDiscussionOrigin: async () => {
        if (!mayRead) throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
        return { discussion, messageId: 'question-1', throughSeq: 7 };
      },
    });
    const authored = { ...definition, blocks: [...definition.blocks, { kind: 'action', id: 'read-source',
      actionId: 'reviews.comments.list', input: { sessionId: { kind: 'literal', value: 'source-session' } },
      execution: { conversation: { kind: 'existing_session', sessionId: 'source-session', machineId: 'machine-a' } } }] };
    const request = WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition: authored },
      origin, ...(delivers ? { onComplete: { kind: 'originating_discussion' } } : {}) });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: home, callerPermissionMode: 'default',
      ...(contextBinding ? { serverIdentityId: 'srv_qa' } : {}),
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    const projectedOrigin = { kind: 'direct', discussion: { discussion, messageId: 'question-1', throughSeq: 7 } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input: request, context }))
      .resolves.toMatchObject({ admission: 'created', run: { origin: projectedOrigin } });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    expect(opened).toMatchObject({ kind: 'available', content: {
      origin: { kind: 'direct', discussion: { discussion, messageId: 'question-1', throughSeq: 7 } },
      ...(delivers ? { resultDelivery: { kind: 'originating_discussion', discussion, messageId: 'question-1', throughSeq: 7 } } : {}),
    } });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: request, context }))
      .resolves.toMatchObject({ admission: 'existing', run: { origin: projectedOrigin } });
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ discussionTargetSessionIds: [] });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { ...request,
      origin: { ...origin, addressingMessageId: 'different-question' } }, context })).rejects.toMatchObject({ code: 'currentness_conflict' });
    const get = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context });
    expect(get).toMatchObject({ run: { origin: projectedOrigin }, acceptedContext: { origin: { kind: 'direct', discussion: {
      discussion, messageId: 'question-1', throughSeq: 7,
    } } } });
    const discussionList = { actionId: 'workflow.run.list' as const,
      input: WorkflowRunListRequestV1Schema.parse({ originDiscussionId: discussion.discussionId }) };
    await expect(owner.execute({ ...discussionList, context }))
      .resolves.toMatchObject({ runs: [{ id: runId, origin: projectedOrigin }] });
    for (const serverId of ['srv_foreign', 'stack_unknown']) {
      await expect(owner.execute({ ...discussionList,
        context: { ...context, serverId, serverIdentityId: undefined } })).resolves.toMatchObject({ runs: [] });
    }
    const unused = (): never => { throw new Error('capture_must_not_save_or_start'); };
    const definitions = createWorkflowDefinitionActions({ artifactStore: { read: unused, list: unused, create: unused, update: unused, delete: unused },
      encodeListCursor: unused, assertDefinitionWriteAllowed: unused });
    let captureAttachment = false;
    const capture = createActionExecutor({ workflowAction: createWorkflowActionExecutor({ definitions, runs: owner, isWorkflowFeatureEnabled: () => true }),
      discussionAction: async () => ({ v: 1, serverId: discussion.serverId, discussionId: discussion.discussionId,
        messageSeq: 8, incomplete: false, hasMoreOlder: false, messages: [{ id: 'published-answer', discussionId: discussion.discussionId,
          seq: 8, localId: null, authorAccountId: null, accountActor: null, mentionedAccountIds: [], createdAt: 8,
          messageRef: { kind: 'discussion', discussion, messageId: 'published-answer' },
          producerV1: delivers ? { v: 1, kind: 'agent', sessionId: 'participant', replyReturn: { serverId: discussion.serverId, requestLocalId: 'original-input',
            workflow: { runId, invocationRecordId: invocationId, invocationAttempt: '0' }, outcome: 'answer' } }
            : { v: 1, kind: 'workflow', runId, invocationRecordId: invocationId, invocationAttempt: '0',
              execution: { kind: 'action', actionId: 'reviews.comments.list' }, outcome: 'answer' },
          content: { v: 1, parts: [{ t: 'text', text: 'NATIVE_RESULT_MUST_NOT_BECOME_A_PROMPT' },
            ...(captureAttachment ? [{ t: 'attachment', attachment: { kind: 'folder', id: '7578de54-3f59-4d6d-8293-ff6e4682fd11', name: 'project', entries: [], directories: [] } }] : []),
          ] },
        }] }),
    } as unknown as ActionExecutorDeps);
    expect(await capture.execute('workflow.definition.capture', { discussion, messageIds: ['published-answer'], choices: [] },
      { ...context, serverId: discussion.serverId }))
      .toMatchObject({ ok: true, result: { status: 'ready', definition: authored, provenance: { workflow: { runId, source: { kind: 'inline' } } } } });
    captureAttachment = true;
    expect(await capture.execute('workflow.definition.capture', { discussion, messageIds: ['published-answer'], choices: [] },
      { ...context, serverId: discussion.serverId })).toMatchObject({ ok: true, result: { status: 'needs_review', definition: null,
        unresolved: expect.arrayContaining([{ messageId: 'published-answer', reason: 'unsupported_content' }]) } });
    const invocation = await owner.execute({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId }, context });
    if (delivers) expect(invocation).toMatchObject({ discussionResultDelivery: { kind: 'originating_discussion', discussion,
      messageId: 'question-1', throughSeq: 7 } });
    else expect(invocation).not.toHaveProperty('discussionResultDelivery');
    mayRead = false;
    await expect(owner.execute({ actionId: 'workflow.run.start', input: request, context })).rejects.toMatchObject({ code: 'run_access_denied' });
  });
  it.each(['srv_foreign', 'stack_unknown'])('refuses an unbound Discussion Home %s before disclosure or admission', async serverId => {
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      throw new Error('foreign_home_must_not_admit');
    } }), resolveMaterializationContext: async () => { throw new Error('foreign_home_must_not_materialize'); },
      resolveServerProfileScopeId: identifier => ['stack_qa', 'srv_qa'].includes(identifier) ? 'srv_qa' : null,
      resolveDiscussionOrigin: async () => { throw new Error('foreign_home_must_not_read'); },
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({
      runId, source: { kind: 'inline', definition }, origin: { kind: 'discussion',
        discussion: { serverId, discussionId: 'discussion-1' }, addressingMessageId: 'question-1' },
    }), context: { surface: 'ui', authority: 'present_user', serverId: 'stack_qa', callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    } })).rejects.toMatchObject({ code: 'run_access_denied' });
  });
  it.each(['self', 'other'] as const)('bounds native active waits and immediately observes settled terminal Runs (%s target)', async scenario => {
    const address = { serverId: 'home', sessionId: 'self' };
    const authored = { version: 1, defaults: {}, inputs: [{ name: 'chosen', valueType: 'json', required: true,
      inputType: { hostType: 'agentParticipant' } }], blocks: [{ kind: 'step', id: 'work',
      document: { text: 'Work', references: [], attachments: [] },
      execution: { participant: { kind: 'input', name: 'chosen' } } }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'inline' }, inputs: { chosen: { kind: 'session', session: address } },
        machineId: 'machine-a', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
        resolveSessionTarget: async () => ({ address, machineId: 'machine-a' }) } });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const base = runSnapshot();
    const snapshot = { ...base, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: accepted.snapshot,
    })) };
    let terminal = false;
    let custody: 'pending' | 'settled' = 'pending';
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'invocations.list') return { invocations: [] };
      if (operation.operation === 'wait' && terminal) return { observation: 'terminal', matchedCondition: 'terminal',
        run: { ...snapshot.run, state: 'failed', workflowCustodyState: custody } };
      if (operation.operation === 'wait') return { observation: 'paused', matchedCondition: 'paused',
        run: { ...snapshot.run, state: 'paused' } };
      throw new Error('unexpected_storage_operation');
    } }), doesImmediateEligibleStepTargetSession: ({ materializedLeaves, inputs, sessionId }) => {
      const conversation = resolveWorkflowAcceptedStepSelectionV1(materializedLeaves[0]!, undefined, inputs).selection.conversation;
      return conversation?.kind === 'existing_session' && conversation.sessionId === sessionId;
    } });
    const unexpected = (): never => { throw new Error('unexpected_artifact_operation'); };
    const definitions = createWorkflowDefinitionActions({
      encodeListCursor: unexpected, assertDefinitionWriteAllowed: unexpected,
      artifactStore: { read: unexpected, list: unexpected, create: unexpected, update: unexpected, delete: unexpected },
    });
    // Only persistence is a boundary: exercise the shared Action adapter and
    // Run owner together, enforcing caller lifetime before target safety.
    const actions = createActionExecutor({ workflowAction: createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: () => true, definitions, runs: owner,
    }) } as unknown as ActionExecutorDeps);
    for (const surface of ['ui', 'agent', 'mcp'] as const) {
      for (const timeoutSeconds of [undefined, 120]) {
        const pending = actions.execute('workflow.run.wait', {
          runId, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        }, { surface, defaultSessionId: scenario, callerPermissionMode: 'yolo' });
        // API-WF §4/§9: the immediate-target check cannot prove that a
        // future branch never needs this occupied calling Session.
        if (surface !== 'ui' && timeoutSeconds === undefined) {
          await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
        } else if (surface !== 'ui' && scenario === 'self') {
          await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'workflow_wait_self_dependency' });
        } else await expect(pending).resolves.toMatchObject({ ok: true, result: { observation: 'paused' } });
      }
    }
    for (const surface of ['agent', 'mcp'] as const) {
      await expect(actions.execute('workflow.run.wait', { runId }, { surface, callerPermissionMode: 'yolo' }))
        .resolves.toMatchObject({ ok: true, result: { observation: 'paused' } });
    }
    // A terminal observation returns immediately, even if a retained accepted
    // input names the occupied caller: it cannot wait on a future branch.
    terminal = true;
    for (const surface of ['agent', 'mcp'] as const) {
      await expect(actions.execute('workflow.run.wait', { runId, conditions: ['terminal'] }, {
        surface, defaultSessionId: scenario, callerPermissionMode: 'yolo',
      })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    }
    custody = 'settled';
    for (const surface of ['ui', 'agent', 'mcp'] as const) {
      await expect(actions.execute('workflow.run.wait', { runId, conditions: ['terminal'] }, {
        surface, defaultSessionId: scenario, callerPermissionMode: 'yolo',
      })).resolves.toMatchObject({ ok: true, result: { observation: 'terminal', run: { state: 'failed' } } });
    }
    for (const surface of ['agent', 'mcp'] as const) {
      await expect(actions.execute('workflow.run.wait', { runId }, {
        surface, defaultSessionId: scenario, callerPermissionMode: 'yolo',
        onWaitSnapshot: () => { throw new Error('unbounded_native_sink_must_not_run'); },
      })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    }
  });
  it.each(['own', 'led', 'host', 'current_only', 'read_identity', 'revoked'] as const)('retains current Session authority for an Action-only %s start and rejoin', async scenario => {
    const address = { serverId: 'home', sessionId: scenario === 'own' ? 'origin-1' : 'review-target' };
    const authored = { version: 1, defaults: {}, inputs: [{ name: 'reviewSession', valueType: 'json', required: true,
      inputType: { hostType: 'session' } }], blocks: [{ kind: 'action', id: 'comments', actionId: 'reviews.comments.list',
      input: { sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] } } }] };
    let committed: ReturnType<typeof runSnapshot> | undefined;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
      committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
      return { kind: 'created', run: committed.run };
    } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
      machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      sessionList: async () => markSessionListQueryResultV1({ sessions: [{ id: address.sessionId, active: false, presence: 'offline', updatedAt: 1 }],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
        resolveSessionTarget: async () => scenario === 'revoked' ? null : { address, machineId: 'machine-a' },
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default',
        ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const args = { actionId: 'workflow.run.start' as const,
      input: WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition: authored }, inputs: { reviewSession: address } }),
      context: { surface: scenario === 'host' ? 'ui' as const : 'agent' as const,
        authority: scenario === 'host' ? 'present_user' as const : 'account_automation' as const,
        serverId: 'home', callerPermissionMode: 'default',
        sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({}),
        ...(scenario === 'current_only' || scenario === 'read_identity' ? { sessionListAccess: 'current_session' as const } : {}),
        ...(scenario === 'host' ? {} : { actionCaller: { kind: 'session' as const, sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 } }),
        defaultSessionId: 'origin-1', externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } };
    if (scenario === 'read_identity') {
      // A real read grant must not become the producer of a starter's frozen
      // Session authority. Keep both policies real to catch read-identity wiring.
      await expect(resolveActionCurrentSessionScopeFailure('reviews.comments.list', address, args.context,
        { sessionId: 'current_session' }, {
          resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 },
            baseline: { machineId: 'machine-a', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default',
            ledSubtreeSessionIds: [], workDepthLimit: 4 }),
          sessionList: async () => markSessionListQueryResultV1({ sessions: [{ id: address.sessionId, active: false, presence: 'offline', updatedAt: 1 }],
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }),
        })).resolves.toBeNull();
      const unexpected = (): never => { throw new Error('unexpected_artifact_operation'); };
      const definitions = createWorkflowDefinitionActions({ encodeListCursor: unexpected, assertDefinitionWriteAllowed: unexpected,
        artifactStore: { read: unexpected, list: unexpected, create: unexpected, update: unexpected, delete: unexpected } });
      const actions = createActionExecutor({ workflowAction: createWorkflowActionExecutor({
        isWorkflowFeatureEnabled: () => true, definitions, runs: owner,
      }), resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default',
        ledSubtreeSessionIds: [], workDepthLimit: 4 }) });
      await expect(actions.execute('workflow.run.start', args.input, args.context)).resolves.toMatchObject({
        ok: false, errorCode: 'subtree_denied',
      });
      expect(committed).toBeUndefined();
    } else if (scenario === 'current_only' || scenario === 'revoked') {
      await expect(owner.execute(args).catch(normalizeWorkflowActionThrownError)).resolves.toMatchObject({ ok: false,
        errorCode: scenario === 'current_only' ? 'subtree_denied' : 'invalid_input' });
      expect(committed).toBeUndefined();
    } else {
      await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'created' });
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!,
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
      expect(opened).toMatchObject({ kind: 'available', content: { materializedLeaves: [{ sessionAuthorityBindings: [
        { inputName: 'reviewSession', targets: [{ address, machineId: 'machine-a' }] },
      ] }] } });
      await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'existing' });
    }
  });
  it.each(['root', 'nested', 'plugin', 'mcp', 'foreign_home'] as const)('refuses a Session starter laundering an unrelated typed Session in an Action-only %s Workflow', async scenario => {
    const address = { serverId: scenario === 'foreign_home' ? 'other-home' : 'home',
      sessionId: scenario === 'foreign_home' ? 'origin-1' : 'unrelated-session' };
    const child = { version: 1, defaults: {}, inputs: [{ name: 'reviewSession', valueType: 'json', required: true,
      inputType: { hostType: 'session' } }], blocks: [{ kind: 'action', id: 'comments', actionId: 'reviews.comments.list',
      input: { sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] } } }] };
    const authored = scenario === 'nested' ? { version: 1, defaults: {}, blocks: [{ kind: 'workflow', id: 'child',
      workflowRef: 'plugin:external.workflow/review', input: { reviewSession: { kind: 'literal', value: address } } }] } : child;
    let admitted = false;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
      admitted = true;
      return { kind: 'created', run: runSnapshot().run };
    } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
      machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      readPluginWorkflows: () => [{ workflow: 'plugin:external.workflow/review', pluginId: 'external.workflow', version: '1', title: 'Review', definition: child }],
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
        resolveSessionTarget: async () => ({ address, machineId: 'machine-a' }),
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }) } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default',
        ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const source = scenario === 'plugin' ? { kind: 'catalog' as const, workflow: 'plugin:external.workflow/review' }
      : { kind: 'inline' as const, definition: authored };
    const executor = createActionExecutor({ workflowAction: async args => {
      if (args.actionId !== 'workflow.run.start') throw new Error('unexpected_workflow_action');
      try { return { ok: true, result: await owner.execute(args) }; }
      catch (error) { return normalizeWorkflowActionThrownError(error); }
    }, resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine-a', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default',
      ledSubtreeSessionIds: [], workDepthLimit: 4 }) });
    await expect(executor.execute('workflow.run.start', WorkflowRunStartRequestV1Schema.parse({ runId, source,
      ...(scenario === 'nested' ? {} : { inputs: { reviewSession: address } }) }), {
      surface: scenario === 'mcp' ? 'mcp' : 'agent', authority: 'account_automation', serverId: 'home', callerPermissionMode: 'default',
      sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({}),
      actionCaller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'origin-1',
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'subtree_denied' });
    expect(admitted).toBe(false);
  });
  it.each(['admitted', 'scale', 'originless', 'retry', 'recovered_parent', 'revoked_recovered_parent', 'wrong_attempt', 'other_slot', 'different', 'revoked', 'miswired', 'foreign_home', 'session_caller', 'untyped', 'unreadable', 'no_witness', 'other_action'] as const)(
    'restricts Workflow Action scope to the current accepted typed reviewSession: %s', async scenario => {
      const address = { serverId: 'home', sessionId: 'review-target' };
      const scopedActionId = scenario === 'other_action' ? 'session.stop' : 'reviews.comments.list';
      const action = {
        kind: 'action' as const, id: 'read', actionId: scopedActionId, input: {
          sessionId: { kind: 'input' as const, name: 'reviewSession', path: ['sessionId'] },
        },
      };
      const unrelated = scenario === 'scale' ? Array.from({ length: 500 }, (_, index) => ({ ...action, id: `unrelated-${index}` })) : [];
      const recoveredParent = scenario === 'recovered_parent' || scenario === 'revoked_recovered_parent';
      const scopedDefinition = { ...definition, inputs: [{ name: 'reviewSession', valueType: 'json' as const, required: true,
        ...(scenario === 'untyped' ? {} : { inputType: { hostType: 'session' as const } }) }], blocks: recoveredParent ? [{
          kind: 'if' as const, id: 'selected', when: { kind: 'compare' as const, operator: 'eq' as const,
            left: { kind: 'literal' as const, value: true }, right: { kind: 'literal' as const, value: true } },
          then: [action], otherwise: [],
        }] : [action, ...unrelated] };
      const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: scopedDefinition,
        context: { source: { kind: 'inline' }, inputs: { reviewSession: address }, machineId: 'machine-a',
          executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
          origin: { kind: 'direct', originSessionId: 'origin-1' }, authorization: { principal: { kind: 'host' } } },
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
          resolveSessionTarget: async () => ({ address, machineId: 'machine-a' }),
          readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }) } });
      if (!materialized.ok) throw new Error(JSON.stringify(materialized.error));
      if (scenario === 'no_witness') {
        for (const leaf of materialized.snapshot.materializedLeaves) delete leaf.sessionAuthorityBindings;
      }
      const snapshot = { ...runSnapshot(), acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: materialized.snapshot,
      })) };
      const reads: string[] = [];
      const rootId = '22222222-2222-4222-8222-222222222222';
      const actionId = '33333333-3333-4333-8333-333333333333';
      const physicalId = '44444444-4444-4444-8444-444444444444';
      const retry = recoveredParent || scenario === 'retry' || scenario === 'wrong_attempt' || scenario === 'other_slot';
      const invocations = [rootId, actionId, ...(retry ? [physicalId] : [])].map((id, position) => {
        const index = WorkflowRunInvocationIndexV1Schema.parse({ id, runId, parentRecordId: position ? rootId : null,
          sequence: String(position), memberOrdinal: position === 2 && scenario === 'other_slot' ? '1' : '0',
          attempt: position === 2 ? '1' : '0', contentRevision: '0', lifecycle: position === 1 && retry ? 'superseded' : 'running',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
          blockKind: position ? 'action' : 'root', invocationPath: { blockId: position ? 'read' : '$root', scope: [] },
          attempt: index.attempt, logicalInvocationRecordId: position === 2 && scenario !== 'wrong_attempt' ? actionId : id,
          ...(position === 2 ? { previousAttemptRecordId: actionId } : {}) });
        return { index, parentRevision: 0, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
          mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
            recordId: id, sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress,
        })) };
      });
      if (recoveredParent) {
        const parentIds = ['66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888'];
        for (const [attempt, id] of parentIds.entries()) {
          const index = WorkflowRunInvocationIndexV1Schema.parse({ ...invocations[0]!.index, id, parentRecordId: rootId,
            sequence: String(invocations.length), attempt: String(attempt), lifecycle: attempt === 2 ? 'running' : 'superseded' });
          const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
            blockKind: 'if', invocationPath: { blockId: 'selected', scope: [] }, attempt: index.attempt,
            logicalInvocationRecordId: parentIds[0], ...(attempt ? { previousAttemptRecordId: parentIds[attempt - 1] } : {}),
            container: { kind: 'if', selected: 'then', nextBlockOrdinal: '0' } });
          invocations.push({ index, parentRevision: 0, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
              recordId: id, sequence: index.sequence, parentRecordId: rootId, memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress })) });
        }
        for (const position of [1, 2]) {
          const item = invocations[position]!;
          item.index.parentRecordId = position === 1 ? parentIds[0]! : parentIds[2]!;
          item.contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: item.index.id,
              sequence: item.index.sequence, parentRecordId: item.index.parentRecordId, memberOrdinal: item.index.memberOrdinal, attempt: item.index.attempt },
            progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action', invocationPath: { blockId: 'read', scope: [] },
              attempt: item.index.attempt, logicalInvocationRecordId: actionId, ...(position === 2 ? { previousAttemptRecordId: actionId } : {}) } }));
        }
      }
      for (let ordinal = 0; ordinal < unrelated.length; ordinal += 1) {
        const id = `55555555-5555-4555-8555-${String(ordinal).padStart(12, '0')}`;
        const index = WorkflowRunInvocationIndexV1Schema.parse({ ...invocations[1]!.index,
          id, sequence: String(ordinal + 2), memberOrdinal: String(ordinal + 1), lifecycle: 'completed' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
          blockKind: 'action', invocationPath: { blockId: unrelated[ordinal]!.id, scope: [] },
          attempt: '0', logicalInvocationRecordId: id });
        invocations.push({ index, parentRevision: 0, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
          mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
            recordId: id, sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress,
        })) });
      }
      const cost = { pages: 0, historyPages: 0, envelopes: 0, bytes: 0 };
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
        if (scenario === 'unreadable') throw new Error('storage_unavailable');
        if (operation.operation === 'get') return snapshot;
        // The public history-content transport supplies the complete ancestry
        // across pages; scope admission must not reopen the Run per ancestor.
        if (operation.operation === 'invocations.get') throw new Error('individual_scope_detail_read');
        if (operation.operation === 'invocations.list') {
          const selected = invocations.filter(row =>
            (operation.invocationId === undefined || row.index.id === operation.invocationId)
            && (operation.parentRecordId === undefined || row.index.parentRecordId === operation.parentRecordId)
            && (operation.memberOrdinal === undefined || row.index.memberOrdinal === operation.memberOrdinal));
          const exact = operation.invocationId !== undefined || operation.parentRecordId !== undefined;
          const rows = exact ? selected : operation.cursor === 'action-page' ? selected.slice(1) : selected.slice(0, 1);
          cost.pages += 1;
          if (!exact) cost.historyPages += 1;
          if (operation.progressEnvelopes === true) {
            cost.envelopes += rows.length;
            cost.bytes += rows.reduce((sum, row) => sum + Buffer.byteLength(row.contentEnvelope), 0);
          }
          return { invocations: rows.map(row => row.index), parentRevision: 0,
            ...(!exact && operation.cursor === undefined ? { nextCursor: 'action-page' } : {}),
            ...(operation.progressEnvelopes === true ? { keyCensus: snapshot.keyCensus,
              progressEnvelopesByInvocationId: Object.fromEntries(rows.map(row => [row.index.id, row.contentEnvelope])) } : {}) };
        }
        throw new Error('unexpected_storage_operation');
      } }));
      const context: ActionExecutorContext = { surface: 'agent', serverId: 'home',
        actionRequestId: `${runId}/${actionId}/${retry ? '1' : '0'}`,
        ...(scenario === 'originless' ? {} : { defaultSessionId: 'origin-1' }),
        actionCaller: scenario === 'session_caller' ? { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 }
          : { kind: 'workflowRun', runId, authorization: materialized.snapshot.authorization } };
      const deps = { sessionList: async () => ({ sessions: [] }),
        workflowAction: async args => {
          return owner.execute(args);
        },
        resolveSessionReference: async ({ sessionId }) => {
          reads.push(sessionId ?? '');
          return scenario === 'revoked' || scenario === 'revoked_recovered_parent' ? { kind: 'none' as const } : { kind: 'unique' as const,
            address: scenario === 'miswired' ? { ...address, sessionId: 'other' } : address };
        },
      } satisfies Pick<ActionExecutorDeps, 'sessionList' | 'workflowAction' | 'resolveSessionReference'>;
      const failure = await resolveActionCurrentSessionScopeFailure(scopedActionId, {
        sessionId: scenario === 'different' ? 'other' : address.sessionId,
        ...(scenario === 'foreign_home' ? { serverId: 'other-home' } : {}),
      }, context, { sessionId: 'current_session' }, deps);
      if (scenario === 'admitted' || scenario === 'scale' || scenario === 'originless' || scenario === 'retry' || scenario === 'recovered_parent') {
        expect(failure).toBeNull();
        expect(reads).toEqual([address.sessionId]);
      } else expect(failure).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      if (scenario === 'revoked_recovered_parent') expect(reads).toEqual([address.sessionId]);
      if (recoveredParent) expect(cost.historyPages).toBe(0);
      if (scenario === 'scale') {
        expect(cost.historyPages).toBe(0);
        expect(cost.envelopes).toBe(2);
      }
    });

  it.each(['source', 'explicit', 'originless'] as const)('admits the exact %s reviewSession through the public start owner and rejoins it', async scenario => {
    const source = { serverId: 'home', sessionId: 'origin-1' };
    const target = scenario === 'source' ? source : { serverId: 'home', sessionId: 'review-target' };
    let committed: ReturnType<typeof runSnapshot> | undefined;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
      committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
      return { kind: 'created', run: committed.run };
    } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: {
      project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' },
        availableAgentTargetKeys: ['agent:happier.agent.codex/codex'] }, effects: {
        resolveTargetAvailability: async () => true, // Machine/native availability boundary
        resolveSessionTarget: async value => value === source.sessionId || JSON.stringify(value) === JSON.stringify(source)
          ? { address: source, machineId: 'machine-a' }
          : JSON.stringify(value) === JSON.stringify(target) ? { address: target, machineId: 'review-machine' } : null,
        readActionContract: async id => {
          const parsed = ActionIdSchema.safeParse(id);
          if (!parsed.success) return null;
          const spec = getActionSpec(parsed.data);
          return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(spec));
        },
      } }),
    });
    const args = { actionId: 'workflow.run.start' as const,
      input: WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition: REVIEW_AND_CONVERGE_WORKFLOW_V1 },
        inputs: { engines: ['agent:happier.agent.codex/codex'], ...(scenario === 'source' ? {} : { reviewSession: target }) } }),
      context: { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
        ...(scenario === 'originless' ? {} : { defaultSessionId: source.sessionId }),
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } };
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'created' });
    const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    expect(accepted).toMatchObject({ kind: 'available', content: { inputs: { reviewSession: target },
      materializedLeaves: expect.arrayContaining([
        expect.objectContaining({ blockId: 'verify', selection: { conversation: { kind: 'existing_session', sessionId: target.sessionId,
          machineId: scenario === 'source' ? 'machine-a' : 'review-machine' } } }),
        expect.objectContaining({ blockId: 'disputes', actionInput: { sessionId: target.sessionId, allPages: true } }),
        expect.objectContaining({ blockId: 'review', actionInput: expect.objectContaining({ sessionId: target.sessionId }) }),
      ]) } });
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'existing' });
  });
  it('starts an input-bound engine roster through the ordinary Action and rejoins its accepted snapshot', async () => {
    const engines = [
      { agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'answerer' } } },
      { agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'reviewer' } } },
    ];
    const authored = { version: 1, inputs: [{ name: 'engines', valueType: 'json', required: true }], defaults: {}, blocks: [{
      kind: 'loop', id: 'panel', repetition: { kind: 'items', items: { kind: 'input', name: 'engines' },
        execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [{
        kind: 'step', id: 'answer', document: { text: 'Answer independently.', references: [], attachments: [] },
        execution: { engine: { kind: 'item', field: 'value' }, conversation: { kind: 'fresh' } },
      }],
    }] };
    let committed: ReturnType<typeof runSnapshot> | undefined;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
      committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
      return { kind: 'created', run: committed.run };
    } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: {
      project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition: authored }, inputs: { engines } });
    const actionRequestAttributionV1 = { requestRef: 'accepted-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'release-bot' }, origin: null };
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'discussion.invite': { approvalRequiredSurfaces: ['ui'] },
    } });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default', defaultSessionId: 'origin-1',
      actionRequestAttributionV1, actionsSettings,
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'created' });
    const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    expect(accepted).toMatchObject({ kind: 'available', content: { origin: { kind: 'direct', originSessionId: 'origin-1', actionRequestAttributionV1,
      actionPolicy: { surface: 'ui', authority: 'present_user', actionsSettings } },
      materializedLeaves: [{ engineBindings: { selections: engines.map(value => ({ value, selection: { agentTarget: value.agentTarget } })) } }] } });
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'existing' });
  });
  it.each(['plain', 'e2ee'] as const)('decodes each large accepted snapshot once per Run list open (%s)', async mode => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }
      : { kind: 'available', material, witness: { mode, version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) } };
    const largeDefinition = { ...definition, blocks: Array.from({ length: 100 }, (_, i) => ({
      kind: 'wait' as const, id: `review-${i}`, document: { text: 'Review the proposed implementation. '.repeat(30), references: [], attachments: [] },
      result: { kind: 'text' as const },
    })) };
    const acceptedResult = await materializeWorkflowAcceptedSnapshotV1({ definition: largeDefinition,
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: 'origin-1' }, authorization: { principal: { kind: 'host' } },
        metadata: { title: 'Large accepted Run' } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!acceptedResult.ok) throw new Error(`large_snapshot_fixture_failed: ${acceptedResult.error.code}`);
    // Keep the regression small; the opt-in benchmark exercises the captured
    // representative page size without making every suite run a CPU benchmark.
    const snapshots = Array.from({ length: process.env.HAPPIER_PERF_C24_MEASURE === '1' ? 43 : 2 }, (_, i) => {
      const snapshot = runSnapshot();
      const id = `perf-c24-run-${i}`;
      const prepared = prepareWorkflowRunDataKeyV1({ accountId: 'account-1', encryption, randomBytes });
      const key = prepared.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
      return { ...snapshot, run: { ...snapshot.run, id },
        keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({ ...snapshot.keyCensus, runId: id,
          encryptionMode: mode, ownerAccountCurrentness: encryption.witness, dataEncryptionKey: key, callerDataEncryptionKey: key }),
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
          ...prepared.runCrypto, randomBytes, binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: id },
          acceptedSnapshot: acceptedResult.snapshot,
        })),
      };
    });
    const page = { runs: snapshots.map(snapshot => snapshot.run),
      acceptedEnvelopesByRunId: Object.fromEntries(snapshots.map(snapshot => [snapshot.run.id, snapshot.acceptedEnvelope])),
      keyCensusByRunId: Object.fromEntries(snapshots.map(snapshot => [snapshot.run.id, snapshot.keyCensus])) };
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation !== 'list') throw new Error('list_must_use_batched_page');
      return page;
    } }), resolveEncryption: async () => encryption, randomBytes });
    const ciphertexts = new Set(snapshots.flatMap(snapshot => {
      const envelope = parseWorkflowStoredContentEnvelopeV1(snapshot.acceptedEnvelope);
      return envelope?.t === 'encrypted' ? [envelope.c.slice('wfr1:'.length)] : [];
    }));
    // Instrumentation only: both spies call the real codec. Filter out the
    // independent recipient-key codec so this measures accepted-snapshot work.
    const decode = vi.spyOn(base64, 'decodeBase64');
    const encode = vi.spyOn(base64, 'encodeBase64');
    const measurements: { ms: number; decodes: number; encodes: number }[] = [];
    try {
      for (let demand = 0; demand < 3; demand++) {
        decode.mockClear(); encode.mockClear();
        const started = performance.now();
        const result = await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} });
        const ms = performance.now() - started;
        expect(result).toMatchObject({ runs: snapshots.map(snapshot => ({ id: snapshot.run.id,
          startedBy: 'user', where: { machineId: 'machine-a', directory: '/repo' } })),
          metadataByRunId: Object.fromEntries(snapshots.map(snapshot => [snapshot.run.id,
            { kind: 'available', value: { title: 'Large accepted Run' } }])) });
        measurements.push({ ms,
          decodes: decode.mock.calls.filter(([value]) => ciphertexts.has(value)).length,
          encodes: encode.mock.results.filter(result => result.type === 'return' && ciphertexts.has(result.value)).length });
      }
      if (process.env.HAPPIER_PERF_C24_MEASURE === '1') console.info('PERF-C24', JSON.stringify({
        mode, runs: snapshots.length, steps: largeDefinition.blocks.length,
        envelopeUtf8Bytes: new TextEncoder().encode(snapshots[0]!.acceptedEnvelope).byteLength, measurements,
      }));
      expect(measurements.map(({ decodes, encodes }) => ({ decodes, encodes })))
        .toEqual(Array.from({ length: 3 }, () => ({ decodes: mode === 'e2ee' ? snapshots.length : 0,
          encodes: mode === 'e2ee' ? snapshots.length : 0 })));
    } finally { decode.mockRestore(); encode.mockRestore(); }
  });

  it('opens an E2EE Run page from its batched census without depending on per-Run census reads', async () => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
    const encryption: AvailableAutomationAccountEncryptionV1 = { kind: 'available', material,
      witness: { mode: 'e2ee', version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) } };
    const snapshots = [runId, '22222222-2222-4222-8222-222222222222'].map(id => {
      const snapshot = runSnapshot();
      const prepared = prepareWorkflowRunDataKeyV1({ accountId: 'account-1', encryption, randomBytes });
      const key = prepared.recipientKeyEnvelopes[0]!.encryptedDataKey;
      return { ...snapshot, run: { ...snapshot.run, id },
        keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({ ...snapshot.keyCensus, runId: id,
          encryptionMode: 'e2ee', ownerAccountCurrentness: encryption.witness, dataEncryptionKey: key, callerDataEncryptionKey: key }),
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
          ...prepared.runCrypto, randomBytes,
          binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: id },
          acceptedSnapshot: { ...acceptedSnapshotResult.snapshot, metadata: { title: 'Readable from the page' } },
        })),
      };
    });
    // Storage is the system boundary. The authorized page already carries each
    // census; an unavailable redundant endpoint must not lock readable content.
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation !== 'list') throw new Error('redundant_census_unavailable');
      return { runs: snapshots.map(snapshot => snapshot.run),
        acceptedEnvelopesByRunId: Object.fromEntries(snapshots.map(snapshot => [snapshot.run.id, snapshot.acceptedEnvelope])),
        keyCensusByRunId: Object.fromEntries(snapshots.map(snapshot => [snapshot.run.id, snapshot.keyCensus])) };
    } }), resolveEncryption: async () => encryption, randomBytes });
    await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} })).resolves.toMatchObject({
      runs: snapshots.map(snapshot => ({ id: snapshot.run.id, where: { machineId: 'machine-a', directory: '/repo' }, startedBy: 'user' })),
      metadataByRunId: Object.fromEntries(snapshots.map(snapshot => [snapshot.run.id,
        { kind: 'available', value: { title: 'Readable from the page' } }])),
    });
  });

  it.each([false, true])('projects the held authored step and lane from the attention list, including frozen children (%s)', async nested => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const childResult = validateWorkflowDefinition({ version: 1, defaults: {}, blocks: [{ kind: 'parallel', id: 'lanes', failurePolicy: 'collect_outcomes',
      branches: [{ id: 'changelog', name: 'Changelog', blocks: [{ kind: 'wait', id: 'review', name: 'Review the changelog',
        document: { text: 'Review it', references: [], attachments: [] }, result: { kind: 'text' } }] }] }] });
    if (!childResult.normalizedDefinition) throw new Error(JSON.stringify(childResult.issues));
    const child = childResult.normalizedDefinition;
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...acceptedSnapshotResult.snapshot,
      definition: nested ? { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'workflow', id: 'child', workflowRef: 'builtin:child', input: {} }] } : child,
      frozenChildren: nested ? { 'builtin:child': child } : {},
    });
    const snapshot = runSnapshot();
    snapshot.acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: accepted,
    }));
    const index = { id: 'held-review', runId, sequence: '4', parentRecordId: 'branch-frame', memberOrdinal: '0', attempt: '0',
      contentRevision: '7', lifecycle: 'waiting_for_review' as const, createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'wait', attempt: '0', logicalInvocationRecordId: index.id,
        invocationPath: { blockId: 'review', scope: [...(nested ? [{ kind: 'workflow' as const, blockId: 'child' }] : []),
          { kind: 'branch', blockId: 'lanes', branchId: 'changelog' }] } },
    }));
    let heldFact: unknown = { index, contentEnvelope };
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'list') throw new Error('attention_must_not_read_per_run_detail');
      return { runs: [{ ...snapshot.run, attentionRequired: true, heldCount: 5 }], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus }, heldProgressByRunId: { [runId]: heldFact } };
    } }));
    const result = await owner.execute({ actionId: 'workflow.run.list', input: { attention: 'required' }, context: {} });
    expect(result).toMatchObject({ runs: [{ heldCount: 5, heldStep: { invocationId: index.id, label: 'Review the changelog', laneLabel: 'Changelog' } }] });
    for (const unavailable of [null, { index: { ...index, lifecycle: 'completed' }, contentEnvelope },
      { index: { ...index, runId: 'other-run' }, contentEnvelope }, { index: { ...index, id: 'other-record' }, contentEnvelope }]) {
      heldFact = unavailable;
      expect(await owner.execute({ actionId: 'workflow.run.list', input: { attention: 'required' }, context: {} }))
        .toMatchObject({ runs: [{ heldCount: 5, heldStep: null, startedBy: 'user', where: { directory: '/repo' } }] });
    }
    expect(await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }))
      .toMatchObject({ runs: [{ heldStep: undefined }] });
  });
  it('distinguishes an unavailable workspace from unavailable Agent inventory before admission', async () => {
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async () => { throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' }); } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      prepareWorkspace: async () => ({ ok: false, code: 'workspace_unavailable' }),
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { kind: 'inline', definition } },
      context: { surface: 'ui', externalActionTarget: { kind: 'machine', machineId: 'machine-a',
        project: { machineId: 'machine-a', directory: '/repo' } } },
    }).catch(normalizeWorkflowActionThrownError)).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable',
      details: { code: 'target_unavailable', reason: 'workspace_unavailable' } });
  });
  it.each([
    ['Review & converge', REVIEW_AND_CONVERGE_WORKFLOW_V1, { engines: ['agent:happier.agent.codex/codex'] }, 4, undefined],
    ['Plan with a panel', PLAN_WITH_A_PANEL_WORKFLOW_V1, { request: 'Plan the change', engines: ['agent:happier.agent.codex/codex'] }, 4, undefined],
    ...(['review.start', 'subagents.plan.start'] as const).map(actionId => [actionId, {
      version: 1, defaults: {}, blocks: [
        { kind: 'wait', id: 'choose', document: { text: 'Choose engines', references: [], attachments: [] },
          result: { kind: 'json', schema: { type: 'array', items: { type: 'string' } } } },
        { kind: 'action', id: 'panel', actionId, input: {
          [actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys']: {
            kind: 'result', producer: { blockId: 'choose', scope: { kind: 'current' } }, path: [],
          },
          ...(actionId === 'review.start' ? { sessionId: { kind: 'origin_session_id' } }
            : { target: { kind: 'literal', value: { kind: 'detached' } } }),
          instructions: { kind: 'literal', value: 'Plan or review the change' },
        } },
      ],
    }, {}, 2, actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys'] as const),
  ] as const)('preserves proved authority for agent-started %s with invoke-time choices', async (name, authored, inputs, workDepthLimit, deferredInputField) => {
    let committed: ReturnType<typeof runSnapshot> | undefined;
    const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async operation => {
        if (operation.operation === 'get') {
          if (!committed) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          return committed;
        }
        if (operation.operation === 'invocations.list') return { invocations: [] };
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
        machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({
        roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' },
          availableAgentTargetKeys: ['agent:happier.agent.codex/codex'] },
        effects: { resolveTargetAvailability: async () => true,
          resolveSessionTarget: async value => typeof value === 'string'
            ? { address: { serverId: 'home', sessionId: value }, machineId: 'machine-a' }
            : value && typeof value === 'object' && !Array.isArray(value) && value.serverId === 'home' && typeof value.sessionId === 'string'
              ? { address: { serverId: value.serverId, sessionId: value.sessionId }, machineId: 'machine-a' } : null,
          readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
      }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: 1, turnDepth: 1 },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: { agentTarget: target, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit }),
    });
    const args = { actionId: 'workflow.run.start' as const, input: { runId, source: { kind: 'inline' as const, definition: authored }, inputs },
      context: { surface: 'agent' as const, authority: 'account_automation' as const, callerPermissionMode: 'default',
        sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({}),
        actionCaller: { kind: 'session' as const, sessionId: 'origin-1', starterDepth: 1, turnDepth: 1 }, defaultSessionId: 'origin-1',
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } };
    // R2-02 admits the Run at its own depth; future Wait-picked engines remain
    // unresolved until each concrete child passes invoke-time admission.
    expect(validateWorkflowDefinition(authored).valid).toBe(true);
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'created' });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    expect(opened).toMatchObject({ kind: 'available', content: { workDepth: 2 } });
    if (deferredInputField) {
      expect(opened).toMatchObject({ kind: 'available', content: { materializedLeaves: expect.arrayContaining([
        expect.objectContaining({ blockId: 'panel', kind: 'action', actionId: name,
          actionInput: expect.objectContaining({ [deferredInputField]: { kind: 'unresolved' } }) }),
      ]) } });
    }
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'existing' });
  });

  it.each([false, true])('starts a catalog Panel with real Action contracts and Session ingress (panel engines: %s)', async withEngines => {
    let committed: ReturnType<typeof runSnapshot> | undefined;
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async operation => {
        if (operation.operation === 'get') {
          if (committed) return committed;
          throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        }
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
        machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({
        roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' },
          availableAgentTargetKeys: ['agent:happier.agent.codex/codex'] },
        effects: { resolveTargetAvailability: async () => true,
          readActionContract: async id => {
            const parsed = ActionIdSchema.safeParse(id);
            if (!parsed.success) return null;
            const spec = getActionSpec(parsed.data);
            return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(spec));
          } },
      }),
    });
    const executor = createActionExecutor({ workflowAction: async args => {
      if (args.actionId !== 'workflow.run.start') throw new Error('unexpected_workflow_action');
      try { return await owner.execute(args, { agentTarget, machineId: 'machine-a', directory: '/repo' }); }
      catch (error) { return normalizeWorkflowActionThrownError(error); }
    } });
    const context = { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default', defaultSessionId: 'origin-1',
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    } as const;
    await expect(executor.execute('workflow.run.start', { runId,
      source: { kind: 'catalog', workflow: 'builtin:plan-with-a-panel' },
      inputs: { request: 'Plan the change', machineId: 'Machine-other', directory: '/other' },
    }, context)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    expect(committed).toBeUndefined();
    const result = await executor.execute('workflow.run.start', { runId,
      source: { kind: 'catalog', workflow: 'builtin:plan-with-a-panel' },
      inputs: { request: 'Plan the change', ...(withEngines ? { engines: ['agent:happier.agent.codex/codex'] } : {}) },
      roleOverrides: [{ roleId: 'planner', engine: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-6.1-sol', effort: 'low' } }],
      onComplete: { kind: 'originating_session' },
    }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { admission: 'created' } });
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope),
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } }))
      .toMatchObject({ kind: 'available', content: {
        machineId: 'machine-a',
        workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: 'origin-1' },
        inputs: { request: 'Plan the change' },
        materializedLeaves: expect.arrayContaining([
        expect.objectContaining({ blockId: 'synthesis', selection: expect.objectContaining({ agentTarget,
          modelSelection: expect.objectContaining({ ref: expect.objectContaining({ modelId: 'gpt-6.1-sol' }) }) }) }),
      ]) } });
  });

  it('admits a Wait run after the slower independent Account read, without serial round trips', async () => {
    vi.useFakeTimers();
    try {
      const encryptionDelayMs = 120;
      const accountIdDelayMs = 80;
      const owner = createWorkflowAccountRunActionOwner({
        ...ownerDeps({ execute: async operation => {
          if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          if (operation.operation === 'admit') return { kind: 'created', run: runSnapshot().run };
          throw new Error('unexpected_storage_operation');
        } }),
        // Account HTTP reads and the clock are genuine boundaries. Validation,
        // materialization, key preparation and sealing remain real.
        resolveEncryption: () => new Promise(resolve => setTimeout(() => resolve({ kind: 'available',
          witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }), encryptionDelayMs)),
        resolveAccountId: () => new Promise(resolve => setTimeout(() => resolve('account-1'), accountIdDelayMs)),
        prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
          machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      });
      const startedAt = Date.now();
      let elapsedMs: number | undefined;
      const result = owner.execute({ actionId: 'workflow.run.start', input: { runId,
        source: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'wait', id: 'wait',
          document: { text: 'Choose', references: [], attachments: [] } }] } },
      }, context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default',
        externalActionTarget: { kind: 'machine', machineId: 'machine-a',
          project: { machineId: 'machine-a', directory: '/repo' } } },
      }).then(value => { elapsedMs = Date.now() - startedAt; return value; });
      await vi.advanceTimersByTimeAsync(encryptionDelayMs + accountIdDelayMs);
      await expect(result).resolves.toMatchObject({ admission: 'created', run: { id: runId } });
      expect(elapsedMs).toBe(Math.max(encryptionDelayMs, accountIdDelayMs));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['encryption', 'account-id'] as const)('does not admit after the independent %s read fails', async failingRead => {
    const failure = new Error('account_read_unavailable');
    let admitted = false;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async operation => {
        if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        admitted = true;
        throw new Error('must_not_write_after_failed_account_read');
      } }),
      resolveEncryption: async () => {
        if (failingRead === 'encryption') throw failure;
        return { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } };
      },
      resolveAccountId: async () => {
        if (failingRead === 'account-id') throw failure;
        return 'account-1';
      },
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
        machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId,
      source: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'wait', id: 'wait',
        document: { text: 'Choose', references: [], attachments: [] } }] } },
    }, context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine', machineId: 'machine-a',
        project: { machineId: 'machine-a', directory: '/repo' } } },
    })).rejects.toBe(failure);
    expect(admitted).toBe(false);
  });

  it.each(['history_not_readable', 'encryption_setup_required', 'waiting_for_keys'] as const)(
    'preserves %s through accepted detail, exact invocation, content list and result reads', async reason => {
      const snapshot = runSnapshot();
      const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
      const encryption: AvailableAutomationAccountEncryptionV1 = { kind: 'available', material,
        witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: material.contentPublicKeyFingerprint } };
      const prepared = prepareWorkflowRunDataKeyV1({ accountId: 'account-1', encryption, randomBytes });
      snapshot.keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ ...snapshot.keyCensus,
        encryptionMode: 'e2ee', ownerAccountCurrentness: { mode: 'e2ee', version: 1,
          contentKeyFingerprint: material.contentPublicKeyFingerprint },
        dataEncryptionKey: reason === 'history_not_readable' ? null : prepared.recipientKeyEnvelopes[0]!.encryptedDataKey,
        callerDataEncryptionKey: null,
      });
      const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
        if (operation.operation === 'get') return snapshot;
        if (operation.operation === 'list') return { runs: [snapshot.run],
          acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
          keyCensusByRunId: { [runId]: snapshot.keyCensus } };
        if (operation.operation === 'invocations.list') return { invocations: [], parentRevision: 0,
          keyCensus: snapshot.keyCensus, progressEnvelopesByInvocationId: {} };
        if (operation.operation === 'wait') return { observation: 'terminal', run: { ...snapshot.run, state: 'succeeded' },
          resultEnvelope: 'unopened-result', keyCensus: snapshot.keyCensus };
        throw new Error(`unexpected_storage_operation:${String(operation.operation)}`);
      } }), resolveEncryption: async () => reason === 'encryption_setup_required'
        ? { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }
        : encryption,
      });
      const reads = [
        owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} }),
        owner.execute({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId: 'held' }, context: {} }),
        owner.execute({ actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true }, context: {} }),
        owner.execute({ actionId: 'workflow.run.wait', input: { runId }, context: {} }),
      ];
      const failures = await Promise.all(reads.map(read => read.catch(normalizeWorkflowActionThrownError)));
      for (const failure of failures) {
        expect(failure).toMatchObject({ ok: false, errorCode: reason });
      }
      await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }))
        .resolves.toMatchObject({ runs: [{ id: runId }], metadataByRunId: { [runId]: { kind: 'unavailable', reason } } });
    },
  );

  it.each([
    { error: Object.assign(new Error('HTTP 500'), { response: { status: 500, data: { error: 'internal_server_error' } } }), code: 'storage_unavailable' },
    { error: Object.assign(new Error('HTTP 500'), { response: { status: 500, data: '<html>failure</html>' } }), code: 'storage_unavailable' },
    { error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }), code: 'storage_unavailable' },
    { error: new Error('transport failed'), code: 'storage_unavailable' },
    { error: Object.assign(new Error('stale'), { code: 'currentness_conflict' }), code: 'currentness_conflict' },
    { error: Object.assign(new Error('forbidden'), { response: { status: 403, data: { error: 'run_access_denied' } } }), code: 'run_access_denied' },
  ])('distinguishes storage failure from typed currentness/access failure ($code)', async ({ error, code }) => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => { throw error; } }));
    const failures = await Promise.all([
      owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} }),
      owner.execute({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 0 }, context: {} }),
    ].map(result => result.catch(normalizeWorkflowActionThrownError)));
    for (const failure of failures) {
      expect(failure).toMatchObject({ ok: false, errorCode: code });
    }
  });

  it('keeps malformed storage projections distinct from transport failures', async () => {
    const snapshot = runSnapshot();
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => ({ ...snapshot, run: { id: runId } }) }));
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} })
      .catch(normalizeWorkflowActionThrownError)).resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it.each([
    Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' }),
    new DOMException('cancelled', 'AbortError'),
  ])('preserves native storage cancellation', async error => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => { throw error; } }));
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} })).rejects.toBe(error);
  });

  it.each(['root', 'nested'] as const)('hydrates exact transcript references in the lean batch using authored %s step numbering', async placement => {
    const snapshot = runSnapshot();
    if (placement === 'nested') {
      if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
      const parentDefinition = { ...definition, blocks: [
        { ...definition.blocks[0]!, id: 'prelude' },
        { kind: 'workflow' as const, id: 'nested', workflowRef: 'builtin:child', input: {} },
      ] };
      const nested = await materializeWorkflowAcceptedSnapshotV1({ definition: parentDefinition,
        context: acceptedSnapshotResult.snapshot,
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
          readWorkflowDefinition: async () => ({ sourceKey: 'builtin:child', definition }) } });
      if (!nested.ok) throw new Error(`snapshot_fixture_failed: ${nested.error.code}`);
      snapshot.acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
        acceptedSnapshot: nested.snapshot,
      }));
    }
    const id = 'transcript-step';
    const index = { id, runId, sequence: '87', parentRecordId: null, memberOrdinal: '8', attempt: '0',
      contentRevision: '1', lifecycle: 'completed' as const,
      createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: id, sequence: index.sequence, parentRecordId: null, memberOrdinal: index.memberOrdinal, attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step',
        invocationPath: { blockId: definition.blocks[0]!.id,
          scope: placement === 'nested' ? [{ kind: 'workflow', blockId: 'nested' }] : [] }, attempt: '0', logicalInvocationRecordId: id },
    }));
    const rootIndex = { ...index, id: 'root', sequence: '0', memberOrdinal: '0', lifecycle: 'running' as const };
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: rootIndex.id, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
        attempt: '0', logicalInvocationRecordId: 'root', resultProvenance: { [id]: { notificationCondition: 'suppressed' } } },
    }));
    const requests: unknown[] = [];
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'list') throw new Error('transcript_must_not_read_detail_or_history');
      requests.push(operation.request);
      return { runs: [snapshot.run], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus },
        rootProgressByRunId: { [runId]: { index: rootIndex, contentEnvelope: rootEnvelope } },
        invocationProgressByRunId: { [runId]: [{ index, contentEnvelope },
          { index: { ...index, id: 'unrequested' }, contentEnvelope },
          { index: { ...index, runId: 'foreign-run' }, contentEnvelope }] } };
    } }));
    const input = { runIds: [runId], invocationProvenance: [{ runId, invocationRecordIds: [id] }] };
    const result = await owner.execute({ actionId: 'workflow.run.list', input, context: {} });
    expect(result).toMatchObject({ invocationProvenance: [{ index, stepOrdinal: '1', notificationCondition: 'suppressed' }] });
    expect(result).toHaveProperty('invocationProvenance.length', 1);
    expect(requests).toEqual([input]);
  });

  it('opens requested invocation content from the same paged storage response', async () => {
    const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    const rows = ids.map((id, ordinal) => {
      const index = { id, runId, sequence: String(ordinal), parentRecordId: null, memberOrdinal: String(ordinal),
        attempt: '0', contentRevision: '1', lifecycle: 'completed' as const,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
      const progress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const,
        invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        result: { kind: 'value' as const, value: { output: `page-${ordinal}` } } };
      const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
          recordId: id, sequence: index.sequence, parentRecordId: null, memberOrdinal: index.memberOrdinal, attempt: '0' }, progress,
      }));
      return { index, progress, contentEnvelope };
    });
    const operations: string[] = [];
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      operations.push(String(operation.operation));
      if (operation.operation !== 'invocations.list') throw new Error('Content list must not read individual details or accepted snapshots');
      const row = operation.cursor ? rows[1]! : rows[0]!;
      return { invocations: [row.index], parentRevision: 4, keyCensus: runSnapshot().keyCensus,
        ...(operation.cursor ? {} : { nextCursor: 'page-2' }),
        ...(operation.progressEnvelopes ? { progressEnvelopesByInvocationId: { [row.index.id]: row.contentEnvelope } } : {}) };
    } }));
    for (const ordinal of [0, 1]) {
      const row = rows[ordinal]!;
      await expect(owner.execute({ actionId: 'workflow.run.invocations.list',
        input: { runId, includeContent: true, ...(ordinal === 1 ? { cursor: 'page-2' } : {}) }, context: {} }))
        .resolves.toEqual({ invocations: [row.index], parentRevision: 4,
          invocationDetails: [{ index: row.index, progress: row.progress, parentRevision: 4 }],
          ...(ordinal === 0 ? { nextCursor: 'page-2' } : {}) });
    }
    expect(operations).toEqual(['invocations.list', 'invocations.list']);
    await expect(owner.execute({ actionId: 'workflow.run.invocations.list', input: { runId }, context: {} }))
      .resolves.toEqual({ invocations: [rows[0]!.index], parentRevision: 4, nextCursor: 'page-2' });
  });

  it.each(['missing', 'malformed', 'rebound', 'mode_mismatch', 'foreign_run'] as const)('fails requested invocation content closed for %s envelopes', async failure => {
    const id = '22222222-2222-4222-8222-222222222222';
    const index = { id, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '1', lifecycle: 'completed' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: failure === 'rebound' ? '33333333-3333-4333-8333-333333333333' : id,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step',
        invocationPath: { blockId: 'work', scope: [] }, attempt: '0',
        logicalInvocationRecordId: failure === 'rebound' ? '33333333-3333-4333-8333-333333333333' : id },
    }));
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'invocations.list') throw new Error('No per-row fallback');
      return { invocations: [{ ...index, ...(failure === 'foreign_run' ? { runId: '33333333-3333-4333-8333-333333333333' } : {}) }], parentRevision: 4, keyCensus: runSnapshot().keyCensus,
        progressEnvelopesByInvocationId: failure === 'missing' ? {} : {
          [id]: failure === 'malformed' ? 'invalid' : failure === 'mode_mismatch' ? JSON.stringify({ t: 'encrypted', c: 'invalid' }) : envelope,
        } };
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true }, context: {} }))
      .rejects.toMatchObject({ code: 'content_unavailable' });
  });

  it('keeps opened invocation details within the stored page byte boundary', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    // The index duplicates in the opened projection. Maximal database decimal
    // fields and revision, short private content and the smallest owner binding
    // exercise the margin supplied by the existing serialized-envelope budget.
    const decimal = '9223372036854775807';
    const index = { id, runId, sequence: decimal, parentRecordId: null, memberOrdinal: decimal,
      attempt: decimal, contentRevision: decimal, lifecycle: 'waiting_for_capacity' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'a', runId,
        recordId: id, sequence: decimal, parentRecordId: null, memberOrdinal: decimal, attempt: decimal },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root',
        invocationPath: { blockId: '$root', scope: [] }, attempt: decimal,
        logicalInvocationRecordId: id, previousAttemptRecordId: '33333333-3333-4333-8333-333333333333' },
    }));
    const page = { invocations: [index], parentRevision: Number.MAX_SAFE_INTEGER,
      keyCensus: { ...runSnapshot().keyCensus, ownerAccountId: 'a' },
      progressEnvelopesByInvocationId: { [id]: contentEnvelope } };
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'invocations.list') throw new Error('No per-row reads');
      return page;
    } }));
    const opened = await owner.execute({ actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true }, context: {} });
    expect(opened).toMatchObject({ invocationDetails: [{ index }] });
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(opened))
      .toBeLessThanOrEqual(measureExternalActionResultResponseEnvelopeUtf8BytesV1(page));
  });

  it('admits the reviewed inline draft with authorized Artifact lineage and rejoins its frozen Team choice', async () => {
    const reviewed = validateWorkflowDefinition({ ...definition, blocks: ['Reviewed unsaved work'] }).normalizedDefinition!;
    const metadata = { title: 'Reviewed title' };
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let admitted: Readonly<Record<string, unknown>> | undefined;
    let sourceAvailable = true;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'admit') {
        admitted = operation;
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope),
          run: { ...runSnapshot().run, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' },
          keyCensus: { ...runSnapshot().keyCensus, visibleTeamId: 'team-a' } };
        return { kind: 'created', run: committed.run };
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }), definitions: { get: async ({ definitionId }) => {
      expect(definitionId).toBe('def-1');
      if (!sourceAvailable) throw new Error('must_not_read_mutable_source_on_rejoin');
      return { definitionId, revision: { headerVersion: 2, bodyVersion: 2 }, definition, metadata: { title: 'Old saved content' } };
    } }, prepareWorkspace: async () => ({ ok: true, workspaceTarget: {
      project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
    resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId, metadata,
      source: { kind: 'inline', definition: reviewed, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' } });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'created' });
    expect(admitted).toMatchObject({ sourceArtifactId: 'def-1', visibleTeamId: 'team-a', recipientKeyEnvelopes: [] });
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context });
    expect(opened).toMatchObject({ definition: reviewed, authoredDefinition: reviewed,
      acceptedContext: { metadata, source: { kind: 'inline', sourceArtifactId: 'def-1' } } });
    sourceAvailable = false;
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'existing' });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { ...input,
      source: { kind: 'inline', definition: reviewed, sourceArtifactId: 'different-source', visibleTeamId: 'team-a' } }, context }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { ...input,
      source: { kind: 'inline', definition: reviewed, sourceArtifactId: 'def-1', visibleTeamId: 'team-b' } }, context }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
  });

  it('refuses an inaccessible inline Artifact binding before preparing a workspace or admitting a Run', async () => {
    const operations: unknown[] = [];
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      operations.push(operation.operation);
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      throw new Error('must_not_admit_inaccessible_binding');
    } }), definitions: { get: async () => { throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' }); } },
      prepareWorkspace: async () => { throw new Error('must_not_prepare_inaccessible_binding'); },
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId,
      source: { kind: 'inline', definition, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' } });
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context: { callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    expect(operations).not.toContain('admit');
  });

  it('uses the same bound inline grant audience for E2EE census, keys and accepted content', async () => {
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: randomBytes(32) } });
    const encryption: AvailableAutomationAccountEncryptionV1 = { kind: 'available', material,
      witness: { mode: 'e2ee', version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) } };
    const census = { ...runSnapshot().keyCensus, encryptionMode: 'e2ee' as const,
      ownerAccountCurrentness: encryption.witness, visibleTeamId: 'team-a' };
    const reviewed = validateWorkflowDefinition({ ...definition, blocks: ['Encrypted reviewed draft'] }).normalizedDefinition!;
    let admitted: Readonly<Record<string, unknown>> | undefined;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      if (operation.operation === 'run-key.census') {
        expect(operation).toMatchObject({ sourceArtifactId: 'def-1', visibleTeamId: 'team-a' });
        return census;
      }
      if (operation.operation === 'admit') {
        admitted = operation;
        return { kind: 'created', run: { ...runSnapshot().run, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' } };
      }
      throw new Error('unexpected_storage_operation');
    } }), resolveEncryption: async () => encryption, randomBytes,
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: {
        project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId,
      source: { kind: 'inline', definition: reviewed, sourceArtifactId: 'def-1', visibleTeamId: 'team-a' } }),
      context: { callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: 'machine-a',
        project: { machineId: 'machine-a', directory: '/repo' } } } });
    expect(admitted).toMatchObject({ sourceArtifactId: 'def-1', visibleTeamId: 'team-a' });
    const envelopes = WorkflowRunRecipientKeyEnvelopesV1Schema.parse(admitted?.recipientKeyEnvelopes);
    const ownerEnvelope = envelopes.find(row => row.recipientAccountId === 'account-1')!.encryptedDataKey;
    const key = resolveWorkflowRunDataKeyV1({ encryption,
      census: { ...census, dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: ownerEnvelope } });
    if (key.kind !== 'available' || key.encryption.runCrypto.mode !== 'e2ee') throw new Error('run_key_fixture_failed');
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'e2ee', runDataKey: key.encryption.runCrypto.runDataKey,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(String(admitted?.acceptedEnvelope)) })).toMatchObject({ kind: 'available', content: {
        source: { kind: 'inline', sourceArtifactId: 'def-1' }, authoredDefinition: reviewed,
      } });
  });
  it('refuses invalid typed Workflow input before workspace preparation or Run admission', async () => {
    const inputType = { pluginId: 'com.acme.inputs', localId: 'repository' };
    const prepareWorkspace = vi.fn(async () => ({ ok: true as const, workspaceTarget: {
      project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }));
    const operations: string[] = [];
    const deps = { ...ownerDeps({ execute: async operation => {
      operations.push(String(operation.operation));
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      if (operation.operation === 'admit') return { kind: 'created', run: runSnapshot().run };
      return { invocations: [] };
    } }), prepareWorkspace,
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      inputTypeDeps: { resolveInputType: async () => ({ identity: inputType, occurrenceId: 'current', definition: {
        id: inputType.localId, title: 'Repository', semantic: 'repository', valueSchema: { type: 'object' as const,
          properties: { repositoryId: { type: 'string' as const } }, required: ['repositoryId'], additionalProperties: false },
      } }) },
    };
    const owner = createWorkflowAccountRunActionOwner(deps);
    await expect(owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId,
      source: { kind: 'inline', definition: { ...definition, inputs: [{ name: 'repository', valueType: 'json', required: true, inputType }] } },
      inputs: { repository: { repositoryId: 42 } },
    }), context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: 'machine-a',
      project: { machineId: 'machine-a', directory: '/repo' } } } })).rejects.toMatchObject({ code: 'input_type_value_invalid' });
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(operations).not.toContain('admit');
  });
  it('admits host Session input without plugin discovery and rejects malformed values before Run admission', async () => {
    const operations: string[] = [];
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      operations.push(String(operation.operation));
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      if (operation.operation === 'admit') return { kind: 'created', run: runSnapshot().run };
      throw new Error('unexpected_storage_operation');
    } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: {
      project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
        resolveSessionTarget: async () => ({ address: { serverId: 'home', sessionId: 'B' }, machineId: 'machine-a' }) } }),
      inputTypeDeps: { resolveInputType: async () => { throw new Error('Host input must not acquire a plugin identity'); } },
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId,
      source: { kind: 'inline', definition: { ...definition, inputs: [{ name: 'session', valueType: 'json',
        required: true, inputType: { hostType: 'session' } }] } }, inputs: { session: { serverId: 'home', sessionId: 'B' } },
    });
    const checkedDefinition = validateWorkflowDefinition(input.source.kind === 'inline' ? input.source.definition : {});
    expect(checkedDefinition.valid, JSON.stringify(checkedDefinition.issues)).toBe(true);
    const context = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'created' });
    operations.length = 0;
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { ...input, inputs: { session: { sessionId: 'B' } } }, context }))
      .rejects.toMatchObject({ code: 'input_type_value_invalid' });
    expect(operations).not.toContain('admit');
  });
  it('returns the frozen child definitions with authorized Run detail rather than resolving current library content', async () => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const frozenChildren = { 'builtin:review': definition };
    const nestedDefinition = { ...definition, blocks: [{ kind: 'workflow' as const, id: 'nested', workflowRef: 'builtin:review', input: {} }] };
    const snapshot = { ...runSnapshot(), acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: { ...acceptedSnapshotResult.snapshot, definition: nestedDefinition, authoredDefinition: nestedDefinition, frozenChildren },
    })) };
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => snapshot }));
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} });
    expect(opened).toMatchObject({ definition: nestedDefinition, acceptedContext: { frozenChildren } });
  });

  it.each([
    { conditions: ['terminal'] as const, observation: 'terminal', matchedCondition: 'terminal' },
    { conditions: ['attention'] as const, observation: 'needs_attention', matchedCondition: 'attention' },
  ])('waits through a pause for $matchedCondition on the existing feed', async ({ conditions, observation, matchedCondition }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      let change: (() => void) | undefined;
      let paused = true;
      const reads: Readonly<Record<string, unknown>>[] = [];
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async operation => {
          reads.push(operation);
          const selected = operation.conditions as readonly string[] | undefined;
          return { observation: paused ? (!selected || selected.includes('paused') ? 'paused' : 'waiting') : observation,
            ...(!paused ? { matchedCondition } : {}),
            run: { ...runSnapshot().run, state: paused ? 'paused' : matchedCondition === 'terminal' ? 'succeeded' : 'waiting_for_review',
              attentionRequired: !paused && matchedCondition === 'attention' } };
        },
        observeChanges: (_runId, onChange) => { change = onChange; return { dispose() {} }; },
      }));
      const input = WorkflowRunWaitRequestV1Schema.parse({ runId, conditions });
      let settled = false;
      const pending = owner.execute({ actionId: 'workflow.run.wait', input, context: { signal: controller.signal } });
      const result = expect(pending).resolves.toMatchObject({ observation, matchedCondition });
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ conditions });
      paused = false;
      change?.();
      await result;
      expect(reads).toHaveLength(2);
    } finally { controller.abort(); vi.useRealTimers(); }
  });

  it('returns typed unmatched terminal evidence for an attention-only wait', async () => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => ({
      observation: 'not_matched_terminal', run: { ...runSnapshot().run, state: 'cancelled', attentionRequired: false },
    }) }));
    await expect(owner.execute({ actionId: 'workflow.run.wait',
      input: WorkflowRunWaitRequestV1Schema.parse({ runId, conditions: ['attention'] }), context: {} }))
      .resolves.toMatchObject({ observation: 'not_matched_terminal', run: { state: 'cancelled' } });
  });

  it('streams ordered summary snapshots, catches up reconnects, and cancels only the observer without idle reads', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      let change: (() => void) | undefined;
      let current = { ...runSnapshot().run, attentionRequired: false };
      let reads = 0;
      let disposed = false;
      const snapshots: unknown[] = [];
      let release: (() => void) | undefined;
      const firstDelivery = new Promise<void>(resolve => { release = resolve; });
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async () => { reads += 1; return { observation: current.state === 'succeeded' ? 'terminal' : 'waiting', run: current }; },
        observeChanges: (_runId, onChange) => { change = onChange; return { dispose: () => { disposed = true; } }; },
      }));
      const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId }, context: {
        signal: controller.signal,
        onWaitSnapshot: async snapshot => { snapshots.push(snapshot); if (snapshots.length === 1) await firstDelivery; },
      } });
      const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots).toEqual([{ run: current }]);
      expect(reads).toBe(1);
      // A change during output backpressure must be delivered after the first snapshot.
      current = { ...current, state: 'running', revision: 1 };
      change?.();
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toMatchObject({ run: { state: 'running', revision: 1 } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(2);
      // Invocation-only attention must publish even at the same parent revision.
      current = { ...current, attentionRequired: true };
      change?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots[2]).toMatchObject({ run: { state: 'running', revision: 1, attentionRequired: true } });
      // Reconnect invalidates once and catches up the current terminal projection.
      current = { ...current, state: 'succeeded', revision: 2, attentionRequired: false };
      change?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots[3]).toMatchObject({ run: { state: 'succeeded', revision: 2 } });
      expect(disposed).toBe(false);
      // An unchanged invalidation may read, but must not duplicate output.
      change?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots).toHaveLength(4);
      controller.abort();
      await cancelled;
      expect(disposed).toBe(true);
      const finalReads = reads;
      change?.();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(finalReads);
      expect(current.state).toBe('succeeded');
    } finally { controller.abort(); vi.useRealTimers(); }
  });
  it.each(['cancel', 'timeout', 'feed_error'] as const)('releases a passive observer on %s even while its snapshot sink is backpressured', async (stop) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    try {
      let disposed = false;
      let delivered = false;
      let onError: ((error: unknown) => void) | undefined;
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async () => ({ observation: 'waiting', run: runSnapshot().run }),
        observeChanges: (_runId, _onChange, fail) => { onError = fail; return { dispose: () => { disposed = true; } }; },
      }));
      const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId, ...(stop === 'timeout' ? { timeoutSeconds: 1 } : {}) }, context: {
        signal: controller.signal,
        onWaitSnapshot: () => { delivered = true; return new Promise<void>(resolve => { release = resolve; }); },
      } });
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(delivered).toBe(true);
      if (stop === 'cancel') controller.abort();
      if (stop === 'feed_error') onError?.(Object.assign(new Error('observer_disconnected'), { code: 'observer_disconnected' }));
      await vi.advanceTimersByTimeAsync(stop === 'timeout' ? 1000 : 0);
      expect(disposed).toBe(true);
      if (stop === 'cancel') await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      else if (stop === 'timeout') await expect(pending).resolves.toMatchObject({ observation: 'timeout', run: { state: 'queued' } });
      else await expect(pending).rejects.toMatchObject({ code: 'observer_disconnected' });
    } finally { controller.abort(); release?.(); vi.useRealTimers(); }
  });
  it.each(['ui', 'agent'] as const)('freezes a version-pinned plugin workflow for %s and rejoins it after the plugin changes or disappears', async (surface) => {
    const workflow = 'plugin:com.acme.workflows/review';
    let plugin = { workflow, pluginId: 'com.acme.workflows', version: '1.2.3', title: 'Plugin review', definition };
    let available = true;
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let writes = 0;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'admit') {
        writes += 1;
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }), readPluginWorkflows: () => available ? [plugin] : [],
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => ({ caller: {
        kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: {
          agentTarget: definition.defaults!.agentTarget!, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'catalog', workflow, pluginVersion: '1.2.3' } });
    const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const, callerPermissionMode: 'default',
      sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({}),
      ...(surface === 'agent' ? { actionCaller: { kind: 'session' as const, sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'caller-session' } : {}),
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start',
      input: { ...input, source: { kind: 'catalog', workflow, pluginVersion: '0.9.0' } }, context }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(writes).toBe(0);
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'created' });
    plugin = { ...plugin, version: '2.0.0', definition: validateWorkflowDefinition({ blocks: ['Different instructions'] }).normalizedDefinition! };
    available = false;
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'existing' });
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context });
    expect(opened).toMatchObject({ definition, acceptedContext: { source: { kind: 'catalog', ref: workflow, version: '1.2.3' } } });
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope),
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
    })).toMatchObject({ kind: 'available', content: { definition, source: { kind: 'catalog', ref: workflow, version: '1.2.3' } } });
    expect(writes).toBe(1);
  });
  it('waits on Account changes without periodic reads and catches up a missed change on reconnect', async () => {
    vi.useFakeTimers();
    try {
      let invalidate: (() => void) | undefined;
      let observation = 'waiting';
      let reads = 0;
      let disposed = false;
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async () => { reads += 1; return { observation, ...(observation === 'paused' ? { matchedCondition: 'paused' } : {}), run: runSnapshot().run }; },
        observeChanges: (_runId: string, onChange: () => void) => {
          invalidate = onChange;
          return { dispose: () => { disposed = true; } };
        },
      }));
      const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId }, context: {} });
      // Attach immediately: the incumbent owner fails on the new nonterminal storage observation.
      const result = expect(pending).resolves.toMatchObject({ observation: 'paused' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(1);
      // A reconnect invalidation rereads current facts, including a change missed offline.
      observation = 'paused';
      invalidate?.();
      await result;
      expect(reads).toBe(2);
      expect(disposed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it.each([2, 2_147_484])('expires observationally at the caller deadline (%s seconds) without changing or polling the Run', async (timeoutSeconds) => {
    vi.useFakeTimers();
    try {
      const operations: unknown[] = [];
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({
        execute: async (operation) => { operations.push(operation.operation); return { observation: 'waiting', run: runSnapshot().run }; },
        observeChanges: () => ({ dispose() {} }),
      }));
      const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId, timeoutSeconds }, context: {} });
      const result = expect(pending).resolves.toMatchObject({ observation: 'timeout', run: { state: 'queued' } });
      await vi.advanceTimersByTimeAsync(timeoutSeconds * 1_000 - 1);
      expect(operations).toEqual(['wait']);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      // One final current observation at the deadline; no cancel/pause/transition write.
      expect(operations).toEqual(['wait', 'wait']);
    } finally { vi.useRealTimers(); }
  });

  it.each(['inline', 'saved', 'catalog', 'plugin', 'automation'] as const)('repeats through inline start from the authenticated snapshot and retains %s lineage', async kind => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const savedBy = { kind: 'person' as const, accountId: 'editor' };
    const source = kind === 'inline' ? { kind, sourceArtifactId: 'def-1' } : kind === 'catalog' || kind === 'plugin'
      ? { kind: 'catalog', ref: kind === 'plugin' ? 'plugin:com.acme.workflows/review' : 'builtin:child', version: kind === 'plugin' ? '1.2.3' : 7 }
      : { kind, ...(kind === 'automation' ? { automationId: 'automation-1' } : {}),
        definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy };
    const originalAccepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...acceptedSnapshotResult.snapshot,
      source,
    });
    const original = { ...runSnapshot(), acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
      sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: originalAccepted }),
    ) };
    if (kind === 'inline') original.keyCensus.visibleTeamId = 'team-a';
    const newRunId = '22222222-2222-4222-8222-222222222222';
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let admittedSourceArtifactId: unknown;
    let admittedVisibleTeamId: unknown;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (operation.runId === runId) return original;
        if (committed) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'admit') {
        admittedSourceArtifactId = operation.sourceArtifactId;
        admittedVisibleTeamId = operation.visibleTeamId;
        committed = { ...runSnapshot(), run: { ...runSnapshot().run, id: newRunId },
          keyCensus: { ...runSnapshot().keyCensus, runId: newRunId }, acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }), definitions: { get: async () => { throw new Error('saved_definition_was_deleted'); } },
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: originalAccepted.workspaceTarget }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId: newRunId, source: { kind: 'inline',
      definition: { blocks: ['This carrier must not replace the accepted graph'] },
      replay: { runId } } });
    const actionContext = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
      defaultSessionId: 'origin-1', externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a',
        project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context: actionContext }))
      .resolves.toMatchObject({ admission: 'created' });
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId: newRunId }, context: actionContext });
    expect(opened).toMatchObject({ definition: originalAccepted.definition,
      acceptedContext: { source: originalAccepted.source, materializedLeaves: originalAccepted.materializedLeaves } });
    expect(admittedSourceArtifactId).toBe(kind === 'catalog' || kind === 'plugin' ? null : 'def-1');
    if (kind === 'inline') expect(admittedVisibleTeamId).toBe('team-a');
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context: actionContext }))
      .resolves.toMatchObject({ admission: 'existing' });
  });
  it.each(['succeeded', 'cancelled'] as const)('starts Another round from a %s source with accepted inputs and durable outcomes, and rejoins the same new Run', async state => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const roundDefinition = { ...definition, inputs: [
      { name: 'question', valueType: 'string' as const, required: true },
      { name: 'participants', valueType: 'json' as const, required: true },
      { name: 'previousRoundContext', valueType: 'json' as const, required: false },
    ] };
    const originalAccepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...acceptedSnapshotResult.snapshot,
      authoredDefinition: roundDefinition, definition: roundDefinition,
      inputs: { question: 'What should we do?', participants: ['original-session', 'original-model'] },
      authorization: { ...acceptedSnapshotResult.snapshot.authorization,
        principal: { kind: 'session', sessionId: 'retired-starter' } },
    });
    const original = { ...runSnapshot(), run: { ...runSnapshot().run, state },
      acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
        acceptedSnapshot: originalAccepted,
      })) };
    const nextId = '22222222-2222-4222-8222-222222222222';
    const root = storedRootInvocation(original);
    const rows = ['completed', 'failed'].map((lifecycle, ordinal) => {
      const id = ordinal === 0 ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444';
      const index = { id, runId, sequence: String(ordinal + 1), parentRecordId: root.index.id, memberOrdinal: String(ordinal),
        attempt: '0', contentRevision: '1', lifecycle, createdAt: original.run.createdAt, updatedAt: original.run.updatedAt };
      const progress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const,
        invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        ...(ordinal === 0 ? { result: { answer: 'Previous answer', pass: false } } : { reason: { code: 'target_unavailable' } }) };
      return { index, progress, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: id,
          sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: '0' }, progress,
      })) };
    });
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let writes = 0;
    let priorContext: 'available' | 'revoked' | 'misbound' = 'available';
    let targetAvailable = true;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (operation.runId === runId) return original;
        if (committed && operation.runId === nextId) return committed;
        throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      }
      if (operation.operation === 'invocations.list') return operation.runId === runId
        ? { invocations: operation.cursor ? [rows[1]!.index] : [root.index, rows[0]!.index], ...(operation.cursor ? {} : { nextCursor: 'second-page' }) }
        : { invocations: [] };
      if (operation.operation === 'invocations.get') {
        if (priorContext === 'revoked') throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
        const row = [root, ...rows].find(candidate => candidate.index.id === operation.invocationId);
        if (!row) throw new Error('unknown_invocation');
        return { invocation: { ...row, parentRevision: 1,
          ...(priorContext === 'misbound' ? { contentEnvelope: rows.find(candidate => candidate !== row)!.contentEnvelope } : {}) } };
      }
      if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
      writes++;
      committed = { ...runSnapshot(), run: { ...runSnapshot().run, id: nextId },
        keyCensus: { ...runSnapshot().keyCensus, runId: nextId }, acceptedEnvelope: String(operation.acceptedEnvelope) };
      return { kind: 'created', run: committed.run };
    } }), resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => targetAvailable } }),
      // The current person can still read this historical Run. A new start is
      // admitted as that person, not under its retired original starter.
      isAcceptedAuthorizationCurrent: async ({ authorization }) => authorization.principal.kind === 'host',
    });
    const input = WorkflowRunStartRequestV1Schema.parse({ runId: nextId, source: { kind: 'inline',
      definition: { blocks: ['This carrier is not execution authority'] }, replay: { runId, intent: 'another_round' } } });
    const context = { surface: 'voice' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'created' });
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId: nextId }, context });
    expect(opened).toMatchObject({ acceptedContext: { inputs: {
      ...originalAccepted.inputs, previousRoundContext: { runId, state, outcomes: rows.map(({ index, progress }) => ({
        invocationRecordId: index.id, attempt: '0', blockId: 'work', lifecycle: index.lifecycle,
        ...(progress.result ? { result: progress.result } : { reason: progress.reason }),
      })) },
    }, materializedLeaves: originalAccepted.materializedLeaves } });
    await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'existing' });
    expect(writes).toBe(1);
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { ...input,
      inputs: { ...originalAccepted.inputs, participants: ['silently-substituted'] } }, context }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    const another = { ...input, runId: '55555555-5555-4555-8555-555555555555' };
    priorContext = 'revoked';
    await expect(owner.execute({ actionId: 'workflow.run.start', input: another, context }))
      .rejects.toMatchObject({ code: 'run_access_denied' });
    priorContext = 'misbound';
    await expect(owner.execute({ actionId: 'workflow.run.start', input: another, context }))
      .rejects.toMatchObject({ code: 'content_unavailable' });
    priorContext = 'available';
    targetAvailable = false;
    await expect(owner.execute({ actionId: 'workflow.run.start', input: another, context }))
      .rejects.toMatchObject({ code: 'target_unavailable' });
    expect(writes).toBe(1);
  });

  it('refuses a replay under current Agent-start policy before admitting another Run', async () => {
    let writes = 0;
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get' && operation.runId === runId) return runSnapshot();
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      writes += 1;
      throw new Error('denied_replay_must_not_write');
    } }), resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.other', localId: 'other' } }, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({
      runId: '22222222-2222-4222-8222-222222222222', source: { kind: 'inline', definition, replay: { runId } },
    }), context: { surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
      defaultSessionId: 'origin-1', actionCaller: { kind: 'session', sessionId: 'origin-1', starterDepth: 0, turnDepth: 0 },
      sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({ allowBackendTargetOverride: false }),
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    } })).rejects.toMatchObject({ code: 'policy_denied_field', details: { field: 'agentTarget' } });
    expect(writes).toBe(0);
  });
  it('admits a portable workflow role through the same inline start producer', async () => {
    let committed: ReturnType<typeof runSnapshot> | undefined;
    const portableDefinition = { version: 1 as const, inputs: [], defaults: { engine: { role: 'portable_builder' } },
      blocks: definition.blocks,
      roles: [{ roleId: 'portable_builder', name: 'Portable Builder', instructions: 'Build carefully',
        runsAs: { kind: 'session' as const }, engine: { agentTargetKey: 'happier.agent.test/test' } }],
    };
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') {
        if (!committed) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        return committed;
      }
      if (operation.operation === 'admit') {
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      }
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }), prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition: portableDefinition } }),
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: 'machine-a',
        project: { machineId: 'machine-a', directory: '/repo' } } } });
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: { surface: 'ui', authority: 'present_user' } });
    expect(opened).toMatchObject({ acceptedContext: { materializedLeaves: [{ role: { name: 'Portable Builder' } }] } });
  });
  it('opens the accepted role overrides and per-step targets without re-resolving them', async () => {
    if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
    const roleOverrides = [{ roleId: 'builder', runsAs: { kind: 'background_run' as const, intent: 'delegate' as const } }];
    const accepted = { ...acceptedSnapshotResult.snapshot, roleOverrides };
    const snapshot = { ...runSnapshot(), acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
      sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: accepted }),
    ) };
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }));
    const opened = await owner.execute({ actionId: 'workflow.run.get', input: { runId },
      context: { surface: 'ui', authority: 'present_user' } });
    expect(opened).toMatchObject({ acceptedContext: {
      roleOverrides, materializedLeaves: accepted.materializedLeaves,
    } });
  });
  it('retains an accepted Session principal without tying the Run to origin liveness', async () => {
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let originExists = true;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') {
          if (!committed) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          return committed;
        }
        if (operation.operation === 'invocations.list') return { invocations: [] };
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
        machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => originExists ? { caller: {
        kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: {
          agentTarget: definition.defaults!.agentTarget!, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit: 4 } : null,
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { kind: 'inline',
      definition } },
      context: { surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
        sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({}),
        actionCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'caller-session',
        externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } },
    })).resolves.toMatchObject({ admission: 'created' });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    if (opened.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
    expect(opened.content.authorization).toMatchObject({ principal: { kind: 'session', sessionId: 'caller-session' } });
    originExists = false;
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId },
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default' } }))
      .resolves.toMatchObject({ run: { id: runId } });
  });
  it.each(['agent', 'ui'] as const)('admits a Wait-only %s run without an Agent leaf and stamps its actual Run depth', async (surface) => {
    let writes = 0;
    let runDepth = 1;
    let envelope: unknown;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        envelope = operation.acceptedEnvelope;
        writes += 1;
        return { kind: 'created', run: runSnapshot().run };
      } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'originless', runId: 'calling-run', runDepth },
        baseline: { machineId: 'machine-a', directory: '/repo' },
        roles: {}, callerPermissionCeiling: 'safe-yolo', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const args = { actionId: 'workflow.run.start' as const, input: { runId, source: { kind: 'inline' as const, definition: {
      version: 1, blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Choose', references: [], attachments: [] } }],
    } } }, context: { surface, ...(surface === 'ui' ? { authority: 'present_user' as const } : {}), callerPermissionMode: 'safe-yolo' as const,
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } };
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'created' });
    expect(writes).toBe(1);
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(envelope),
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } }))
      .toMatchObject({ kind: 'available', content: { workDepth: surface === 'agent' ? 2 : 0,
        materializedLeaves: [{ kind: 'wait' }] } });
    runDepth = 4;
    if (surface === 'agent') {
      await expect(owner.execute(args)).rejects.toMatchObject({ code: 'work_depth_exceeded' });
      expect(writes).toBe(1);
    } else await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'created' });
  });

  it('records boundary Resume without opening encrypted content or checking private authority', async () => {
    const calls: string[] = [];
    const resumed = { ...runSnapshot().run, state: 'queued' as const, revision: 4 };
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        calls.push(String(operation.operation));
        if (operation.operation !== 'resume') throw new Error('key_free_resume_cannot_read_private_content');
        return { run: resumed, intent: 'resumed' };
      } }),
      resolveEncryption: async () => { throw new Error('encrypted_run_key_not_available'); },
      isAcceptedAuthorizationCurrent: async () => { throw new Error('worker_checks_private_authority'); },
    });
    await expect(owner.execute({ actionId: 'workflow.run.resume',
      input: { mode: 'boundary', runId, expectedRevision: 3 },
      context: { surface: 'ui', authority: 'present_user' } })).resolves.toEqual({ run: resumed, intent: 'resumed' });
    expect(calls).toEqual(['resume']);
  });

  it('preserves the typed Can-edit refusal from key-free boundary Resume', async () => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation !== 'resume') throw new Error('key_free_resume_cannot_read_private_content');
      throw Object.assign(new Error('run_access_denied'), { response: { status: 403, data: { error: 'run_access_denied' } } });
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.resume',
      input: { mode: 'boundary', runId, expectedRevision: 3 },
      context: { surface: 'ui', authority: 'present_user' } })).rejects.toMatchObject({ code: 'run_access_denied' });
  });

  it.each([
    { target: { kind: 'machine' as const, machineId: 'machine-a' }, allowed: true },
    { target: { kind: 'machine' as const, machineId: 'machine-b' }, allowed: false },
    { target: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } }, allowed: false },
    { target: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/other' } }, allowed: false },
  ])('enforces resource restrictions without opening private Resume content ($target)', async ({ target, allowed }) => {
    let resumed = false;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async operation => {
        if (operation.operation === 'get') return { ...runSnapshot(), acceptedEnvelope: 'unreadable' };
        if (operation.operation === 'resume') { resumed = true; return { run: runSnapshot().run, intent: 'resumed' }; }
        throw new Error('unexpected_storage_operation');
      } }),
      resolveEncryption: async () => { throw new Error('key_free_resume_must_not_resolve_keys'); },
    });
    const result = owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'boundary', runId, expectedRevision: 0 },
      context: { surface: 'ui', authority: 'present_user', externalActionTarget: target } });
    if (allowed) await expect(result).resolves.toMatchObject({ intent: 'resumed' });
    else await expect(result).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(resumed).toBe(allowed);
  });

  it('refuses new origin reporting when the captured Account policy is unavailable', async () => {
    const execute = vi.fn<WorkflowAccountRunActionDeps['storage']['execute']>(async () => {
      throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
    });
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveRunReportPolicy: async () => { throw new Error('preferences_unavailable'); },
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId,
      source: { kind: 'inline', definition }, onComplete: { kind: 'originating_session' } },
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'safe-yolo', defaultSessionId: 'origin-1',
        externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } },
    })).rejects.toMatchObject({ code: 'content_unavailable' });
    expect(execute.mock.calls.every(([operation]) => operation.operation === 'get')).toBe(true);
  });

  it.each([
    { surface: 'agent', authority: 'account_automation', originSessionId: 'origin-1', explicit: false, delivery: true },
    { surface: 'agent', authority: 'present_user', originSessionId: 'origin-1', explicit: false, delivery: false },
    { surface: 'ui', authority: 'present_user', originSessionId: 'origin-1', explicit: false, delivery: false },
    { surface: 'ui', authority: 'present_user', originSessionId: 'origin-1', explicit: true, delivery: true },
    { surface: 'agent', authority: 'account_automation', originSessionId: undefined, explicit: false, delivery: false },
  ] as const)('normalizes direct origin delivery once for $surface/$authority/$explicit/$originSessionId and rejoin', async (scenario) => {
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let writes = 0;
    let deliveryRequest: unknown;
    const readReportPolicy = vi.fn(async () => ({ preset: 'quiet' as const }));
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') {
          if (!committed) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          return committed;
        }
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        writes += 1;
        deliveryRequest = operation.resultDelivery;
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      } }),
      resolveRunReportPolicy: readReportPolicy,
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'originless', runId, runDepth: 0,
        ...(scenario.originSessionId ? { runOriginSessionId: scenario.originSessionId } : {}) },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } }, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'safe-yolo', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const args = { actionId: 'workflow.run.start' as const,
      input: { runId, source: { kind: 'inline' as const, definition },
        ...(scenario.explicit ? { onComplete: { kind: 'originating_session' as const } } : {}) },
      context: { surface: scenario.surface, authority: scenario.authority, callerPermissionMode: 'safe-yolo',
        ...(scenario.originSessionId ? { defaultSessionId: scenario.originSessionId } : {}),
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } };
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'created' });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    if (opened.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
    // These requests have the canonical host caller even on the agent transport.
    expect(opened.content).toMatchObject({ startedBy: 'user' });
    const acceptedDelivery = 'resultDelivery' in opened.content ? opened.content.resultDelivery : undefined;
    expect(acceptedDelivery).toEqual(scenario.delivery
      ? { kind: 'originating_session', originSessionId: scenario.originSessionId, reportPolicy: { preset: 'quiet' } } : undefined);
    expect(deliveryRequest).toEqual(scenario.delivery ? { kind: 'originating_session' } : undefined);
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'existing' });
    expect(writes).toBe(1);
    expect(readReportPolicy).toHaveBeenCalledTimes(scenario.delivery ? 1 : 0);
  });

  it.each([
    { activity: 'active', lifecycle: 'failed', same: false, fresh: false, reattach: false, continuation: true },
    { activity: 'not_active', lifecycle: 'failed', same: true, fresh: true, reattach: false, continuation: true },
    { activity: 'not_active', lifecycle: 'failed', same: false, fresh: true, reattach: false, continuation: false },
    { activity: 'unknown', lifecycle: 'needs_attention', same: false, fresh: false, reattach: true, continuation: true },
    { activity: 'active', lifecycle: 'cancel_requested', same: false, fresh: false, reattach: true, continuation: true },
    { activity: 'unknown', lifecycle: 'failed', same: false, fresh: false, reattach: false, continuation: false },
    { activity: 'not_active', lifecycle: 'needs_attention', same: true, fresh: true, reattach: false, continuation: true },
    { activity: 'not_active', lifecycle: 'failed', same: false, fresh: false, reattach: false, continuation: true, stale: true },
    { activity: 'not_active', lifecycle: 'failed', same: false, fresh: false, reattach: false, continuation: false, workspace: true, restore: true },
    { activity: 'unknown', lifecycle: 'needs_attention', same: false, fresh: false, reattach: false, continuation: false, workspace: true, restore: false },
  ] as const)('uses exact observation for offered and enforced recovery: $activity/$lifecycle', async (scenario) => {
    const recordId = '33333333-3333-4333-8333-333333333333';
    const snapshot = runSnapshot();
    snapshot.run.state = 'interrupted';
    snapshot.run.revision = 2;
    // These are initially stored envelope snapshots, matching the persisted
    // WorkflowRunInvocation default and canonical storage testkit admission.
    const root = storedRootInvocation(snapshot);
    const index = { id: recordId, runId, sequence: '1', parentRecordId: root.index.id, memberOrdinal: '0', attempt: '0', contentRevision: '0',
      lifecycle: scenario.lifecycle, createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId,
        sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '0', logicalInvocationRecordId: recordId,
        execution: { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' },
        ...('workspace' in scenario ? { reason: { code: 'workspace_unavailable' }, workspace: {
          creationIntent: { kind: 'git_worktree' as const, sourceDirectory: '/repo', baseRef: 'a'.repeat(40), displayName: 'work', branchMode: 'new' as const },
          descriptor: { machineId: 'machine-a', directory: '/repo/work', checkoutRootPath: '/repo/work', checkout: { kind: 'git_worktree' as const, branchName: 'work' } },
        } } : {}),
        ...(scenario.activity === 'not_active' && scenario.lifecycle === 'needs_attention'
          ? { uncertainPriorEffects: { activity: 'stopped' as const } } : {}),
        recovery: { conversation: 'same_conversation', input: { kind: 'replacement', value: { document: { text: 'prepared', references: [], attachments: [] }, input: [] } } } },
    }));
    const latestId = '44444444-4444-4444-8444-444444444444';
    const latestIndex = { ...index, id: latestId, attempt: '1', sequence: '2', lifecycle: 'pending' };
    const latestEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: latestId,
        sequence: latestIndex.sequence, parentRecordId: latestIndex.parentRecordId, memberOrdinal: '0', attempt: '1' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '1', logicalInvocationRecordId: recordId, previousAttemptRecordId: recordId },
    }));
    let reattachments = 0;
    let replacements = 0;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') return snapshot;
        if (operation.operation === 'invocations.get' && operation.invocationId === root.index.id) return { invocation: { ...root, parentRevision: 2 } };
        if (operation.operation === 'invocations.get') return { invocation: operation.invocationId === latestId
          ? { index: latestIndex, contentEnvelope: latestEnvelope, parentRevision: 2 } : { index, contentEnvelope, parentRevision: 2 } };
        if (operation.operation === 'invocations.list') return { invocations: [root.index, index, ...('stale' in scenario ? [latestIndex] : [])], nextCursor: null };
        replacements += 1;
        throw new Error('unexpected_replacement');
      } }),
      observeRecovery: async () => ({ activity: scenario.activity, canReattach: scenario.reattach, canContinueConversation: scenario.continuation }),
      reattachInvocation: async () => { reattachments += 1; },
    });
    const detail = await owner.execute({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId: recordId }, context: {} });
    expect(detail).toMatchObject({ invocation: { recoveryAvailability: {
      reattach: { kind: scenario.reattach ? 'available' : 'unavailable' },
      continueSameConversation: { kind: scenario.same ? 'available' : 'unavailable' },
      continueFreshAgent: { kind: scenario.fresh ? 'available' : 'unavailable' },
      retry: { kind: scenario.fresh ? 'available' : 'unavailable' },
      ...('restore' in scenario ? { restoreWorkspace: { kind: scenario.restore ? 'available' : 'unavailable' } } : {}),
    } } });
    if (!scenario.same) {
      await expect(owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'continue', invocation: { recordId }, conversation: 'same_conversation', input: { document: { text: 'new', references: [], attachments: [] }, input: [] } }] },
        context: { authority: 'present_user', callerPermissionMode: 'safe-yolo' } })).rejects.toMatchObject({ code: 'ineligible_state' });
    }
    if (scenario.activity === 'not_active' && scenario.lifecycle === 'needs_attention') {
      await expect(owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'continue', invocation: { recordId }, conversation: 'fresh_agent', input: { document: { text: 'new', references: [], attachments: [] }, input: [] } }] },
        context: { authority: 'present_user', callerPermissionMode: 'safe-yolo' } })).rejects.toMatchObject({ code: 'workflow_outcome_unresolved' });
    }
    if (scenario.reattach) {
      await owner.execute({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'reattach', invocation: { recordId } }] }, context: {} });
      expect(reattachments).toBe(1);
    }
    expect(replacements).toBe(0);
  });

  it.each(['inline', 'saved'] as const)('materializes run overrides before authority and freezes them across %s admission rejoin', async (sourceKind) => {
    const authored = {
      version: 1,
      defaults: { engine: { role: 'writer' } },
      roles: [{ roleId: 'writer', name: 'Writer', instructions: 'Write carefully',
        engine: { agentTargetKey: 'happier.agent.test/test', modelId: 'pinned' },
        runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off' }],
      blocks: ['work'],
    };
    const roleOverrides = [{ roleId: 'writer', engine: { agentTargetKey: 'happier.agent.test/test', modelId: 'override' } }];
    let committed: ReturnType<typeof runSnapshot> | undefined;
    let writes = 0;
    let resolutions = 0;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') {
          if (!committed) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
          return committed;
        }
        if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
        writes += 1;
        committed = { ...runSnapshot(), acceptedEnvelope: String(operation.acceptedEnvelope) };
        return { kind: 'created', run: committed.run };
      } }),
      definitions: { get: async () => ({ definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 },
        definition: validateWorkflowDefinition(authored).normalizedDefinition!, metadata: { title: 'Saved roles' },
        savedBy: { kind: 'agent', accountId: 'editor-account', sessionId: 'editor-session' } }) },
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => {
        resolutions += 1;
        return { effects: { resolveTargetAvailability: async () => true } };
      },
    });
    const source = sourceKind === 'inline' ? { kind: 'inline' as const, definition: authored }
      : { kind: 'saved' as const, definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } };
    const args = { actionId: 'workflow.run.start' as const, input: { runId, source, roleOverrides },
      context: { authority: 'present_user' as const, callerPermissionMode: 'safe-yolo', defaultSessionId: 'origin-1',
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } };
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'created' });
    const envelope = parseWorkflowStoredContentEnvelopeV1(committed!.acceptedEnvelope)!;
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', envelope,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
    expect(opened).toMatchObject({ kind: 'available', content: { roleOverrides, workDepth: 0,
      definition: { blocks: [{ execution: { modelSelection: { ref: { modelId: 'override' } } } }] } } });
    if (sourceKind === 'saved') expect(opened).toMatchObject({ content: { source: {
      savedBy: { kind: 'agent', accountId: 'editor-account', sessionId: 'editor-session' },
    } } });
    if (opened.kind === 'available') expect(opened.content.authoredDefinition)
      .toEqual(validateWorkflowDefinition(authored).normalizedDefinition);
    await expect(owner.execute(args)).resolves.toMatchObject({ admission: 'existing' });
    expect(writes).toBe(1);
    expect(resolutions).toBe(1);
    await expect(owner.execute({ ...args, input: { ...args.input, roleOverrides: [] } })).rejects.toMatchObject({ code: 'currentness_conflict' });
  });

  it.each(['availability', 'depth', 'model_policy'] as const)('refuses %s before writing a direct Run', async (scenario) => {
    let writes = 0;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        writes += 1;
        throw new Error('must_not_write_refused_run');
      } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => scenario !== 'availability' } }),
      resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'origin-1', starterDepth: scenario === 'depth' ? 4 : 1, turnDepth: 0 },
        baseline: { machineId: 'machine-a', directory: '/repo', configuration: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } }, permissionMode: 'default' } },
        roles: {}, callerPermissionCeiling: 'safe-yolo', ledSubtreeSessionIds: [], workDepthLimit: 4 }),
    });
    const result = owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { kind: 'inline', definition: {
      version: 1, defaults: { engine: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        modelSelection: { v: 1, updatedAt: 0, ref: { agentTargetKey: 'happier.agent.test/test', providerConnectionId: null, modelId: 'override' } } } }, blocks: ['work'],
    } } }, context: { surface: scenario === 'availability' ? 'cli' : 'agent', authority: scenario === 'availability' ? 'present_user' : undefined,
      callerPermissionMode: 'safe-yolo', defaultSessionId: 'origin-1',
      sessionAgentSpawnPolicyV1: SessionAgentSpawnPolicyV1StrictSchema.parse({ allowModelOverride: scenario !== 'model_policy' }),
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } });
    await expect(result).rejects.toMatchObject({ code: scenario === 'availability' ? 'target_unavailable' : scenario === 'depth' ? 'work_depth_exceeded' : 'policy_denied_field' });
    expect(writes).toBe(0);
  });
  it('reads one lean summary batch without resolving definitions or Account keys', async () => {
    const result = { summaries: [{ sourceArtifactId: 'def-1', lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: ['def-2'] };
    const deps = ownerDeps({ execute: async (operation, options) => {
      if (operation.operation !== 'summaries' || options?.publisherMachineId) throw new Error('unexpected_storage_boundary');
      return result;
    } });
    const owner = createWorkflowAccountRunActionOwner({
      ...deps,
      definitions: { get: async () => { throw new Error('must_not_read_definition'); } },
      resolveEncryption: async () => { throw new Error('must_not_resolve_private_keys'); },
    });
    await expect(owner.execute({ actionId: 'workflow.run.summaries', input: { sourceArtifactIds: ['def-1', 'def-2'], recent: 3 }, context: {} })).resolves.toEqual(result);
  });
  it('reads public Automation statuses without opening accepted private content and refuses the wrong summary family', async () => {
    const result = { automationSummaries: [{ automationId: 'habit-a', lastRun: {
      id: runId, state: 'succeeded', workflowCustodyState: 'settled', attentionRequired: false,
      createdAt: '2026-10-21T00:00:00.000Z',
    } }], remainingAutomationIds: [] };
    let response: unknown = result;
    const deps = ownerDeps({ execute: async (operation, options) => {
      if (operation.operation !== 'summaries' || options?.publisherMachineId) throw new Error('unexpected_storage_boundary');
      return response;
    } });
    const owner = createWorkflowAccountRunActionOwner(deps);
    const input = WorkflowRunSummariesRequestV1Schema.parse({ automationIds: ['habit-a'] });
    await expect(owner.execute({ actionId: 'workflow.run.summaries', input, context: {} })).resolves.toEqual(result);
    response = { summaries: [], remainingSourceArtifactIds: [] };
    await expect(owner.execute({ actionId: 'workflow.run.summaries', input, context: {} }))
      .rejects.toMatchObject({ code: 'content_unavailable' });
    response = result;
    await expect(owner.execute({ actionId: 'workflow.run.summaries', input: { sourceArtifactIds: ['def-a'], recent: 1 }, context: {} }))
      .rejects.toMatchObject({ code: 'content_unavailable' });
  });
  it('refuses unaccepted plugin catalog sources before any run effect', async () => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async () => { throw new Error('must_not_access_run'); } }));
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId, source: { kind: 'catalog', workflow: 'plugin:happier.test/workflow' },
    }, context: {} })).rejects.toMatchObject({ code: 'source_unavailable' });
  });

  it('fails role admission closed when the materialization host is unavailable', async () => {
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
      throw new Error('must_not_write_unavailable_run');
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId, source: { kind: 'inline', definition }, roleOverrides: [{ roleId: 'reviewer', workspaceWrites: 'deny' }],
    }, context: { externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } } })).rejects.toMatchObject({ code: 'target_unavailable' });
  });
  it.each(['revision_changed', 'source_deleted', 'run_absent', 'different_origin'] as const)(
    'rechecks the exact immutable admission after mutable source failure: %s', async (scenario) => {
      const snapshot = runSnapshot();
      let reads = 0;
      const deps = ownerDeps({ execute: async (operation) => {
        if (operation.operation !== 'get') throw new Error('must_not_repeat_effect');
        reads += 1;
        if (reads === 1 || scenario === 'run_absent') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        return snapshot;
      } });
      const prepareWorkspace = vi.fn();
      const owner = createWorkflowAccountRunActionOwner({
        ...deps, prepareWorkspace,
        definitions: { get: async () => {
          if (scenario === 'source_deleted') throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
          return { definitionId: 'def-1', revision: { headerVersion: 2, bodyVersion: 2 }, definition, metadata: { title: 'Changed' } };
        } },
      });
      const result = owner.execute({ actionId: 'workflow.run.start', input: {
        runId, source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } },
      }, context: {
        callerPermissionMode: 'safe-yolo',
        defaultSessionId: scenario === 'different_origin' ? 'origin-2' : 'origin-1',
        externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
      } });
      if (scenario === 'run_absent' || scenario === 'different_origin') {
        await expect(result).rejects.toMatchObject({ code: 'currentness_conflict' });
      } else {
        await expect(result).resolves.toMatchObject({ admission: 'existing', run: { id: runId } });
      }
      expect(reads).toBe(2);
      expect(prepareWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([null, { kind: 'person' as const, accountId: 'editor' }])('retains saved authorship in authenticated detail while wait and cancellation remain boundary-only (%j)', async (savedBy) => {
    const snapshot = runSnapshot();
    if (!acceptedSnapshotResult.ok || acceptedSnapshotResult.snapshot.source.kind !== 'saved') throw new Error('saved_snapshot_fixture_required');
    snapshot.acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: { ...acceptedSnapshotResult.snapshot, source: { ...acceptedSnapshotResult.snapshot.source, savedBy } },
    }));
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation, options) => {
      expect(options?.publisherMachineId).toBeUndefined();
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'invocations.list') return { invocations: [] };
      if (operation.operation === 'wait') return { run: snapshot.run, observation: 'timeout' };
      if (operation.operation === 'cancel') return { run: { ...snapshot.run, state: 'cancelled' }, intent: 'cancel_requested' };
      throw new Error(`unexpected:${String(operation.operation)}`);
    } }));
    const detail = WorkflowRunGetResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} }));
    expect(detail).toMatchObject({ definition });
    expect(detail.acceptedContext.source).toEqual({ kind: 'saved', definitionId: 'def-1',
      revision: { headerVersion: 1, bodyVersion: 1 }, savedBy });
    await expect(owner.execute({ actionId: 'workflow.run.wait', input: { runId, timeoutSeconds: 1 }, context: {} })).resolves.toMatchObject({ observation: 'timeout' });
    await expect(owner.execute({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 0 }, context: {} })).resolves.toMatchObject({ run: { state: 'cancelled' }, intent: 'cancel_requested' });
  });

  it.each(['workflow.run.get', 'workflow.run.cancel', 'workflow.run.invocations.list'] as const)(
    'rejects an explicit resource restriction that disagrees with the retained Run for %s', async (actionId) => {
      const snapshot = runSnapshot();
      const operations: string[] = [];
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
        operations.push(String(operation.operation));
        if (operation.operation === 'get') return snapshot;
        if (operation.operation === 'invocations.list') return { invocations: [] };
        if (operation.operation === 'cancel') return { run: snapshot.run, intent: 'cancel_requested' };
        throw new Error('unexpected_storage_operation');
      } }));
      const context = { authority: 'present_user' as const,
        externalActionTarget: { kind: 'machine' as const, machineId: 'another-machine' } };
      const pending = actionId === 'workflow.run.cancel'
        ? owner.execute({ actionId, input: { runId, expectedRevision: 0 }, context })
        : owner.execute({ actionId, input: { runId }, context });
      await expect(pending).rejects.toMatchObject({ code: 'target_unavailable' });
      expect(operations).not.toContain('cancel');
      expect(operations).not.toContain('invocations.list');
    },
  );

  it('uses the accepted project restriction for reads and never substitutes the relay project', async () => {
    const snapshot = runSnapshot();
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'invocations.list') return { invocations: [] };
      throw new Error('unexpected_storage_operation');
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/other-project' } },
    } })).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    } })).resolves.toMatchObject({ definition });
  });

  it('projects the required frozen admitting starter in the lean list', async () => {
    const snapshot = runSnapshot();
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation !== 'list') throw new Error('lean_list_must_not_read_detail');
      return { runs: [snapshot.run], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus } };
    } }));
    // The snapshot fixture is admitted by the real user materializer, not an origin/depth guess.
    await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }))
      .resolves.toMatchObject({ runs: [{ startedBy: 'user' }] });
  });

  it.each([{}, { machineId: 'machine-a' }, { runId }, { runIds: [runId] }])(
    'lists only Runs proven to match the accepted Project restriction (%j)', async input => {
      const snapshot = runSnapshot();
      const requests: unknown[] = [];
      let listing = false;
      const target = { kind: 'machine' as const, machineId: 'machine-a',
        project: { machineId: 'machine-a', directory: '/repo' } };
      const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
        if (operation.operation === 'get' && !listing) return snapshot;
        if (operation.operation === 'invocations.list') return { invocations: [] };
        if (operation.operation !== 'list') throw new Error('project_list_must_stay_lean');
        requests.push(operation.request);
        // The first page contains another Project and an unreadable snapshot.
        // Neither public row may escape a private Project restriction.
        if (requests.length === 1) {
          if (!acceptedSnapshotResult.ok) throw new Error('snapshot_fixture_failed');
          const otherId = 'other-project-run';
          const otherEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: otherId },
            acceptedSnapshot: { ...acceptedSnapshotResult.snapshot,
              workspaceTarget: { project: { machineId: 'machine-a', directory: '/other-project', checkoutRootPath: '/other-project' } } },
          }));
          return { runs: [{ ...snapshot.run, id: otherId }, { ...snapshot.run, id: 'unreadable-run' }],
            acceptedEnvelopesByRunId: { [otherId]: otherEnvelope, 'unreadable-run': 'not-an-envelope' },
            keyCensusByRunId: Object.fromEntries([otherId, 'unreadable-run'].map(id => [id, { ...snapshot.keyCensus, runId: id }])),
            nextCursor: 'matching-project-page' };
        }
        return { runs: [snapshot.run], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
          keyCensusByRunId: { [runId]: snapshot.keyCensus } };
      } }));
      await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: { externalActionTarget: target } }))
        .resolves.toMatchObject({ run: { id: runId } });
      listing = true;
      await expect(owner.execute({ actionId: 'workflow.run.list', input, context: { externalActionTarget: target } }))
        .resolves.toMatchObject({ runs: [{ id: runId, where: target.project }] });
      expect(requests).toEqual([{ ...input, machineId: 'machine-a' },
        { ...input, machineId: 'machine-a', cursor: 'matching-project-page' }]);
    },
  );

  it('finds destination writes after nonmatching pages for both Account and Session triggers', async () => {
    const snapshot = runSnapshot();
    const scoped = await materializeWorkflowAcceptedSnapshotV1({ definition: { ...definition,
      defaults: { ...definition.defaults, conversation: { kind: 'origin_session' } } },
      context: {
        source: { kind: 'automation', automationId: 'habit' }, inputs: {}, machineId: 'machine-a',
        executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: 'destination' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    const account = await materializeWorkflowAcceptedSnapshotV1({ definition: { ...definition,
      defaults: { ...definition.defaults, conversation: { kind: 'existing_session', sessionId: 'destination', machineId: 'machine-a' } } },
      context: { source: { kind: 'automation', automationId: 'account-trigger' }, inputs: {}, machineId: 'machine-a',
        executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!scoped.ok || !account.ok) throw new Error('destination_fixture_failed');
    // Accepted 0.3 snapshots before HB did not carry the stored projection.
    const beforeHb = { ...account.snapshot };
    delete beforeHb.targetSessionIds;
    const envelope = (acceptedSnapshot: typeof scoped.snapshot, id: string) => serializeWorkflowStoredContentEnvelopeV1(
      sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: id }, acceptedSnapshot }));
    const requested: unknown[] = [];
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async operation => {
      if (operation.operation !== 'list') throw new Error('destination_filter_must_stay_lean');
      requested.push(operation.request);
      if (requested.length === 1) return { runs: [snapshot.run],
        acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus }, nextCursor: 'next-page' };
      return { runs: ['habit-run', 'account-run'].map(id => ({ ...snapshot.run, id })),
        acceptedEnvelopesByRunId: { 'habit-run': envelope(scoped.snapshot, 'habit-run'), 'account-run': envelope(beforeHb, 'account-run') },
        keyCensusByRunId: Object.fromEntries(['habit-run', 'account-run'].map(id => [id, { ...snapshot.keyCensus, runId: id }])) };
    } }));
    const result = await owner.execute({ actionId: 'workflow.run.list', input: { targetSessionId: 'destination' }, context: {} });
    expect(result).toMatchObject({ runs: [{ id: 'habit-run' }, { id: 'account-run' }] });
    expect(requested).toEqual([{ targetSessionId: 'destination' }, { targetSessionId: 'destination', cursor: 'next-page' }]);
  });

  it('lists Under Runs from complete server subtree membership across Session and Run pages', async () => {
    const base = runSnapshot();
    if (!acceptedSnapshotResult.ok) throw new Error('base_fixture_failed');
    const target = await materializeWorkflowAcceptedSnapshotV1({ definition: { ...definition,
      defaults: { ...definition.defaults, conversation: { kind: 'existing_session', sessionId: 'leaf', machineId: 'machine-a' } } },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!target.ok) throw new Error('target_fixture_failed');
    const envelope = (id: string, acceptedSnapshot: WorkflowAcceptedSnapshotV1) => serializeWorkflowStoredContentEnvelopeV1(
      sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId: id }, acceptedSnapshot }));
    const originId = '22222222-2222-4222-8222-222222222222';
    const targetId = '33333333-3333-4333-8333-333333333333';
    const listSessions = vi.fn(async ({ query }: Parameters<NonNullable<WorkflowAccountRunActionDeps['sessionList']>>[0]) =>
      markSessionListQueryResultV1({ sessions: query?.cursor ? [{ id: 'leaf', active: false, presence: 'offline', updatedAt: 1 }]
        : [{ id: 'lead', active: false, presence: 'offline', updatedAt: 1 }],
      nextCursor: query?.cursor ? null : 'next-session-page', hasNext: !query?.cursor,
      attentionNextCursor: null, attentionHasNext: false }));
    const storage = vi.fn(async (operation: Parameters<WorkflowAccountRunActionDeps['storage']['execute']>[0]) => {
      if (operation.operation !== 'list') throw new Error('unexpected_storage_operation');
      if (!operation.request?.cursor) return { runs: [base.run], acceptedEnvelopesByRunId: { [runId]: base.acceptedEnvelope },
        keyCensusByRunId: { [runId]: base.keyCensus }, nextCursor: 'next-run-page' };
      return { runs: [{ ...base.run, id: originId, origin: { kind: 'direct', originSessionId: 'leaf' } },
          { ...base.run, id: targetId }],
        acceptedEnvelopesByRunId: { [originId]: envelope(originId, { ...acceptedSnapshotResult.snapshot, origin: { kind: 'direct', originSessionId: 'leaf' } }),
          [targetId]: envelope(targetId, target.snapshot) },
        keyCensusByRunId: { [originId]: { ...base.keyCensus, runId: originId }, [targetId]: { ...base.keyCensus, runId: targetId } } };
    });
    const owner = createWorkflowAccountRunActionOwner({ ...ownerDeps({ execute: storage }), sessionList: listSessions });
    const page = await owner.execute({ actionId: 'workflow.run.list', input: { underSessionId: 'lead' }, context: { serverId: 'home' } });
    expect(page).toMatchObject({ runs: [{ id: originId }, { id: targetId }] });
    expect(listSessions).toHaveBeenCalledTimes(4); // active and archived, each through its continuation
    expect(listSessions.mock.calls.every(([input]) => input.query?.underSessionId === 'lead')).toBe(true);
    expect(storage.mock.calls.map(([operation]) => operation.request)).toEqual([
      { underSessionId: 'lead' }, { underSessionId: 'lead', cursor: 'next-run-page' },
    ]);
  });

  it('opens the same authored progress in direct Run detail and the lean list', async () => {
    const snapshot = runSnapshot();
    const unreadableId = '22222222-2222-4222-8222-222222222222';
    const rootId = 'root-list-progress';
    const index = { id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '4', lifecycle: 'running', createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt };
    // Storage returns opaque bytes; the real opener and exact binding run in the list owner.
    const contentEnvelope = JSON.stringify({ t: 'plain', v: {
      v: 2, binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId,
        recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      content: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId,
        stepProgress: { completed: 1, total: 3, currentLoop: { completed: 1, total: 4 } } },
    } });
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation === 'get') return { ...snapshot, rootProgress: { index, contentEnvelope } };
      if (operation.operation === 'invocations.list') return { invocations: [] };
      if (operation.operation !== 'list') throw new Error('lean_list_must_not_read_detail_or_invocations');
      return {
        runs: [snapshot.run, { ...snapshot.run, id: unreadableId }],
        acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope, [unreadableId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus, [unreadableId]: { ...snapshot.keyCensus, runId: unreadableId } },
        rootProgressByRunId: { [runId]: { index, contentEnvelope }, [unreadableId]: { index, contentEnvelope } },
      };
    } }));
    const result = await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} });
    expect(result).toMatchObject({ runs: [{ id: runId,
      where: { machineId: 'machine-a', directory: '/repo' }, startedBy: 'user',
      stepProgressCurrentness: { recordId: rootId, attempt: '0', contentRevision: '4' },
      stepProgress: { completed: 1, total: 3, currentLoop: { completed: 1, total: 4 } } },
      { id: unreadableId, where: null, startedBy: null, stepProgress: null, stepProgressCurrentness: null }],
      metadataByRunId: { [unreadableId]: { kind: 'unavailable', reason: 'content_unavailable' } } });
    // The name may be absent on a readable snapshot; its Where remains available.
    expect(result.metadataByRunId).not.toHaveProperty(runId);
    const detail = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} });
    expect(detail.run.stepProgress).toEqual(result.runs[0]?.stepProgress);
    expect(detail.run.stepProgressCurrentness).toEqual(result.runs[0]?.stepProgressCurrentness);
  });

  it.each(['unreadable', 'child', 'foreign-envelope', 'missing'] as const)
  ('binds root count currentness independently of private readability (%s)', async (scenario) => {
    const snapshot = runSnapshot();
    const rootId = 'root-list-token';
    const index = { id: rootId, runId, sequence: scenario === 'child' ? '1' : '0',
      parentRecordId: scenario === 'child' ? 'another-root' : null, memberOrdinal: '0', attempt: '0',
      contentRevision: '9', lifecycle: 'running', createdAt: snapshot.run.createdAt, updatedAt: snapshot.run.updatedAt };
    const contentEnvelope = JSON.stringify({ t: 'plain', v: { v: 2,
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1',
        runId: scenario === 'foreign-envelope' ? 'other-run' : runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, content: scenario === 'foreign-envelope'
          ? { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
            blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId }
          : { malformed: true } } });
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation === 'get') return { ...snapshot,
        ...(scenario === 'missing' ? {} : { rootProgress: { index, contentEnvelope } }) };
      if (operation.operation === 'invocations.list') return { invocations: [] };
      if (operation.operation !== 'list') throw new Error('lean_list_must_not_read_detail');
      return { runs: [snapshot.run], acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus },
        rootProgressByRunId: scenario === 'missing' ? {} : { [runId]: { index, contentEnvelope } } };
    } }));
    await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }))
      .resolves.toMatchObject({ runs: [{ startedBy: 'user', where: { machineId: 'machine-a', directory: '/repo' },
        stepProgress: scenario === 'missing' ? undefined : null, stepProgressCurrentness: scenario === 'unreadable'
          ? { recordId: rootId, attempt: '0', contentRevision: '9' } : scenario === 'missing' ? undefined : null }] });
    const direct = await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} });
    expect(direct.run).toMatchObject({ stepProgress: scenario === 'missing' ? undefined : null, stepProgressCurrentness: scenario === 'unreadable'
      ? { recordId: rootId, attempt: '0', contentRevision: '9' } : scenario === 'missing' ? undefined : null });
  });

  it('narrows a listed resource to the explicit Machine and refuses restrictions the batch cannot represent', async () => {
    const snapshot = runSnapshot();
    const owner = createWorkflowAccountRunActionOwner(ownerDeps({ execute: async (operation) => {
      if (operation.operation !== 'list') throw new Error('must_not_read_unrestricted_summary_batch');
      const request = operation.request as Readonly<{ machineId?: string }>;
      return {
        runs: request.machineId === 'machine-a' ? [snapshot.run] : [],
        acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
        keyCensusByRunId: { [runId]: snapshot.keyCensus },
      };
    } }));
    const target = { kind: 'machine' as const, machineId: 'machine-a' };
    await expect(owner.execute({ actionId: 'workflow.run.list', input: {}, context: { externalActionTarget: target } }))
      .resolves.toMatchObject({ runs: [{ id: runId }] });
    await expect(owner.execute({ actionId: 'workflow.run.list', input: { machineId: 'machine-b' }, context: { externalActionTarget: target } }))
      .rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(owner.execute({ actionId: 'workflow.run.summaries', input: { sourceArtifactIds: ['def-1'] }, context: { externalActionTarget: target } }))
      .rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('rejoins the frozen Team choice but rejects a different explicit admission audience', async () => {
    const snapshot = runSnapshot();
    snapshot.keyCensus.visibleTeamId = 'team-a';
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async operation => {
        if (operation.operation !== 'get') throw new Error('must_not_repeat_admission');
        return snapshot;
      } }),
      definitions: { get: async () => { throw new Error('must_not_read_mutable_grants_on_rejoin'); } },
    });
    const source = { kind: 'saved' as const, definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } };
    const context = { callerPermissionMode: 'safe-yolo', defaultSessionId: 'origin-1',
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId, source }, context }))
      .resolves.toMatchObject({ admission: 'existing' });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { ...source, visibleTeamId: 'team-a' } }, context }))
      .resolves.toMatchObject({ admission: 'existing' });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: { runId, source: { ...source, visibleTeamId: 'team-b' } }, context }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
  });

  it('does not rejoin an exact accepted admission after its authorization is revoked', async () => {
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async () => runSnapshot() }),
      isAcceptedAuthorizationCurrent: async () => false,
    });
    await expect(owner.execute({ actionId: 'workflow.run.start', input: {
      runId, source: { kind: 'saved', definitionId: 'def-1', revision: { headerVersion: 1, bodyVersion: 1 } },
    }, context: {
      externalActionTarget: { kind: 'machine', machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } },
    } })).rejects.toMatchObject({ code: 'run_access_denied' });
  });

  it('discloses nothing from an asynchronous read after Account retirement and performs no later mutation', async () => {
    const snapshot = runSnapshot();
    let retired = false;
    let writes = 0;
    const owner = createWorkflowAccountRunActionOwner({
      ...ownerDeps({ execute: async (operation) => {
        if (operation.operation === 'get') { retired = true; return snapshot; }
        if (operation.operation === 'invocations.list') return { invocations: [] };
        writes += 1;
        return { run: snapshot.run, intent: 'cancel_requested' };
      } }),
      assertCurrent: () => { if (retired) throw Object.assign(new Error('account_retired'), { code: 'account_retired' }); },
    });
    await expect(owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} })).rejects.toMatchObject({ code: 'account_retired' });
    await expect(owner.execute({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 0 }, context: {} })).rejects.toMatchObject({ code: 'account_retired' });
    expect(writes).toBe(0);
  });
});
