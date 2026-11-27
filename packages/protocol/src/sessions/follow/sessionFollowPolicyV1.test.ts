import { describe, expect, it } from 'vitest';
import { SessionUserActionRequiredOccurrenceV1Schema } from '../userActionRequiredOccurrenceV1.js';

import {
  FOLLOW_EVENT_KINDS_V1, FollowPolicyV1Schema, resolveFollowDeliveryV1,
  resolveWorkerUpdateFollowDeliveryV1,
  resolveRequestFollowEventV1,
  isFollowPolicyEqualV1,
  resolveSessionInboxAttentionV1,
  type FollowEventV1, type FollowPolicyV1,
} from './sessionFollowPolicyV1.js';

describe('Follow policy receiver projections', () => {
  it('publishes only admitted C1 types, keeping failure news separate from concurrent requests', () => {
    const classify = (reasons: readonly import('../personal/attention.js').SessionPersonalAttentionReasonV1[],
      needsAttention = true) => resolveSessionInboxAttentionV1({
      personalAttention: { needsAttention, reasons }, hasBlockedPendingDelivery: reasons.includes('pending_blocked'),
      working: false, ready: false,
    });
    expect(classify(['permission_required'], false)).toEqual({ section: null, type: null });
    expect(classify(['unread'])).toEqual({ section: null, type: null });
    expect(classify(['failed'])).toEqual({ section: 'needs_attention', type: 'update' });
    expect(classify(['failed', 'permission_required'])).toEqual({ section: 'needs_attention', type: 'approval' });
    expect(classify(['mentioned'])).toEqual({ section: 'needs_attention', type: 'mention' });
    expect(classify(['pending_blocked'])).toEqual({ section: 'needs_attention', type: 'blocked' });
  });
  it('keeps Voice-only interest independent of Inbox and Session delivery', () => {
    const policy: FollowPolicyV1 = { preset: 'custom', events: { message: { delivery: 'off', voice: true } } };
    expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'message' } })).toEqual({
      selected: false, interrupt: false, voice: true,
      person: { inbox: false, push: false, voice: true }, session: { nextTurn: false, wake: false },
    });
    expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'message' }, muted: true }).person.voice).toBe(false);
    expect(resolveFollowDeliveryV1({ policies: [{ preset: 'custom', events: { message: { delivery: 'off' } } }],
      event: { kind: 'message' } }).person.voice).toBe(false);
  });
  it('keeps Important Voice additive for messages without changing continue-mode question delivery', () => {
    const policy: FollowPolicyV1 = { preset: 'important', voice: true };
    expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'message' } })).toMatchObject({
      selected: false, person: { inbox: false, push: false, voice: true }, session: { nextTurn: false, wake: false },
    });
    expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'needs_you', type: 'decision', mode: 'continue' } }))
      .toMatchObject({ person: { inbox: true, push: false, voice: true }, session: { nextTurn: true, wake: false } });
  });
  it.each([{ preset: 'quiet' }, { preset: 'custom', events: { needs_you: { decision: { delivery: 'off' } } } }] satisfies FollowPolicyV1[])(
    'routes an exact Discussion answer obligation as a direct ask without changing $preset informational policy', policy => {
      const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'receiver' };
      const original = { id: addressing.messageId, discussionId: addressing.discussionId, seq: addressing.throughSeq,
        addressingV1: { throughSeq: 2, participantSessionIds: ['receiver'] } };
      const reply = { mode: 'return' as const, discussion: addressing };
      const request = { policies: [policy], event: { kind: 'needs_you' as const, type: 'decision' as const, mode: 'wait' as const } };
      const discussionInput = { addressing, original, reply };
      expect(resolveFollowDeliveryV1({ ...request, discussionInput }).session).toEqual({ nextTurn: false, wake: true });
      // An event or a return tuple alone is not evidence of an addressed ask.
      const ordinary = resolveFollowDeliveryV1(request);
      for (const input of [
        { ...discussionInput, reply: null },
        { ...discussionInput, reply: { ...reply, discussion: { ...addressing, messageId: 'another' } } },
        { ...discussionInput, original: { ...original, seq: 3 } },
        { ...discussionInput, original: { ...original, addressingV1: { throughSeq: 2, participantSessionIds: [] } } },
        { ...discussionInput, original: { ...original, addressingV1: { ...original.addressingV1, watcherSessionIds: ['receiver'] } } },
      ]) expect(resolveFollowDeliveryV1({ ...request, discussionInput: input })).toEqual(ordinary);
      expect(resolveFollowDeliveryV1({ ...request, discussionInput, muted: true }).selected).toBe(false);
      expect(resolveFollowDeliveryV1({ ...request, discussionInput, causalEcho: true }).selected).toBe(false);
    });
  it('compares exact canonical policies independently of nested input property order', () => {
    const left: FollowPolicyV1 = { preset: 'custom', events: { person_wrote: { voice: true, delivery: 'interrupt' },
      needs_you: { approval: { delivery: 'quiet' }, decision: { delivery: 'off' } } } };
    const reordered: FollowPolicyV1 = { events: { needs_you: { decision: { delivery: 'off' }, approval: { delivery: 'quiet' } },
      person_wrote: { delivery: 'interrupt', voice: true } }, preset: 'custom' };
    expect(isFollowPolicyEqualV1(left, reordered)).toBe(true);
    expect(isFollowPolicyEqualV1(left, { ...left, events: { ...left.events, person_wrote: { delivery: 'quiet', voice: true } } })).toBe(false);
  });
  it('accepts content-free source intent for Home delivery but rejects non-request or mismatched intent', () => {
    const occurrence = { requestId: 'question', sourceTurnId: 'turn_1', requestKind: 'user_action', occurredAt: 200 };
    expect(SessionUserActionRequiredOccurrenceV1Schema.safeParse({ ...occurrence,
      followEvent: { kind: 'needs_you', type: 'blocked', mode: 'continue', handling: 'manager' },
    }).success).toBe(true);
    for (const followEvent of [{ kind: 'finished' },
      { kind: 'needs_you', type: 'decision', managerSessionId: 'private' }]) {
      expect(SessionUserActionRequiredOccurrenceV1Schema.safeParse({ ...occurrence, followEvent }).success).toBe(false);
    }
    expect(SessionUserActionRequiredOccurrenceV1Schema.safeParse({ ...occurrence, requestKind: 'permission',
      followEvent: { kind: 'needs_you', type: 'blocked' },
    }).success).toBe(false);
  });
  it('projects source-owned question mode and current handler without granting approval authority', () => {
    expect(resolveRequestFollowEventV1({ requestKind: 'user_action',
      questionV1: { mode: 'continue', type: 'blocked' }, currentHandler: { kind: 'session', sessionId: 'manager' },
    })).toEqual({ kind: 'needs_you', type: 'blocked', mode: 'continue', handling: 'manager' });
    expect(resolveRequestFollowEventV1({ requestKind: 'permission',
      questionV1: { mode: 'continue' }, currentHandler: { kind: 'session', sessionId: 'manager' },
    })).toEqual({ kind: 'needs_you', type: 'approval' });
    expect(resolveRequestFollowEventV1({ requestKind: 'user_action' }))
      .toEqual({ kind: 'needs_you', type: 'decision' });
  });
  it('applies the shared event policy to real worker envelopes instead of their legacy wake hint', () => {
    const base = { v: 1 as const, workerKind: 'execution_run' as const, workerId: 'run',
      wake: 'finished' as const, headline: 'Run result', canInspect: true };
    for (const ownerState of ['succeeded', 'failed', 'cancelled', 'timeout'] as const) {
      const decision = resolveWorkerUpdateFollowDeliveryV1({ update: { ...base, ownerState }, ownWorker: true });
      expect(decision?.selected).toBe(true);
      expect(decision?.session.wake).toBe(true);
      if (ownerState === 'succeeded') {
        expect(decision?.person.push).toBe(false);
        expect(resolveWorkerUpdateFollowDeliveryV1({ update: { ...base, ownerState } })?.session.nextTurn).toBe(true);
        expect(resolveWorkerUpdateFollowDeliveryV1({ update: { ...base, ownerState }, ownWorker: true,
          policies: [{ preset: 'quiet' }] })?.session.wake).toBe(false);
      }
    }
    const update = { ...base, workerKind: 'workflow_run' as const, ownerState: 'running' as const, wake: 'needs_you' as const };
    expect(resolveWorkerUpdateFollowDeliveryV1({ update })?.session.wake).toBe(true);
    expect(resolveWorkerUpdateFollowDeliveryV1({ update, policies: [{ preset: 'quiet' }] })?.session.wake).toBe(false);
    expect(resolveWorkerUpdateFollowDeliveryV1({ update: { ...update, wake: 'finished' } })).toBeNull();
    expect(resolveWorkerUpdateFollowDeliveryV1({ update, policies: [{ preset: 'custom', events: {
      needs_you: { approval: { delivery: 'interrupt' } },
    } }] })?.selected).toBe(false);
    expect(resolveWorkerUpdateFollowDeliveryV1({ update, needsYou: { type: 'approval' }, policies: [{ preset: 'custom', events: {
      needs_you: { approval: { delivery: 'interrupt' } },
    } }] })?.session.wake).toBe(true);
  });

  const events: FollowEventV1[] = FOLLOW_EVENT_KINDS_V1.flatMap((kind): FollowEventV1[] => kind === 'needs_you'
    ? ['decision', 'approval', 'blocked'].map((type) => ({ kind, type: type as 'decision' | 'approval' | 'blocked' }))
    : [{ kind }]);

  it.each(['everything', 'important', 'quiet'] as const)('uses one %s event table for people and sessions', (preset) => {
    for (const event of events) {
      const selected = event.kind !== 'message' || preset === 'everything';
      const interrupt = preset === 'everything' ? event.kind !== 'message'
        : preset === 'important' && ['needs_you', 'failed_or_stopped', 'stalled'].includes(event.kind);
      expect(resolveFollowDeliveryV1({ policies: [{ preset }], event })).toEqual({
        selected, interrupt, voice: false,
        person: { inbox: selected, push: interrupt, voice: false },
        session: { nextTurn: selected && !interrupt, wake: interrupt },
      });
    }
  });

  it('unions matching routes by event, with additive Voice and no quiet veto', () => {
    const policies: FollowPolicyV1[] = [
      { preset: 'quiet' },
      { preset: 'custom', events: { person_wrote: { delivery: 'interrupt' }, finished: { delivery: 'quiet', voice: true } } },
    ];
    expect(resolveFollowDeliveryV1({ policies, event: { kind: 'person_wrote' } })).toMatchObject({
      person: { inbox: true, push: true }, session: { nextTurn: false, wake: true },
    });
    expect(resolveFollowDeliveryV1({ policies, event: { kind: 'finished' } })).toMatchObject({
      person: { inbox: true, push: false, voice: true }, session: { nextTurn: true, wake: false },
    });
    for (const suppression of [{ muted: true }, { causalEcho: true }]) {
      expect(resolveFollowDeliveryV1({ policies, event: { kind: 'person_wrote' }, ...suppression })).toMatchObject({
        selected: false, person: { inbox: false, push: false, voice: false }, session: { nextTurn: false, wake: false },
      });
    }
  });

  it('keeps needs-you subtype choices in Custom and continue mode quiet under Important', () => {
    const custom: FollowPolicyV1 = { preset: 'custom', events: { needs_you: {
      decision: { delivery: 'quiet' }, approval: { delivery: 'interrupt' },
    } } };
    expect(resolveFollowDeliveryV1({ policies: [custom], event: { kind: 'needs_you', type: 'blocked' } }).selected).toBe(false);
    expect(resolveFollowDeliveryV1({ policies: [custom], event: { kind: 'needs_you', type: 'approval', mode: 'continue' } }).interrupt).toBe(true);
    expect(resolveFollowDeliveryV1({ policies: [{ preset: 'important' }], event: { kind: 'needs_you', type: 'decision', mode: 'continue' } }))
      .toMatchObject({ person: { inbox: true, push: false }, session: { nextTurn: true, wake: false } });
  });

  it('keeps manager-handled requests visible and quiet for the person, with delivery to the manager', () => {
    expect(resolveFollowDeliveryV1({ policies: [{ preset: 'everything', voice: true }], event: {
      kind: 'needs_you', type: 'decision', handling: 'manager',
    } })).toMatchObject({ person: { inbox: true, push: false, voice: false }, session: { nextTurn: false, wake: true } });
  });

  it('rejects unknown executable policy fields at each nested boundary', () => {
    expect(FollowPolicyV1Schema.safeParse({ preset: 'important', events: {} }).success).toBe(false);
    expect(FollowPolicyV1Schema.safeParse({ preset: 'custom', events: { finished: { delivery: 'quiet', wake: true } } }).success).toBe(false);
    expect(FollowPolicyV1Schema.safeParse({ preset: 'custom', events: { needs_you: { invented: { delivery: 'interrupt' } } } }).success).toBe(false);
  });
});
