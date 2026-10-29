import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1, SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowFinalResultStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1, WorkflowRunSummaryV1Schema,
  createAccountScopedCryptoMaterialSnapshotV1, prepareWorkflowRunDataKeyV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  TranscriptRawAgentEventV1Schema, TranscriptRawRecordV1Schema, WorkerUpdateV1Schema,
  type SessionUpdatePostInputV1,
  type SessionRuntimeIssueV1,
  type SessionFollowSessionPendingObservationV1, type WorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionScopedSocket } from '@/api/session/sockets';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1, SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V2,
  SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, SessionTranscriptObservationInputSchema,
  SessionTranscriptObservationAckV1Schema, SessionTranscriptObservationCapabilityAckSchema } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { createPlainSessionFixture, createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { findTranscriptMessagesQueryRejection } from '@/testkit/transcript/transcriptMessagesRouteContract';
import { createSessionFollowContextReconciler } from './sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';
import { createSessionFollowSourceMaterialResolver } from './sessionFollowSourceMaterialResolver';
import type { RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import type { StoredCredentials } from '@/persistence';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { isSessionFollowFrontierEqualV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { SessionFollowAcknowledgeRequestV1Schema, SessionFollowObservePendingRequestV1Schema,
  type SessionFollowObservePendingRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { classifyWorkerUpdateEventV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
// Socket.IO and HTTP are network boundaries; all internal owners remain real.
vi.mock('socket.io-client', () => ({ io: mockIo }));
const workerId = 'cworker0000000000000000000';
const origin = 'http://worker-producer.test';
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 }))); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); });

