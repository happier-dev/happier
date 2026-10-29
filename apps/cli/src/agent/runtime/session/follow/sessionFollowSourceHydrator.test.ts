import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { SessionFollowUpdateEnvelopeV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowUpdateEnvelopeV1';
import type { SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import type { SessionAwarenessProjectionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { createSessionFollowContextReconciler } from './sessionFollowContextReconciler';
import { createSessionFollowSourceMaterialResolver } from './sessionFollowSourceMaterialResolver';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  createSessionFollowSourceHydrator,
  resolveAccountVoiceFollowDisclosure,
} from './sessionFollowSourceHydrator';

const observation = { policy: { preset: 'everything' as const },
  relation: 'follower' as const,
  sourceSessionId: 'source',
  destinationSessionId: 'destination',
  delivered: { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null },
  observed: { transcriptSeq: 3, readyEventSeq: 0, agentStateVersion: 0, turn: null },
};

const awareness: SessionAwarenessProjectionV1 = {
  v: 1,
  sessionId: 'source',
  lifecycle: 'ready' as const,
  runtime: 'idle' as const,
  freshness: 'live' as const,
  operational: { primary: 'ready' as const, reasons: ['ready' as const] },
  encryption: 'plain' as const,
  availability: 'complete' as const,
};

const destinationSession = {
  sessionId: 'destination',
  runSessionFollowSourceRequest: <T>(input: Readonly<{ request: () => T }>): T => input.request(),
};

function plainSourceTransport(overrides: Partial<ReturnType<typeof createSessionRecordFixture>> = {}) {
  return { ok: true as const, sessionId: 'source',
    rawSession: createSessionRecordFixture({ id: 'source', encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/source', host: 'test' }), active: true, activeAt: Date.now(), ...overrides }),
    accountEncryptionCurrentness: createAccountEncryptionCurrentnessFixture(), ctx: null, mode: 'plain' as const };
}

describe('Session Follow source hydrator', () => {
  it.each(['plain', 'e2ee'] as const)('keeps a restricted %s manager terminal behind an unadmitted original but supports legacy rows', async mode => {
    const ctx = { encryptionKey: new Uint8Array(32).fill(21), encryptionVariant: 'dataKey' as const };
    const material = createSessionFollowSourceMaterialResolver();
    if (mode === 'e2ee') material.installPreparedDataKey({ sourceSessionId: 'source', dataKey: ctx.encryptionKey });
    try {
      for (const { localId, legacyText } of [{ localId: 'report-original', legacyText: false },
        { localId: null, legacyText: false }, { localId: 'legacy-text', legacyText: true }]) {
        const deferred = localId !== null && !legacyText;
        const payload = { role: 'agent', content: legacyText ? { type: 'text', text: 'Historical final text' }
          : { type: 'event', id: 'report-original',
            data: TranscriptRawAgentEventV1Schema.parse({ type: 'worker-report', summary: 'Pending report' }) } };
        const hydrate = createSessionFollowSourceHydrator({ session: destinationSession,
          credentials: { token: 'token', encryption: null }, sourceMaterialResolver: material,
          deps: { fetchRunnerSourceProjection: async () => SessionFollowSourceProjectionResponseV1Schema.parse({ v: 1, source: {
            id: 'source', encryptionMode: mode, metadata: mode === 'plain' ? JSON.stringify({ path: '/source', host: 'test' })
              : encryptSessionPayload({ ctx, payload: { path: '/source', host: 'test' } }), metadataLayoutVersion: 0,
            archivedAt: null, createdAt: 1, updatedAt: 1, active: true, activeAt: Date.now(), thinking: false, thinkingAt: null,
            latestTurnStatus: 'completed', latestTurnId: 'completed-turn', latestTurnStatusObservedAt: 1,
            latestReadyEventSeq: null, latestReadyEventAt: null, meaningfulActivityAt: 1, agentStateVersion: 0,
          }, messages: [{ seq: 2, localId, createdAt: 1, messageRole: 'event', content: mode === 'plain'
            ? { t: 'plain', v: payload } : { t: 'encrypted', c: encryptSessionPayload({ ctx, payload }) } }], hasMore: false }) } });
        const result = await hydrate({ signal: new AbortController().signal,
          observation: { ...observation, relation: 'manager', attachedAt: 1,
            observed: { ...observation.observed, transcriptSeq: 2, turn: { id: 'completed-turn', status: 'completed' } } } });
        expect(result?.reason).toBe(deferred ? 'source_unavailable' : 'source_changed');
        if (deferred) {
          expect(result?.workerUpdate).toBeUndefined();
          expect(result?.recentMessages).toEqual([]);
        } else {
          expect(result?.observed.transcriptSeq).toBe(2);
          expect(result?.observed.turn).toEqual({ id: 'completed-turn', status: 'completed' });
        }
      }
    } finally { material.dispose(); }
  });

  it('retains an admitted request through unavailable or unreadable source state and withdraws only on a current resolved snapshot', async () => {
    const material = createSessionFollowSourceMaterialResolver();
    let unavailable = false;
    const source = {
      id: 'source', encryptionMode: 'plain' as const, metadata: '{}', archivedAt: null,
      createdAt: 1, updatedAt: 1, active: true, activeAt: 1, thinking: false, thinkingAt: null,
      latestTurnStatus: null, latestTurnStatusObservedAt: null, latestReadyEventSeq: null,
      latestReadyEventAt: null, meaningfulActivityAt: null, agentStateVersion: 1,
      agentState: JSON.stringify({ requests: { approval: { tool: 'Bash', arguments: {}, createdAt: 42 } } }),
    };
    const hydrate = createSessionFollowSourceHydrator({ session: destinationSession,
      credentials: { token: 'token', encryption: null }, sourceMaterialResolver: material,
      deps: { fetchRunnerSourceProjection: async () => {
        if (unavailable) throw Object.assign(new Error('Home timed out'), { code: 'ECONNABORTED' });
        return { v: 1, source, messages: [], hasMore: false };
      } } });
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'wake',
      original: { sourceSessionId: 'source', sourceRequests: { agentStateVersion: 1,
        requests: [{ requestId: 'approval', createdAt: 42 }] } },
      requestEvents: [{ requestId: 'approval', event: { kind: 'needs_you', type: 'approval' } }] });
    const signal = new AbortController().signal;
    try {
      const result = await hydrate({ signal, observation: { kind: 'admitted_input', localInputId: 'request-original', effectiveDelivery: delivery.delivery,
        sourceSessionId: 'source', destinationSessionId: 'destination', delivery,
        delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
        observed: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 1, turn: null } } });
      expect(result?.recheckWorkerUpdateAdmission).toBeTypeOf('function');
      unavailable = true;
      await expect(result!.recheckWorkerUpdateAdmission!(signal)).rejects.toMatchObject({ status: 'preparation_pending' });
      expect(result!.isOriginalRequestWithdrawn?.()).not.toBe(true);
      unavailable = false;
      await expect(result!.recheckWorkerUpdateAdmission!(signal)).resolves.toBe(true);
      for (const [agentStateVersion, agentState] of [[0, JSON.stringify({ requests: {} })],
        [2, '{malformed'], [2, null]] as const) {
        const original = { ...source, agentStateVersion, agentState };
        const originalHydrate = createSessionFollowSourceHydrator({ session: destinationSession,
          credentials: { token: 'token', encryption: null }, sourceMaterialResolver: material,
          deps: { fetchRunnerSourceProjection: async () => SessionFollowSourceProjectionResponseV1Schema.parse({
            v: 1, source: original, messages: [], hasMore: false,
          }) } });
        const pending = await originalHydrate({ signal, observation: { kind: 'admitted_input', localInputId: 'request-original', effectiveDelivery: delivery.delivery,
          sourceSessionId: 'source', destinationSessionId: 'destination', delivery,
          delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
          observed: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 1, turn: null } } });
        expect(pending?.isOriginalRequestWithdrawn?.()).not.toBe(true);
      }
      source.agentStateVersion = 2;
      source.agentState = JSON.stringify({ requests: {} });
      await expect(result!.recheckWorkerUpdateAdmission!(signal)).resolves.toBe(false);
      expect(result!.isOriginalRequestWithdrawn?.()).toBe(true);
      // Old groups and a reused request id cannot consume either current original.
      source.agentState = JSON.stringify({ requests: {
        approval: { tool: 'Bash', arguments: {}, createdAt: 43 },
        survivor: { tool: 'Bash', arguments: {}, createdAt: 44 },
      } });
      const hydrateRequests = async (requests: ReadonlyArray<{ requestId: string; createdAt: number }>) => await hydrate({ signal,
        observation: { kind: 'admitted_input', localInputId: 'request-original', effectiveDelivery: delivery.delivery, sourceSessionId: 'source', destinationSessionId: 'destination',
          delivery: SessionFollowInputV1Schema.parse({ ...delivery,
            original: { sourceSessionId: 'source', sourceRequests: { agentStateVersion: 2, requests } },
            requestEvents: requests.map(request => ({ requestId: request.requestId, event: { kind: 'needs_you', type: 'approval' } })),
          }), delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
          observed: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 2, turn: null } } });
      expect((await hydrateRequests([{ requestId: 'approval', createdAt: 42 }, { requestId: 'survivor', createdAt: 44 }]))
        ?.isOriginalRequestWithdrawn?.()).toBe(true);
      for (const request of [{ requestId: 'approval', createdAt: 43 }, { requestId: 'survivor', createdAt: 44 }]) {
        const current = await hydrateRequests([request]);
        expect(current?.isOriginalRequestWithdrawn?.()).toBe(false);
        await expect(current?.recheckWorkerUpdateAdmission?.(signal)).resolves.toBe(true);
      }
    } finally { material.dispose(); }
  });

  it.each(['plain', 'e2ee'] as const)('materializes the admitted %s Turn outcome and its exact anchored result without advancing the transcript', async mode => {
    const key = new Uint8Array(32).fill(21);
    const ctx = { encryptionKey: key, encryptionVariant: 'dataKey' as const };
    const material = createSessionFollowSourceMaterialResolver();
    material.installPreparedDataKey({ sourceSessionId: 'source', dataKey: key });
    try {
      for (const status of ['completed', 'failed', 'cancelled'] as const) {
        const payload = { role: 'agent', content: { type: 'text', text: 'Exact historical final answer' } };
        const metadata = { path: '/source', host: 'test' };
        const projection = vi.fn(async () => ({ v: 1 as const, source: {
          id: 'source', encryptionMode: mode, metadata: mode === 'plain' ? JSON.stringify(metadata)
            : encryptSessionPayload({ ctx, payload: metadata }), archivedAt: null,
          createdAt: 1, updatedAt: 1, active: true, activeAt: Date.now(), thinking: false, thinkingAt: null,
          latestTurnStatus: 'completed', latestTurnId: 'a-later-turn', latestTurnStatusObservedAt: 1,
          latestReadyEventSeq: 9, latestReadyEventAt: 1, meaningfulActivityAt: 1, agentStateVersion: 0, pendingReviewRuns: 0,
        }, messages: [{ seq: 2, localId: 'final-message', createdAt: 1, messageRole: 'agent' as const, content: mode === 'plain'
          ? { t: 'plain' as const, v: payload } : { t: 'encrypted' as const, c: encryptSessionPayload({ ctx, payload }) } }], hasMore: false }));
        const hydrate = createSessionFollowSourceHydrator({ session: destinationSession,
          credentials: { token: 'token', encryption: null }, sourceMaterialResolver: material,
          deps: { fetchRunnerSourceProjection: projection },
        });
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
          event: { kind: status === 'completed' ? 'finished' : 'failed_or_stopped' },
          original: { sourceSessionId: 'source', sourceTurn: { id: 'completed-turn', status } } });
        const result = await hydrate({ signal: new AbortController().signal, observation: { kind: 'admitted_input',
          localInputId: 'accepted-turn', effectiveDelivery: delivery.delivery, sourceSessionId: 'source', destinationSessionId: 'destination',
          delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
          observed: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: { id: 'completed-turn', status } }, delivery } });
        expect(result?.workerUpdate).toMatchObject({ ownerState: status === 'completed' ? 'settled' : status,
          headline: status === 'completed' ? 'Finished its turn' : status === 'failed' ? 'Failed' : 'Stopped',
          result: 'Exact historical final answer', transcriptPointer: { kind: 'session', sessionId: 'source', seq: 2 } });
        expect(result?.observed.transcriptSeq).toBe(0);
        expect(result?.recentMessages).toEqual([]);
        expect(projection).toHaveBeenCalledTimes(1);
      }
    } finally { material.dispose(); }
  });

  it.each(['sidechain', 'foreign_deliverable'] as const)('R14 does not promote or skip a %s publication while selecting the original Voice prefix', async problem => {
    const hydrate = createSessionFollowSourceHydrator({ session: destinationSession, credentials: { token: 'token', encryption: null }, deps: {
      resolveSourceTransport: (async () => plainSourceTransport()) as never,
      fetchTranscriptPage: (async () => ({ messages: [2, 3].map(seq => ({ seq, createdAt: seq,
        ...(seq === 2 && problem === 'sidechain' ? { sidechainId: 'child-run' } : {}),
        content: { t: 'plain', v: { role: 'agent', content: { type: 'event', data: { type: 'worker-report', summary: `Report ${seq}`,
          ...(seq === 2 && problem === 'foreign_deliverable'
            ? { deliverables: [{ kind: 'workspace_file', sessionId: 'other-source', path: 'result.md' }] } : {}) } } } } })),
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })) as never,
    } });
    const result = await hydrate({ observation: { ...observation,
      policy: { preset: 'custom' as const, events: { update_posted: { delivery: 'quiet' as const, voice: true } } } },
      signal: new AbortController().signal, selectionChannel: 'voice' });
    if (problem === 'sidechain') expect(result?.recentMessages.map(message => message.seq)).toEqual([3]);
    else expect(result).toMatchObject({ reason: 'source_unavailable', recentMessages: [] });
  });

  it('R14 selects a real active Voice request and withdraws it when that original is answered before dispatch', async () => {
    const transport = plainSourceTransport({ agentStateVersion: 1, pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
      agentState: JSON.stringify({ requests: { approval: { tool: 'Bash', arguments: {}, createdAt: 42 } } }) });
    const rawSession = transport.rawSession;
    const hydrate = createSessionFollowSourceHydrator({ session: destinationSession,
      credentials: { token: 'token', encryption: null }, deps: {
        resolveSourceTransport: (async () => transport) as never,
        fetchTranscriptPage: (async () => ({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })) as never,
      } });
    const args = { signal: new AbortController().signal, selectionChannel: 'voice' as const,
      observation: { ...observation, observed: { ...observation.delivered, agentStateVersion: 1 },
        policy: { preset: 'custom' as const, events: { needs_you: { approval: { delivery: 'quiet' as const, voice: true } } } } } };
    const result = await hydrate(args);
    expect(result).not.toBeNull();
    expect(await result?.recheckWorkerUpdateAdmission?.(args.signal)).toBe(true);
    rawSession.agentState = JSON.stringify({ requests: { approval: { tool: 'Bash', arguments: {} } } });
    expect(await hydrate(args)).toBeNull();
    rawSession.agentStateVersion = 2;
    rawSession.pendingPermissionRequestCount = 0;
    rawSession.agentState = JSON.stringify({ requests: {} });
    expect(await result?.recheckWorkerUpdateAdmission?.(args.signal)).toBe(false);
    expect(await hydrate(args)).toBeNull();
  });

  it('R14 keeps the oldest selected Voice original pending prefix when the snippet allowance cannot represent both reports', async () => {
    const hydrate = createSessionFollowSourceHydrator({ session: destinationSession,
      credentials: { token: 'token', encryption: null },
      disclosure: { level: 'snippets', shareRecentMessages: true, shareSessionSummary: true,
        includeUserMessagesInSnippets: true, snippetsMaxMessages: 1 },
      deps: {
        resolveSourceTransport: (async () => plainSourceTransport()) as never,
        fetchTranscriptPage: (async () => ({ messages: [2, 3].map(seq => ({ seq, createdAt: seq,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'event',
            data: { type: 'worker-report', summary: `Original report ${seq}` } } } } })),
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })) as never,
      } });
    const result = await hydrate({ signal: new AbortController().signal, selectionChannel: 'voice',
      observation: { ...observation, policy: { preset: 'custom' as const, events: { update_posted: { delivery: 'quiet' as const, voice: true } } } } });
    expect(result?.recentMessages.map(message => message.seq)).toEqual([2]);
    expect(result?.observed.transcriptSeq).toBe(2);
    expect(result?.transcriptConsumedThroughByRenderedMessageCount).toEqual([1, 2]);
    expect(result?.truncated).toBe(true);
  });

  it.each(['off', 'finished', 'stalled'] as const)('R14 withholds unselected Voice context and represents the actual %s lifecycle occurrence without inventing a message', async selected => {
    const observed = { ...observation.delivered,
      turn: selected === 'off' ? null : { id: 'source-turn', status: selected === 'finished' ? 'completed' as const : 'stalled' as const } };
    const hydrate = createSessionFollowSourceHydrator({ session: destinationSession,
      credentials: { token: 'token', encryption: null }, deps: {
        resolveSourceTransport: (async () => plainSourceTransport({ active: selected !== 'stalled',
          latestTurnId: observed.turn?.id, latestTurnStatus: selected === 'stalled' ? 'in_progress' : selected === 'finished' ? 'completed' : undefined })) as never,
        fetchTranscriptPage: (async () => ({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })) as never,
      } });
    const result = await hydrate({ signal: new AbortController().signal, selectionChannel: 'voice',
      observation: { ...observation, observed, policy: { preset: 'custom' as const, events: {
        finished: { delivery: 'quiet' as const, voice: true }, stalled: { delivery: 'quiet' as const, voice: true },
      } } } });
    if (selected === 'off') expect(result).toBeNull();
    else expect(result).toMatchObject({ observed, recentMessages: [] });
  });

  it.each([
    { messageVoice: false, selectedSequences: [4] },
    { messageVoice: true, selectedSequences: [2, 4, 5] },
  ])('R14 selects original Voice events independently of other delivery channels (message Voice: $messageVoice) and withdraws after policy replacement', async ({ messageVoice, selectedSequences }) => {
    const selectedPolicy = { preset: 'custom' as const, events: {
      update_posted: { delivery: 'quiet' as const, voice: true },
      goal_changed: { delivery: 'quiet' as const, voice: false },
      message: { delivery: 'off' as const, voice: messageVoice },
    } };
    let policy = selectedPolicy;
    const observed = { ...observation.observed, transcriptSeq: 5 };
    const acknowledgements: unknown[] = [];
    const session = { ...destinationSession,
      observePendingAccountVoiceFollow: async () => ({ ok: true, v: 1, voiceSessionId: 'destination',
        publisherGeneration: '1', executionRunOccurrenceId: 'voice-occurrence', observations: [{
          sourceSessionId: 'source', voiceSessionId: 'destination', expected: observation.delivered, observed, policy,
        }] }),
      acknowledgeAccountVoiceFollow: async (request: unknown) => { acknowledgements.push(request); return { ok: true }; },
    } as unknown as ApiSessionClient;
    const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null },
      deps: {
        resolveSourceTransport: (async () => plainSourceTransport()) as never,
        fetchTranscriptPage: (async () => ({ messages: [
          { seq: 2, content: { type: 'text', text: 'Unselected ordinary text' } },
          { seq: 3, content: { type: 'event', data: { type: 'goal-changed' } } },
          { seq: 4, content: { type: 'event', data: { type: 'worker-report', summary: 'Selected published update' } } },
          { seq: 5, content: { type: 'text', text: 'Later unselected text' } },
        ].map(row => ({ seq: row.seq, createdAt: row.seq, content: { t: 'plain', v: { role: 'agent', content: row.content } } })),
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })) as never,
      } });
    const prepare = createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192,
      observer: { kind: 'account_voice', accountId: 'account', voiceSessionId: 'destination' } });
    const prepared = await prepare({ signal: new AbortController().signal, executionRunId: 'voice-run' });
    expect(prepared?.updates[0]?.recentMessages.map(message => message.seq)).toEqual(selectedSequences);
    expect(prepared?.updates[0]?.recentMessages.find(message => message.seq === 4)?.text).toContain('Selected published update');
    expect(prepared?.updates[0]?.observed).toEqual(observed);
    expect(acknowledgements).toEqual([]);
    expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(true);
    policy = { ...selectedPolicy, events: { ...selectedPolicy.events,
      update_posted: { delivery: 'quiet', voice: false } } };
    expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(false);
    policy = selectedPolicy;
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'voice-input', userMessageSeq: null });
    await vi.waitFor(() => expect(acknowledgements).toEqual([expect.objectContaining({ policy: selectedPolicy,
      expected: observation.delivered, observed, consumed: observed })]));
  });

  it.each([
    ['natural', 'person_wrote'], ['wake', 'person_wrote'],
    ['natural', 'goal_changed'], ['wake', 'goal_changed'],
  ] as const)('represents one admitted %s notice for %s despite ordinary and manager overlap', async (deliveryIntent, eventKind) => {
    const delivery = SessionFollowInputV1Schema.parse({ v: 1,
      delivery: deliveryIntent === 'wake' ? 'wake' : 'next_turn', event: { kind: eventKind },
      original: { sourceSessionId: 'source', sourceMessage: { localId: 'source-notice', seq: 2 } } });
    const delivered = { ...observation.delivered, transcriptSeq: 1 };
    const observed = { ...delivered, transcriptSeq: 2 };
    const routes = [
      { ...observation, relation: 'follower' as const, policy: { preset: 'quiet' as const } },
      { ...observation, relation: 'manager' as const, attachedAt: 100,
        policy: { preset: 'custom' as const, events: { [eventKind]: { delivery: 'interrupt' as const } } } },
    ];
    const acknowledgements: unknown[] = [];
    const session = { ...destinationSession,
      observePendingSessionFollow: async () => ({ ok: true, publisherGeneration: '1', observations: [
        ...routes, { kind: 'admitted_input', localInputId: 'accepted-notice', delivery, effectiveDelivery: delivery.delivery,
          sourceSessionId: 'source', destinationSessionId: 'destination', delivered, observed },
      ] }),
      acknowledgeSessionFollow: async (request: unknown) => { acknowledgements.push(request); return { ok: true }; },
    } as unknown as ApiSessionClient;
    const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null },
      deps: {
        resolveSourceTransport: (async () => plainSourceTransport()) as never,
        fetchTranscriptPage: (async () => ({ messages: [
          { seq: 2, createdAt: 2, content: { t: 'plain', v: eventKind === 'goal_changed'
            ? { role: 'agent', content: { type: 'event', data: { type: 'goal-changed' } } }
            : { role: 'user', content: { type: 'text', text: 'Private human direction' },
              meta: { happierProvenanceV1: { v: 1, kind: 'happierApp', actor: { kind: 'owner' } } } } } },
          { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Another original' } } } },
        ], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })) as never,
        projectSourceAwareness: () => awareness,
      } });
    const prepared = await createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 })({
      signal: new AbortController().signal, deliveryIntent,
      followDeliveries: [{ delivery, localInputId: 'accepted-notice', userMessageSeq: 1 }],
    });
    expect(prepared?.representedFollowLocalInputIds).toEqual(['accepted-notice']);
    expect(prepared?.updates).toHaveLength(1);
    expect(prepared!.updates[0]!.recentMessages).toHaveLength(1);
    expect(prepared!.updates[0]!.recentMessages[0]).toMatchObject({ seq: 2,
      ...(eventKind === 'goal_changed' ? { event: { kind: 'goal_changed' } } : { provenance: { kind: 'happierApp' } }) });
    expect(JSON.stringify(prepared)).not.toContain('Private human direction');
    expect(JSON.stringify(prepared)).not.toContain('Another original');
    expect(prepared?.wakeEventLocalId).toBeUndefined();
    prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'accepted-notice', userMessageSeq: 1 });
    await vi.waitFor(() => expect(acknowledgements).toHaveLength(1));
    expect(acknowledgements[0]).toMatchObject({ localInputId: 'accepted-notice', consumed: observed });
  });

  it('represents an admitted original report and its deliverables without consuming a later report or terminal turn', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'token', encryption: null },
      deps: {
        resolveSourceTransport: (async () => ({ ok: true, sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain' },
          accountEncryptionCurrentness: { mode: 'plain' }, ctx: null, mode: 'plain' })) as never,
        fetchTranscriptPage: (async () => ({
          messages: [2, 3].map(seq => ({ seq, createdAt: seq, content: { t: 'plain', v: {
            role: 'agent', content: { type: 'event', data: { type: 'worker-report', summary: `Report ${seq}`,
              deliverables: [{ kind: 'workspace_file', sessionId: 'source', path: `report-${seq}.md` }] } },
          } } })),
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => awareness,
      },
    });
    const envelope = await hydrate({ signal: new AbortController().signal,
      observation: { kind: 'admitted_input', localInputId: 'accepted-report', effectiveDelivery: 'next_turn', sourceSessionId: 'source', destinationSessionId: 'destination',
        delivered: observation.delivered, observed: { ...observation.delivered, transcriptSeq: 2 },
        delivery: SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', event: { kind: 'update_posted' },
          original: { sourceSessionId: 'source', sourceMessage: { localId: 'report-original', seq: 2 } } }) },
    });
    expect(envelope?.workerUpdate).toMatchObject({ ownerState: 'published', headline: 'Published an update', result: 'Report 2',
      deliverables: [{ kind: 'workspace_file', sessionId: 'source', path: 'report-2.md' }],
      transcriptPointer: { kind: 'session', sessionId: 'source', seq: 2 } });
    expect(envelope?.observed).toMatchObject({ transcriptSeq: 2, turn: null });
    expect(envelope?.recentMessages.every(message => message.seq <= 2)).toBe(true);
  });
  it.each([
    { type: 'worker-report', summary: 17 },
    { type: 'worker-report', summary: 'Wrong source deliverable',
      deliverables: [{ kind: 'workspace_file', sessionId: 'another-source', path: 'foreign.md' }] },
  ])('keeps a malformed selected original report pending instead of scanning around it: %j', async (invalidReport) => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'token', encryption: null },
      deps: {
        resolveSourceTransport: (async () => ({ ok: true, sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain' },
          accountEncryptionCurrentness: { mode: 'plain' }, ctx: null, mode: 'plain' })) as never,
        fetchTranscriptPage: (async () => ({ messages: [
          { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent',
            content: { type: 'event', data: invalidReport } } } },
          { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'agent',
            content: { type: 'event', data: { type: 'worker-report', summary: 'Must stay pending' } } } } },
        ], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })) as never,
        projectSourceAwareness: () => awareness,
      },
    });
    const envelope = await hydrate({ signal: new AbortController().signal,
      observation: { kind: 'admitted_input', localInputId: 'accepted-report', effectiveDelivery: 'next_turn', sourceSessionId: 'source', destinationSessionId: 'destination',
        delivered: observation.delivered, observed: { ...observation.delivered, transcriptSeq: 2 },
        delivery: SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', event: { kind: 'update_posted' },
          original: { sourceSessionId: 'source', sourceMessage: { localId: 'report-original', seq: 2 } } }) },
    });
    expect(envelope).toMatchObject({ reason: 'source_unavailable', recentMessages: [] });
    expect(envelope?.workerUpdate).toBeUndefined();
  });



  it('hydrates a restricted Runner from the dedicated projection and omits a null author label', async () => {
    const sourceDataKey = new Uint8Array(32).fill(17);
    const encryptedContent = encryptSessionPayload({
      ctx: { encryptionKey: sourceDataKey, encryptionVariant: 'dataKey' },
      payload: { role: 'user', content: { type: 'text', text: 'dedicated projection' } },
    });
    // A real E2EE source carries metadata sealed with the same Session key the
    // preparer delivered. Without it the awareness projection reports the source
    // unreadable and the canonical envelope contract forbids summaries entirely,
    // so an empty fixture cannot exercise the hydrated-content path at all.
    const sourceMetadata = encryptSessionPayload({
      ctx: { encryptionKey: sourceDataKey, encryptionVariant: 'dataKey' },
      payload: { path: '/workspace/source', host: 'source-host' },
    });
    const fetchRunnerSourceProjection = vi.fn(async () => ({
      v: 1 as const,
      source: {
        id: 'source', encryptionMode: 'e2ee' as const, metadata: sourceMetadata, metadataLayoutVersion: 0,
        archivedAt: null, createdAt: 1, updatedAt: 2, active: true, activeAt: 2,
        thinking: false, thinkingAt: null, latestTurnStatus: null, latestTurnStatusObservedAt: null,
        latestReadyEventSeq: null, latestReadyEventAt: null, meaningfulActivityAt: null, agentStateVersion: 0,
      },
      messages: [{ seq: 2, localId: null, content: { t: 'encrypted' as const, c: encryptedContent }, createdAt: 2, accountActor: null }],
      hasMore: false,
    }));
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'runner-token', encryption: null },
      sourceMaterialResolver: {
        installPreparedDataKey: () => 'installed',
        resolveForHydration: () => ({ mode: 'e2ee', dataKey: sourceDataKey }),
      },
      deps: { fetchRunnerSourceProjection: fetchRunnerSourceProjection as never },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(fetchRunnerSourceProjection).toHaveBeenCalledWith(expect.objectContaining({
      destinationSessionId: 'destination', sourceSessionId: 'source', afterTranscriptSeq: 1, observedTranscriptSeq: 3,
    }));
    expect(envelope?.recentMessages).toEqual([{ messageId: 'seq:2', seq: 2, text: 'dedicated projection', provenance: null }]);
    // The reconciler renders every hydrated envelope through this exact schema
    // after removing its host-only ordering/budget evidence. An invalid wire
    // projection drops the optional Follow block before it reaches the provider.
    const {
      sourceRecencyMs: _sourceRecencyMs,
      transcriptConsumedThroughByRenderedMessageCount: _transcriptCheckpoints,
      ...wireEnvelope
    } = envelope!;
    expect(() => SessionFollowUpdateEnvelopeV1Schema.parse(wireEnvelope)).not.toThrow();
  });

  it('hydrates an awareness-only frontier without requiring a transcript page', async () => {
    const fetchTranscriptPage = vi.fn();
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        projectSourceAwareness: () => awareness as never,
      },
    });
    const observed = { transcriptSeq: 1, readyEventSeq: 2, agentStateVersion: 3, turn: null };

    const envelope = await hydrate({
      observation: { ...observation, observed } as never,
      signal: new AbortController().signal,
    });

    expect(fetchTranscriptPage).not.toHaveBeenCalled();
    expect(envelope).toMatchObject({ reason: 'source_changed', observed, recentMessages: [], truncated: false });
  });

  it('hydrates only the originally observed range through existing owners', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'token' } as never,
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain', updatedAt: 1234, activeAt: 2345 },
          accountEncryptionCurrentness: { mode: 'plain' },
          ctx: null,
          mode: 'plain',
        })) as never,
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'old' } } } },
            {
              seq: 2,
              createdAt: 2,
              accountActor: { v: 1, accountId: 'author', profile: { firstName: 'Ada', lastName: 'Lovelace', username: 'ada', avatarUrl: null } },
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'new' } } },
            },
            { seq: 99, createdAt: 3, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'newer-than-observed' } } } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });
    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });
    expect(envelope?.reason).toBe('source_changed');
    expect(envelope?.observed).toEqual({ ...observation.observed, transcriptSeq: 2 });
    expect(envelope?.sourceRecencyMs).toBe(2345);
    expect(envelope?.recentMessages.map((message) => message.seq)).toEqual([2]);
    expect(envelope?.recentMessages[0]?.authorLabel).toBe('Ada Lovelace');
  });

  it('withholds source transcript text and the work headline when the Account Voice disclosure policy does', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'token' } as never,
      // The one owner both Voice hosts ask. `shareRecentMessages` is off while
      // this Session is explicitly included in Voice, which is exactly the case
      // the foreground path already withholds transcript text for.
      disclosure: resolveAccountVoiceFollowDisclosure({
        voice: {
          privacy: { shareSessionSummary: false, shareRecentMessages: false },
          ui: { updates: { activeSession: 'snippets' } },
        },
      }),
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain', updatedAt: 1234, activeAt: 2345 },
          accountEncryptionCurrentness: { mode: 'plain' },
          ctx: null,
          mode: 'plain',
        })) as never,
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private transcript text' } } } },
            { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'more private text' } } } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => ({
          ...awareness,
          title: 'Source Session',
          currentWork: { title: 'refactoring the billing module' },
        }) as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(envelope?.recentMessages).toEqual([]);
    expect(JSON.stringify(envelope)).not.toContain('private transcript text');
    expect(JSON.stringify(envelope)).not.toContain('refactoring the billing module');
    // Source awareness is still disclosed: this is the activity-only projection,
    // not a withheld source.
    expect(envelope?.reason).toBe('source_changed');
    expect(envelope?.awareness.title).toBe('Source Session');
    // The exact frontier this read represents still settles, so Voice does not
    // replay an undisclosable observation forever.
    expect(envelope?.observed.transcriptSeq).toBe(3);
    expect(envelope?.transcriptConsumedThroughByRenderedMessageCount).toEqual([3]);
    const {
      sourceRecencyMs: _sourceRecencyMs,
      transcriptConsumedThroughByRenderedMessageCount: _checkpoints,
      ...wireEnvelope
    } = envelope!;
    expect(() => SessionFollowUpdateEnvelopeV1Schema.parse(wireEnvelope)).not.toThrow();
  });

  it('keeps source transcript text when the Account Voice disclosure policy permits snippets', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'token' } as never,
      // The row is the user's own message, so the Account must also opt user
      // messages into snippets, exactly as the foreground Voice path requires.
      disclosure: resolveAccountVoiceFollowDisclosure({
        voice: {
          privacy: { shareSessionSummary: true, shareRecentMessages: true },
          ui: { updates: { activeSession: 'snippets', includeUserMessagesInSnippets: true } },
        },
      }),
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain', updatedAt: 1234, activeAt: 2345 },
          accountEncryptionCurrentness: { mode: 'plain' },
          ctx: null,
          mode: 'plain',
        })) as never,
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'shared transcript text' } } } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => ({
          ...awareness,
          currentWork: { title: 'refactoring the billing module' },
        }) as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(envelope?.recentMessages.map((message) => message.text)).toEqual(['shared transcript text']);
    expect(envelope?.awareness.currentWork?.title).toBe('refactoring the billing module');
  });

  it('uses the canonical semantic summary for durable tool calls and results', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        fetchTranscriptPage: (async () => ({
          messages: [
            {
              seq: 2,
              createdAt: 2,
              content: { t: 'plain', v: {
                role: 'agent',
                content: { type: 'acp', agentId: 'opencode', data: {
                  type: 'tool-call', name: 'shell', callId: 'call-1', input: { command: 'git status' },
                } },
              } },
            },
            {
              seq: 3,
              createdAt: 3,
              content: { t: 'plain', v: {
                role: 'agent',
                content: { type: 'acp', agentId: 'opencode', data: {
                  type: 'tool-result', callId: 'call-1', output: [{ type: 'text', text: 'clean' }],
                } },
              } },
            },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(envelope?.recentMessages).toEqual([
      expect.objectContaining({ seq: 2, text: 'Tool use (shell): git status' }),
      expect.objectContaining({ seq: 3, text: 'Tool result: clean' }),
    ]);
    expect(envelope?.observed.transcriptSeq).toBe(3);
  });

  it('advances through valid non-renderable events and still renders a later human message', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        fetchTranscriptPage: (async () => ({
          messages: [
            {
              seq: 2,
              createdAt: 2,
              content: { t: 'plain', v: {
                role: 'agent',
                content: { type: 'acp', agentId: 'opencode', data: { type: 'unknown-valid-event' } },
              } },
            },
            {
              seq: 3,
              createdAt: 3,
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'human after event' } } },
            },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(envelope?.recentMessages).toEqual([
      expect.objectContaining({ seq: 3, text: 'human after event' }),
    ]);
    expect(envelope?.observed.transcriptSeq).toBe(3);
    expect(envelope?.transcriptConsumedThroughByRenderedMessageCount).toEqual([2, 3]);
  });

  it('carries a trailing valid non-renderable frontier independently from rendered messages', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'render me' } } } },
            { seq: 3, createdAt: 3, content: { t: 'plain', v: {
              role: 'agent', content: { type: 'acp', data: { type: 'unknown-valid-event' } },
            } } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(envelope?.recentMessages.map((message) => message.seq)).toEqual([2]);
    expect(envelope?.observed.transcriptSeq).toBe(3);
    expect(envelope?.transcriptConsumedThroughByRenderedMessageCount).toEqual([1, 3]);
  });

  it('does not require prepared key material for a Plain source', async () => {
    const resolveForHydration = vi.fn(() => ({ mode: 'unavailable' as const }));
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'scoped-runtime-token' } as never,
      sourceMaterialResolver: {
        installPreparedDataKey: () => 'installed',
        resolveForHydration,
      },
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain' },
          accountEncryptionCurrentness: { mode: 'plain' },
          ctx: null,
          mode: 'plain',
        })) as never,
        fetchTranscriptPage: (async () => ({
          messages: [{
            seq: 2,
            createdAt: 2,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'plain source' } } },
          }],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(envelope?.recentMessages).toEqual([expect.objectContaining({ seq: 2, text: 'plain source' })]);
    expect(resolveForHydration).not.toHaveBeenCalled();
  });

  it('rejects a Plain envelope in an E2EE source and does not scan past it', async () => {
    const sourceDataKey = new Uint8Array(32).fill(37);
    const laterEncryptedContent = encryptSessionPayload({
      ctx: { encryptionKey: sourceDataKey, encryptionVariant: 'dataKey' },
      payload: { role: 'user', content: { type: 'text', text: 'must remain pending' } },
    });
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'scoped-runtime-token', encryption: null },
      sourceMaterialResolver: {
        installPreparedDataKey: () => 'installed',
        resolveForHydration: () => ({ mode: 'e2ee', dataKey: sourceDataKey.slice() }),
      },
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'e2ee' },
          accountEncryptionCurrentness: { mode: 'e2ee' },
          ctx: null,
          mode: 'e2ee',
        })) as never,
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'wrong mode' } } } },
            { seq: 3, createdAt: 3, content: { t: 'encrypted', c: laterEncryptedContent } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => ({ ...awareness, encryption: 'e2ee', availability: 'complete' }) as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(envelope).toMatchObject({ reason: 'source_unavailable', recentMessages: [] });
  });

  it('rejects an encrypted envelope in a Plain source and does not scan past it', async () => {
    const encryptedContent = encryptSessionPayload({
      ctx: { encryptionKey: new Uint8Array(32).fill(51), encryptionVariant: 'dataKey' },
      payload: { role: 'user', content: { type: 'text', text: 'wrong mode' } },
    });
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 2, createdAt: 2, content: { t: 'encrypted', c: encryptedContent } },
            { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'must remain pending' } } } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(envelope).toMatchObject({ reason: 'source_unavailable', recentMessages: [] });
  });

  it('stops at the first corrupt row and exposes only the valid contiguous prefix', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'contiguous prefix' } } } },
            { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'invalid', content: { type: 'text', text: 'corrupt' } } } },
            { seq: 4, createdAt: 4, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'must remain pending' } } } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });

    const envelope = await hydrate({
      observation: {
        ...observation,
        observed: { ...observation.observed, transcriptSeq: 4 },
      } as never,
      signal: new AbortController().signal,
    });

    expect(envelope).toMatchObject({
      reason: 'source_changed',
      observed: { transcriptSeq: 2 },
      recentMessages: [{ seq: 2, text: 'contiguous prefix' }],
      truncated: true,
    });
  });

  it('retries from the admitted prefix after content repair without duplicating it', async () => {
    let afterSeq = 1;
    let repaired = false;
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        fetchTranscriptPage: (async (input: Readonly<{ afterSeq?: number }>) => {
          afterSeq = input.afterSeq ?? 0;
          return {
            messages: afterSeq === 1
              ? [
                  { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'first' } } } },
                  { seq: 3, createdAt: 3, content: { t: 'plain', v: repaired
                    ? { role: 'user', content: { type: 'text', text: 'repaired' } }
                    : { role: 'invalid', content: { type: 'text', text: 'corrupt' } } } },
                  { seq: 4, createdAt: 4, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'later' } } } },
                ]
              : [
                  { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'repaired' } } } },
                  { seq: 4, createdAt: 4, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'later' } } } },
                ],
            hasMore: false,
            nextBeforeSeq: null,
            nextAfterSeq: null,
          };
        }) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });

    const retryObservation = {
      ...observation,
      observed: { ...observation.observed, transcriptSeq: 4 },
    };
    const first = await hydrate({ observation: retryObservation as never, signal: new AbortController().signal });
    expect(first?.recentMessages.map((message) => message.seq)).toEqual([2]);
    expect(first?.observed.transcriptSeq).toBe(2);

    repaired = true;
    const second = await hydrate({
      observation: {
        ...retryObservation,
        delivered: { ...retryObservation.delivered, transcriptSeq: 2 },
      } as never,
      signal: new AbortController().signal,
    });
    expect(afterSeq).toBe(2);
    expect(second?.recentMessages.map((message) => message.seq)).toEqual([3, 4]);
    expect(second?.observed.transcriptSeq).toBe(4);
  });

  it('rejects a wrong destination instead of trusting caller identity', async () => {
    const resolveSourceTransport = vi.fn();
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'token' } as never,
      deps: { resolveSourceTransport: resolveSourceTransport as never },
    });
    const envelope = await hydrate({
      observation: { ...observation, destinationSessionId: 'other' } as never,
      signal: new AbortController().signal,
    });
    expect(envelope).toBeNull();
    expect(resolveSourceTransport).not.toHaveBeenCalled();
  });

  it('fails closed before source fetch when the destination Home rejects the credentials', async () => {
    const resolveSourceTransport = vi.fn();
    const hydrate = createSessionFollowSourceHydrator({
      session: {
        sessionId: 'destination',
        runSessionFollowSourceRequest: () => { throw new Error('wrong Home'); },
      },
      credentials: { token: 'wrong-home-token' } as never,
      deps: { resolveSourceTransport: resolveSourceTransport as never },
    });

    await expect(hydrate({
      observation: observation as never,
      signal: new AbortController().signal,
    })).resolves.toBeNull();
    expect(resolveSourceTransport).not.toHaveBeenCalled();
  });

  it('returns visible source_unavailable when decryption cannot open', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        fetchTranscriptPage: (async () => { throw new Error('unavailable'); }) as never,
        projectSourceAwareness: () => ({ ...awareness, encryption: 'locked', availability: 'locked', title: undefined }) as never,
      },
    });
    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });
    expect(envelope?.reason).toBe('source_unavailable');
    expect(envelope?.recentMessages).toEqual([]);
    expect(envelope?.observed).toEqual(observation.observed);
  });

  it('omits readable transcript content while its own awareness projection reports the source unreadable', async () => {
    // AWI-06: everything derived from private content is gated on one readability
    // answer. A source whose metadata cannot be opened projects `locked`/`unknown`
    // awareness even when the prepared Session key still opens transcript rows.
    // Emitting summaries beside that projection builds an envelope the canonical
    // validator rejects, and the reconciler renders every candidate through that
    // validator — so one such source silently discards the whole turn's Follow
    // context instead of staying visibly retryable.
    const sourceDataKey = new Uint8Array(32).fill(53);
    const encryptedContent = encryptSessionPayload({
      ctx: { encryptionKey: sourceDataKey, encryptionVariant: 'dataKey' },
      payload: { role: 'user', content: { type: 'text', text: 'readable row, unreadable metadata' } },
    });
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'runner-token', encryption: null },
      sourceMaterialResolver: {
        installPreparedDataKey: () => 'installed',
        resolveForHydration: () => ({ mode: 'e2ee', dataKey: sourceDataKey }),
      },
      deps: {
        fetchRunnerSourceProjection: (async () => ({
          v: 1 as const,
          source: {
            id: 'source', encryptionMode: 'e2ee' as const, metadata: '', metadataLayoutVersion: 0,
            archivedAt: null, createdAt: 1, updatedAt: 2, active: true, activeAt: 2,
            thinking: false, thinkingAt: null, latestTurnStatus: null, latestTurnStatusObservedAt: null,
            latestReadyEventSeq: null, latestReadyEventAt: null, meaningfulActivityAt: null, agentStateVersion: 0,
          },
          messages: [{ seq: 2, localId: null, content: { t: 'encrypted' as const, c: encryptedContent }, createdAt: 2, accountActor: null }],
          hasMore: false,
        })) as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(envelope?.reason).toBe('source_unavailable');
    expect(envelope?.recentMessages).toEqual([]);
    expect(isSessionAwarenessContentReadableV1(envelope!.awareness.encryption)).toBe(false);
    const { sourceRecencyMs: _sourceRecencyMs, ...wireEnvelope } = envelope!;
    expect(() => SessionFollowUpdateEnvelopeV1Schema.parse(wireEnvelope)).not.toThrow();
  });

  it('hydrates an E2EE source from explicitly supplied standalone material without Account key fallback', async () => {
    const sourceDataKey = new Uint8Array(32).fill(41);
    const encryptedContent = encryptSessionPayload({
      ctx: { encryptionKey: sourceDataKey, encryptionVariant: 'dataKey' },
      payload: { role: 'user', content: { type: 'text', text: 'prepared source context' } },
    });
    const encryptedMetadata = encryptSessionPayload({
      ctx: { encryptionKey: sourceDataKey, encryptionVariant: 'dataKey' },
      payload: { path: '/workspace/source', host: 'source-host' },
    });
    const resolveForHydration = vi.fn(() => ({ mode: 'e2ee' as const, dataKey: sourceDataKey }));
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      // The scoped runtime has no Account opening material. Only the explicitly
      // prepared standalone source key may open this row.
      credentials: { token: 'scoped-runtime-token', encryption: null },
      sourceMaterialResolver: {
        installPreparedDataKey: () => 'installed',
        resolveForHydration,
      },
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'e2ee', metadata: encryptedMetadata, metadataLayoutVersion: 0 },
          accountEncryptionCurrentness: { mode: 'e2ee' },
          ctx: null,
          mode: 'e2ee',
        })) as never,
        fetchTranscriptPage: (async () => ({
          messages: [{
            seq: 2,
            createdAt: 2,
            content: { t: 'encrypted', c: encryptedContent },
          }],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        // `ready` is the canonical projection for E2EE content this caller
        // actually opened. `e2ee` is not a member of the awareness encryption
        // union, so it read as unreadable and could never carry summaries.
        projectSourceAwareness: () => ({
          ...awareness,
          encryption: 'ready',
          availability: 'complete',
        }) as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(resolveForHydration).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'source' }));
    expect(envelope).toMatchObject({
      reason: 'source_changed',
      edge: { sourceSessionId: 'source', destinationSessionId: 'destination' },
      recentMessages: [{ seq: 2, text: 'prepared source context' }],
    });
    expect(sourceDataKey).toEqual(new Uint8Array(32));
  });

  it('zeroes a temporary prepared key copy when hydration exits before transcript decryption', async () => {
    const temporaryKey = new Uint8Array(32).fill(23);
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'scoped-runtime-token', encryption: null },
      sourceMaterialResolver: {
        installPreparedDataKey: () => 'installed',
        resolveForHydration: () => ({ mode: 'e2ee', dataKey: temporaryKey }),
      },
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'e2ee' },
          accountEncryptionCurrentness: { mode: 'e2ee' },
          ctx: null,
          mode: 'e2ee',
        })) as never,
        projectSourceAwareness: () => ({ ...awareness, sessionId: 'wrong-source' }) as never,
      },
    });

    await expect(hydrate({ observation: observation as never, signal: new AbortController().signal })).resolves.toBeNull();
    expect(temporaryKey).toEqual(new Uint8Array(32));
  });

  it('zeroes the temporary prepared-key copy after hydration', async () => {
    const retainedKey = new Uint8Array(32).fill(41);
    const hydrationCopy = retainedKey.slice();
    const encryptedContent = encryptSessionPayload({
      ctx: { encryptionKey: retainedKey, encryptionVariant: 'dataKey' },
      payload: { role: 'user', content: { type: 'text', text: 'prepared source context' } },
    });
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
      credentials: { token: 'scoped-runtime-token', encryption: null },
      sourceMaterialResolver: {
        installPreparedDataKey: () => 'installed',
        resolveForHydration: () => ({ mode: 'e2ee', dataKey: hydrationCopy }),
      },
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true, sessionId: 'source', rawSession: { id: 'source', encryptionMode: 'e2ee' },
          accountEncryptionCurrentness: { mode: 'e2ee' }, ctx: null, mode: 'e2ee',
        })) as never,
        fetchTranscriptPage: (async () => ({
          messages: [{ seq: 2, createdAt: 2, content: { t: 'encrypted', c: encryptedContent } }],
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => ({ ...awareness, encryption: 'e2ee', availability: 'complete' }) as never,
      },
    });

    await hydrate({ observation: observation as never, signal: new AbortController().signal });

    expect(hydrationCopy).toEqual(new Uint8Array(32));
    expect(retainedKey).toEqual(new Uint8Array(32).fill(41));
  });

  it('marks a bounded page truncated while consuming its trailing valid non-renderable row', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'kept' } } } },
            { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'user', content: { type: 'image', url: 'opaque' } } } },
          ],
          hasMore: true,
          nextBeforeSeq: null,
          nextAfterSeq: 3,
        })) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });
    expect(envelope?.recentMessages.map((message) => message.seq)).toEqual([2]);
    expect(envelope?.observed.transcriptSeq).toBe(3);
    expect(envelope?.transcriptConsumedThroughByRenderedMessageCount).toEqual([1, 3]);
    expect(envelope?.truncated).toBe(true);
  });

  it('hydrates the oldest bounded pending prefix and exposes its exact consumed frontier', async () => {
    const fetchTranscriptPage = vi.fn().mockResolvedValue({
      messages: Array.from({ length: 20 }, (_, index) => {
        const seq = index + 2;
        return {
          seq,
          createdAt: seq,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `message-${seq}` } } },
        };
      }),
      hasMore: true,
      nextBeforeSeq: null,
      nextAfterSeq: 21,
    });
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        projectSourceAwareness: () => awareness as never,
      },
    });

    const envelope = await hydrate({
      observation: {
        ...observation,
        observed: { transcriptSeq: 30, readyEventSeq: 4, agentStateVersion: 5, turn: null },
      } as never,
      signal: new AbortController().signal,
    });
    expect(fetchTranscriptPage).toHaveBeenCalledTimes(1);
    expect(fetchTranscriptPage).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 1, limit: 500 }));
    expect(fetchTranscriptPage).toHaveBeenCalledWith(expect.not.objectContaining({ beforeSeq: expect.anything() }));
    expect(envelope?.recentMessages.map((message) => message.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
    expect(envelope?.observed).toEqual({
      transcriptSeq: 21,
      readyEventSeq: 4,
      agentStateVersion: 5,
      turn: null,
    });
    expect(envelope?.truncated).toBe(true);
  });

  it('does not represent a missing observed transcript range as complete', async () => {
    const hydrate = createSessionFollowSourceHydrator({
      session: destinationSession,
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
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 99, createdAt: 3, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'newer' } } } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => awareness as never,
      },
    });

    const envelope = await hydrate({ observation: observation as never, signal: new AbortController().signal });
    expect(envelope?.reason).toBe('source_unavailable');
  });
});

