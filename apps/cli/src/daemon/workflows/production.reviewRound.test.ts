import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  type WorkflowDefinitionV1, type WorkflowProgressEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';
import { ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { createInMemoryReviewRecordPortV1 } from '../../../../../packages/protocol/src/reviews/reviewArtifactV1.testkit';
import { createSessionRecordFixture } from '@/testkit';
import { createProductionWorkflowRunCoordinator, type WorkflowProductionExecutionDeps } from './production';
import { resolveWorkflowSessionConversation } from './invocationRecoveryObserver';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const accountId = 'account-1';
const machineId = 'machine-1';
const rootRecordId = 'review-root';
const sessionId = 'c123456789012345678901234';
const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
afterEach(() => vi.restoreAllMocks());

describe('production Review round lifecycle', () => {
  it.each(['cancelled', 'cancelled_before_prepare', 'failed', 'waiting_for_review', 'session_review'] as const)(
    'settles only terminal Review execution after %s, using the actual prepared round', async state => {
      const records = createInMemoryReviewRecordPortV1();
      const first = await records.start({ reviewId: 'review', title: 'Review', subjectKind: 'comparison',
        sourceKind: 'workflow', reviewerIds: ['reviewer'], startedAt: 1 });
      const beforePrepare = state === 'cancelled_before_prepare';
      if (!beforePrepare) await records.settle({ ...first, outcome: 'completed', finishedAt: 2, runs: [],
        reviewerOutcomes: [{ key: 'reviewer', outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' } }] });
      const prepared = beforePrepare ? first : await records.start({ reviewId: 'review', title: 'Review', subjectKind: 'comparison',
        sourceKind: 'workflow', reviewerIds: ['reviewer'], startedAt: 3, newRound: true });
      const sessionStep = state === 'failed' || state === 'session_review';
      const definition: WorkflowDefinitionV1 = { version: 1,
        inputs: [{ name: 'reviewRound', valueType: 'json', required: true }], defaults: {}, blocks: [
          { kind: 'action', id: 'prepare', actionId: 'review.prepare_round', input: {} },
          sessionStep
            ? { kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] },
              input: [], result: { kind: 'json', schema: zodSchemaToJsonSchemaObject(ReviewStartTerminalValueV1Schema, { target: 'draft-7' }) } }
            : { kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } },
        ] };
      const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
          definition, authoredDefinition: definition, startedBy: 'user', workDepth: 0, frozenChildren: {}, metadata: null,
          inputs: { reviewRound: first }, machineId, executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
          authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
          materializedLeaves: [
            { authoredWorkspace: { kind: 'inherit' }, sourceKey: '$root', blockId: 'prepare', kind: 'action',
              actionId: 'review.prepare_round', selection: {}, executionTarget: { kind: 'session' } },
            sessionStep
              ? { authoredWorkspace: { kind: 'inherit' }, sourceKey: '$root', blockId: 'review', kind: 'step',
                selection: {}, executionTarget: { kind: 'session' } }
              : { authoredWorkspace: { kind: 'inherit' }, sourceKey: '$root', blockId: 'human', kind: 'wait',
                selection: {}, executionTarget: { kind: 'session' } },
          ], source: { kind: 'inline' }, origin: { kind: 'direct' },
        } }));
      const boundary = createWorkflowRunStorageTestkit({ runId, accountId, machineId, acceptedEnvelope,
        origin: { kind: 'direct' }, invocationPageSize: 1 });
      const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: {
          kind: 'happier.workflow-checkpoint.v1', rootRecordId, nextSequence: '3',
          frontier: { nextBlockOrdinal: beforePrepare ? 0 : 1, paused: false },
        } }));
      const serialize = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string,
        progress: Omit<WorkflowProgressEnvelopeV1, 'logicalInvocationRecordId'>) =>
        serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence,
            parentRecordId, memberOrdinal, attempt: '0' }, progress: { ...progress, logicalInvocationRecordId: id } }));
      await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, parentAttempt: 0,
        accountCurrentness: witness, checkpointEnvelope, rootInvocation: { id: rootRecordId,
          contentEnvelope: serialize(rootRecordId, '0', null, '0', { kind: 'happier.workflow-progress.v1',
            invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0' }) } });
      if (!beforePrepare) {
        await boundary.execute({ operation: 'invocations.admit', runId, parentAttempt: 0, accountCurrentness: witness,
        expectedRevision: boundary.run().revision, checkpointEnvelope, invocations: [{ id: 'prepare', sequence: '1',
          parentRecordId: rootRecordId, memberOrdinal: '0', contentEnvelope: serialize('prepare', '1', rootRecordId, '0', {
            kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'prepare', scope: [] }, blockKind: 'action', attempt: '0',
            execution: { kind: 'action', actionId: 'review.prepare_round', localInputId: 'prepare', actionRequestId: 'prepare', input: {} },
            result: { reviewRound: prepared, retainedExtension: true },
          }) }] });
      const prepareRow = boundary.rowById('prepare')!;
      prepareRow.index = { ...prepareRow.index, lifecycle: 'completed' };
      }
      if (sessionStep) {
        await boundary.execute({ operation: 'invocations.admit', runId, parentAttempt: 0, accountCurrentness: witness,
          expectedRevision: boundary.run().revision, checkpointEnvelope, invocations: [{ id: 'reviewer', sequence: '2',
            parentRecordId: rootRecordId, memberOrdinal: '1', contentEnvelope: serialize('reviewer', '2', rootRecordId, '1', {
              kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'review', scope: [] }, blockKind: 'step', attempt: '0',
              execution: { kind: 'session', sessionId, localInputId: 'review-input' },
              workspace: { descriptor: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
              input: { document: { text: 'Review', references: [], attachments: [] }, input: [
                { reviewRound: prepared }, { kind: 'review_session.v1', reviewerId: 'reviewer' },
              ] },
              ...(state === 'failed' ? { reason: { code: 'missing_reference' } } : {}),
            }) }] });
        const failed = boundary.rowById('reviewer')!;
        failed.index = { ...failed.index, lifecycle: state === 'failed' ? 'failed' : 'running' };
      }
      if (state === 'cancelled' || beforePrepare) boundary.requestControl('cancel_requested');
      if (state === 'session_review') {
        const session = createSessionRecordFixture({ id: sessionId, machineId, active: true,
          encryptionMode: 'plain', metadata: JSON.stringify({ machineId, path: '/repo',
            runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }) });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
          const path = new URL(String(url)).pathname;
          if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          } };
          if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session } };
          throw new Error(`Unexpected Session metadata read: ${path}`);
        });
      }
      const execution: WorkflowProductionExecutionDeps = { credentials: { token: 'token', encryption: null }, serverId: 'server',
        machineAdmissionTransport: async () => { throw new Error('Retained execution cannot admit new input'); },
        resolveExistingSessionConversation: input => resolveWorkflowSessionConversation({ ...input, credentials: { token: 'token', encryption: null } }),
        sessionInput: { enqueue: async () => { throw new Error('Retained input must be observed'); }, observe: async () => ({
          ok: true, sessionId, localId: 'review-input', result: { kind: 'final_text',
            text: JSON.stringify({ reviewOutcome: 'complete', summary: 'Inspected', overviewMarkdown: 'Inspected',
              findings: [], questions: [], assumptions: [], commentIds: ['invented'] }) },
        }) },
        detachedRun: { actionExecutor: {
          execute: async () => { throw new Error('Retained execution cannot start native work'); },
          resolveReviewServices: async () => ({ records,
            comments: async () => { throw new Error('Empty findings cannot publish a comment'); } }),
        }, buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) } };
      const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary,
        workspaceScm: { inspectLocation: async () => ({ inspection: { rootPath: '/repo' } }), verifyRecordedWorkspace: async () => 'available' },
        execution, resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation' }),
        resolveAccountEncryption: async () => ({ kind: 'available', witness }), isAcceptedAuthorizationCurrent: async () => true,
        onCommittedTransition: () => {}, onReviewEntered: () => {} });
      const coordinated = await coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
        accountCurrentness: witness, acceptedEnvelope });
      expect(coordinated, JSON.stringify(coordinated)).toMatchObject({ state: state === 'session_review' ? 'succeeded' : beforePrepare ? 'cancelled' : state });
      const review = await records.read('review');
      const nonterminal = state === 'waiting_for_review' || state === 'session_review';
      expect(review?.rounds.map(round => round.state)).toEqual(beforePrepare ? ['cancelled'] : ['completed', nonterminal ? 'running' : state]);
      expect(review?.rounds.at(-1)?.runs).toEqual(nonterminal ? [] : [{ kind: 'workflow', runId }]);
      if (state === 'session_review') {
        const row = boundary.rowById('reviewer')!;
        const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
            sequence: row.index.sequence, parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt },
          envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
        expect(opened).toMatchObject({ kind: 'available', content: { result: { reviewRound: prepared, commentIds: [],
          perEngineOutcome: [{ key: 'reviewer', outcome: 'completed', materialization: { kind: 'complete' } }] } } });
      }
    });
});
