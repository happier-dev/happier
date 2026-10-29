import { describe, expect, it } from 'vitest';
import { ExecutionRunFollowEventV1Schema, RunFollowOccurrenceV1Schema, SessionFollowInputV1Schema, resolveExecutionRunFollowOccurrenceV1 } from './sessionFollowInputV1.js';
import { ExecutionRunFollowFrontierResponseSchema } from '../../execution/runs/responseSchemas.js';
import { resolveWorkflowRunFollowEventV1 } from '../../workflows/composeWorkflowRunWorkerUpdateV1.js';
import { classifyWorkerUpdateEventV1 } from '../relations/workerUpdateV1.js';
import { RunFollowUpdateNotificationV1Schema } from '../../activity/webhookPayload.js';

import {
  buildSessionFollowWakeEventLocalId,
  deriveSessionFollowWakeEventLocalIdV1,
  deriveDiscussionFollowInputLocalIdV1,
  isSessionFollowWakeEventLocalId,
  SessionFollowAcknowledgeRequestV1Schema,
  SessionFollowAcknowledgeResponseV1Schema,
  SessionFollowObservePendingRequestV1Schema,
  SessionFollowObservePendingResponseV1Schema,
  SessionFollowPendingObservationV1Schema,
  SessionFollowRunOccurrenceRoutesRequestV1Schema,
  SessionFollowRunOccurrenceRoutesResponseV1Schema,
  SessionFollowRunOccurrenceRoutesQueryV1Schema,
  SessionFollowWakeObservationV1Schema,
} from './sessionFollowTransportV1.js';

const frontier = { transcriptSeq: 1, readyEventSeq: 2, agentStateVersion: 3, turn: null } as const;
const wakeObservations = [{ policy: { preset: 'everything' as const },
  sourceSessionId: 'source',
  expected: frontier,
  consumed: { ...frontier, transcriptSeq: 4 },
}] as const;

