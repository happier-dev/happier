import { describe, expect, it, vi } from 'vitest';

import {
  SessionFollowUpdateEnvelopeV1Schema,
  type SessionFollowUpdateEnvelopeV1,
  type SessionFollowFrontierV1,
} from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { SocketAckError } from '@/session/transport/shared/socketAck';
import {
  createSessionFollowContextReconciler,
  shouldWakeForSessionFollowObservation,
  type SessionFollowHydrateObservation,
} from './sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { createSessionFollowSourceMaterialResolver } from './sessionFollowSourceMaterialResolver';
import { projectSessionFollowFrontierFromSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';

const frontier = {
  transcriptSeq: 2,
  readyEventSeq: 1,
  agentStateVersion: 3,
  turn: { id: 'turn-1', status: 'completed' as const },
};

const zeroFrontier = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };

function envelopeFor(observation: { sourceSessionId: string; destinationSessionId: string; observed: typeof frontier }): SessionFollowUpdateEnvelopeV1 {
  return {
    v: 1 as const,
    kind: 'session_follow_update' as const,
    edge: {
      sourceSessionId: observation.sourceSessionId,
      destinationSessionId: observation.destinationSessionId,
    },
    reason: 'source_changed' as const,
    deliveryIntent: 'context_only' as const,
    observed: observation.observed,
    awareness: {
      v: 1,
      sessionId: observation.sourceSessionId,
      lifecycle: 'ready' as const,
      runtime: 'idle' as const,
      freshness: 'live' as const,
      operational: { primary: 'ready' as const, reasons: ['ready' as const] },
      encryption: 'plain' as const,
      availability: 'complete' as const,
    },
    recentMessages: [],
    truncated: false,
  };
}

/** HTTP/socket are boundaries; original hydration, budgeting and admission stay real. */
function originalInputFixture(texts: readonly string[]) {
  const deliveries = texts.map((_text, index) => ({ localInputId: `original-input-${index + 1}`, userMessageSeq: 100 + index,
    delivery: SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', event: { kind: 'message' },
      original: { sourceSessionId: 'source', sourceMessage: { localId: `original-${index + 1}`, seq: index + 1 } } }) }));
  const acknowledgements: unknown[] = [];
  const state = { publisherGeneration: '1', sourceAvailable: true, sourceError: null as Error | null, revoked: false, corruptSeq: 0,
    afterFetch: () => {} };
  const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
    runSessionFollowSourceRequest: ({ request }) => request(),
    observePendingSessionFollow: async () => ({ ok: true, v: 1, sessionId: 'destination',
      publisherGeneration: state.publisherGeneration, currentSourceSessionIds: state.revoked ? [] : ['source'],
      observations: state.revoked ? [] : deliveries.map(({ delivery, localInputId }, index) => ({
        kind: 'admitted_input' as const, localInputId, delivery, effectiveDelivery: delivery.delivery,
        sourceSessionId: 'source', destinationSessionId: 'destination',
        delivered: { ...zeroFrontier, transcriptSeq: index }, observed: { ...zeroFrontier, transcriptSeq: index + 1 },
      })),
    }),
    acknowledgeSessionFollow: async request => { acknowledgements.push(request);
      if (!('consumed' in request)) throw new Error('Expected a Session original acknowledgement');
      return { ok: true, v: 1, destinationSessionId: 'destination', sourceSessionId: 'source', delivered: request.consumed }; },
  } });
  const material = createSessionFollowSourceMaterialResolver();
  const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null },
    sourceMaterialResolver: material, deps: { fetchRunnerSourceProjection: async request => {
      state.afterFetch();
      if (state.sourceError) throw state.sourceError;
      if (!state.sourceAvailable) return null;
      return SessionFollowSourceProjectionResponseV1Schema.parse({ v: 1,
        source: { id: 'source', encryptionMode: 'plain', metadata: '{}', archivedAt: null,
          createdAt: 1, updatedAt: 1, active: true, activeAt: 1, thinking: false, thinkingAt: null,
          latestTurnStatus: null, latestTurnStatusObservedAt: null, latestReadyEventSeq: null, latestReadyEventAt: null,
          meaningfulActivityAt: null, agentStateVersion: 0 },
        messages: texts.flatMap((text, index) => index + 1 > request.afterTranscriptSeq && index + 1 <= request.observedTranscriptSeq
          ? [{ seq: index + 1, localId: `original-${index + 1}`, createdAt: 1, messageRole: 'agent', content: { t: 'plain', v: {
            ...buildAcpAgentMessageEnvelope({ provider: 'codex', body: { type: 'message', message: text } }),
            role: state.corruptSeq === index + 1 ? 'invalid' : 'agent' } } }] : []), hasMore: false });
    } } });
  const reconcile = createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 100_000 });
  return { deliveries, acknowledgements, state, reconcile, dispose: () => material.dispose() };
}

