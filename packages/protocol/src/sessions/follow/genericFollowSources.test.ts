import { describe, expect, it } from 'vitest';

import { SessionFollowActionInputSchemasV1 } from './actions.js';
import { parseSessionFollowActionResponse, resolveSessionFollowActionRequest } from './actionTransport.js';
import { OtherSessionFollowSourceV1Schema } from './sessionFollowSourcesApi.js';
import { FollowSourceRefV1Schema, followDeliveryMuteScopeKeyV1 } from './sessionDeliveryMuteV1.js';

describe('generic Follow sources', () => {
  const receiver = { kind: 'session' as const, sessionId: 'receiver' };
  const sources = [
    { kind: 'discussion' as const, discussionId: 'discussion-a' },
    { kind: 'execution_run' as const, sessionId: 'parent-a', runId: 'run-a' },
    { kind: 'execution_run' as const, machineId: 'machine-a', runId: 'run-a' },
    { kind: 'workflow_run' as const, runId: 'workflow-a' },
  ];

  it('admits one exact Run authority and preserves Session source identities', () => {
    expect(FollowSourceRefV1Schema.safeParse({ kind: 'execution_run', runId: 'run-a' }).success).toBe(false);
    expect(FollowSourceRefV1Schema.safeParse({ kind: 'execution_run', sessionId: 'parent-a', machineId: 'machine-a', runId: 'run-a' }).success).toBe(false);
    expect(followDeliveryMuteScopeKeyV1({ kind: 'source', source: sources[1]! })).toBe('["source","execution_run","parent-a","run-a"]');
    expect(followDeliveryMuteScopeKeyV1({ kind: 'source', source: sources[2]! })).not.toBe(
      followDeliveryMuteScopeKeyV1({ kind: 'source', source: { kind: 'execution_run', sessionId: 'machine-a', runId: 'run-a' } }));
  });

  it('preserves independent Run intents through the executable Action transport', () => {
    const source = { kind: 'execution_run', machineId: 'machine-a', runId: 'run-a' };
    const once = [{ kind: 'run_settled' }, { kind: 'output_ready', outputRef: {
      kind: 'scm_diff_summary', output: 'walkthrough', comparisonId: 'comparison-a', resultId: 'result-a' } }];
    expect(resolveSessionFollowActionRequest('follow.set', { receiver: { kind: 'account' }, source, once }).body).toEqual({ once });
    expect(resolveSessionFollowActionRequest('follow.set', { receiver: { kind: 'account' }, source, once, clearOnceDeliveries: true }).body)
      .toEqual({ once, clearOnceDeliveries: true });
    expect(SessionFollowActionInputSchemasV1['follow.set'].safeParse({ receiver: { kind: 'account' },
      source: { kind: 'discussion', discussionId: 'discussion' }, policy: { preset: 'important' }, clearOnceDeliveries: true }).success).toBe(false);
    expect(SessionFollowActionInputSchemasV1['follow.set'].safeParse({ receiver, source, once }).success).toBe(false);
  });

  it.each(sources)('keeps $kind as an exact source in set/get/remove/list', source => {
    const policy = { preset: 'important' as const };
    expect(SessionFollowActionInputSchemasV1['follow.set'].safeParse({ receiver, source, policy }).success).toBe(true);
    expect(SessionFollowActionInputSchemasV1['follow.get'].safeParse({ receiver, source }).success).toBe(true);
    expect(SessionFollowActionInputSchemasV1['follow.remove'].safeParse({ receiver, source }).success).toBe(true);
    expect(SessionFollowActionInputSchemasV1['follow.list'].safeParse({ direction: 'followers', source }).success).toBe(true);
    const request = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy });
    expect(request.method).toBe('PUT');
    expect(request.path).toContain('/follows/');
    expect(request.body).toMatchObject({ policy });
    const relation = OtherSessionFollowSourceV1Schema.parse({ source, destinationSessionId: receiver.sessionId, policy,
      deliveryState: 'eligible', sourceAvailability: 'available', hasPendingUpdates: false, relation: 'follower' });
    expect(parseSessionFollowActionResponse('follow.get', { receiver, source }, { source: relation }))
      .toEqual({ source: relation });
    expect(() => parseSessionFollowActionResponse('follow.get', { receiver, source },
      { source: { ...relation, source: { kind: 'discussion', discussionId: 'other' } } })).toThrow();
  });
});
