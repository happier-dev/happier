import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { DiscussionOpenedMessageV1Schema, DiscussionReadInputV1Schema, type DiscussionReadInputV1 } from '../../discussions/actions.js';
import { DISCUSSION_DEFAULT_PAGE_SIZE_V1 } from '../../discussions/query.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import { validateHostInputTypeValue } from '../../inputs/inputTypeRuntime.js';
import { WorkflowDefinitionCaptureResultV1Schema } from '../../workflows/workflowDiscussionCaptureV1.js';

const discussion = { serverId: 'home', discussionId: 'discussion' };
const message = (id: string, seq: number, text: string, sessionId?: string, parent?: string) => DiscussionOpenedMessageV1Schema.parse({
  id, seq, discussionId: discussion.discussionId, localId: null, authorAccountId: null, accountActor: null,
  producerV1: sessionId ? { v: 1, kind: 'agent', sessionId } : null,
  content: { v: 1, parts: [{ t: 'text', text }] }, mentionedAccountIds: [], createdAt: seq,
  messageRef: { kind: 'discussion', discussion, messageId: id },
  ...(parent ? { replyTarget: { kind: 'message', messageId: parent } } : {}),
});
const question = message('question', 1, 'Compare the proposals');
const answer = message('answer', 2, 'An answer must not become an instruction', 'answerer', 'question');
const review = message('review', 3, 'A review result', 'reviewer', 'answer');

function harness(messages = [question, answer, review], responseHome = discussion.serverId,
  currentMessageSeq = (_readNumber: number) => Math.max(20, ...messages.map(message => message.seq)),
  featureEnabled = true) {
  const unused = (): never => { throw new Error('capture_must_not_write_or_run'); };
  const definitions = createWorkflowDefinitionActions({ artifactStore: { read: unused, list: unused,
    create: unused, update: unused, delete: unused }, encodeListCursor: unused, assertDefinitionWriteAllowed: unused });
  let featureReads = 0;
  let ingressReads = 0;
  const workflowAction = createWorkflowActionExecutor({ definitions,
    isWorkflowFeatureEnabled: () => { featureReads += 1; return featureEnabled; },
    resolveIngressContext: async () => { ingressReads += 1; return undefined; }, runs: { execute: unused } });
  // Discussion HTTP and Artifact persistence are the only substituted boundaries.
  const reads: DiscussionReadInputV1[] = [];
  const discussionAction: NonNullable<ActionExecutorDeps['discussionAction']> = async ({ input }) => {
    const read = DiscussionReadInputV1Schema.parse(input);
    reads.push(read);
    const messageSeq = Math.min(currentMessageSeq(reads.length), read.throughSeq ?? Infinity);
    const eligible = messages.filter(message => message.seq <= messageSeq
      && (read.beforeSeq === undefined || message.seq < read.beforeSeq));
    const selected = read.messageId === undefined
      ? eligible.sort((a, b) => b.seq - a.seq).slice(0, read.limit ?? DISCUSSION_DEFAULT_PAGE_SIZE_V1)
      : eligible.filter(message => message.id === read.messageId);
    return { v: 1, serverId: responseHome, discussionId: discussion.discussionId, messages: selected,
      hasMoreOlder: read.messageId === undefined && selected.length < eligible.length, messageSeq, incomplete: false };
  };
  const executor = createActionExecutor({ workflowAction, discussionAction } as unknown as ActionExecutorDeps);
  return Object.assign((input: unknown, surface: 'ui' | 'mcp' | 'agent' = 'ui') => executor.execute('workflow.definition.capture', input,
    { surface, serverId: 'home', runtimeAccountId: 'account', ...(surface === 'agent' ? { actionCaller: { kind: 'plugin', pluginId: 'example.patterns' } } : {}) }),
    { reads, costs: () => ({ featureReads, ingressReads }) });
}