async function fixture(status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting', pendingReviewRuns = 0, restricted = false,
  review?: Readonly<{ outcome: 'exhausted' | 'stop_condition'; sourceTurnId?: string; readable?: boolean; ref?: string; olderExhausted?: boolean; listReadable?: boolean; keyState?: 'available' | 'missing' }>,
  runtimeIssueV1?: SessionRuntimeIssueV1, overlap = false) {
  const secret = randomBytes(32);
  const credentials: StoredCredentials = { token: 'lead-own-grant',
    encryption: review?.keyState ? { type: 'legacy', secret } : null };
  const ctx = { encryptionKey: secret, encryptionVariant: 'legacy' as const };
  const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
  const witness = { mode: 'e2ee' as const, version: 1,
    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) };
  const preparedRunKey = prepareWorkflowRunDataKeyV1({ accountId: 'worker-account', randomBytes,
    encryption: review?.keyState ? { kind: 'available', material, witness }
      : { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } } });
  const runKeyEnvelope = preparedRunKey.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
  const runAccess = { readable: review?.readable !== false };
  const observation: SessionFollowSessionPendingObservationV1 = {
    sourceSessionId: workerId, destinationSessionId: 'lead', relation: 'manager', attachedAt: 100, policy: { preset: 'everything' as const },
    delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
    observed: { transcriptSeq: 1, readyEventSeq: 1, agentStateVersion: 0,
      turn: status === 'running' ? null : { id: 'worker-turn', status } },
  };
  const observations: SessionFollowSessionPendingObservationV1[] = [observation, ...(overlap ? [{
    sourceSessionId: workerId, destinationSessionId: 'lead', relation: 'follower' as const, policy: { preset: 'quiet' as const },
    delivered: { ...observation.delivered }, observed: observation.observed,
  }] : [])];
  const metadata = { path: '/worker', host: 'host' };
  const row = createSessionRecordFixture({ id: workerId, seq: 1, encryptionMode: review?.keyState ? 'e2ee' : 'plain',
    metadata: review?.keyState ? encryptSessionPayload({ ctx, payload: metadata }) : JSON.stringify(metadata), active: true,
    activeAt: Date.now(), updatedAt: Date.now(), latestTurnStatus: status === 'running' ? 'in_progress' : status,
    latestTurnStatusObservedAt: Date.now(), latestReadyEventSeq: 1,
    latestTurnId: 'worker-turn', ...(runtimeIssueV1 ? { lastRuntimeIssue: runtimeIssueV1 } : {}),
    manager: { sessionId: 'lead' }, pendingReviewRuns, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 });
  const app = fastify();
  const features = FeaturesResponseSchema.parse({ features: {
    sessions: { enabled: true, autonomousExchange: { enabled: true } },
  }, capabilities: { session: {
    runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 4 }, publisherAuthority: { protocolVersion: 1 },
  } } });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return url.pathname === '/v1/features' ? Response.json(features) : new Response('{}', { status: 404 });
  }));
  app.get('/v1/auth/ping', async () => ({ ok: true }));
  const finalText = { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Actual final result' } } };
  const messages: (RawTranscriptRow & { seq: number })[] = [{ seq: 1, localId: null, createdAt: 1,
    content: review?.keyState ? { t: 'encrypted', c: encryptSessionPayload({ ctx, payload: finalText }) } : { t: 'plain', v: finalText } }];
  app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture(
    review?.keyState ? witness : { mode: 'plain' }));
  const reviewRun = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, visibleTeamId: null,
    attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
    id: 'review-run', ownerAccountId: 'worker-account', machineId: 'worker-machine',
    origin: { kind: 'automation', automationId: 'review-trigger', originSessionId: workerId,
      cause: { kind: 'trigger', triggerId: 'review-trigger', triggerRevision: 0, triggerKind: 'sessionLifecycle',
        occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', occurredAt: Date.parse('2026-10-01T00:00:00.000Z'),
        evidence: { event: 'parentTurnCompleted', sourceSessionId: workerId,
          sourceTurnId: review?.sourceTurnId ?? 'worker-turn', policy: { kind: 'everyMatch' } } } },
    state: 'succeeded', revision: 5, workflowCustodyState: 'settled', originDeliveryAckRevision: 0,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false,
      inspectExecution: true, disabledReasons: [] },
  });
  if (reviewRun.origin.kind !== 'automation') throw new Error('Expected automation review fixture');
  const reviewOrigin = reviewRun.origin;
  if (reviewOrigin.cause?.kind !== 'trigger' || reviewOrigin.cause.triggerKind !== 'sessionLifecycle') throw new Error('Expected lifecycle review fixture');
  const reviewCause = reviewOrigin.cause;
  const olderReviewRun = { ...reviewRun, id: 'older-review-run', origin: { ...reviewOrigin, cause: {
    ...reviewCause, occurredAt: Date.parse('2026-09-30T00:00:00.000Z'),
    evidence: { ...reviewCause.evidence, sourceTurnId: 'older-turn' },
  } } };
  const definition: WorkflowAcceptedSnapshotV1['definition'] = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ] };
  const acceptedSnapshot = { definition, startedBy: 'trigger', authoredDefinition: definition,
      materializedLeaves: [], frozenChildren: {}, metadata: null,
      source: { kind: 'catalog', ref: review?.ref ?? 'builtin:review-and-converge', version: 1 },
      inputs: {}, machineId: 'worker-machine', executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId: 'worker-machine', directory: '/worker', checkoutRootPath: '/worker' } },
      origin: { kind: 'direct', originSessionId: workerId },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, workDepth: 0 } satisfies WorkflowAcceptedSnapshotV1;
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    ...(preparedRunKey.runCrypto.mode === 'e2ee' ? { ...preparedRunKey.runCrypto, randomBytes } : preparedRunKey.runCrypto),
    binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'worker-account', runId: reviewRun.id },
    acceptedSnapshot,
  }));
  const resultEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
    ...(preparedRunKey.runCrypto.mode === 'e2ee' ? { ...preparedRunKey.runCrypto, randomBytes } : preparedRunKey.runCrypto),
    binding: { v: 1, purpose: 'final_result', accountId: 'worker-account', runId: reviewRun.id },
    finalResult: { kind: 'happier.workflow-final-result.v1', producerInvocation: { recordId: 'rounds' },
      result: { kind: 'json', value: review?.outcome === 'exhausted' ? { kind: 'exhausted', rounds: 3 } : { kind: 'stop_condition' } } },
  }));
  app.post('/v3/automations/runs/workflow-storage', async (request, reply) => {
    expect(request.headers.authorization).toBe('Bearer lead-own-grant');
    const body = request.body as Record<string, unknown>;
    if (body.operation === 'list') {
      expect(body.request).toMatchObject({ originSessionId: workerId });
      if (review?.listReadable === false) return reply.code(403).send({ error: 'run_access_denied' });
      return { runs: review ? [...(review.olderExhausted ? [olderReviewRun] : []), reviewRun] : [] };
    }
    if (body.operation === 'get' && review) {
      expect(['review-run', 'older-review-run']).toContain(body.runId);
      if (!runAccess.readable) return reply.code(403).send({ error: 'run_access_denied' });
      if (body.runId === 'older-review-run') {
        const oldRun = olderReviewRun;
        const oldBinding = { v: 1 as const, accountId: 'worker-account', runId: oldRun.id };
        return { run: oldRun,
          acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { ...oldBinding, purpose: 'accepted_snapshot' }, acceptedSnapshot })),
          resultEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
            mode: 'plain', binding: { ...oldBinding, purpose: 'final_result' },
            finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'json', value: { kind: 'exhausted', rounds: 3 } },
              producerInvocation: { recordId: 'rounds' } } })),
          keyCensus: { runId: oldRun.id, ownerAccountId: 'worker-account', access: 'view', encryptionMode: 'plain',
            visibleTeamId: null, ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
            dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] } };
      }
      return { run: reviewRun, acceptedEnvelope, resultEnvelope,
        keyCensus: { runId: reviewRun.id, ownerAccountId: 'worker-account', access: 'view', encryptionMode: preparedRunKey.runCrypto.mode,
          visibleTeamId: null, ownerAccountCurrentness: review.keyState ? witness : { mode: 'plain', version: 1, contentKeyFingerprint: null },
          dataEncryptionKey: runKeyEnvelope, callerDataEncryptionKey: review.keyState === 'missing' ? null : runKeyEnvelope, recipients: [] } };
    }
    throw new Error('unexpected workflow mutation or read');
  });
  app.get('/v2/sessions/:id', async (request) => {
    expect(request.headers.authorization).toBe('Bearer lead-own-grant');
    return { session: row };
  });
  app.get('/v1/sessions/:id/messages', async (request, reply) => {
    const query = new URL(request.url, origin).searchParams;
    const rejected = findTranscriptMessagesQueryRejection(query);
    if (rejected) return reply.code(400).send({ error: rejected });
    const limit = Number(query.get('limit'));
    const after = query.get('afterSeq');
    const before = query.get('beforeSeq');
    const selected = after !== null ? messages.filter(message => message.seq > Number(after))
      : messages.filter(message => before === null || message.seq < Number(before)).reverse();
    const page = selected.slice(0, limit).map((message) => ({
      ...message, id: `worker-message-${message.seq}`,
    }));
    const hasMore = selected.length > limit;
    return SessionMessagesPageV1Schema.parse({ messages: page, hasMore,
      nextAfterSeq: after !== null && hasMore ? page.at(-1)?.seq : null,
      nextBeforeSeq: after === null && hasMore ? page.at(-1)?.seq : null });
  });
  app.post('/v2/sessions/:id/follows/source-projection', async (request) => {
    expect(request.body).toMatchObject({ sourceSessionId: workerId, relation: 'manager', attachedAt: 100,
      readMode: 'incremental', observedTranscriptSeq: observation.observed.transcriptSeq });
    const body = request.body as { afterTranscriptSeq: number; limit: number };
    const selected = messages.filter(message => message.seq > body.afterTranscriptSeq);
    return { v: 1, source: { id: row.id, encryptionMode: 'plain', metadata: row.metadata, metadataLayoutVersion: 0,
      archivedAt: null, createdAt: row.createdAt, updatedAt: row.updatedAt, active: row.active, activeAt: row.activeAt,
      thinking: false, thinkingAt: null, latestTurnStatus: row.latestTurnStatus,
      latestTurnId: row.latestTurnId, lastRuntimeIssue: row.lastRuntimeIssue,
      latestTurnStatusObservedAt: row.latestTurnStatusObservedAt, latestReadyEventSeq: row.latestReadyEventSeq,
      latestReadyEventAt: null, meaningfulActivityAt: null, agentStateVersion: row.agentStateVersion, pendingReviewRuns: row.pendingReviewRuns },
      messages: selected.slice(0, body.limit), hasMore: selected.length > body.limit };
  });
  const restore = installAxiosFastifyAdapter({ app, origin });
  const acknowledgements: unknown[] = [];
  const followObserveRequests: SessionFollowObservePendingRequestV1[] = [];
  const leadMessages: (RawTranscriptRow & { seq: number })[] = [];
  const acknowledgementState: { accepted: boolean; failBeforeCommit: boolean; publisherGeneration: string;
    beforeAcknowledge?: (relation: 'manager' | 'follower') => Promise<void> } = {
      accepted: true, failBeforeCommit: false, publisherGeneration: '1',
    };
  const runtimeActivityHome = createSessionRuntimeActivityHomeStub({ machineId: 'worker-machine' });
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    const activity = runtimeActivityHome.answer(event, payload);
    if (activity !== null) return activity;
    if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
      return SessionTranscriptObservationCapabilityAckSchema.parse({ ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V2 });
    }
    if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
      const request = SessionTranscriptObservationInputSchema.parse(payload);
      expect([workerId, 'lead']).toContain(request.sessionId);
      const content = SessionStoredMessageContentSchema.parse(request.content);
      if (content.t !== 'plain') throw new Error('Expected plain producer fixture');
      const target = request.sessionId === workerId ? messages : leadMessages;
      const seq = request.sessionId === workerId ? observation.observed.transcriptSeq + 1 : target.length + 1;
      target.push({ seq, createdAt: seq, localId: request.localId, messageRole: request.messageRole, content });
      if (request.sessionId === workerId) {
        observation.observed = { ...observation.observed, transcriptSeq: seq };
        for (const route of observations) route.observed = observation.observed;
        row.seq = seq;
      }
      return SessionTranscriptObservationAckV1Schema.parse({ ok: true, status: 'observed', id: `message-${seq}`,
        seq, localId: request.localId, didWrite: true, ingestedAt: Date.now() });
    }
    if (event === SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1) {
      const request = SessionFollowObservePendingRequestV1Schema.parse(payload);
      followObserveRequests.push(request);
      return { ok: true, v: 1, sessionId: 'lead',
        publisherGeneration: acknowledgementState.publisherGeneration, currentSourceSessionIds: [workerId],
        observations: observations.filter(entry => !isSessionFollowFrontierEqualV1(entry.delivered, entry.observed))
          .map(entry => ({ ...entry })),
        ...(request.wakeAdmission ? { wakeAdmission: { status: 'allowed', originatingDiscussion: null } } : {}) };
    }
    if (event === SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1) {
      const request = SessionFollowAcknowledgeRequestV1Schema.parse(payload);
      if (!('relation' in request)) throw new Error('Expected a Session relation acknowledgement');
      acknowledgements.push(request);
      const apply = () => {
        if (acknowledgementState.failBeforeCommit) throw new Error('ACK failed before progress commit');
        if (!acknowledgementState.accepted) return { ok: false, error: 'stale_observation' };
        const route = observations.find(entry => entry.relation === request.relation);
        if (!route) throw new Error('ACK names an unobserved route');
        route.delivered = request.consumed;
        return {  ok: true, v: 1, destinationSessionId: 'lead', sourceSessionId: workerId, delivered: request.consumed };
      };
      return acknowledgementState.beforeAcknowledge?.(request.relation).then(apply) ?? apply();
    }
    return { ok: true };
  } });
  mockIo.mockImplementation((url, options) => {
    if (options?.auth?.clientType !== 'user-scoped') return socket;
    expect(url).toBe(origin);
    return createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
        || !('method' in payload) || !('params' in payload)) throw new Error('Unexpected publication RPC');
      expect(payload.method).toBe(`${workerId}:session.update.post`);
      return { ok: true, result: await getWorkerSession().rpcHandlerManager.invokeLocal('session.update.post', payload.params, {
        localActionContext: { surface: 'cli', authority: 'present_user' },
      }) };
    } });
  });
  const leadSession = createPlainSessionFixture({ id: 'lead' });
  const session = new ApiSessionClient('lead-own-grant', review?.keyState
    ? { ...leadSession, encryptionMode: 'e2ee', encryptionKey: secret, encryptionVariant: 'legacy' }
    : leadSession, {
    metadataAuthority: { kind: 'shared_editor' },
    localMachineId: 'worker-machine',
    transport: { serverId: 'worker-home', serverUrl: origin,
      createSessionSocketTransport: ({ sessionId, machineId }) => {
        const liveSocket = createSessionScopedSocket({ token: 'lead-own-grant', sessionId, machineId, serverUrl: origin });
        return { socket: liveSocket, transport: createSocketTransportAdapter(liveSocket) };
      } },
  });
  cleanups.push(async () => { await session.close(); restore(); await app.close(); });
  const sourceMaterialResolver = restricted ? createSessionFollowSourceMaterialResolver() : null;
  if (sourceMaterialResolver) cleanups.push(async () => { sourceMaterialResolver.dispose(); });
  const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials, sourceMaterialResolver });
  let workerSession: ApiSessionClient | undefined;
  const getWorkerSession = () => {
    if (!workerSession) {
      workerSession = new ApiSessionClient(credentials.token, createPlainSessionFixture({ id: workerId }), {
        metadataAuthority: { kind: 'shared_editor' },
        localMachineId: 'worker-machine',
        transport: { serverId: 'worker-home', serverUrl: origin,
          createSessionSocketTransport: ({ sessionId, machineId }) => {
            const liveSocket = createSessionScopedSocket({ token: credentials.token, sessionId, machineId, serverUrl: origin });
            return { socket: liveSocket, transport: createSocketTransportAdapter(liveSocket) };
          } },
      });
      cleanups.push(() => workerSession!.close());
    }
    return workerSession;
  };
  const publisher = createCliActionDeps({ token: credentials.token, credentials, sessionId: workerId,
    mode: 'plain', ctx: null, serverId: 'worker-home', serverHttpBaseUrl: origin,
    postSessionUpdate: (report) => getWorkerSession().enqueueSessionEventCommitted({ type: 'worker-report', ...report }),
  });
  const publicationExecutor = createActionExecutor(publisher);
  const makeReconciler = () => createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 });
  return { observation, observations, acknowledgements, acknowledgementState, row, messages, leadMessages, session, runAccess, makeReconciler,
    commitEvent: (event: Parameters<ApiSessionClient['enqueueSessionEventCommitted']>[0]) => getWorkerSession().enqueueSessionEventCommitted(event),
    postViaRpc: (report: unknown, callerSessionId?: string) => getWorkerSession().rpcHandlerManager.invokeLocal('session.update.post', report, {
      localActionContext: { surface: 'ui', authority: 'present_user' },
      ...(callerSessionId ? { rpcContext: { sessionActionOrigin: {
        v: 1 as const, caller: { kind: 'session' as const, sessionId: callerSessionId, starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'original-turn', requestId: 'original-publication', callerPermissionMode: null,
      } } } : {}),
    }),
    publish: async (report: SessionUpdatePostInputV1) => {
      const result = await publicationExecutor.execute('session.update.post', report, {
        surface: 'agent', authority: 'account_automation', defaultSessionId: workerId,
      });
      expect(result).toMatchObject({ ok: true });
      return result.ok ? result.result : result;
    },
    publishViaCli: (report: SessionUpdatePostInputV1) => createActionExecutor(createCliActionDeps({
      token: credentials.token, credentials, sessionId: workerId, mode: 'plain', ctx: null,
      serverId: 'worker-home', serverHttpBaseUrl: origin,
    })).execute('session.update.post', report, { surface: 'cli', authority: 'present_user' }),
    reconcile: makeReconciler(), followObserveRequests };
}

