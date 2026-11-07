import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createWorkflowDiscussionResultPublisher } from './workflowDiscussionPublication';
import type { WorkflowCoordinatorInvocation } from './coordinator';
import type { StoredCredentials } from '@/persistence';
import type { DiscussionReplyReturnPublication } from '@/session/services/sessionMessageReply';
import { WorkflowResultDeliveryV1Schema } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import { DiscussionAgentApprovedReplayPublicationV1Schema } from '@happier-dev/protocol/discussions/api';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { projectWorkflowDiscussionProducerV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { SessionMessageReplyAccountMutationV1Schema, SessionMessageReplyReadResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

const origin = { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
const invocation = (extra: Partial<WorkflowCoordinatorInvocation> = {}): WorkflowCoordinatorInvocation => ({
  key: 'leaf', recordId: 'invocation', runId: 'run', blockId: 'check', path: { blockId: 'check', scope: [] }, attempt: 0,
  acceptedAtMs: 0, blockKind: 'action', lifecycle: 'completed',
  execution: { kind: 'action', actionId: 'plugin:external/check', actionRequestId: 'action-request', localInputId: 'input', input: {} }, result: { checked: true }, ...extra,
});
afterEach(() => vi.restoreAllMocks());
it.each(['approval_rejected', 'approval_canceled', 'wrong_original_binding'] as const)(
  'observes retained Session refusal without another decision write (%s)', async code => {
    const failure = { code: code === 'approval_canceled' ? 'approval_canceled' as const : 'approval_rejected' as const,
      phase: 'action_admission' as const, retryable: false };
    let decided = false;
    const reads = vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200,
      data: SessionMessageReplyReadResultV1Schema.parse({ v: 1, status: 'available', progress: {
        v: 1, mode: 'wait', workflow: { purpose: 'invocation', runId: 'run', invocationRecordId: 'invocation' },
        disposition: decided ? 'released' : 'observing',
        discussion: { discussionId: origin.discussion.discussionId, messageId: origin.messageId, throughSeq: origin.throughSeq,
          participantSessionId: decided && code === 'wrong_original_binding' ? 'other' : 'session' },
        outcome: { kind: 'answer', result: { sessionId: 'session', messageId: 'answer' } },
        returnPublication: decided ? { kind: 'failed', failure } : { kind: 'approval_pending', artifactId: 'approval' },
      } }) }));
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      // The actual HTTP route rejects the old daemon decision without its id.
      SessionMessageReplyAccountMutationV1Schema.parse(body);
      throw new Error('unexpected_original_decision_write');
    });
    let observations = 0;
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
      origin, isCurrent: async () => true,
      publish: async () => { throw new Error('unexpected_republication'); },
      observeApproval: async ({ artifactId }) => {
        expect(artifactId).toBe('approval');
        observations++;
        decided = true;
        return { ok: false, errorCode: failure.code, error: failure.code };
      } });
    await expect(publish({ runId: 'run', invocation: invocation({ blockKind: 'step',
      execution: { kind: 'session', sessionId: 'session', localInputId: 'input' } }) })).rejects.toMatchObject(
      code === 'wrong_original_binding' ? { code: 'workflow_discussion_publication_unavailable' } : { code: failure.code, failure, terminal: true });
    expect(writes).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(observations).toBe(1);
  });