describe('Session Follow context reconciler', () => {
  it.each(['execution_run', 'workflow_run'] as const)('rechecks current %s mode without losing the original on Important to Quiet', async kind => {
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'wake', event: { kind: 'failed_or_stopped' },
      original: kind === 'execution_run'
        ? { source: { kind, machineId: 'machine', runId: 'run' }, terminalEventId: 'terminal' }
        : { source: { kind, runId: 'run' }, revision: 1 } });
    let effectiveDelivery: 'wake' | 'next_turn' | null = 'wake';
    const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
      observePendingSessionFollow: async () => ({ ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1',
        currentSourceSessionIds: [], observations: [{ kind: 'admitted_run_input', localInputId: 'run-input',
          destinationSessionId: 'destination', delivery, effectiveDelivery }] }),
    } });
    const reconcile = createSessionFollowContextReconciler({ session, hydrateObservation: async () => {
      throw new Error('Run admission must not hydrate a Session source');
    }, maxFollowContextUtf8Bytes: 100_000 });
    const followDeliveries = [{ localInputId: 'run-input', delivery, userMessageSeq: 2 }];
    const signal = new AbortController().signal;
    const wake = await reconcile({ signal, deliveryIntent: 'wake', followDeliveries });
    expect(wake?.representedFollowLocalInputIds).toEqual(['run-input']);
    effectiveDelivery = 'next_turn';
    expect(await wake!.recheckAdmission(signal)).toBe(false);
    expect(await reconcile({ signal, deliveryIntent: 'wake', followDeliveries })).toBeNull();
    expect((await reconcile({ signal, deliveryIntent: 'natural', followDeliveries }))?.representedFollowLocalInputIds).toEqual(['run-input']);
    effectiveDelivery = null;
    expect(await reconcile({ signal, deliveryIntent: 'natural', followDeliveries })).toBeNull();
  });
  it('retains required-original Home failure classification while omitting optional context from the same unavailable source', async () => {
    const f = originalInputFixture(['Original']);
    try {
      f.state.sourceError = Object.assign(new Error('Home transport unavailable'), { code: 'ECONNABORTED' });
      await expect(f.reconcile({ signal: new AbortController().signal, followDeliveries: f.deliveries }))
        .rejects.toMatchObject({ status: 'preparation_pending' });
      await expect(f.reconcile({ signal: new AbortController().signal })).resolves.toBeNull();
      expect(f.acknowledgements).toEqual([]);
    } finally { f.dispose(); }
  });

  it('represents more than twenty admitted originals and ACKs only each exact accepted input', async () => {
    const f = originalInputFixture(Array.from({ length: 24 }, (_, index) => `Original ${index + 1}`));
    try {
      const prepared = await f.reconcile({ signal: new AbortController().signal, followDeliveries: f.deliveries });
      expect(prepared?.updates).toHaveLength(24);
      expect(prepared?.representedFollowLocalInputIds).toEqual(f.deliveries.map(row => row.localInputId));
      expect(f.acknowledgements).toEqual([]);
      for (const row of f.deliveries) prepared!.acknowledgeAccepted({ kind: 'admitted_input', ...row });
      await vi.waitFor(() => expect(f.acknowledgements).toHaveLength(24));
      expect(f.acknowledgements).toEqual(f.deliveries.map((row, index) => expect.objectContaining({
        localInputId: row.localInputId, expected: { ...zeroFrontier, transcriptSeq: index },
        consumed: { ...zeroFrontier, transcriptSeq: index + 1 },
        acceptance: { kind: 'admitted_input', localInputId: row.localInputId, userMessageSeq: row.userMessageSeq },
      })));
    } finally { f.dispose(); }
  });

  it.each(['oversized', 'corrupt', 'unavailable'] as const)('keeps a later admitted original pending behind an %s original', async failure => {
    const f = originalInputFixture([failure === 'oversized' ? 'x'.repeat(20_000) : 'First', 'Later']);
    try {
      f.state.corruptSeq = failure === 'corrupt' ? 1 : 0;
      f.state.sourceAvailable = failure !== 'unavailable';
      const prepared = await f.reconcile({ signal: new AbortController().signal, followDeliveries: f.deliveries,
        maxFollowContextUtf8Bytes: 1_000 });
      expect(prepared?.representedFollowLocalInputIds ?? []).toEqual([]);
      expect(prepared?.updates.flatMap(update => update.recentMessages).some(message => message.text === 'Later') ?? false).toBe(false);
      if (prepared) for (const row of f.deliveries) prepared.acknowledgeAccepted({ kind: 'admitted_input', ...row });
      await Promise.resolve();
      expect(f.acknowledgements).toEqual([]);
      f.state.corruptSeq = 0;
      f.state.sourceAvailable = true;
      const recovered = await f.reconcile({ signal: new AbortController().signal, followDeliveries: f.deliveries });
      expect(recovered?.representedFollowLocalInputIds).toEqual(f.deliveries.map(row => row.localInputId));
    } finally { f.dispose(); }
  });

  it.each(['revocation', 'publisher replacement'] as const)('rechecks original admission after hydration and rejects %s', async change => {
    const f = originalInputFixture(['Original']);
    try {
      f.state.afterFetch = () => { if (change === 'revocation') f.state.revoked = true; else f.state.publisherGeneration = '2'; };
      expect(await f.reconcile({ signal: new AbortController().signal, followDeliveries: f.deliveries })).toBeNull();
      expect(f.acknowledgements).toEqual([]);
      f.state.afterFetch = () => {};
      f.state.revoked = false;
      const recovered = await f.reconcile({ signal: new AbortController().signal, followDeliveries: f.deliveries });
      expect(recovered?.representedFollowLocalInputIds).toEqual(['original-input-1']);
    } finally { f.dispose(); }
  });

  it('does not ACK an original after abort or bind it to a different accepted input', async () => {
    const f = originalInputFixture(['Original']);
    try {
      const controller = new AbortController();
      const prepared = await f.reconcile({ signal: controller.signal, followDeliveries: f.deliveries });
      expect(prepared?.representedFollowLocalInputIds).toEqual(['original-input-1']);
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'different-input', userMessageSeq: 100 });
      controller.abort();
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', ...f.deliveries[0]! });
      await Promise.resolve();
      expect(f.acknowledgements).toEqual([]);
    } finally { f.dispose(); }
  });

  it('uses only admitted original custody when ordinary and manager observations also expose the same report', async () => {
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
      original: { sourceSessionId: 'source', sourceMessage: { localId: 'report-original', seq: 1 } },
      event: { kind: 'update_posted' } });
    const observed = { ...zeroFrontier, transcriptSeq: 1 };
    const acknowledgements: unknown[] = [];
    const routes = [
      { sourceSessionId: 'source', destinationSessionId: 'destination', relation: 'follower' as const,
        policy: { preset: 'everything' as const }, delivered: zeroFrontier, observed },
      { sourceSessionId: 'source', destinationSessionId: 'destination', relation: 'manager' as const,
        attachedAt: 1, policy: { preset: 'everything' as const }, delivered: zeroFrontier, observed },
    ];
    const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
      runSessionFollowSourceRequest: ({ request }) => request(),
      observePendingSessionFollow: async options => ({ ok: true, v: 1, sessionId: 'destination',
        publisherGeneration: '1', currentSourceSessionIds: ['source'], observations: [...routes,
          ...(options?.inputLocalIds?.includes('accepted-follow') ? [{ kind: 'admitted_input' as const,
            localInputId: 'accepted-follow', sourceSessionId: 'source', destinationSessionId: 'destination',
            delivered: zeroFrontier, observed, delivery, effectiveDelivery: delivery.delivery }] : [])],
      }),
      acknowledgeSessionFollow: async request => {
        acknowledgements.push(request);
        // The accepted destination input survives this unavailable Home ACK.
        // Existing ordinary frontiers therefore remain pending on the next read.
        throw new SocketAckError({ code: 'socket_ack_timeout', event: 'session.follow.acknowledge' });
      },
    } });
    const material = createSessionFollowSourceMaterialResolver();
    const hydrateObservation = createSessionFollowSourceHydrator({ session,
      credentials: { token: 'token', encryption: null }, sourceMaterialResolver: material,
      deps: { fetchRunnerSourceProjection: async () => SessionFollowSourceProjectionResponseV1Schema.parse({
        v: 1, source: { id: 'source', encryptionMode: 'plain', metadata: '{}',
          archivedAt: null, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, thinking: false,
          thinkingAt: null, latestTurnStatus: null, latestTurnStatusObservedAt: null, latestReadyEventSeq: null,
          latestReadyEventAt: null, meaningfulActivityAt: null, agentStateVersion: 0 },
        messages: [{ seq: 1, localId: 'committed-report', createdAt: 1,
          messageRole: 'agent', content: { t: 'plain', v: { role: 'agent',
            content: { type: 'event', data: { type: 'worker-report', summary: 'One committed report',
              deliverables: [{ kind: 'workspace_file', sessionId: 'source', path: 'result.md' }] } } } } }],
        hasMore: false,
      }) },
    });
    try {
      const reconcile = createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 });
      const signal = new AbortController().signal;
      const omitted = await reconcile({ signal, maxFollowContextUtf8Bytes: 1,
        followDeliveries: [{ delivery, localInputId: 'accepted-follow', userMessageSeq: 17 }] });
      expect(omitted?.representedFollowLocalInputIds ?? []).toEqual([]);
      const prepared = await reconcile({ signal,
        followDeliveries: [{ delivery, localInputId: 'accepted-follow', userMessageSeq: 17,
          followMatches: [{ kind: 'relation', relation: 'manager' }, { kind: 'relation', relation: 'follower' }, { kind: 'rule' }],
        }] });
      expect(prepared?.representedFollowLocalInputIds).toEqual(['accepted-follow']);
      expect(prepared?.workerUpdates).toEqual([expect.objectContaining({ ownerState: 'published',
        result: 'One committed report', deliverables: [{ kind: 'workspace_file', sessionId: 'source', path: 'result.md' }],
        transcriptPointer: { kind: 'session', sessionId: 'source', seq: 1 } })]);
      expect(prepared?.workerUpdateEvents).toMatchObject([{ followInputLocalId: 'accepted-follow', followMatches: [
        { kind: 'relation', relation: 'manager' }, { kind: 'relation', relation: 'follower' }, { kind: 'rule' },
      ] }]);
      const representationCount = (prepared?.updates.length ?? 0) + (prepared?.workerUpdates?.length ?? 0);
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'accepted-follow', userMessageSeq: 17 });
      await vi.waitFor(() => expect(acknowledgements.length).toBeGreaterThan(0));
      // Losing/advancing a route ACK must not re-enable the retired direct
      // transcript intake after the accepted Pending is no longer presented.
      expect(await reconcile({ signal })).toBeNull();
      expect(representationCount).toBe(1);
      expect(acknowledgements).toHaveLength(2);
      expect(acknowledgements[1]).toEqual(acknowledgements[0]);
      expect(acknowledgements[0]).toMatchObject({ localInputId: 'accepted-follow',
        acceptance: { localInputId: 'accepted-follow', userMessageSeq: 17 } });
    } finally { material.dispose(); }
  });

  it('wakes the manager once for a typed waiting turn without request contents or count heuristics, then follows the next turn', async () => {
    const now = Date.now();
    let source = SessionFollowSourceProjectionResponseV1Schema.parse({ v: 1, source: {
      id: 'source', encryptionMode: 'plain', metadata: JSON.stringify({ path: '/workspace', host: 'host' }),
      archivedAt: null, createdAt: now, updatedAt: now, active: true, activeAt: now,
      thinking: false, thinkingAt: now, latestTurnStatus: 'waiting', latestTurnId: 'wait-turn',
      latestTurnStatusObservedAt: now, latestReadyEventSeq: null, latestReadyEventAt: null,
      meaningfulActivityAt: now, agentStateVersion: 1,
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
    }, messages: [], hasMore: false }).source;
    let delivered: SessionFollowFrontierV1 = zeroFrontier;
    const acknowledgements: SessionFollowFrontierV1[] = [];
    const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
      runSessionFollowSourceRequest: ({ request }) => request(),
      observePendingSessionFollow: async () => ({ ok: true, v: 1, sessionId: 'destination',
        publisherGeneration: '1', currentSourceSessionIds: ['source'], observations: [{
          relation: 'manager', attachedAt: now, sourceSessionId: 'source', destinationSessionId: 'destination',
          policy: { preset: 'important' }, delivered,
          observed: projectSessionFollowFrontierFromSourceV1({ ...source, seq: 0,
            agentStateVersion: source.agentStateVersion, latestTurnId: source.latestTurnId }),
        }] }),
      acknowledgeSessionFollow: async input => {
        if (!('consumed' in input)) throw new Error('Expected a Session original acknowledgement');
        delivered = input.consumed;
        acknowledgements.push(delivered);
        return { ok: true, v: 1, sourceSessionId: 'source', destinationSessionId: 'destination',
           delivered };
      },
    } });
    const hydrateObservation = createSessionFollowSourceHydrator({ session,
      credentials: { token: 'token', encryption: null }, sourceMaterialResolver: createSessionFollowSourceMaterialResolver(),
      deps: { fetchRunnerSourceProjection: async () => ({ v: 1, source, messages: [], hasMore: false }) },
    });
    const reconcile = createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 });
    const signal = new AbortController().signal;
    const waitingSource = await hydrateObservation({ signal, observation: {
      relation: 'manager', attachedAt: now, sourceSessionId: 'source', destinationSessionId: 'destination',
      policy: { preset: 'important' }, delivered,
      observed: projectSessionFollowFrontierFromSourceV1({ ...source, seq: 0,
        agentStateVersion: source.agentStateVersion, latestTurnId: source.latestTurnId }),
    } });
    expect(waitingSource?.awareness).toMatchObject({ runtime: 'waiting',
      operational: { primary: 'action_required' } });
    expect(waitingSource?.awareness.lifecycle).not.toMatch(/cancelled|failed|ready/u);
    expect(waitingSource?.workerUpdate).toMatchObject({ workerKind: 'session', ownerState: 'needs_input', wake: 'needs_you' });
    const waiting = await reconcile({ signal, deliveryIntent: 'wake' });
    expect(waiting?.workerUpdates).toEqual([expect.objectContaining({ workerKind: 'session',
      ownerState: 'needs_input', wake: 'needs_you' })]);
    expect(waiting?.wakeEventLocalId).toBeDefined();
    expect(waiting?.workerUpdateEvents).toMatchObject([{ followMatches: [{ kind: 'relation', relation: 'manager' }] }]);
    waiting!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: waiting!.wakeEventLocalId! });
    await vi.waitFor(() => expect(acknowledgements).toHaveLength(1));
    expect(await reconcile({ signal, deliveryIntent: 'wake' })).toBeNull();
    // The existing begin publication replaces the typed waiting state; an answer
    // does not manufacture a completed outcome while its next turn is running.
    source = { ...source, latestTurnStatus: 'in_progress', latestTurnId: 'answer-turn', thinking: true };
    expect(await reconcile({ signal, deliveryIntent: 'wake' })).toBeNull();
    const next = await hydrateObservation({ signal, observation: {
      relation: 'manager', attachedAt: now, sourceSessionId: 'source', destinationSessionId: 'destination',
      policy: { preset: 'important' }, delivered,
      observed: projectSessionFollowFrontierFromSourceV1({ ...source, seq: 0,
        agentStateVersion: source.agentStateVersion, latestTurnId: source.latestTurnId }),
    } });
    expect(next?.awareness).toMatchObject({ lifecycle: 'active', runtime: 'working' });
    expect(next?.workerUpdate).toBeUndefined();
  });

  it.each([true, false])('suppresses only an exactly witnessed waiting Turn beside an admitted question (turn witness: %s)', async witnessed => {
    const now = Date.now();
    const request = { requestId: 'question', createdAt: 3, ...(witnessed ? { turnId: 'waiting-turn' } : {}) };
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'wake',
      original: { sourceSessionId: 'source', sourceRequests: { agentStateVersion: 1, requests: [request] } },
      requestEvents: [{ requestId: 'question', event: { kind: 'needs_you', type: 'decision' } }] });
    const questionObserved = { ...zeroFrontier, agentStateVersion: 1 };
    const managerObserved = { ...questionObserved, turn: { id: 'waiting-turn', status: 'waiting' as const } };
    const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
      runSessionFollowSourceRequest: ({ request }) => request(),
      observePendingSessionFollow: async () => ({ ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1',
        currentSourceSessionIds: ['source'], observations: [
          { sourceSessionId: 'source', destinationSessionId: 'destination', relation: 'manager', attachedAt: 1,
            policy: { preset: 'important' }, delivered: zeroFrontier, observed: managerObserved },
          { kind: 'admitted_input', localInputId: 'question-input', sourceSessionId: 'source', destinationSessionId: 'destination',
            delivered: zeroFrontier, observed: questionObserved, delivery, effectiveDelivery: delivery.delivery },
        ] }),
    } });
    const material = createSessionFollowSourceMaterialResolver();
    const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null },
      sourceMaterialResolver: material, deps: { fetchRunnerSourceProjection: async () => SessionFollowSourceProjectionResponseV1Schema.parse({
        v: 1, source: { id: 'source', encryptionMode: 'plain', metadata: '{}', archivedAt: null,
          createdAt: now, updatedAt: now, active: true, activeAt: now, thinking: false, thinkingAt: now,
          latestTurnStatus: 'waiting', latestTurnId: 'waiting-turn', latestTurnStatusObservedAt: now,
          latestReadyEventSeq: null, latestReadyEventAt: null, meaningfulActivityAt: now, agentStateVersion: 1,
          agentState: JSON.stringify({ requests: { question: { tool: 'AskUserQuestion', arguments: {}, kind: 'user_action',
            createdAt: 3, ...(witnessed ? { turnId: 'waiting-turn' } : {}) } } }),
        }, messages: [], hasMore: false }) },
    });
    try {
      const prepared = await createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 })({
        signal: new AbortController().signal, followDeliveries: [{ delivery, localInputId: 'question-input', userMessageSeq: 4 }],
      });
      expect(prepared?.representedFollowLocalInputIds).toEqual(['question-input']);
      expect(prepared?.workerUpdates ?? []).toHaveLength(witnessed ? 0 : 1);
      if (!witnessed) expect(prepared?.workerUpdates).toMatchObject([{ ownerState: 'needs_input' }]);
    } finally { material.dispose(); }
  });

  it('selects wake from the stored event policy, including quiet managers and protected human ingress', () => {
    const observation = { sourceSessionId: 'source', destinationSessionId: 'destination', relation: 'manager' as const,
      attachedAt: 123, delivered: zeroFrontier, observed: frontier, policy: { preset: 'important' as const } };
    const source = { ...envelopeFor(observation), workerUpdate: { v: 1 as const, workerKind: 'session' as const,
      workerId: 'source', ownerState: 'settled' as const, wake: 'finished' as const, headline: 'Done', canInspect: true } };
    expect(shouldWakeForSessionFollowObservation(observation, source)).toBe(false);
    expect(shouldWakeForSessionFollowObservation({ ...observation, policy: { preset: 'everything' as const } }, source)).toBe(true);
    const failed = { ...source, workerUpdate: { ...source.workerUpdate, ownerState: 'failed' as const } };
    expect(shouldWakeForSessionFollowObservation(observation, failed)).toBe(true);
    expect(shouldWakeForSessionFollowObservation({ ...observation, policy: { preset: 'quiet' as const } }, failed)).toBe(false);
    expect(shouldWakeForSessionFollowObservation(observation, { ...failed, reason: 'source_unavailable' })).toBe(false);
    const humanPolicy = { preset: 'custom' as const, events: { person_wrote: { delivery: 'interrupt' as const } } };
    const ordinary = { ...observation, relation: 'follower' as const, attachedAt: undefined, policy: humanPolicy };
    expect(shouldWakeForSessionFollowObservation(ordinary, envelopeFor(observation))).toBe(false);
    expect(shouldWakeForSessionFollowObservation(ordinary, { ...envelopeFor(observation), pendingHumanIngress: true })).toBe(true);
    expect(shouldWakeForSessionFollowObservation(observation, { ...envelopeFor(observation), pendingHumanIngress: true })).toBe(false);
  });


  it.each([
    { kind: 'message', retirePreparation: false },
    { kind: 'request', retirePreparation: false },
    { kind: 'message', retirePreparation: true },
  ] as const)('binds a represented public original ($kind, retired preparation $retirePreparation) to its own admitted input without private rule references', async ({ kind, retirePreparation }) => {
    const delivery = SessionFollowInputV1Schema.parse(kind === 'message' ? { v: 1, delivery: 'next_turn',
      original: { sourceSessionId: 'source', sourceMessage: { localId: 'original', seq: 4 } }, event: { kind: 'update_posted' } }
      : { v: 1, delivery: 'wake', original: { sourceSessionId: 'source', sourceRequests: {
        agentStateVersion: 2, requests: [{ requestId: 'question', createdAt: 3 }],
      } }, requestEvents: [{ requestId: 'question', event: { kind: 'needs_you', type: 'decision' } }] });
    const observed = { ...zeroFrontier, ...(kind === 'message' ? { transcriptSeq: 4 } : { agentStateVersion: 2 }) };
    const delivered = { ...zeroFrontier, ...(kind === 'message' ? { transcriptSeq: 3 } : { agentStateVersion: 1 }) };
    const acknowledgements: unknown[] = [];
    const observations: unknown[] = [];
    const sourceRequests: unknown[] = [];
    const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
      runSessionFollowSourceRequest: ({ request }) => request(),
      observePendingSessionFollow: async options => {
        observations.push(options);
        return { ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1', currentSourceSessionIds: ['source'],
          observations: [{ kind: 'admitted_input', localInputId: 'rule-input',
            sourceSessionId: 'source', destinationSessionId: 'destination', delivered, observed, delivery, effectiveDelivery: delivery.delivery }] };
      },
      acknowledgeSessionFollow: async input => {
        acknowledgements.push(input);
        if (!('consumed' in input)) throw new Error('Expected a Session original acknowledgement');
        return {  ok: true, v: 1, destinationSessionId: 'destination', sourceSessionId: 'source', delivered: input.consumed };
      },
    } });
    const material = createSessionFollowSourceMaterialResolver();
    const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null },
      sourceMaterialResolver: material, deps: { fetchRunnerSourceProjection: async request => {
        sourceRequests.push(request);
        return SessionFollowSourceProjectionResponseV1Schema.parse({ v: 1, source: { id: 'source', encryptionMode: 'plain',
          metadata: '{}', archivedAt: null, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, thinking: false,
          thinkingAt: null, latestTurnStatus: null, latestTurnStatusObservedAt: null, latestReadyEventSeq: null,
          latestReadyEventAt: null, meaningfulActivityAt: null, agentStateVersion: observed.agentStateVersion,
          ...(kind === 'request' ? { agentState: JSON.stringify({ requests: { question: {
            tool: 'AskUserQuestion', arguments: {}, kind: 'user_action', createdAt: 3,
          } } }) } : {}) }, messages: kind === 'message' ? [{ seq: 4, localId: 'rule-original', createdAt: 4,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Retained original report' } } } }] : [], hasMore: false });
      } } });
    try {
      const preparation = new AbortController();
      const prepared = await createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 })({
        signal: preparation.signal,
        followDeliveries: [{ delivery, localInputId: 'rule-input', userMessageSeq: 17 }],
      });
      expect(prepared?.representedFollowLocalInputIds).toEqual(['rule-input']);
      expect(observations[0]).toMatchObject({ inputLocalIds: ['rule-input'] });
      expect(sourceRequests[0]).toMatchObject({ localInputId: 'rule-input' });
      expect(sourceRequests[0]).not.toHaveProperty('rule');
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'human-input', userMessageSeq: 18 });
      expect(acknowledgements).toEqual([]);
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'rule-input', userMessageSeq: 18 });
      expect(acknowledgements).toEqual([]);
      let release!: () => void;
      const pendingSettlement = retirePreparation ? new Promise<void>(resolve => { release = resolve; }) : undefined;
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'rule-input', userMessageSeq: 17 }, pendingSettlement);
      // Acceptance is captured before cancellation; the already accepted ACK
      // must survive retirement while its Pending write is still settling.
      if (retirePreparation) { preparation.abort(); release(); }
      await vi.waitFor(() => expect(acknowledgements).toMatchObject([{ localInputId: 'rule-input',
        acceptance: { localInputId: 'rule-input', userMessageSeq: 17 }, consumed: observed }]));
      expect(acknowledgements[0]).not.toHaveProperty('rule');
      expect(acknowledgements[0]).not.toHaveProperty('policy');
    } finally { material.dispose(); }
  });

  it('does not self-rearm the wake signal after an observe transport timeout', async () => {
    const observePendingSessionFollow = vi.fn().mockRejectedValue(new SocketAckError({
      code: 'socket_ack_timeout',
      event: 'session.follow.observe_pending',
    }));
    const prepared = await createSessionFollowContextReconciler({
      session: {
        sessionId: 'destination',
        observePendingSessionFollow,
      } as unknown as ApiSessionClient,
      hydrateObservation: vi.fn(),
    })({ signal: new AbortController().signal, maxFollowContextUtf8Bytes: 8_192, deliveryIntent: 'wake' });

    expect(prepared).toBeNull();
    expect(observePendingSessionFollow).toHaveBeenCalledOnce();
  });

  it('does not re-arm for a disconnected or otherwise non-timeout observation failure', async () => {
    const prepared = await createSessionFollowContextReconciler({
      session: {
        sessionId: 'destination',
        observePendingSessionFollow: vi.fn().mockRejectedValue(new SocketAckError({
          code: 'socket_not_connected',
          event: 'session.follow.observe_pending',
        })),
      } as unknown as ApiSessionClient,
      hydrateObservation: vi.fn(),
    })({ signal: new AbortController().signal, maxFollowContextUtf8Bytes: 8_192, deliveryIntent: 'wake' });

    expect(prepared).toBeNull();
  });

  it('does not observe or hydrate Follow sources without an evidence-backed provider allowance', async () => {
    const observePendingSessionFollow = vi.fn();
    const hydrateObservation = vi.fn();
    const prepared = await createSessionFollowContextReconciler({
      session: { sessionId: 'destination', observePendingSessionFollow } as unknown as ApiSessionClient,
      hydrateObservation,
    })({ signal: new AbortController().signal });
    expect(prepared).toBeNull();
    expect(observePendingSessionFollow).not.toHaveBeenCalled();
    expect(hydrateObservation).not.toHaveBeenCalled();
  });

  it('lets an explicit null invocation allowance fail closed over a constructor test allowance', async () => {
    const observePendingSessionFollow = vi.fn();
    const prepared = await createSessionFollowContextReconciler({
      session: { sessionId: 'destination', observePendingSessionFollow } as unknown as ApiSessionClient,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: vi.fn(),
    })({
      signal: new AbortController().signal,
      maxFollowContextUtf8Bytes: null,
    });
    expect(prepared).toBeNull();
    expect(observePendingSessionFollow).not.toHaveBeenCalled();
  });

  it('retains prepared source material from authoritative membership when no delivery delta is pending', async () => {
    const retainSources = vi.fn();
    const prepared = await createSessionFollowContextReconciler({
      session: {
        sessionId: 'destination',
        observePendingSessionFollow: vi.fn().mockResolvedValue({
          ok: true,
          v: 1,
          sessionId: 'destination',
          publisherGeneration: '4',
          currentSourceSessionIds: ['source-current'],
          observations: [],
        }),
      } as unknown as ApiSessionClient,
      hydrateObservation: vi.fn(),
      sourceMaterialController: { retainSources } as never,
    })({ signal: new AbortController().signal, maxFollowContextUtf8Bytes: 8_192 });

    expect(prepared).toBeNull();
    expect(retainSources).toHaveBeenCalledWith(['source-current']);
  });

  it('prunes restricted runtime source material even when provider capacity cannot admit Follow context', async () => {
    const retainSources = vi.fn();
    const hydrateObservation = vi.fn();
    const observePendingSessionFollow = vi.fn().mockResolvedValue({
      ok: true,
      v: 1,
      sessionId: 'destination',
      publisherGeneration: '4',
      currentSourceSessionIds: [],
      observations: [],
    });

    const prepared = await createSessionFollowContextReconciler({
      session: { sessionId: 'destination', observePendingSessionFollow } as unknown as ApiSessionClient,
      hydrateObservation,
      sourceMaterialController: { retainSources } as never,
    })({ signal: new AbortController().signal, maxFollowContextUtf8Bytes: 0 });

    expect(prepared).toBeNull();
    expect(observePendingSessionFollow).toHaveBeenCalledOnce();
    expect(retainSources).toHaveBeenCalledWith([]);
    expect(hydrateObservation).not.toHaveBeenCalled();
  });

  it('keeps unavailable source material pending without producing an acknowledgement', async () => {
    const acknowledgeSessionFollow = vi.fn();
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1', observations: [],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: vi.fn(),
    })({ signal: new AbortController().signal });
    expect(prepared).toBeNull();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
  });

  it('omits observations for another destination instead of trusting caller identity', async () => {
    const acknowledgeSessionFollow = vi.fn();
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1',
        observations: [{ policy: { preset: 'everything' as const },
          sourceSessionId: 'source',
          destinationSessionId: 'other-destination',
          delivered: zeroFrontier,
          observed: frontier,
        }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => envelopeFor(observation as never) as never,
    })({ signal: new AbortController().signal });
    expect(prepared).toBeNull();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
  });

  it('never acknowledges a newer hydration frontier; only the originally observed tuple', async () => {
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({  ok: true, v: 1, destinationSessionId: 'destination', sourceSessionId: 'source', delivered: frontier });
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '2',
        observations: [{ policy: { preset: 'everything' as const },
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          delivered: zeroFrontier,
          observed: frontier,
        }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const newer = { ...frontier, transcriptSeq: 99 };
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => ({
        ...(envelopeFor(observation as never) as object),
        observed: newer,
      }) as never,
    })({ signal: new AbortController().signal });
    expect(prepared).toBeNull();
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
  });

  it('delivers one bounded current Account Voice snapshot and ACKs its exact original frontier', async () => {
    const observed: SessionFollowFrontierV1 = {
      transcriptSeq: 600,
      readyEventSeq: 7,
      agentStateVersion: 11,
      turn: { id: 'turn-600', status: 'completed' },
    };
    let delivered: SessionFollowFrontierV1 | null = null;
    const acknowledgeAccountVoiceFollow = vi.fn(async (input: Readonly<{
      consumed: SessionFollowFrontierV1;
    }>) => {
      delivered = input.consumed;
      return {
        ok: true as const,
        v: 1 as const,
        voiceSessionId: 'destination',
        sourceSessionId: 'source',
        delivered,
      };
    });
    const observePendingAccountVoiceFollow = vi.fn(async () => ({
      ok: true as const,
      v: 1 as const,
      voiceSessionId: 'destination',
      publisherGeneration: '12',
      executionRunOccurrenceId: 'voice-occurrence-1',
      observations: delivered === null ? [{
        sourceSessionId: 'source',
        voiceSessionId: 'destination',
        expected: null,
        observed,
      }] : [],
    }));
    const session = {
      sessionId: 'destination',
      runSessionFollowSourceRequest: <T>(input: Readonly<{ request: () => T }>): T => input.request(),
      observePendingAccountVoiceFollow,
      acknowledgeAccountVoiceFollow,
    } as unknown as ApiSessionClient;
    const fetchTranscriptPage = vi.fn(async (input: Readonly<{
      afterSeq?: number;
      beforeSeq?: number;
      limit: number;
    }>) => {
      const upperInclusive = input.beforeSeq === undefined
        ? Math.min(observed.transcriptSeq, (input.afterSeq ?? 0) + input.limit)
        : Math.min(observed.transcriptSeq, input.beforeSeq - 1);
      const lowerInclusive = input.beforeSeq === undefined
        ? (input.afterSeq ?? 0) + 1
        : Math.max(1, upperInclusive - input.limit + 1);
      const seqs = Array.from(
        { length: Math.max(0, upperInclusive - lowerInclusive + 1) },
        (_, index) => lowerInclusive + index,
      );
      if (input.beforeSeq !== undefined) seqs.reverse();
      return {
        messages: seqs.map((seq) => ({
          seq,
          createdAt: seq,
          content: {
            t: 'plain' as const,
            v: {
              role: 'user' as const,
              content: { type: 'text' as const, text: `current-context-${seq}-${'x'.repeat(40)}` },
            },
          },
        })),
        hasMore: lowerInclusive > 1,
        nextBeforeSeq: lowerInclusive > 1 ? lowerInclusive : null,
        nextAfterSeq: upperInclusive < observed.transcriptSeq ? upperInclusive : null,
      };
    });
    const hydrateObservation = createSessionFollowSourceHydrator({
      session,
      credentials: { token: 'token' } as never,
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain' },
          accountEncryptionCurrentness: { mode: 'plain' },
          ctx: null,
          mode: 'plain',
        })) as never,
        fetchTranscriptPage: fetchTranscriptPage as never,
        projectSourceAwareness: () => envelopeFor({
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          observed: frontier,
        }).awareness as never,
      },
    });
    const prepared = await createSessionFollowContextReconciler({
      session,
      observer: { kind: 'account_voice', accountId: 'account', voiceSessionId: 'destination' },
      maxFollowContextUtf8Bytes: 900,
      hydrateObservation,
    })({ signal: new AbortController().signal, executionRunId: 'voice-run-1' });

    expect(prepared?.updates).toHaveLength(1);
    const deliveredSeqs = prepared?.updates[0]?.recentMessages.map((message) => message.seq) ?? [];
    expect(deliveredSeqs.length).toBeGreaterThan(0);
    expect(deliveredSeqs[0]).toBeGreaterThan(500);
    expect(deliveredSeqs.at(-1)).toBe(600);
    expect(prepared?.updates[0]).toMatchObject({
      observed,
      truncated: true,
    });
    expect(fetchTranscriptPage).toHaveBeenCalledWith(expect.objectContaining({
      beforeSeq: 601,
      limit: 500,
    }));
    expect(fetchTranscriptPage).toHaveBeenCalledWith(expect.not.objectContaining({ afterSeq: expect.anything() }));
    expect(acknowledgeAccountVoiceFollow).not.toHaveBeenCalled();
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'voice-input', userMessageSeq: null });
    await vi.waitFor(() => expect(acknowledgeAccountVoiceFollow).toHaveBeenCalledOnce());
    expect(acknowledgeAccountVoiceFollow).toHaveBeenCalledWith({
      executionRunId: 'voice-run-1',
      expectedExecutionRunOccurrenceId: 'voice-occurrence-1',
      sourceSessionId: 'source',
      expectedPublisherGeneration: '12',
      expected: null,
      observed,
      consumed: observed,
      acceptance: { localInputId: 'voice-input', userMessageSeq: null },
    });

    const second = await createSessionFollowContextReconciler({
      session,
      observer: { kind: 'account_voice', accountId: 'account', voiceSessionId: 'destination' },
      maxFollowContextUtf8Bytes: 900,
      hydrateObservation,
    })({ signal: new AbortController().signal, executionRunId: 'voice-run-1' });
    expect(second).toBeNull();
    expect(observePendingAccountVoiceFollow).toHaveBeenCalledTimes(3);
  });

  it('caps an initial Account Voice snapshot at its original observation and leaves a concurrent advance pending', async () => {
    const initialObserved: SessionFollowFrontierV1 = {
      transcriptSeq: 600,
      readyEventSeq: 7,
      agentStateVersion: 11,
      turn: { id: 'turn-600', status: 'completed' },
    };
    const advancedObserved: SessionFollowFrontierV1 = {
      transcriptSeq: 650,
      readyEventSeq: 7,
      agentStateVersion: 11,
      turn: { id: 'turn-600', status: 'completed' },
    };
    let delivered: SessionFollowFrontierV1 | null = null;
    let observeCount = 0;
    const acknowledgeAccountVoiceFollow = vi.fn(async (input: Readonly<{ consumed: SessionFollowFrontierV1 }>) => {
      delivered = input.consumed;
      return {
        ok: true as const,
        v: 1 as const,
        voiceSessionId: 'destination',
        sourceSessionId: 'source',
        delivered,
      };
    });
    const observePendingAccountVoiceFollow = vi.fn(async () => {
      observeCount += 1;
      const current = observeCount === 1 ? initialObserved : advancedObserved;
      return {
        ok: true as const,
        v: 1 as const,
        voiceSessionId: 'destination',
        publisherGeneration: '12',
        executionRunOccurrenceId: 'voice-occurrence-1',
        observations: delivered && delivered.transcriptSeq === current.transcriptSeq ? [] : [{
          sourceSessionId: 'source',
          voiceSessionId: 'destination',
          expected: delivered,
          observed: current,
        }],
      };
    });
    const hydrateObservation = vi.fn<SessionFollowHydrateObservation>(async ({ observation, readMode }) => ({
      ...SessionFollowUpdateEnvelopeV1Schema.parse({
        ...envelopeFor({
          sourceSessionId: observation.sourceSessionId,
          destinationSessionId: observation.destinationSessionId,
          observed: observation.observed as typeof frontier,
        }),
        observed: observation.observed,
        recentMessages: readMode === 'initial_current_snapshot'
          ? [{ messageId: 'seq:600', seq: 600, text: 'snapshot tail', provenance: null }]
          : [{ messageId: 'seq:650', seq: 650, text: 'later change', provenance: null }],
      }),
      sourceRecencyMs: 1,
    }));
    const session = {
      sessionId: 'destination',
      observePendingAccountVoiceFollow,
      acknowledgeAccountVoiceFollow,
    } as unknown as ApiSessionClient;
    const reconcile = createSessionFollowContextReconciler({
      session,
      observer: { kind: 'account_voice', accountId: 'account', voiceSessionId: 'destination' },
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation,
    });

    const prepared = await reconcile({
      signal: new AbortController().signal,
      executionRunId: 'voice-run-1',
    });
    expect(hydrateObservation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      observation: expect.objectContaining({ observed: initialObserved }),
      readMode: 'initial_current_snapshot',
    }));
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'voice-input', userMessageSeq: null });
    await vi.waitFor(() => expect(acknowledgeAccountVoiceFollow).toHaveBeenCalledOnce());
    expect(acknowledgeAccountVoiceFollow).toHaveBeenCalledWith(expect.objectContaining({
      expected: null,
      observed: initialObserved,
      consumed: initialObserved,
    }));

    const later = await reconcile({
      signal: new AbortController().signal,
      executionRunId: 'voice-run-1',
    });
    expect(later?.updates[0]).toMatchObject({
      observed: advancedObserved,
      recentMessages: [{ seq: 650, text: 'later change' }],
    });
    expect(hydrateObservation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      observation: expect.objectContaining({
        delivered: initialObserved,
        observed: advancedObserved,
      }),
      readMode: 'incremental',
    }));
  });
});