describe('session WorkerUpdate producer through Follow', () => {
  it.each([false, true])('delivers an ended question-wait turn once without stopped/finished or private question reads (restricted=%s)', async restricted => {
    const f = await fixture('waiting', 0, restricted);
    f.observation.policy = { preset: 'important' };
    // The restricted source has no AgentState or request counts. Its canonical
    // typed lifecycle alone carries this needs-you fact to the manager.
    const waiting = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    expect(waiting?.workerUpdates).toEqual([expect.objectContaining({
      workerId, ownerState: 'needs_input', wake: 'needs_you', headline: 'Needs you',
    })]);
    expect(waiting?.wakeEventLocalId).toBeTruthy();
    expect(await waiting!.recheckAdmission(new AbortController().signal)).toBe(true);
    // The source can accept the answer between observing its frontier and
    // opening its current projection. That old wait can no longer wake anyone.
    f.row.latestTurnId = 'answer-turn';
    f.row.latestTurnStatus = 'in_progress';
    expect(await waiting!.recheckAdmission(new AbortController().signal)).toBe(false);
    f.row.latestTurnId = 'worker-turn';
    f.row.latestTurnStatus = 'waiting';
    waiting!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: waiting!.wakeEventLocalId! });
    await vi.waitFor(() => expect(f.observation.delivered).toEqual(f.observation.observed));
    expect(await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' })).toBeNull();

    // A later state echo is not another occurrence of the same waiting turn.
    f.row.agentStateVersion = 1;
    f.observation.observed = { ...f.observation.observed, agentStateVersion: 1 };
    expect(await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' })).toBeNull();

    // S3's returned information starts a new host turn. The old question wait
    // must not survive that begin or become a successful completion.
    f.row.latestTurnId = 'answer-turn';
    f.row.latestTurnStatus = 'in_progress';
    f.row.agentStateVersion = 2;
    f.observation.observed = { ...f.observation.observed, agentStateVersion: 2, turn: null };
    expect(await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' })).toBeNull();
  });

  // Original delivery/overlap/prefix/retry contracts run through actual Pending
  // custody in sessionFollowStalled.sqlite.composed.integration.spec.ts. Legacy
  // route observations are retained only for disjoint manager Turn outcomes.
  it.each(['goal-changed', 'worker-report'] as const)('does not redeliver a committed %s original through legacy route intake', async type => {
    const f = await fixture('running', 0, false, undefined, undefined, true);
    await f.commitEvent(type === 'goal-changed' ? { type } : { type, summary: 'Original finding' });
    const stored = SessionStoredMessageContentSchema.parse(f.messages.at(-1)?.content);
    if (stored.t !== 'plain') throw new Error('Expected plain original');
    expect(TranscriptRawRecordV1Schema.parse(stored.v)).toMatchObject({ role: 'agent',
      content: { type: 'event', data: { type } } });
    expect(await f.reconcile({ signal: new AbortController().signal })).toBeNull();
    expect(await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' })).toBeNull();
    expect(f.acknowledgements).toEqual([]);
  });

  it('posts an original mid-turn update through the registered source publisher with no manager', async () => {
    const f = await fixture('running');
    delete f.row.manager;
    const report = { summary: 'A finding before completion', deliverables: [
      { kind: 'workspace_file' as const, sessionId: workerId, path: 'docs/finding.md' },
    ] };
    const result = await f.postViaRpc(report);
    expect(result).toMatchObject({ sessionId: workerId, persisted: true, localId: expect.any(String) });
    expect(f.messages.at(-1)?.content).toMatchObject({ t: 'plain', v: { role: 'agent',
      content: { type: 'event', data: TranscriptRawAgentEventV1Schema.parse({ type: 'worker-report', ...report }) },
    } });
    const stored = f.messages.length;
    expect(await f.postViaRpc({ ...report, sessionId: 'another-source' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await f.postViaRpc(report, 'another-source'))
      .toMatchObject({ ok: false, errorCode: 'session_update_source_mismatch' });
    expect(f.messages).toHaveLength(stored);
  });
  it('posts a CLI original through the bound source RPC and retains source ownership guards', async () => {
    const f = await fixture('running');
    const report = { summary: 'CLI finding before completion', deliverables: [
      { kind: 'workspace_file' as const, sessionId: workerId, path: 'docs/cli-finding.md' },
    ] };
    const result = await f.publishViaCli(report);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
      sessionId: workerId, persisted: true, localId: expect.any(String),
    } });
    expect(f.messages.at(-1)?.content).toMatchObject({ t: 'plain', v: { role: 'agent',
      content: { type: 'event', data: TranscriptRawAgentEventV1Schema.parse({ type: 'worker-report', ...report }) },
    } });
    const stored = f.messages.length;
    expect(await f.publishViaCli({ summary: 'Unowned', deliverables: [
      { kind: 'workspace_file', sessionId: 'another-source', path: 'docs/foreign.md' },
    ] })).toMatchObject({ ok: false, errorCode: 'session_update_deliverable_scope_mismatch' });
    f.row.origin = { kind: 'run_step', runId: 'workflow-run' };
    expect(await f.publishViaCli({ summary: 'Unreviewed workflow result' }))
      .toMatchObject({ ok: false, errorCode: 'session_update_run_step_requires_publish_draft' });
    expect(f.messages).toHaveLength(stored);
  });
  it.each([['completed', 'settled'], ['failed', 'failed'], ['cancelled', 'cancelled']] as const)(
    'projects awareness %s into %s without a user row', async (status, ownerState) => {
      const f = await fixture(status);
      const prepared = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
      expect(prepared?.workerUpdates).toEqual([expect.objectContaining({ workerKind: 'session', workerId,
        ownerState, result: 'Actual final result', wake: status === 'completed' ? 'finished' : 'needs_you' })]);
      expect(classifyWorkerUpdateEventV1(prepared!.workerUpdates![0]!)).toBe(status === 'completed' ? 'finished' : 'failed_or_stopped');
      expect(prepared?.workerUpdates?.[0]).not.toHaveProperty('bucket');
      expect(prepared?.updates).toEqual([]);
      expect(f.acknowledgements).toEqual([]);
      prepared?.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared.wakeEventLocalId! });
      await Promise.resolve();
      expect(f.acknowledgements).toEqual([expect.objectContaining({ relation: 'manager', attachedAt: 100 })]);
    },
  );
  it.each([true, false])('carries a source-owned terminal issue to the real receiver (restricted=%s)', async restricted => {
    const runtimeIssueV1: SessionRuntimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit',
      source: 'usage_limit', occurredAt: 1000, usageLimit: { v: 1, resetAtMs: 1_800_000, retryAfterMs: null,
        quotaScope: 'provider', recoverability: 'wait' } };
    const f = await fixture('failed', 0, restricted, undefined, runtimeIssueV1);
    const prepared = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    expect(prepared?.workerUpdates?.[0]?.runtimeIssueV1).toEqual(runtimeIssueV1);
    expect(WorkerUpdateV1Schema.parse(prepared!.workerUpdates![0]!).runtimeIssueV1).toEqual(runtimeIssueV1);
    f.row.latestTurnId = 'later-turn';
    const stale = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    expect(stale?.workerUpdates?.[0]).not.toHaveProperty('runtimeIssueV1');
  });
  it('waits for the server pending-review count under the lead own read grant', async () => {
    const f = await fixture('completed', 1);
    expect(await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' })).toBeNull();
    f.row.pendingReviewRuns = 0;
    expect((await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' }))?.workerUpdates?.[0]?.ownerState).toBe('settled');
  });
  it('replaces settled with the authorized current exhausted review through production Follow hydration', async () => {
    const f = await fixture('completed', 1, false, { outcome: 'exhausted' });
    expect(await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' })).toBeNull();
    f.row.pendingReviewRuns = 0;
    const prepared = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    expect(prepared?.workerUpdates).toEqual([expect.objectContaining({ workerKind: 'workflow_run', workerId: 'review-run',
      ownerState: 'succeeded', wake: 'needs_you', canInspect: true,
      result: JSON.stringify({ kind: 'exhausted', rounds: 3 }),
      transcriptPointer: { kind: 'workflow_run', runId: 'review-run', invocationRecordId: 'rounds' } })]);
    expect(prepared?.updates).toEqual([]);
    expect(f.acknowledgements).toEqual([]);
    prepared?.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared.wakeEventLocalId! });
    await Promise.resolve();
    expect(f.acknowledgements).toEqual([expect.objectContaining({ relation: 'manager', attachedAt: 100 })]);
  });
  it.each([
    { outcome: 'stop_condition' },
    { outcome: 'stop_condition', olderExhausted: true },
    { outcome: 'exhausted', readable: false },
    { outcome: 'exhausted', listReadable: false },
    { outcome: 'exhausted', ref: 'builtin:keep-going' },
  ] as const)('keeps settled without disclosing an irrelevant or unreadable review: %j', async (review) => {
    const f = await fixture('completed', 0, false, review);
    expect((await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' }))?.workerUpdates).toEqual([
      expect.objectContaining({ workerKind: 'session', ownerState: 'settled', result: 'Actual final result' }),
    ]);
  });
  it('keeps the latest review firing current after its verify/fix step changes the source turn', async () => {
    const f = await fixture('completed', 0, false, { outcome: 'exhausted', sourceTurnId: 'review-firing-turn' });
    expect((await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' }))?.workerUpdates).toEqual([
      expect.objectContaining({ workerKind: 'workflow_run', workerId: 'review-run', wake: 'needs_you' }),
    ]);
  });
  it.each(['available', 'missing'] as const)('opens the exhausted E2EE outcome only with its Run recipient key (%s)', async (keyState) => {
    const f = await fixture('completed', 0, false, { outcome: 'exhausted', keyState });
    const prepared = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    expect(prepared?.workerUpdates).toEqual([keyState === 'available'
      ? expect.objectContaining({ workerKind: 'workflow_run', workerId: 'review-run', wake: 'needs_you', result: JSON.stringify({ kind: 'exhausted', rounds: 3 }) })
      : expect.objectContaining({ workerKind: 'session', ownerState: 'settled', result: 'Actual final result' })]);
    expect(prepared?.updates).toEqual([]);
  });
  it('withdraws the review result when its independent Run grant is revoked before dispatch', async () => {
    const f = await fixture('completed', 0, false, { outcome: 'exhausted' });
    const prepared = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    expect(prepared?.workerUpdates?.[0]?.wake).toBe('needs_you');
    expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(true);
    f.runAccess.readable = false;
    expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(false);
    expect(f.acknowledgements).toEqual([]);
  });
  it('hydrates a restricted Runner manager through its incremental source projection transport', async () => {
    const f = await fixture('completed', 0, true);
    expect((await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' }))?.workerUpdates).toEqual([
      expect.objectContaining({ ownerState: 'settled', result: 'Actual final result', engine: { agentId: 'codex' } }),
    ]);
  });
  it('withdraws a prepared update when A → B → A changed the attachment', async () => {
    const f = await fixture('completed');
    const prepared = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    const retry = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    expect(prepared?.workerUpdateEvents).toEqual(retry?.workerUpdateEvents);
    f.observation.attachedAt = 101;
    expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(false);
    const reattached = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    expect(reattached?.workerUpdateEvents?.[0]?.localId).not.toBe(prepared?.workerUpdateEvents?.[0]?.localId);
  });
  it('does not announce an idle newly attached worker as finished', async () => {
    const f = await fixture('completed');
    f.observation.observed.turn = null;
    expect(await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' })).toBeNull();
  });
  it('commits a published report as a strict original event before returning its receipt', async () => {
    const f = await fixture('running');
    const report = { summary: 'Partial finding', deliverables: [
      { kind: 'workspace_file' as const, sessionId: workerId, path: 'docs/result.md' },
      { kind: 'artifact' as const, artifactId: 'document-1' },
    ] };
    const result = await f.publish(report);
    expect(result).toMatchObject({ sessionId: workerId, persisted: true, localId: expect.any(String) });
    if (!result || typeof result !== 'object' || !('localId' in result)) throw new Error('Expected committed original receipt');
    const original = f.messages.at(-1)!;
    expect(original).toMatchObject({ seq: 2, localId: result.localId, messageRole: 'event' });
    const content = SessionStoredMessageContentSchema.parse(original.content);
    if (content.t !== 'plain') throw new Error('Expected plain original');
    expect(TranscriptRawRecordV1Schema.parse(content.v)).toMatchObject({ role: 'agent',
      content: { type: 'event', data: TranscriptRawAgentEventV1Schema.parse({ type: 'worker-report', ...report }) } });
  });
  it.each([['lead', 'accepted', true], ['other-lead', 'accepted', false], ['lead', 'rejected', false]] as const)(
    'suppresses final text only after the exact current lead accepted the last send (%s/%s)', async (target, status, omitted) => {
      const f = await fixture('completed');
      f.observation.observed.transcriptSeq = 3;
      f.row.seq = 3;
      const receipt = status === 'accepted' ? { status, localId: 'send-input' }
        : { status, code: 'session_input_unauthorized' };
      f.messages.splice(0, 1, ...[
        { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'send-1', name: 'session_message_send', input: { sessionId: target, message: 'Actual final result' } } } } } },
        { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'tool-result', callId: 'send-1', output: [{ type: 'text', text: JSON.stringify({ ok: true, result: receipt }) }] } } } } },
        { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Actual final result' } } } } },
      ]);
      const update = (await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' }))?.workerUpdates?.[0];
      expect(update).toMatchObject({ ownerState: 'settled', transcriptPointer: { kind: 'session', sessionId: workerId } });
      if (omitted) expect(update).not.toHaveProperty('result');
      else expect(update?.result).toBe('Actual final result');
    },
  );
});