describe('Account Voice Follow disclosure, through the real reconciler and hydrator', () => {
  const voiceDelivered: SessionFollowFrontierV1 = { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null };
  const voiceObserved: SessionFollowFrontierV1 = { transcriptSeq: 5, readyEventSeq: 0, agentStateVersion: 0, turn: null };

  function createAccountVoiceFixture(accountSettings: unknown) {
    const acknowledgeAccountVoiceFollow = vi.fn(async () => ({ ok: true as const }));
    const session = {
      sessionId: 'destination',
      runSessionFollowSourceRequest: <T>(input: Readonly<{ request: () => T }>): T => input.request(),
      observePendingAccountVoiceFollow: vi.fn(async () => ({
        ok: true as const,
        v: 1 as const,
        voiceSessionId: 'destination',
        publisherGeneration: '3',
        executionRunOccurrenceId: 'voice-occurrence',
        observations: [{ sourceSessionId: 'source', voiceSessionId: 'destination', expected: voiceDelivered, observed: voiceObserved }],
      })),
      acknowledgeAccountVoiceFollow,
    } as unknown as ApiSessionClient;
    const resolveSourceTransport = vi.fn(async () => ({
      ok: true,
      sessionId: 'source',
      rawSession: { id: 'source', encryptionMode: 'plain' },
      accountEncryptionCurrentness: { mode: 'plain' },
      ctx: null,
      mode: 'plain',
    }));
    const fetchTranscriptPage = vi.fn(async () => ({
      messages: [
        { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'human private words' },
          meta: { happierProvenanceV1: { v: 1, kind: 'happierApp', actor: { kind: 'owner' } } } } } },
        { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'assistant one' } } } },
        { seq: 4, createdAt: 4, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'assistant two' } } } },
        { seq: 5, createdAt: 5, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'assistant three' } } } },
      ],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
    }));
    const hydrateObservation = createSessionFollowSourceHydrator({
      session,
      credentials: { token: 'token' } as never,
      disclosure: resolveAccountVoiceFollowDisclosure(accountSettings),
      deps: {
        resolveSourceTransport: resolveSourceTransport as never,
        fetchTranscriptPage: fetchTranscriptPage as never,
        projectSourceAwareness: () => awareness as never,
      },
    });
    const reconcile = createSessionFollowContextReconciler({
      session,
      observer: { kind: 'account_voice', accountId: 'account', voiceSessionId: 'destination' },
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation,
    });
    return {
      acknowledgeAccountVoiceFollow,
      resolveSourceTransport,
      fetchTranscriptPage,
      prepare: async () => await reconcile({ signal: new AbortController().signal, executionRunId: 'voice-run' }),
    };
  }

  it('withholds the user\'s own messages by default, keeps only the Account\'s newest represented messages, and settles the withheld rows on acceptance', async () => {
    const fixture = createAccountVoiceFixture({
      voice: {
        privacy: { shareSessionSummary: true, shareRecentMessages: true },
        ui: { updates: { activeSession: 'snippets', snippetsMaxMessages: 2 } },
      },
    });

    const prepared = await fixture.prepare();

    expect(prepared?.updates[0]?.recentMessages.map((message) => message.text)).toEqual(['assistant two', 'assistant three']);
    expect(JSON.stringify(prepared?.updates)).not.toContain('human private words');
    expect(JSON.stringify(prepared?.updates)).not.toContain('assistant one');
    prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'voice-input', userMessageSeq: null });
    await vi.waitFor(() => expect(fixture.acknowledgeAccountVoiceFollow).toHaveBeenCalledOnce());
    // Policy-withheld rows are a deliberate disclosure decision, not deferred work:
    // the represented frontier settles instead of replaying them every Voice turn.
    expect(fixture.acknowledgeAccountVoiceFollow).toHaveBeenCalledWith(expect.objectContaining({
      expected: voiceDelivered,
      observed: voiceObserved,
      consumed: voiceObserved,
    }));
  });

  it('quotes the user\'s own messages when the Account explicitly shares them in snippets', async () => {
    const fixture = createAccountVoiceFixture({
      voice: {
        privacy: { shareSessionSummary: true, shareRecentMessages: true },
        ui: { updates: { activeSession: 'snippets', includeUserMessagesInSnippets: true, snippetsMaxMessages: 10 } },
      },
    });

    const prepared = await fixture.prepare();

    expect(prepared?.updates[0]?.recentMessages.map((message) => message.text)).toEqual([
      'human private words',
      'assistant one',
      'assistant two',
      'assistant three',
    ]);
  });

  it('produces no source update at all when the Account Voice update level is none', async () => {
    const fixture = createAccountVoiceFixture({
      voice: {
        privacy: { shareSessionSummary: true, shareRecentMessages: true },
        ui: { updates: { activeSession: 'none' } },
      },
    });

    const prepared = await fixture.prepare();

    expect(prepared).toBeNull();
    expect(fixture.resolveSourceTransport).not.toHaveBeenCalled();
    expect(fixture.fetchTranscriptPage).not.toHaveBeenCalled();
    expect(fixture.acknowledgeAccountVoiceFollow).not.toHaveBeenCalled();
  });
});