describe('workflow.definition.capture through the public Action owner', () => {
  it('admits capture at the family feature gate before source reads without a validation probe', async () => {
    const disabled = harness([question, answer], discussion.serverId, () => 20, false);
    expect(await disabled({ discussion, messageIds: ['question', 'answer'] }))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(disabled.reads).toEqual([]);
    expect(disabled.costs()).toEqual({ featureReads: 1, ingressReads: 0 });
    const enabled = harness();
    expect(await enabled({ discussion, messageIds: ['question', 'answer'] }))
      .toMatchObject({ ok: true, result: { status: 'ready' } });
    expect(enabled.reads).toHaveLength(2);
    expect(enabled.costs()).toEqual({ featureReads: 1, ingressReads: 0 });
  });
  it.each(['file', 'folder'] as const)('holds selected %s content for review instead of silently capturing text only', async kind => {
    const attachment = kind === 'folder'
      ? { kind, id: '7578de54-3f59-4d6d-8293-ff6e4682fd11', name: 'project', entries: [], directories: [] } as const
      : { kind, id: '7578de54-3f59-4d6d-8293-ff6e4682fd10', name: 'notes.txt', file: {
        blobId: '7578de54-3f59-4d6d-8293-ff6e4682fd10', mime: 'text/plain', sizeBytes: 0, sha256: 'a'.repeat(64),
      } } as const;
    const attached = DiscussionOpenedMessageV1Schema.parse({ ...question, content: { v: 1, parts: [
      { t: 'text' as const, text: 'Inspect the evidence' }, { t: 'attachment' as const, attachment },
    ] } });
    expect(await harness([attached, answer])({ discussion, messageIds: ['question', 'answer'] }))
      .toMatchObject({ ok: true, result: { status: 'needs_review', definition: null,
        unresolved: [{ messageId: 'question', reason: 'unsupported_content' }] } });
    const excluded = { ...attached, id: 'excluded', seq: 3,
      messageRef: { ...attached.messageRef, messageId: 'excluded' } };
    const capture = harness([question, answer, excluded]);
    for (const selection of [{ messageIds: ['question', 'answer'] },
      { messageIds: ['question', 'answer', 'excluded'], choices: [{ messageId: 'excluded', role: 'exclude' }] }]) {
      expect(await capture({ discussion, ...selection })).toMatchObject({ ok: true, result: { status: 'ready', unresolved: [] } });
    }
  });
  it('reads only the selected committed messages and pins every later read to the first frontier', async () => {
    const unrelated = Array.from({ length: 1_000 }, (_, index) => message(`unrelated-${index}`, index + 4, 'UNRELATED_PRIVATE_SENTINEL'));
    const capture = harness([question, answer, review, ...unrelated]);
    expect(await capture({ discussion, messageIds: ['review', 'question', 'answer'] }))
      .toMatchObject({ ok: true, result: { status: 'ready', steps: [
        expect.objectContaining({ messageId: 'question' }), expect.objectContaining({ messageId: 'answer' }),
        expect.objectContaining({ messageId: 'review' }),
      ] } });
    expect(capture.reads).toEqual([
      { discussionId: discussion.discussionId, messageId: 'review' },
      { discussionId: discussion.discussionId, messageId: 'question', throughSeq: 1_003 },
      { discussionId: discussion.discussionId, messageId: 'answer', throughSeq: 1_003 },
    ]);
  });

  it('refuses a selected message committed after the captured frontier without falling back to history', async () => {
    const capture = harness([question, answer, review], discussion.serverId, readNumber => readNumber === 1 ? 2 : 3);
    expect(await capture({ discussion, messageIds: ['question', 'review'] }))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(capture.reads).toEqual([
      { discussionId: discussion.discussionId, messageId: 'question' },
      { discussionId: discussion.discussionId, messageId: 'review', throughSeq: 2 },
    ]);
  });

  it.each(['ui', 'mcp', 'agent'] as const)('captures exact dependencies without copying answer prose on %s', async surface => {
    const capture = harness([... [question, answer, review], message('private', 4, 'UNRELATED_PRIVATE_SENTINEL')]);
    const value = await capture({ discussion, messageIds: ['question', 'answer', 'review'], name: 'Compare and review' }, surface);
    expect(value).toMatchObject({ ok: true, result: { status: 'ready', name: 'Compare and review',
      steps: [expect.objectContaining({ messageId: 'question', role: 'input' }),
        expect.objectContaining({ messageId: 'answer', dependsOnMessageIds: ['question'] }),
        expect.objectContaining({ messageId: 'review', dependsOnMessageIds: ['answer'] })] } });
    if (!value.ok) throw new Error(value.errorCode);
    const draft = value.result as { definition: unknown };
    const produced = WorkflowDefinitionCaptureResultV1Schema.parse(value.result);
    expect(validateHostInputTypeValue({ hostType: 'agentParticipant' }, produced.inputs.participant_1)).toMatchObject({ status: 'valid' });
    expect(validateWorkflowDefinition(draft.definition)).toMatchObject({ valid: true });
    expect(JSON.stringify(draft.definition)).not.toContain('UNRELATED_PRIVATE_SENTINEL');
    expect(JSON.stringify(draft.definition)).not.toContain('An answer must not become an instruction');
    expect(JSON.stringify(draft.definition)).toContain('"blockId":"step_1"');
  });
  it('keeps an unlinked selection unresolved until an explicit role is supplied', async () => {
    const capture = harness([question, message('orphan', 3, 'Unlinked answer', 'answerer')]);
    expect(await capture({ discussion, messageIds: ['question', 'orphan'] })).toMatchObject({ ok: true,
      result: { status: 'needs_review', definition: null, unresolved: expect.arrayContaining([
        { messageId: 'orphan', reason: 'unlinked_message' }, { messageId: 'question', reason: 'unlinked_message' },
      ]) } });
  });
  it('requires a choice for a human selection outside the executable dependency closure', async () => {
    const capture = harness([question, answer, message('unlinked-human', 3, 'A separate human note')]);
    const input = { discussion, messageIds: ['question', 'answer', 'unlinked-human'] };
    expect(await capture(input)).toMatchObject({ ok: true, result: {
      status: 'needs_review', definition: null,
      unresolved: [{ messageId: 'unlinked-human', reason: 'unlinked_message' }],
    } });
    for (const role of ['input', 'exclude'] as const) {
      expect(await capture({ ...input, choices: [{ messageId: 'unlinked-human', role }] }))
        .toMatchObject({ ok: true, result: { status: 'ready', unresolved: [] } });
    }
  });
  it('lets review choose fixed defaults and repair an unlinked dependency explicitly', async () => {
    const capture = harness([question, message('orphan', 3, 'Unlinked answer', 'answerer'),
      message('excluded', 4, 'Unrelated answer', 'other-answerer', 'unselected-parent')]);
    const value = await capture({ discussion, messageIds: ['question', 'orphan', 'excluded'], choices: [
      { messageId: 'question', role: 'input', perRun: false },
      { messageId: 'orphan', role: 'step', dependsOnMessageIds: ['question'], instruction: 'Compare both proposals carefully.', perRun: false },
      { messageId: 'excluded', role: 'exclude' },
    ] });
    expect(value).toMatchObject({ ok: true, result: { status: 'ready', definition: { inputs: [
      { name: 'question', required: false, default: 'Compare the proposals' },
      expect.objectContaining({ name: 'participant_1', required: false, default: { kind: 'session', session: { serverId: 'home', sessionId: 'answerer' } } }),
    ] } } });
  });
  it('keeps independent answers parallel and binds a later review to only the selected answer', async () => {
    const capture = harness([question, answer, message('other', 3, 'Other independent answer', 'other-answerer', 'question'),
      message('review', 4, 'Review result', 'reviewer', 'answer')]);
    const value = await capture({ discussion, messageIds: ['question', 'answer', 'other', 'review'] });
    expect(value).toMatchObject({ ok: true, result: { definition: { blocks: [
      { kind: 'loop', repetition: { kind: 'items', execution: 'parallel' } },
      { kind: 'step', input: [{ kind: 'result', producer: { blockId: 'exchange_1' }, path: [0, 'results', 'step_1'] }] },
    ] } } });
  });
  it.each([true, false])('folds independent answerers into one typed participants input (per run: %s)', async perRun => {
    const capture = harness([question, answer, message('other', 3, 'Other answer', 'other-answerer', 'question'),
      message('review', 4, 'Review result', 'reviewer', 'answer')]);
    const value = await capture({ discussion, messageIds: ['question', 'answer', 'other', 'review'], choices: [
      { messageId: 'answer', role: 'step', perRun }, { messageId: 'other', role: 'step', perRun },
    ] });
    if (!value.ok) throw new Error(value.errorCode);
    const draft = WorkflowDefinitionCaptureResultV1Schema.parse(value.result);
    const participants = ['answerer', 'other-answerer'].map(sessionId => ({ kind: 'session', session: { serverId: 'home', sessionId } }));
    expect(draft.definition?.inputs).toEqual([
      { name: 'question', valueType: 'string', required: true },
      { name: 'participants', valueType: 'json', multiple: true, required: perRun,
        inputType: { hostType: 'agentParticipant' }, ...(!perRun ? { default: participants } : {}) },
      { name: 'participant_3', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' } },
    ]);
    expect(draft.inputs.participants).toEqual(participants);
    expect(draft.steps.filter(step => ['answer', 'other'].includes(step.messageId)).map(step => step.participantInputName))
      .toEqual(['participants', 'participants']);
    expect(draft.definition?.blocks[0]).toMatchObject({ kind: 'loop', repetition: {
      kind: 'items', items: { kind: 'input', name: 'participants' }, execution: 'parallel', failurePolicy: 'collect_outcomes',
    }, body: [{ id: 'step_1', execution: { participant: { kind: 'item', field: 'value' } } }] });
    expect(validateWorkflowDefinition(draft.definition)).toMatchObject({ valid: true });
  });
  it('carries an exact answer dependency through a human review request instead of scheduling both agents independently', async () => {
    const capture = harness([question, answer, message('review-request', 3, 'Review this answer for missing evidence', undefined, 'answer'),
      message('review', 4, 'Review result', 'reviewer', 'review-request')]);
    const value = await capture({ discussion, messageIds: ['question', 'answer', 'review-request', 'review'] });
    expect(value).toMatchObject({ ok: true, result: { definition: { blocks: [
      { kind: 'step', id: 'step_1' },
      { kind: 'step', id: 'step_2', input: expect.arrayContaining([
        expect.objectContaining({ kind: 'input', name: 'context_2' }),
        { kind: 'result', producer: { blockId: 'step_1', scope: { kind: 'current' } }, path: [] },
      ]) },
    ] } } });
  });
  it('refuses a mis-bound Home response and never falls back to local text', async () => {
    expect(await harness([question, answer], 'other-home')({ discussion, messageIds: ['question', 'answer'] }))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
  it('refuses a selected unreadable source before returning any draft', async () => {
    expect(await harness([question, { ...answer, content: null }])({ discussion, messageIds: ['question', 'answer'] }))
      .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
});
