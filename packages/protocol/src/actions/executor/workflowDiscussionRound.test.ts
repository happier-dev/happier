import { describe, expect, it } from 'vitest';
import { createWorkflowDiscussionRoundFixture as fixture } from '../../../testkit/workflowDiscussionRound.js';
import { WorkflowDiscussionRoundProjectResultV1Schema } from '../../workflows/workflowDiscussionRoundV1.js';
import { resolveActionCurrentSessionScopeFailure } from './sessionListAccess.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';

const runId = '11111111-1111-4111-8111-111111111111';
const participantCount = process.env.HAPPIER_WORKFLOW_SCALE_MEASUREMENT === '1' ? 500 : 24;

describe('Discussion round projection demand', () => {
  it.each(['frame', 'descendants'] as const)('preserves a typed storage refusal while reading %s', async stage => {
    const f = await fixture('projector-in-if');
    const round = f.rounds[2]!;
    f.failStorage(operation => {
      if (stage === 'frame' ? operation.operation === 'get'
        : operation.operation === 'invocations.list' && operation.parentRecordIds?.includes(round.collection)) {
        throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
      }
    });
    await expect(f.executor.execute('workflow.discussion.round.project',
      { collections: ['speakers'], preparationBlockId: 'context' }, f.context(round.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'run_access_denied',
        failureCause: { errorCode: 'run_access_denied' } });
  });

  it('preserves a Session read failure instead of claiming the admitted review scope is missing', async () => {
    const f = await fixture('projector-in-if', 2, 'review');
    const executor = createActionExecutor({ ...f.deps,
      resolveSessionReference: async () => { throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' }); },
      reviewCommentAction: async () => { throw new Error('review_must_not_dispatch'); },
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('reviews.comments.list', { sessionId: f.address.sessionId }, f.context(f.rounds[2]!.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable', failureCause: { errorCode: 'target_unavailable' } });
  });

  it('carries one host-admitted Workflow Session scope through review dispatch and refreshes it for the next Action', async () => {
    const f = await fixture('projector-in-if', 2, 'review');
    let sessionReads = 0;
    const scopes: unknown[] = [];
    const executor = createActionExecutor({ ...f.deps,
      resolveSessionReference: async () => { sessionReads += 1; return { kind: 'unique', address: f.address }; },
      // Review transport is the boundary; accepted-frame reads and admission stay real.
      reviewCommentAction: async args => {
        scopes.push(args.reviewCommentPrincipal?.workflowScope);
        return { items: [], cursor: null };
      },
    } as unknown as ActionExecutorDeps);
    const context = f.context(f.rounds[2]!.complete);
    for (let request = 0; request < 2; request += 1) {
      expect(await executor.execute('reviews.comments.list', { sessionId: f.address.sessionId }, context))
        .toMatchObject({ ok: true, result: { items: [] } });
      expect(sessionReads).toBe(request + 1);
      expect(scopes.at(-1)).toMatchObject({ actionRequestId: context.actionRequestId, sessions: [f.address] });
    }
    expect(await executor.execute('reviews.comments.list', { sessionId: 'unrelated-session' }, context))
      .toMatchObject({ ok: false });
    expect(scopes).toHaveLength(2);
    f.miswire();
    expect(await executor.execute('reviews.comments.list', { sessionId: f.address.sessionId }, context))
      .toMatchObject({ ok: false });
    expect(scopes).toHaveLength(2);
  });
  it('keeps an original-parent failed descendant retryable', async () => {
    const f = await fixture('projector-in-if');
    await expect(f.retry(f.rounds[2]!.complete)).resolves.toEqual(expect.any(String));
  });

  it.each(['root', 'intermediate', 'intermediate-failed'] as const)('retries an inherited child after %s-only recovery', async ancestor => {
    const f = await fixture('projector-in-if');
    const action = f.rounds[2]!.complete;
    f.row(action).index.lifecycle = 'pending';
    const currentParent = await f.retry(ancestor === 'root' ? f.currentRoot() : f.row(action).index.parentRecordId!);
    await expect(f.executor.execute('workflow.discussion.round.project',
      { collections: ['speakers'], preparationBlockId: 'context' }, f.context(action)))
      .resolves.toMatchObject({ ok: true, result: { throughSeq: 3, outcomeReferences: f.rounds[2]!.replies } });
    expect(f.cost.historyPages).toBe(0);
    if (ancestor === 'intermediate-failed') f.row(currentParent).index.lifecycle = 'failed';
    const replacement = await f.retry(action);
    if (ancestor === 'intermediate-failed') expect(f.row(currentParent).index.lifecycle).toBe('superseded');
    expect(f.row(action).index.lifecycle).toBe('superseded');
    await expect(f.executor.execute('workflow.discussion.round.project',
      { collections: ['speakers'], preparationBlockId: 'context' }, f.context(replacement)))
      .resolves.toMatchObject({ ok: true, result: { throughSeq: 3, outcomeReferences: f.rounds[2]!.replies } });
    expect(f.cost.historyPages).toBe(0);
    f.interrupt();
    expect((await f.inspect(action)).invocation.recoveryAvailability?.retry)
      .toMatchObject({ kind: 'unavailable', reason: 'invocation_not_recoverable' });
    await expect(f.requestRetry(action, [replacement])).rejects.toMatchObject({ code: 'ineligible_state' });
    // A valid producer result cannot authorize an unrelated transport row.
    f.miswire();
    await expect(f.executor.execute('workflow.discussion.round.project',
      { collections: ['speakers'] }, f.context(replacement)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it.each([false, true])('retains complete fail-stop closure and its completed neighbor (root recovered: %s)', async recoveredRoot => {
    const f = await fixture(undefined, 2, 'round', 'parallel');
    const action = f.rounds[2]!.complete;
    const stoppedSibling = f.rounds[0]!.complete;
    const completedNeighbor = f.rounds[1]!.complete;
    if (recoveredRoot) {
      f.row(action).index.lifecycle = 'pending';
      f.row(stoppedSibling).index.lifecycle = 'pending';
      await f.retry(f.currentRoot());
    }
    let group = f.row(action);
    while (group.progress.blockKind !== 'parallel' || group.progress.frame) group = f.row(group.index.parentRecordId!);
    const groupId = group.index.id;
    for (const id of [action, stoppedSibling]) {
      let row = f.row(id);
      row.progress.reason = { code: `container_fail_stop:${groupId}` };
      row.index.lifecycle = id === action ? 'failed' : 'cancelled';
      f.seal(row);
      while (row.index.id !== groupId) {
        row = f.row(row.index.parentRecordId!);
        row.index.lifecycle = 'needs_attention';
        f.seal(row);
      }
    }
    await expect(f.retry(action)).resolves.toEqual(expect.any(String));
    expect(f.row(stoppedSibling).index.lifecycle).toBe('superseded');
    expect(f.row(groupId).index.lifecycle).toBe('superseded');
    expect(f.row(completedNeighbor).index.lifecycle).toBe('completed');
    expect(f.row(f.currentRoot()).index.lifecycle).toBe(recoveredRoot ? 'pending' : 'completed');
  });

  const retryShapes = [
    { name: 'leaf only', shape: false },
    { name: 'one intermediate', shape: true },
    { name: 'all intermediates', shape: 'ancestors' },
    { name: 'root and intermediates', shape: 'root' },
    { name: 'root only', shape: 'root-only' },
    { name: 'selected IF and loop/item frames', shape: 'root', framePath: 'item' },
    { name: 'parallel branch frames', shape: 'root', framePath: 'parallel' },
    { name: 'inline Workflow frames', shape: 'root', framePath: 'workflow' },
    { name: 'root only after Action retry', shape: 'root-only', afterAction: true },
    { name: 'persisted original checkpoint root', shape: 'root', legacyCheckpoint: true },
    { name: 'persisted original checkpoint root only', shape: 'root-only', legacyCheckpoint: true },
  ] as const;
  it.each(retryShapes.flatMap(shape => (['round', 'review'] as const).map(consumer => ({ ...shape, consumer }))))
  ('binds producer retries: $name / $consumer', async ({ shape, consumer, ...options }) => {
    const f = await fixture('projector-in-if', 2, consumer, 'framePath' in options ? options.framePath : undefined);
    const round = f.rounds[2]!;
    let action = round.complete;
    if ('afterAction' in options) action = await f.retry(action);
    const check = async () => {
      if (consumer === 'round') {
        await expect(f.executor.execute('workflow.discussion.round.project',
          { collections: ['speakers'], preparationBlockId: 'context' }, f.context(action)))
          .resolves.toMatchObject({ ok: true, result: { allPassed: false, hasNext: true,
            throughSeq: 3, outcomeReferences: round.replies } });
      } else {
        await expect(resolveActionCurrentSessionScopeFailure('reviews.comments.list', { sessionId: f.address.sessionId },
          f.context(action), { sessionId: 'current_session' }, f.deps)).resolves.toBeNull();
      }
      expect(f.cost.historyPages).toBe(0);
    };
    for (let depth = 0; depth < 2; depth += 1) {
      if (shape === 'root-only') await f.retry(f.currentRoot());
      else action = await f.retry(action, shape);
      if ('legacyCheckpoint' in options) f.retainOriginalCheckpointRoot();
      await check();
    }
    // A later producer-created parent-only recovery must inherit the Action.
    if (shape !== 'root-only') {
      await f.retry(f.row(action).index.parentRecordId!);
      await check();
    }
    // A transport returning a different slot must not turn successful binding
    // into permission to use unrelated progress.
    f.miswire();
    if (consumer === 'round') await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(action)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    else await expect(resolveActionCurrentSessionScopeFailure('reviews.comments.list', { sessionId: f.address.sessionId },
      f.context(action), { sessionId: 'current_session' }, f.deps)).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it.each((['root', 'root-predecessor', 'run'] as const).flatMap(field => (['round', 'review'] as const).map(consumer => ({ field, consumer }))))
  ('refuses producer-created root replacement with misbound $field / $consumer', async ({ field, consumer }) => {
    const f = await fixture(undefined, 2, consumer);
    const action = await f.retry(f.rounds[2]!.complete, 'root');
    const context = f.context(action);
    if (field === 'root' || field === 'root-predecessor') {
      if (field === 'root') f.row(f.currentRoot()).progress.logicalInvocationRecordId = f.rounds[0]!.frame;
      else f.row(f.currentRoot()).progress.previousAttemptRecordId = f.rounds[0]!.frame;
      f.seal(f.row(f.currentRoot()));
    } else if (context.actionCaller?.kind === 'workflowRun') context.actionCaller = { ...context.actionCaller,
      runId: '99999999-9999-4999-8999-999999999999' };
    if (consumer === 'round') await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    else await expect(resolveActionCurrentSessionScopeFailure('reviews.comments.list', { sessionId: f.address.sessionId },
      context, { sessionId: 'current_session' }, f.deps)).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(f.cost.historyPages).toBe(0);
  });

  it.each(['logical', 'attempt', 'run', 'envelope'] as const)('refuses a recovered projector with wrong %s binding', async field => {
    const f = await fixture();
    const round = f.rounds[2]!;
    const action = await f.retry(round.complete, true);
    const context = f.context(action);
    if (field === 'logical') context.actionRequestId = `${runId}/${round.prepare}/1`;
    if (field === 'attempt') context.actionRequestId = `${runId}/${round.complete}/2`;
    if (field === 'run' && context.actionCaller?.kind === 'workflowRun') context.actionCaller = {
      ...context.actionCaller, runId: '99999999-9999-4999-8999-999999999999' };
    if (field === 'envelope') f.row(action).contentEnvelope = f.row(round.prepare).contentEnvelope;
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(f.cost.historyPages).toBe(0);
  });
  it('inherits committed collection and preparation from a recovered round frame', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    const frame = f.recover(round.frame);
    f.move(round.complete, frame);
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' }, f.context(round.complete));
    expect(result).toMatchObject({ ok: true, result: { allPassed: false, hasNext: true, throughSeq: 3,
      outcomeReferences: round.replies } });
    expect(f.cost.historyPages).toBe(0);
    // Keep admission/ancestry intact, then mis-bind only the batched recovery
    // descendant reader. A successful empty projection must not hide it.
    f.miswireChildren();
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' }, f.context(round.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it('retains committed answers through successive recovered participant frames', async () => {
    const f = await fixture(undefined, 24);
    const round = f.rounds[2]!;
    for (const frame of round.itemFrames) f.recover(f.recover(frame));
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' }, f.context(round.complete));
    expect(result).toMatchObject({ ok: true, result: { allPassed: false, hasNext: true, outcomeReferences: round.replies } });
    expect(f.cost.historyPages).toBe(0);
    // Recovery depth adds batched levels, never one request per participant.
    expect(f.cost.requests).toBeLessThan(30);
  });

  it('masks inherited answers with replacement and skipped slots without double counting', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    const replacementReplies: string[] = [];
    for (const [index, frame] of round.itemFrames.entries()) {
      const replacement = f.recover(frame);
      const reply = f.row(f.recover(round.replies[index]!.invocationRecordId, replacement));
      if (index === 0) reply.index.lifecycle = 'skipped';
      else reply.progress.replyOutcome = { kind: 'pass' };
      f.seal(reply);
      if (index !== 0) replacementReplies.push(reply.index.id);
    }
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(round.complete));
    expect(result).toMatchObject({ ok: true, result: { allPassed: true, hasNext: false,
      outcomeReferences: [{ invocationRecordId: replacementReplies[0], kind: 'pass' }] } });
    if (!result.ok) throw new Error('Projection unavailable');
    expect(WorkflowDiscussionRoundProjectResultV1Schema.parse(result.result).outcomeReferences).toHaveLength(1);
  });

  it('prepares from the inherited preceding round projection', async () => {
    const f = await fixture();
    f.recover(f.recover(f.rounds[1]!.frame));
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], phase: 'prepare',
      rosterInput: 'participants', previousProjectionBlockId: 'outcomes' }, f.context(f.rounds[2]!.prepare));
    expect(result).toMatchObject({ ok: true, result: { throughSeq: 2, hasNext: true, outcomeReferences: f.rounds[1]!.replies } });
    expect(f.cost.historyPages).toBe(0);
  });

  it('inherits the selected IF branch after structural recovery', async () => {
    const f = await fixture('collection-in-if');
    f.recover(f.recover(f.rounds[2]!.collectionParent));
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' }, f.context(f.rounds[2]!.complete));
    expect(result).toMatchObject({ ok: true, result: { allPassed: false, hasNext: true, outcomeReferences: f.rounds[2]!.replies } });
  });

  it('fails closed when an inherited parent is unavailable', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    f.recover(round.itemFrames[0]!);
    f.omit(round.itemFrames[0]!);
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(round.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it('does not treat a missing nonempty collection history as all passed', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    for (const id of round.itemFrames) f.omit(id);
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(round.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it('accepts an empty outcome set only after reading a genuinely empty collection', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    for (const id of round.itemFrames) f.omit(id);
    const collection = f.row(round.collection);
    if (collection.progress.container?.kind !== 'loop' || collection.progress.container.mode !== 'items') throw new Error('Not an item collection');
    collection.progress.container.itemCount = '0';
    collection.progress.container.nextMemberIndex = '0';
    f.seal(collection);
    const preparation = f.row(round.prepare);
    preparation.progress.result = WorkflowDiscussionRoundProjectResultV1Schema.parse({ allPassed: false, hasNext: false,
      nextParticipants: [], outcomeReferences: [], throughSeq: 3 });
    f.seal(preparation);
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(round.complete)))
      .resolves.toMatchObject({ ok: true, result: { allPassed: true, hasNext: false, outcomeReferences: [] } });
  });
  it.each(['collection-in-if', 'projector-in-if'] as const)('retains the same lexical scope across a selected conditional (%s)', async conditionalShape => {
    const f = await fixture(conditionalShape, 2);
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' },
      f.context(f.rounds[2]!.complete));
    expect(result, JSON.stringify({ result, cost: f.cost })).toMatchObject({ ok: true,
      result: { throughSeq: 3, nextParticipants: expect.any(Array), outcomeReferences: expect.any(Array) } });
    if (!result.ok) throw new Error('Conditional projection unavailable');
    const projected = WorkflowDiscussionRoundProjectResultV1Schema.parse(result.result);
    expect(projected.outcomeReferences.map(outcome => outcome.participant)).toEqual([
      { kind: 'session', session: { serverId: 'home', sessionId: 'participant-0' } },
      { kind: 'session', session: { serverId: 'home', sessionId: 'participant-1' } },
    ]);
    expect(f.cost.historyPages).toBe(0);
  });

  it('opens only the preceding projection on a scale-shaped three-round Run', async () => {
    const f = await fixture(undefined, participantCount);
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], phase: 'prepare',
      rosterInput: 'participants', previousProjectionBlockId: 'outcomes' }, f.context(f.rounds[2]!.prepare));
    expect(result, JSON.stringify({ result, cost: f.cost })).toMatchObject({ ok: true, result: { hasNext: true, nextParticipants: expect.any(Array), throughSeq: 2 } });
    console.info('PERF-FIN-RT prepare cost', JSON.stringify(f.cost));
    expect(f.cost.historyPages).toBe(0);
    expect(f.cost.envelopes).toBeLessThan(12);
  });

  it('reads the current collection without reopening earlier rounds and rejects a misbound selector', async () => {
    const f = await fixture(undefined, participantCount);
    const input = { collections: ['speakers'], preparationBlockId: 'context' };
    const result = await f.executor.execute('workflow.discussion.round.project', input, f.context(f.rounds[2]!.complete));
    expect(result, JSON.stringify({ result, cost: f.cost })).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Projection unavailable');
    const projected = WorkflowDiscussionRoundProjectResultV1Schema.parse(result.result);
    expect(projected.outcomeReferences).toHaveLength(participantCount);
    console.info('PERF-FIN-RT complete cost', JSON.stringify(f.cost));
    expect(f.cost.historyPages).toBe(0);
    expect(f.cost.envelopes).toBeLessThan(2 * participantCount + 10);
    expect(f.cost.requests).toBeLessThan(20);
    f.miswire();
    await expect(f.executor.execute('workflow.discussion.round.project', input, f.context(f.rounds[2]!.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
});