describe('Session Follow socket transport V1', () => {
  it('carries only an aggregate admitted rule decision through no-original observation, wake and ACK', () => {
    const delivered = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const observed = { ...delivered, turn: { id: 'live-turn', status: 'stalled' } };
    const route = { relation: 'rule', effectiveDelivery: 'wake', presence: { turnId: 'live-turn', publisherFence: 42 } };
    const observation = { sourceSessionId: 'source', destinationSessionId: 'receiver', delivered, observed, ...route };
    const wake = { sourceSessionId: 'source', expected: delivered, consumed: observed, ...route };
    const ack = { v: 1, destinationSessionId: 'receiver', sourceSessionId: 'source', expectedPublisherGeneration: '1',
      expected: delivered, observed, consumed: observed, ...route,
      acceptance: { kind: 'context_only_wake', eventLocalId: 'session-follow-wake:accepted', observations: [wake] } };
    expect(SessionFollowPendingObservationV1Schema.parse(observation)).toEqual(observation);
    expect(SessionFollowWakeObservationV1Schema.parse(wake)).toEqual(wake);
    expect(SessionFollowAcknowledgeRequestV1Schema.parse(ack)).toEqual(ack);
    for (const privateFields of [{ ruleId: 'secret' }, { ruleVersion: 2 }, { sources: [] }, { policy: { preset: 'important' } }]) {
      expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation, ...privateFields }).success).toBe(false);
      expect(SessionFollowWakeObservationV1Schema.safeParse({ ...wake, ...privateFields }).success).toBe(false);
      expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ ...ack, ...privateFields }).success).toBe(false);
    }
    const identity = deriveSessionFollowWakeEventLocalIdV1({ destinationSessionId: 'receiver', publisherGeneration: '1',
      observations: [SessionFollowWakeObservationV1Schema.parse(wake)] });
    expect(deriveSessionFollowWakeEventLocalIdV1({ destinationSessionId: 'receiver', publisherGeneration: '1',
      observations: [SessionFollowWakeObservationV1Schema.parse({ ...wake, presence: { ...route.presence, publisherFence: 43 } })] }))
      .not.toBe(identity);
  });
  it('carries an optional content-free target only on an unavailable Run refusal', () => {
    const refusal = { ok: false, v: 1, error: 'source_unavailable' };
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse(refusal).success).toBe(true);
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse({ ...refusal, targetMachineId: 'target-machine' }).success).toBe(true);
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse({ ...refusal, targetMachineId: '' }).success).toBe(false);
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse({ ...refusal, error: 'forbidden', targetMachineId: 'target-machine' }).success).toBe(false);
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse({ ...refusal, targetMachineId: 'target-machine', payload: 'private' }).success).toBe(false);
  });
  it('keeps the target opt-in and closed release diagnostics outside the strict Run body', () => {
    const body = { v: 1, source: { kind: 'execution_run', sessionId: 'parent', runId: 'run' } };
    expect(SessionFollowRunOccurrenceRoutesRequestV1Schema.parse(body)).toEqual(body);
    expect(SessionFollowRunOccurrenceRoutesRequestV1Schema.safeParse({ ...body, releaseReason: 'target_machine' }).success).toBe(false);
    expect(SessionFollowRunOccurrenceRoutesQueryV1Schema.parse({})).toEqual({});
    for (const releaseReason of ['exact_run', 'target_machine', 'account_reconnect', 'full_recovery', 'legacy_broad']) {
      const query = { includeTargetMachineId: 'true', releaseReason };
      expect(SessionFollowRunOccurrenceRoutesQueryV1Schema.parse(query)).toEqual(query);
    }
    expect(SessionFollowRunOccurrenceRoutesQueryV1Schema.safeParse({ includeTargetMachineId: true }).success).toBe(false);
    expect(SessionFollowRunOccurrenceRoutesQueryV1Schema.safeParse({ releaseReason: 'untrusted-prose' }).success).toBe(false);
    expect(SessionFollowRunOccurrenceRoutesQueryV1Schema.safeParse({ payload: 'private' }).success).toBe(false);
  });
  it('carries an actual live Run attention frontier through strict routes, input and source notifications', () => {
    const frontier = ExecutionRunFollowFrontierResponseSchema.parse({ sessionId: 'parent', runId: 'run-1', status: 'running',
      terminalEventId: null, attention: { kind: 'permission_required', requestIds: ['permission-1'], requests: [{ requestId: 'permission-1', createdAt: 1 }] } });
    const produced = resolveExecutionRunFollowOccurrenceV1(frontier)!;
    const response = { ok: true, v: 1, ...produced, routes: [{ destinationSessionId: 'receiver', relation: 'follower',
      attachedAt: 12, policy: { preset: 'important' }, expectedTerminalEventId: null }] };
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.parse(response)).toEqual(response);
    expect(SessionFollowInputV1Schema.parse({ v: 1, ...produced, delivery: 'wake' })).toMatchObject(produced);
    expect(RunFollowUpdateNotificationV1Schema.parse({ topic: 'follow_update', follow: produced })).toMatchObject({ follow: produced });
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse({ ...response, event: { kind: 'finished' } }).success).toBe(false);
    expect(SessionFollowPendingObservationV1Schema.parse({ kind: 'admitted_run_input', localInputId: 'follow-input',
      destinationSessionId: 'receiver', disposition: 'withdrawn', effectiveDelivery: null, delivery: { v: 1, ...produced, delivery: 'wake' } }))
      .toMatchObject({ disposition: 'withdrawn' });
    expect(resolveExecutionRunFollowOccurrenceV1({ ...frontier, attention: undefined })).toBeNull();
  });
  it('binds Run routes to one exact original and per-edge cursor without a parent Session alias', () => {
    const original = { source: { kind: 'execution_run', sessionId: 'parent', runId: 'run-1' }, terminalEventId: 'terminal-2' } as const;
    const request = { v: 1, original } as const;
    const event = ExecutionRunFollowEventV1Schema.parse({ kind: classifyWorkerUpdateEventV1({ workerKind: 'execution_run', ownerState: 'succeeded' }) });
    const response = { ok: true, v: 1, original, event, routes: [{ destinationSessionId: 'receiver', relation: 'follower',
      attachedAt: 12, policy: { preset: 'important' }, expectedTerminalEventId: 'terminal-1' }] } as const;
    expect(SessionFollowRunOccurrenceRoutesRequestV1Schema.parse(request)).toEqual(request);
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.parse(response)).toEqual(response);
    expect(SessionFollowRunOccurrenceRoutesRequestV1Schema.safeParse({ ...request, sourceSessionId: 'parent' }).success).toBe(false);
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse({ ...response,
      routes: [{ ...response.routes[0], expectedRevision: 1 }] }).success).toBe(false);
    const workflow = { source: { kind: 'workflow_run', runId: 'workflow-1' }, revision: 4 } as const;
    expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse({ ok: true, v: 1, original: workflow,
      event: resolveWorkflowRunFollowEventV1({ state: 'succeeded' }),
      routes: [{ destinationSessionId: 'receiver', relation: 'follower', attachedAt: 12,
        policy: { preset: 'quiet' }, expectedRevision: 3 }] }).success).toBe(true);
  });
  it.each([{ kind: 'needs_you', type: 'decision' }, { kind: 'update_posted' }] as const)(
    'admits a Workflow revision with its current $kind event through routing and input admission', event => {
      const original = { source: { kind: 'workflow_run', runId: 'workflow-1' }, revision: 4 } as const;
      const produced = resolveWorkflowRunFollowEventV1({ state: 'running', attentionRequired: event.kind === 'needs_you' });
      expect(produced).toEqual(event);
      expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse({ ok: true, v: 1, original, event: produced,
        routes: [{ destinationSessionId: 'receiver', relation: 'follower', attachedAt: 12,
          policy: { preset: 'important' }, expectedRevision: 3 }] }).success).toBe(true);
      expect(SessionFollowInputV1Schema.parse({ v: 1, original, event: produced, delivery: 'next_turn' })).toMatchObject({ event });
      expect(RunFollowUpdateNotificationV1Schema.parse({ topic: 'follow_update', follow: { original, event: produced } })).toMatchObject({ follow: { event } });
      expect(SessionFollowInputV1Schema.safeParse({ v: 1, original, event: { ...event, unknown: true }, delivery: 'next_turn' }).success).toBe(false);
      expect(RunFollowOccurrenceV1Schema.safeParse({ original: { source: { kind: 'execution_run', sessionId: 'parent', runId: 'run-1' },
        terminalEventId: 'terminal-2' }, event }).success).toBe(false);
    },
  );
  it('carries a committed Discussion occurrence without a fabricated source Session', () => {
    const observation = { source: { kind: 'discussion', discussionId: 'discussion' }, destinationSessionId: 'receiver',
      policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' },
      addressing: { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'receiver' } };
    expect(SessionFollowPendingObservationV1Schema.safeParse(observation).success).toBe(true);
    expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation, policy: undefined }).success).toBe(false);
    expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation, event: undefined }).success).toBe(false);
    expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation, sourceSessionId: 'invented' }).success).toBe(false);
    expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation, addressing: { ...observation.addressing, participantSessionId: 'other' } }).success).toBe(false);
    expect(deriveDiscussionFollowInputLocalIdV1(observation.addressing)).toBe(deriveDiscussionFollowInputLocalIdV1({ ...observation.addressing }));
    expect(deriveDiscussionFollowInputLocalIdV1({ ...observation.addressing, participantSessionId: 'other' }))
      .not.toBe(deriveDiscussionFollowInputLocalIdV1(observation.addressing));
  });
  it('requires an exact typed wake admission decision without changing ordinary observation', () => {
    const eventLocalId = deriveSessionFollowWakeEventLocalIdV1({
      destinationSessionId: 'destination', publisherGeneration: '7', observations: wakeObservations,
    });
    const request = { v: 1, sessionId: 'destination', supportsWakeAdmission: true, wakeAdmission: {
      eventLocalId, observations: wakeObservations, autonomousCheckIn: { afterTurns: 5 },
    } };
    expect(SessionFollowObservePendingRequestV1Schema.parse(request)).toMatchObject(request);
    const response = { ok: true, v: 1, sessionId: 'destination', publisherGeneration: '7',
      currentSourceSessionIds: ['source'], observations: [],
      wakeAdmission: { status: 'held', code: 'session_input_cancelled' } };
    expect(SessionFollowObservePendingResponseV1Schema.parse(response)).toMatchObject(response);
    expect(SessionFollowObservePendingResponseV1Schema.safeParse({ ...response,
      wakeAdmission: { status: 'allowed', code: 'autonomous_check_in' },
    }).success).toBe(false);
    expect(SessionFollowObservePendingRequestV1Schema.safeParse({ ...request,
      wakeAdmission: { ...request.wakeAdmission, unknown: true },
    }).success).toBe(false);
    expect(SessionFollowObservePendingRequestV1Schema.safeParse({ v: 1,
      sessionId: 'destination', supportsWakeAdmission: false,
    }).success).toBe(false);
  });
  it('requires the relation policy on admitted observations and rejects a parallel mode authority', () => {
    const policy = { preset: 'custom', events: { update_posted: { delivery: 'quiet' } } } as const;
    const observation = { sourceSessionId: 'source', destinationSessionId: 'destination',
      relation: 'manager', attachedAt: 123, delivered: frontier, observed: frontier, policy };
    expect(SessionFollowPendingObservationV1Schema.parse(observation)).toEqual(observation);
    const { policy: _policy, ...withoutPolicy } = observation;
    expect(SessionFollowPendingObservationV1Schema.safeParse(withoutPolicy).success).toBe(false);
    expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation, mode: 'next_turn' }).success).toBe(false);
    expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation,
      policy: { ...policy, events: { update_posted: { delivery: 'quiet', targetSessionId: 'other' } } },
    }).success).toBe(false);
  });
  it('admits manager and ordinary routes together with exact attachment identity', () => {
    const base = { sourceSessionId: 'source', destinationSessionId: 'destination', delivered: frontier, observed: frontier,
      policy: { preset: 'important' } };
    const manager = { ...base, relation: 'manager', attachedAt: 123 };
    const follower = { ...base, relation: 'follower' };
    expect(SessionFollowObservePendingResponseV1Schema.safeParse({
      ok: true, v: 1, sessionId: 'destination', publisherGeneration: '7',
      currentSourceSessionIds: ['source'], observations: [manager, follower],
    }).success).toBe(true);
    for (const invalid of [{ ...manager, attachedAt: undefined }, { ...follower, attachedAt: 123 }]) {
      expect(SessionFollowObservePendingResponseV1Schema.safeParse({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '7',
        currentSourceSessionIds: ['source'], observations: [invalid],
      }).success).toBe(false);
    }
  });
  it('derives one stable wake event identity from the exact accepted frontier set', () => {
    const first = deriveSessionFollowWakeEventLocalIdV1({
      destinationSessionId: 'destination',
      publisherGeneration: '7',
      observations: [
        { policy: { preset: 'everything' as const },
          sourceSessionId: 'source-b',
          expected: frontier,
          consumed: { ...frontier, transcriptSeq: 4 },
        },
        { policy: { preset: 'everything' as const },
          sourceSessionId: 'source-a',
          expected: frontier,
          consumed: { ...frontier, transcriptSeq: 3 },
        },
      ],
    });
    const retry = deriveSessionFollowWakeEventLocalIdV1({
      destinationSessionId: 'destination',
      publisherGeneration: '7',
      observations: [
        { policy: { preset: 'everything' as const },
          sourceSessionId: 'source-a',
          expected: frontier,
          consumed: { ...frontier, transcriptSeq: 3 },
        },
        { policy: { preset: 'everything' as const },
          sourceSessionId: 'source-b',
          expected: frontier,
          consumed: { ...frontier, transcriptSeq: 4 },
        },
      ],
    });
    const laterFrontier = deriveSessionFollowWakeEventLocalIdV1({
      destinationSessionId: 'destination',
      publisherGeneration: '7',
      observations: [{ policy: { preset: 'everything' as const },
        sourceSessionId: 'source-a',
        expected: frontier,
        consumed: { ...frontier, transcriptSeq: 4 },
      }],
    });

    expect(first).toBe(retry);
    expect(first).toMatch(/^session-follow-wake:[A-Za-z0-9_-]{43}$/u);
    expect(laterFrontier).not.toBe(first);
    expect(deriveSessionFollowWakeEventLocalIdV1({
      destinationSessionId: 'destination',
      publisherGeneration: '8',
      observations: wakeObservations,
    })).not.toBe(deriveSessionFollowWakeEventLocalIdV1({
      destinationSessionId: 'destination',
      publisherGeneration: '7',
      observations: wakeObservations,
    }));
  });

  it('keeps observe responses strict and carries the publisher fence as a decimal string', () => {
    const parsed = SessionFollowObservePendingResponseV1Schema.safeParse({
      ok: true, v: 1, sessionId: 'destination', publisherGeneration: '0', observations: [],
      ignored: true,
    });
    expect(parsed.success).toBe(false);
    expect(SessionFollowObservePendingResponseV1Schema.parse({
      ok: true, v: 1, sessionId: 'destination', publisherGeneration: '42', currentSourceSessionIds: ['source'], observations: [],
    }).publisherGeneration).toBe('42');
    expect(SessionFollowObservePendingResponseV1Schema.safeParse({
      ok: true, v: 1, sessionId: 'destination', publisherGeneration: '42', observations: [],
    }).success).toBe(false);
  });

  it('requires the exact relation, frontiers, and provider acceptance identity for ACK', () => {
    const parsed = SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7',
      expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null },
    });
    expect(parsed.success).toBe(true);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7',
      expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { localInputId: 'input-1', userMessageSeq: null },
    }).success).toBe(false);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7',
      expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null }, extra: true,
    }).success).toBe(false);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'same', sourceSessionId: 'same',
      expectedPublisherGeneration: '7',
      expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null },
    }).success).toBe(false);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7', expectedMode: 'next_turn',
      expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null },
    }).success).toBe(false);
    const wakeEventLocalId = buildSessionFollowWakeEventLocalId('wake-1');
    expect(isSessionFollowWakeEventLocalId(wakeEventLocalId)).toBe(true);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7', expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { kind: 'context_only_wake', eventLocalId: wakeEventLocalId, observations: wakeObservations },
    }).success).toBe(true);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7', expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { kind: 'context_only_wake', eventLocalId: wakeEventLocalId },
    }).success).toBe(false);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7', expected: frontier, observed: frontier, consumed: frontier,
      acceptance: {
        kind: 'context_only_wake',
        eventLocalId: wakeEventLocalId,
        observations: [...wakeObservations, ...wakeObservations],
      },
    }).success).toBe(false);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7', expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { kind: 'context_only_wake', eventLocalId: 'fabricated-wake-1', observations: wakeObservations },
    }).success).toBe(false);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7', expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { kind: 'context_only_wake', localInputId: wakeEventLocalId },
    }).success).toBe(false);
  });

  it('requires the exact observed frontier in every ACK', () => {
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ policy: { preset: 'everything' as const },
      v: 1,
      destinationSessionId: 'destination', sourceSessionId: 'source',
      expectedPublisherGeneration: '7', expected: frontier, consumed: frontier,
      acceptance: { kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null },
    }).success).toBe(false);
  });

  it('parses both ACK response branches with canonical session ids', () => {
    expect(SessionFollowAcknowledgeResponseV1Schema.parse({
      ok: true,
      v: 1,
      destinationSessionId: 'destination',
      sourceSessionId: 'source',
      delivered: frontier,
    })).toMatchObject({ ok: true, destinationSessionId: 'destination' });
    expect(SessionFollowAcknowledgeResponseV1Schema.parse({
      ok: false,
      v: 1,
      error: 'source_forbidden',
    })).toEqual({ ok: false, v: 1, error: 'source_forbidden' });
    expect(SessionFollowAcknowledgeResponseV1Schema.parse({
      ok: false,
      v: 1,
      error: 'provider_acceptance_unverified',
    })).toEqual({ ok: false, v: 1, error: 'provider_acceptance_unverified' });
    expect(SessionFollowAcknowledgeResponseV1Schema.parse({
      ok: false,
      v: 1,
      error: 'unsupported',
    })).toEqual({ ok: false, v: 1, error: 'unsupported' });
  });
});