it('honors invocation cancellation before publication while its claim remains alive', async () => {
  const caller = new AbortController();
  caller.abort();
  let authorityReads = 0;
  let publications = 0;
  const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'token', encryption: null },
    origin, signal: new AbortController().signal,
    isCurrent: async () => { authorityReads += 1; return true; },
    publish: async () => { publications += 1; return { v: 1, ok: false, error: 'discussions_unavailable',
      failure: { code: 'discussions_unavailable', phase: 'workflow_publication', retryable: false } }; } });
  await expect(publish({ runId: 'run', invocation: invocation(), signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(authorityReads).toBe(0);
  expect(publications).toBe(0);
});
it.each(['cancelled', 'failed'] as const)('does not publish a %s external Action outcome', async lifecycle => {
  const publications: DiscussionReplyReturnPublication[] = [];
  let authorityReads = 0;
  const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
    origin, isCurrent: async () => { authorityReads += 1; return true; },
    publish: async publication => { publications.push(publication); throw new Error('unexpected_publication'); } });
  const stopped = invocation({ lifecycle });
  await publish({ runId: 'run', invocation: stopped });
  await publish({ runId: 'run', invocation: stopped });
  expect(publications).toHaveLength(0);
  expect(authorityReads).toBe(0);
  expect(stopped.lifecycle).toBe(lifecycle);
  expect(stopped.result).toEqual({ checked: true });
});
describe('Workflow Discussion accepted-result publication', () => {
  it('preserves the Action owner failure and its retryability at the Workflow boundary', async () => {
    const failure = { code: 'action_failed' as const, phase: 'action_admission' as const, retryable: false };
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
      origin, isCurrent: async () => true,
      publish: async () => ({ v: 1, ok: false, error: failure.code, failure }) });
    await expect(publish({ runId: 'run', invocation: invocation() })).rejects.toMatchObject({
      code: failure.code, failure, terminal: true,
    });
  });
  it('retains the private approval hold without advancing a dependent Workflow step', async () => {
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
      origin, isCurrent: async () => true, publish: async () => ({ v: 1, ok: false,
        error: 'discussions_unavailable', pending: { kind: 'approval', artifactId: 'approval' } }) });
    await expect(publish({ runId: 'run', invocation: invocation() })).rejects.toMatchObject({
      terminal: false, pending: { kind: 'approval', artifactId: 'approval' },
    });
  });
  it('rejoins an uncertain acknowledgement when original custody already proves the Discussion return committed', async () => {
    let returned = false;
    const progress = () => ({ v: 1, mode: 'wait',
      workflow: { purpose: 'invocation', runId: 'run', invocationRecordId: 'invocation' },
      disposition: returned ? 'returned' : 'observing',
      discussion: { discussionId: origin.discussion.discussionId, messageId: origin.messageId,
        throughSeq: origin.throughSeq, participantSessionId: 'session' },
      outcome: returned ? { kind: 'answer', publicationRef: { kind: 'discussion', discussion: origin.discussion, messageId: 'reply' } }
        : { kind: 'answer', result: { sessionId: 'session', messageId: 'answer' } } });
    vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200,
      data: SessionMessageReplyReadResultV1Schema.parse({ v: 1, status: 'available', progress: progress() }) }));
    vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: 200, data: { v: 1, ok: true, progress: progress() } }));
    let attempts = 0;
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
      origin, isCurrent: async () => true, publish: async () => {
        attempts += 1;
        returned = true;
        return { v: 1, ok: false, error: 'discussions_unavailable',
          failure: { code: 'outcome_unknown', phase: 'machine_publisher', retryable: true } };
      } });
    const native = invocation({ blockKind: 'step', execution: { kind: 'session', sessionId: 'session', localInputId: 'input' } });
    await expect(publish({ runId: 'run', invocation: native })).resolves.toBeUndefined();
    await expect(publish({ runId: 'run', invocation: native })).resolves.toBeUndefined();
    expect(attempts).toBe(1);
  });
  it.each([{ kind: 'approval_pending', retryable: false }, { kind: 'failed', retryable: false },
    { kind: 'failed', retryable: true }] as const)('does not reattempt a Session result with unchanged $kind original custody (retryable=$retryable)', async ({ kind, retryable }) => {
    const failure = { code: retryable ? 'discussions_unavailable' as const : 'action_failed' as const,
      phase: 'action_admission' as const, retryable };
    const progress = { v: 1, mode: 'wait', workflow: { purpose: 'invocation', runId: 'run', invocationRecordId: 'invocation' },
      disposition: kind === 'failed' ? 'released' : 'return_pending',
      discussion: { discussionId: origin.discussion.discussionId, messageId: origin.messageId, throughSeq: origin.throughSeq,
        participantSessionId: 'session' }, outcome: { kind: 'answer', result: { sessionId: 'session', messageId: 'answer' } },
      returnPublication: kind === 'failed' ? { kind, failure } : { kind, artifactId: 'approval' } };
    const body = SessionMessageReplyReadResultV1Schema.parse({ v: 1, status: 'available', progress });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: body });
    let attempts = 0;
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
      origin, isCurrent: async () => true, publish: async () => {
        attempts += 1;
        return { v: 1, ok: false, error: failure.code, failure };
      } });
    const native = invocation({ blockKind: 'step', execution: { kind: 'session', sessionId: 'session', localInputId: 'input' } });
    for (let change = 0; change < 5; change += 1) {
      await expect(publish({ runId: 'run', invocation: native })).rejects.toMatchObject(kind === 'failed'
        ? { code: failure.code, failure, terminal: !retryable }
        : { pending: { kind: 'approval', artifactId: 'approval' }, terminal: false });
    }
    expect(attempts).toBe(0);
    const resumed = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
      origin, isCurrent: async () => true, retryFailedPublications: true,
      publish: async () => { attempts += 1; throw new Error('lost_publication_ack'); } });
    if (kind === 'failed' && retryable) {
      await expect(resumed({ runId: 'run', invocation: native })).rejects.toThrow('lost_publication_ack');
      expect(attempts).toBe(1);
    } else {
      await expect(resumed({ runId: 'run', invocation: native })).rejects.toMatchObject(kind === 'failed'
        ? { terminal: true, failure } : { pending: { kind: 'approval', artifactId: 'approval' } });
      expect(attempts).toBe(0);
    }
  });
  it('keeps round projections internal without suppressing an external Action result', async () => {
    const publications: DiscussionReplyReturnPublication[] = [];
    let authorityReads = 0;
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
      origin, isCurrent: async () => { authorityReads += 1; return true; },
      publish: async input => { publications.push(input); return { v: 1, ok: false, error: 'discussion_post_denied' }; } });
    const aggregate = invocation({ execution: { kind: 'action', actionId: 'workflow.discussion.round.project',
      actionRequestId: 'projection', localInputId: 'projection', input: { collections: ['opinions'] } },
      result: { allPassed: false, hasNext: true, nextParticipants: [], outcomeReferences: [] } });
    await publish({ runId: 'run', invocation: aggregate });
    expect(publications).toEqual([]);
    expect(authorityReads).toBe(0);
    expect(projectWorkflowDiscussionProducerV1({ runId: 'run', invocationRecordId: aggregate.recordId,
      invocationAttempt: '0', blockKind: 'action', lifecycle: 'completed', execution: aggregate.execution })).toBeNull();
    await expect(publish({ runId: 'run', invocation: invocation() })).rejects.toThrow('workflow_discussion_publication_unavailable');
    expect(publications).toMatchObject([{ kind: 'workflow_invocation', producer: { runId: 'run', outcome: 'answer' }, content: { v: 1, parts: [{ t: 'text' }] } }]);
    const publication = publications[0];
    const content = publication && 'kind' in publication ? publication.content : undefined;
    expect(DiscussionMessageContentV1Schema.safeParse(content).success).toBe(true);
    expect(content).not.toHaveProperty('value');
    expect(authorityReads).toBe(1);
  });
  it('projects an accepted tagged result destination into the strict Machine publication origin', async () => {
    const destination = WorkflowResultDeliveryV1Schema.parse({ kind: 'originating_discussion', ...origin });
    if (destination.kind !== 'originating_discussion') throw new Error('Expected Discussion result destination');
    const packets: unknown[] = [];
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
      origin: destination, isCurrent: async () => true, publish: async publication => {
        if (!('kind' in publication)) throw new Error('Expected non-Session Workflow publication');
        packets.push({ v: 1, operation: 'workflow_result', machineId: 'machine', publication: {
          discussionId: publication.discussion.discussion.discussionId, origin: publication.discussion,
          producer: publication.producer, request: { localId: deriveWorkflowDiscussionReplyLocalIdV1(publication.workflow),
            content: { t: 'plain', v: publication.content }, mentionedAccountIds: [],
            replyTarget: { kind: 'message', messageId: publication.discussion.messageId } },
        } });
        return { v: 1, ok: false, error: 'discussion_post_denied' };
      } });
    await expect(publish({ runId: 'run', invocation: invocation() })).rejects.toThrow('workflow_discussion_publication_unavailable');
    expect(packets).toHaveLength(1);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.safeParse(packets[0]).success).toBe(true);
  });
  it('omits aggregate rows and private review-held drafts', async () => {
    const publications: DiscussionReplyReturnPublication[] = [];
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test' } as StoredCredentials,
      origin, isCurrent: async () => true, publish: async input => { publications.push(input); throw new Error('unexpected'); } });
    await publish({ runId: 'run', invocation: invocation({ blockKind: 'parallel' }) });
    await publish({ runId: 'run', invocation: invocation({ lifecycle: 'waiting_for_review' }) });
    await publish({ runId: 'run', invocation: invocation({ lifecycle: 'cancelled', result: 'PRIVATE-DRAFT',
      review: { resultSource: { kind: 'published', by: 'agent' } } }) });
    expect(publications).toEqual([]);
  });
  it('publishes an authorized completed review generation without a copied prior decision', async () => {
    let offered = false;
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test' } as StoredCredentials,
      origin, isCurrent: async () => true, publish: async () => { offered = true; return { v: 1, ok: false, error: 'discussion_post_denied' }; } });
    await expect(publish({ runId: 'run', invocation: invocation({ review: { resultSource: { kind: 'execution_input' } } }) }))
      .rejects.toThrow('workflow_discussion_publication_unavailable');
    expect(offered).toBe(true);
  });
});
