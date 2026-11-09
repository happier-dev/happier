import { expect, it } from 'vitest';
import { SessionMessageReplyOperationV1Schema, SessionMessageReplyOutcomeV1Schema, SessionMessageReplyResolvedOutcomeV1Schema,
  SessionMessageReplyAccountMutationV1Schema } from './sessionMessageReplyV1.js';

it.each([
  { code: 'action_disabled', retryable: false }, { code: 'discussions_unavailable', retryable: true },
  { code: 'discussion_answer_policy_denied', retryable: false },
])('admits only the owning retryability of publication $code', ({ code, retryable }) => {
  const mutation = { kind: 'discussion_publication', discussionId: 'discussion', messageId: 'question', acceptedTurnId: 'turn',
    publication: { kind: 'failed', failure: { code, phase: 'action_admission', retryable } } };
  expect(SessionMessageReplyAccountMutationV1Schema.safeParse(mutation).success).toBe(true);
  expect(SessionMessageReplyAccountMutationV1Schema.safeParse({ ...mutation, approvalArtifactId: 'approval' }).success).toBe(true);
  expect(SessionMessageReplyAccountMutationV1Schema.safeParse({ ...mutation, publication: { ...mutation.publication,
    failure: { ...mutation.publication.failure, retryable: !retryable } } }).success).toBe(false);
});

it('binds an ordinary confirmation refusal to its exact private approval', () => {
  const mutation = { kind: 'discussion_publication', discussionId: 'discussion', messageId: 'question',
    publication: { kind: 'failed', failure: { code: 'approval_rejected', phase: 'action_admission', retryable: false } } };
  expect(SessionMessageReplyAccountMutationV1Schema.safeParse(mutation).success).toBe(false);
  expect(SessionMessageReplyAccountMutationV1Schema.safeParse({ ...mutation, approvalArtifactId: 'approval' }).success).toBe(true);
  expect(SessionMessageReplyAccountMutationV1Schema.safeParse({ ...mutation, approvalArtifactId: 'approval',
    publication: { kind: 'approval_pending', artifactId: 'approval' } }).success).toBe(false);
});

it('admits a closed native committed-result binding on the existing fulfillment operation', () => {
  const operation = { kind: 'fulfill', turnId: 'turn', outcome: { kind: 'cancelled', result: { sessionId: 'session', messageId: 'committed' } },
    nativeResult: { runId: 'run', sidechainId: 'sidechain', localId: 'native-row' } };
  expect(SessionMessageReplyOperationV1Schema.parse(operation)).toEqual(operation);
  expect(SessionMessageReplyOperationV1Schema.safeParse({ ...operation,
    nativeResult: { ...operation.nativeResult, partialText: 'private' } }).success).toBe(false);
  expect(SessionMessageReplyOperationV1Schema.safeParse({ ...operation, outcome: { kind: 'cancelled' } }).success).toBe(false);
});

it('keeps stopped partial content out of custody and exposes it only in a resolved result', () => {
  const result = { sessionId: 'participant', messageId: 'partial-row' };
  expect(SessionMessageReplyOutcomeV1Schema.parse({ kind: 'cancelled', result })).toEqual({ kind: 'cancelled', result });
  expect(SessionMessageReplyOutcomeV1Schema.safeParse({ kind: 'cancelled', partialText: 'private' }).success).toBe(false);
  const resolved = { kind: 'cancelled', partialText: 'partial'.repeat(20_000),
    messageRef: { kind: 'session', session: { serverId: 'home', sessionId: 'participant' }, messageId: 'partial-row' } };
  expect(SessionMessageReplyResolvedOutcomeV1Schema.parse(resolved)).toEqual(resolved);
  expect(SessionMessageReplyResolvedOutcomeV1Schema.safeParse({ ...resolved, arbitrary: true }).success).toBe(false);
  expect(SessionMessageReplyOutcomeV1Schema.parse({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' });
});
