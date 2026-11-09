import { describe, expect, it } from 'vitest';
import { getBuiltinWorkflowCatalogV1, type WorkflowDiscussionRoundBindingV1 } from '@happier-dev/protocol/workflows';
import { sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { DurableWorkflowCoordinatorStore } from './production';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { workflowInvocationKey } from './coordinator';

async function setup(pattern: WorkflowDiscussionRoundBindingV1['pattern']) {
    const accountId = 'account', runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c', machineId = 'machine', rootRecordId = 'root';
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId, nextSequence: '1',
      frontier: { nextBlockOrdinal: 0, paused: false } };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint', rootInvocation: {
      id: rootRecordId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootRecordId,
          sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress: {
          kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
          attempt: '0', logicalInvocationRecordId: rootRecordId,
        } })),
    } });
    const params = { accountId, runId, machineId, parentAttempt: 0, rootRecordId, checkpoint,
      authoredDefinition: getBuiltinWorkflowCatalogV1().find(entry => entry.id === (pattern === 'fresh_opinions'
        ? 'builtin:fresh-opinions' : 'builtin:answer-and-review'))!.definition, storage: boundary, destinations: [],
      discussionRound: { discussionId: 'discussion', pattern },
      encryption: { witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' as const } } };
    const store = await DurableWorkflowCoordinatorStore.load({ ...params, revision: boundary.run().revision });
    return { params, boundary, store };
}

describe('durable Discussion round summary publication', () => {
  it.each(['answer', 'pass'] as const)('projects the exact accepted %s after reload without another answer read', async outcome => {
    const { params, boundary, store } = await setup('answer_and_review');
    const { runId } = params;
    const key = workflowInvocationKey({ runId, blockId: 'answer', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId: 'answer', runId, blockId: 'answer', blockKind: 'step',
      path: { blockId: 'answer', scope: [] }, memberOrdinal: '0', attempt: 0, acceptedAtMs: 0, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'completed', result: outcome === 'answer' ? 'PRIVATE ANSWER' : '',
      ...(outcome === 'pass' ? { replyOutcome: { kind: 'pass' as const } } : {}) });
    const expected = { discussionId: 'discussion', answerCount: outcome === 'answer' ? 1 : 0, synthesized: false };
    expect(boundary.calls.filter(call => call.operation === 'invocations.fact').at(-1)?.discussionRound).toEqual(expected);
    const reloaded = await DurableWorkflowCoordinatorStore.load({ ...params, checkpoint: store.checkpoint, revision: boundary.run().revision });
    await reloaded.refreshStepProgress();
    expect(await reloaded.readDiscussionRoundProgress()).toEqual(expected);
    const before = boundary.calls.length;
    await reloaded.refreshStepProgress();
    expect(boundary.calls.slice(before).filter(call => call.operation === 'invocations.get')).toEqual([]);
    const review = workflowInvocationKey({ runId, blockId: 'reviewed', scope: [], attempt: 0 });
    await reloaded.ensureIntent({ key: review, recordId: 'reviewed', runId, blockId: 'reviewed', blockKind: 'if',
      path: { blockId: 'reviewed', scope: [] }, memberOrdinal: '1', attempt: 0, acceptedAtMs: 0, lifecycle: 'pending' });
    await reloaded.commitFact({ key: review, lifecycle: 'completed', container: { kind: 'if', selected: 'then', nextBlockOrdinal: '1' } });
    expect(boundary.calls.filter(call => call.operation === 'invocations.fact').at(-1)?.discussionRound).toBeUndefined();
  });

  it('counts typed fresh outcomes separately from the exact completed synthesis slot', async () => {
    const { params, boundary, store } = await setup('fresh_opinions');
    const { runId } = params;
    const outcomes = workflowInvocationKey({ runId, blockId: 'outcomes', scope: [], attempt: 0 });
    await store.ensureIntent({ key: outcomes, recordId: 'outcomes', runId, blockId: 'outcomes', blockKind: 'action',
      path: { blockId: 'outcomes', scope: [] }, memberOrdinal: '1', attempt: 0, acceptedAtMs: 0, lifecycle: 'pending' });
    await store.commitFact({ key: outcomes, lifecycle: 'completed', result: { allPassed: false, hasNext: false, nextParticipants: [],
      outcomeReferences: ['answer', 'pass', 'failed', 'cancelled', 'declined', 'terminal_no_result'].map((kind, index) => ({
        runId, invocationRecordId: `opinion-${index}`, participant: { kind: 'session', session: { serverId: 'home', sessionId: `session-${index}` } },
        kind, ...(kind === 'answer' ? { result: 'PRIVATE ANSWER' } : {}),
      })) } });
    expect(await store.readDiscussionRoundProgress()).toEqual({ discussionId: 'discussion', answerCount: 1, synthesized: false });
    let parentKey: string | undefined;
    for (const [index, blockId] of ['synthesize', 'choose-synthesizer', 'selected-synthesis'].entries()) {
      const key = workflowInvocationKey({ runId, blockId, scope: [], attempt: 0 });
      await store.ensureIntent({ key, recordId: blockId, runId, blockId, blockKind: index === 2 ? 'step' : 'if',
        path: { blockId, scope: [] }, ...(parentKey ? { parentKey } : {}), memberOrdinal: index === 0 ? '2' : '0',
        attempt: 0, acceptedAtMs: 0, lifecycle: 'pending' });
      await store.commitFact(index === 2 ? { key, lifecycle: 'completed', result: 'PRIVATE SYNTHESIS' }
        : { key, lifecycle: 'running', container: { kind: 'if', selected: 'then', nextBlockOrdinal: '0' } });
      parentKey = key;
    }
    const expected = { discussionId: 'discussion', answerCount: 1, synthesized: true };
    expect(boundary.calls.filter(call => call.operation === 'invocations.fact').at(-1)?.discussionRound).toEqual(expected);
    const reloaded = await DurableWorkflowCoordinatorStore.load({ ...params, checkpoint: store.checkpoint, revision: boundary.run().revision });
    expect(await reloaded.readDiscussionRoundProgress()).toEqual(expected);
  });
});
