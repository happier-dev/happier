import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1, SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowFinalResultStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1, WorkflowRunSummaryV1Schema,
  createAccountScopedCryptoMaterialSnapshotV1, prepareWorkflowRunDataKeyV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  type SessionFollowPendingObservationV1, type WorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionScopedSocket } from '@/api/session/sockets';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { findTranscriptMessagesQueryRejection } from '@/testkit/transcript/transcriptMessagesRouteContract';
import { createSessionFollowContextReconciler } from './sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';
import { createSessionFollowSourceMaterialResolver } from './sessionFollowSourceMaterialResolver';
import type { RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import type { StoredCredentials } from '@/persistence';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
// Socket.IO and HTTP are network boundaries; all internal owners remain real.
vi.mock('socket.io-client', () => ({ io: mockIo }));
const workerId = 'cworker0000000000000000000';
const origin = 'http://worker-producer.test';
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 }))); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); });

async function fixture(status: 'completed' | 'failed' | 'cancelled' | 'running', pendingReviewRuns = 0, restricted = false,
  review?: Readonly<{ outcome: 'exhausted' | 'stop_condition'; sourceTurnId?: string; readable?: boolean; ref?: string; olderExhausted?: boolean; listReadable?: boolean; keyState?: 'available' | 'missing' }>) {
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
  const observation: SessionFollowPendingObservationV1 = {
    sourceSessionId: workerId, destinationSessionId: 'lead', edgeKind: 'reports_to', attachedAt: 100, mode: 'next_turn',
    delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
    observed: { transcriptSeq: 1, readyEventSeq: 1, agentStateVersion: 0,
      turn: status === 'running' ? null : { id: 'worker-turn', status } },
  };
  const metadata = { path: '/worker', host: 'host' };
  const row = createSessionRecordFixture({ id: workerId, seq: 1, encryptionMode: review?.keyState ? 'e2ee' : 'plain',
    metadata: review?.keyState ? encryptSessionPayload({ ctx, payload: metadata }) : JSON.stringify(metadata), active: true,
    activeAt: Date.now(), updatedAt: Date.now(), latestTurnStatus: status === 'running' ? 'in_progress' : status,
    latestTurnStatusObservedAt: Date.now(), latestReadyEventSeq: 1,
    pendingReviewRuns, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 });
  const app = fastify();
  const finalText = { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Actual final result' } } };
  const messages: RawTranscriptRow[] = [{ seq: 1, createdAt: 1,
    content: review?.keyState ? { t: 'encrypted', c: encryptSessionPayload({ ctx, payload: finalText }) } : { t: 'plain', v: finalText } }];
  app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture(
    review?.keyState ? witness : { mode: 'plain' }));
  const reviewRun = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, visibleTeamId: null,
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
    const rejected = findTranscriptMessagesQueryRejection(new URL(request.url, origin).searchParams);
    if (rejected) return reply.code(400).send({ error: rejected });
    return { messages: [...messages].reverse().map((message) => ({
      ...message, id: `worker-message-${message.seq}`,
    })), hasMore: false };
  });
  app.post('/v2/sessions/:id/follows/source-projection', async (request) => {
    expect(request.body).toMatchObject({ sourceSessionId: workerId, edgeKind: 'reports_to', attachedAt: 100,
      readMode: 'initial_current_snapshot', afterTranscriptSeq: 0, observedTranscriptSeq: observation.observed.transcriptSeq });
    return { v: 1, source: { id: row.id, encryptionMode: 'plain', metadata: row.metadata, metadataLayoutVersion: 0,
      archivedAt: null, createdAt: row.createdAt, updatedAt: row.updatedAt, active: row.active, activeAt: row.activeAt,
      thinking: false, thinkingAt: null, latestTurnStatus: row.latestTurnStatus,
      latestTurnStatusObservedAt: row.latestTurnStatusObservedAt, latestReadyEventSeq: row.latestReadyEventSeq,
      latestReadyEventAt: null, meaningfulActivityAt: null, agentStateVersion: 0, pendingReviewRuns: row.pendingReviewRuns },
      messages: [...messages].reverse(), hasMore: false };
  });
  const restore = installAxiosFastifyAdapter({ app, origin });
  const acknowledgements: unknown[] = [];
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event === SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1) return { ok: true, v: 1, sessionId: 'lead',
      publisherGeneration: '1', currentSourceSessionIds: [workerId], observations: [{ ...observation }] };
    if (event === SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1) {
      acknowledgements.push(payload);
      return { ok: true, v: 1, destinationSessionId: 'lead', sourceSessionId: workerId, delivered: observation.observed };
    }
    return { ok: true };
  } });
  mockIo.mockImplementation(() => socket);
  const leadSession = createPlainSessionFixture({ id: 'lead' });
  const session = new ApiSessionClient('lead-own-grant', review?.keyState
    ? { ...leadSession, encryptionMode: 'e2ee', encryptionKey: secret, encryptionVariant: 'legacy' }
    : leadSession, {
    metadataAuthority: { kind: 'shared_editor' },
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
  return { observation, acknowledgements, row, messages, runAccess,
    reconcile: createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 }) };
}

describe('session WorkerUpdate producer through Follow', () => {
  it.each([['completed', 'settled'], ['failed', 'failed'], ['cancelled', 'cancelled']] as const)(
    'projects awareness %s into %s without a user row', async (status, ownerState) => {
      const f = await fixture(status);
      const prepared = await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' });
      expect(prepared?.workerUpdates).toEqual([expect.objectContaining({ workerKind: 'session', workerId,
        ownerState, result: 'Actual final result', wake: status === 'failed' ? 'needs_you' : 'finished' })]);
      expect(prepared?.workerUpdates?.[0]).not.toHaveProperty('bucket');
      expect(prepared?.updates).toEqual([]);
      expect(f.acknowledgements).toEqual([]);
      prepared?.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared.wakeEventLocalId! });
      await Promise.resolve();
      expect(f.acknowledgements).toEqual([expect.objectContaining({ edgeKind: 'reports_to', attachedAt: 100 })]);
    },
  );
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
    expect(f.acknowledgements).toEqual([expect.objectContaining({ edgeKind: 'reports_to', attachedAt: 100 })]);
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
  it('hydrates a restricted Runner reports-to snapshot through its existing source projection transport', async () => {
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
  it('publishes an explicit worker-report mid-turn through the same frontier without awaiting terminal state', async () => {
    const f = await fixture('running');
    const deliverables = [{ kind: 'workspace_file', sessionId: workerId, path: 'docs/result.md' }, { kind: 'artifact', artifactId: 'document-1' }];
    f.messages[0] = { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'agent',
      content: { type: 'event', data: { type: 'worker-report', summary: 'Partial finding', future: true,
        deliverables: deliverables.map((item) => ({ ...item, future: true })) } } } } };
    expect((await f.reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' }))?.workerUpdates).toEqual([
      expect.objectContaining({ ownerState: 'published', wake: 'published', result: 'Partial finding', deliverables }),
    ]);
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
