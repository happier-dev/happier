import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import type { VisibleRunSessionPort } from '@/agent/executionRuns/runtime/visibleRuns/visibleRunSessionPort';
import type { VisibleRunTranscriptMessage } from '@/agent/executionRuns/runtime/visibleRuns/visibleRunRules';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readSessionLineageReadbackV1, resolveExecutionRunLinkDeliveryStateV1 } from '@happier-dev/protocol';

import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerExecutionRunHandlers } from './executionRuns';
import { listExecutionRunMarkers, removeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

vi.mock('@/persistence', () => ({ readCredentials: vi.fn(async () => null) }));

const reviewOutput = JSON.stringify({ findings: [], summary: 'No findings.' });

type FakeChild = { metadata: Record<string, unknown>; transcript: VisibleRunTranscriptMessage[]; archived?: boolean };

function createFakePort(children: Record<string, FakeChild>) {
  const sent: Array<{ sessionId: string; text: string; requestedAction: unknown; executionRunLinkV1?: unknown }> = [];
  const created: Array<Record<string, unknown>> = [];
  const hostTranscript: VisibleRunTranscriptMessage[] = [];
  const transcriptReads: Record<string, number> = {};
  let failNextSend = false;
  // Holds the next read of the host transcript: it snapshots the rows at call time and returns after release.
  let hostReadGate: Promise<void> | null = null;
  let createdCount = 0;
  const port: VisibleRunSessionPort = {
    createChild: async (params) => {
      createdCount += 1;
      const sessionId = `child_${createdCount}`;
      created.push(params as unknown as Record<string, unknown>);
      children[sessionId] = {
        metadata: {
          flavor: 'claude',
          permissionMode: params.permissionMode,
          sessionOriginV1: params.sessionOriginV1,
          executionRunLinkV1: params.executionRunLinkV1,
          ...(params.sessionRoleV1 ? { sessionRoleV1: params.sessionRoleV1 } : {}),
        },
        transcript: [{ seq: 1, role: 'user', text: params.firstInputText, localId: null, meta: { permissionMode: params.permissionMode } }],
      };
      return { sessionId };
    },
    readChild: async (sessionId) => (children[sessionId] ? { sessionId, metadata: children[sessionId]!.metadata, archived: children[sessionId]!.archived === true } : null),
    updateChildMetadata: async (sessionId, updater) => {
      const child = children[sessionId]!;
      child.metadata = updater(child.metadata);
    },
    sendChildMessage: async (sessionId, params) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error('session_archived');
      }
      sent.push({ sessionId, ...params });
      const child = children[sessionId]!;
      child.transcript.push({
        seq: child.transcript.length + 1,
        role: 'user',
        text: params.text,
        localId: null,
        meta: {
          permissionMode: child.metadata.permissionMode,
          ...(params.executionRunLinkV1 ? { happierExecutionRunLinkV1: params.executionRunLinkV1 } : {}),
        },
      });
    },
    readTranscript: async (sessionId) => {
      transcriptReads[sessionId] = (transcriptReads[sessionId] ?? 0) + 1;
      if (sessionId !== 'lead') return children[sessionId]?.transcript ?? [];
      const snapshot = [...hostTranscript];
      const gate = hostReadGate;
      hostReadGate = null;
      if (gate) await gate;
      return snapshot;
    },
  };
  const holdNextHostRead = () => {
    let release: () => void = () => {};
    hostReadGate = new Promise<void>((resolve) => { release = resolve; });
    return () => release();
  };
  return { port, sent, created, hostTranscript, children, transcriptReads, failNextSend: () => { failNextSend = true; }, holdNextHostRead };
}

function setup(
  children: Record<string, FakeChild> = {},
  opts: Readonly<{
    boundedTimeoutMs?: number;
    budgetRegistry?: ExecutionBudgetRegistry;
    recoveryReReadDelaysMs?: readonly number[];
    holdEnqueue?: boolean;
  }> = {},
) {
  const fake = createFakePort(children);
  const enqueued: Array<Readonly<{ text: string; meta: Record<string, unknown>; localId?: string }>> = [];
  let enqueueOutcome: 'ok' | 'fail' = 'ok';
  let releaseEnqueue: () => void = () => {};
  const enqueueGate = opts.holdEnqueue ? new Promise<void>((resolve) => { releaseEnqueue = resolve; }) : null;
  let registration: ReturnType<typeof registerExecutionRunHandlers> | null = null;
  const client = createEncryptedRpcTestClient({
    scopePrefix: 'lead',
    registerHandlers: (rpc) => {
      registration = registerExecutionRunHandlers(rpc, {
        sessionId: 'lead',
        cwd: process.cwd(),
        parentProvider: 'claude',
        createBackend: () => { throw new Error('visible runs never create a hidden backend'); },
        sendAcp: () => {},
        resolveAccountSettings: () => ({ sessionRoleProfilesV1: { v: 1, instructionsByRole: {} } }),
        visibleRunSessionPort: fake.port,
        enqueueParentSessionInput: async (input) => {
          enqueued.push(input);
          if (enqueueGate) await enqueueGate;
          if (enqueueOutcome === 'fail') throw new Error('queue unavailable');
        },
        ...(opts.recoveryReReadDelaysMs ? { visibleRunRecoveryReReadDelaysMs: opts.recoveryReReadDelaysMs } : {}),
        ...(opts.boundedTimeoutMs ? { policy: { boundedTimeoutMs: opts.boundedTimeoutMs, reviewBoundedTimeoutMs: opts.boundedTimeoutMs } } : {}),
        ...(opts.budgetRegistry ? { budgetRegistry: opts.budgetRegistry } : {}),
      });
    },
  });
  return {
    ...fake,
    client,
    enqueued,
    failEnqueue: () => { enqueueOutcome = 'fail'; },
    releaseEnqueue: () => releaseEnqueue(),
    holdNextHostRead: fake.holdNextHostRead,
    registration: () => registration!,
  };
}

const visibleReview = {
  intent: 'review',
  backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
  instructions: 'Review the plan.',
  permissionMode: 'read_only',
  retentionPolicy: 'resumable',
  runClass: 'bounded',
  ioMode: 'request_response',
  visibility: 'session',
} as const;

const reviewerPlaceholder = (permissionMode = 'read-only'): FakeChild => ({
  metadata: {
    flavor: 'claude',
    permissionMode,
    sessionRoleV1: { v: 1, role: 'reviewer', instructions: 'Review.', assignmentId: 'a1', assignedAt: 1 },
    sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'x' } },
  },
  transcript: [{ seq: 1, role: 'user', text: 'Earlier unrelated work', localId: null, meta: null }, { seq: 2, role: 'assistant', text: reviewOutput, localId: null, meta: null }],
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

async function report(client: ReturnType<typeof setup>['client'], body: Record<string, unknown>) {
  return await client.call<any, any>(SESSION_RPC_METHODS.SESSION_EXECUTION_RUN_CHILD_TURN_REPORT_V1, body);
}

afterEach(() => {
  delete process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS;
});

describe('visible runs: create and bind', () => {
  it('creates the child through the spawn port with origin, link, mapped controls, role snapshot, and the exact profile prompt', async () => {
    const t = setup();
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, role: 'reviewer', roleSource: 'explicit' });
    expect(started).toEqual(expect.objectContaining({ visibility: 'session', binding: 'created', linkedSessionId: 'child_1', roleSource: 'explicit' }));
    const created = t.created[0]!;
    expect(created.sessionOriginV1).toEqual({ v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'execution_run', runId: started.runId } });
    expect(created.executionRunLinkV1).toEqual({ v: 1, parentSessionId: 'lead', runId: started.runId, turnEpoch: 0 });
    expect(created.permissionMode).toBe('read-only');
    expect((created.sessionRoleV1 as { role: string }).role).toBe('reviewer');
    const profile = resolveExecutionRunIntentProfile('review');
    expect(created.firstInputText).toBe(profile.buildPrompt({
      sessionId: 'lead', runId: started.runId, callId: started.callId, sidechainId: started.sidechainId, intent: 'review', backendId: 'claude',
      backendTarget: visibleReview.backendTarget, instructions: visibleReview.instructions, permissionMode: 'read_only',
      retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response', startedAtMs: 0,
    }));
    expect(String(created.firstInputText)).not.toContain('Current run role:');
  });

  it('binds an admitted placeholder: CAS link write, then the task message with the link and no control overrides', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    expect(started).toEqual(expect.objectContaining({ binding: 'reused', linkedSessionId: 'reviewer_1' }));
    expect(t.children.reviewer_1!.metadata.executionRunLinkV1).toEqual({ v: 1, parentSessionId: 'lead', runId: started.runId, turnEpoch: 0 });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toEqual(expect.objectContaining({ sessionId: 'reviewer_1', requestedAction: { v: 1, kind: 'enqueue' } }));
    expect(t.sent[0]!.executionRunLinkV1).toEqual(expect.objectContaining({ runId: started.runId }));
    expect(t.sent[0]).not.toHaveProperty('permissionModeOverride');
    expect(t.sent[0]).not.toHaveProperty('modelOverride');
  });

  it('echoes the child\'s actual role assignment, as read back from the child, for a created and a bound child', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const created = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, role: 'reviewer', roleSource: 'explicit' });
    expect(created.role.assignmentId).toBe(readSessionLineageReadbackV1(t.children.child_1!.metadata).role!.assignmentId);
    const bound = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, role: 'reviewer', roleSource: 'explicit', targetSessionId: 'reviewer_1' });
    expect(bound.role.assignmentId).toBe(readSessionLineageReadbackV1(t.children.reviewer_1!.metadata).role!.assignmentId);
    expect(bound.role.assignmentId).toBe('a1');
  });

  it('rejects an archived bind target before writing any link or message', async () => {
    const archived = { ...reviewerPlaceholder(), archived: true };
    const t = setup({ reviewer_1: archived });
    expect(await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' }))
      .toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_bind_rejected', reason: 'child_archived' }));
    expect(t.children.reviewer_1!.metadata.executionRunLinkV1).toBeUndefined();
    expect(t.sent).toHaveLength(0);
  });

  it('resumes an ambiguous bound start by its start request id: the same run, one task message', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const request = { ...visibleReview, targetSessionId: 'reviewer_1', startRequestId: 'action-request-7' };
    const first = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, request);
    const resumed = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, request);
    expect(resumed).toEqual(expect.objectContaining({ runId: first.runId, binding: 'reused', linkedSessionId: 'reviewer_1' }));
    expect(t.sent).toHaveLength(1);
  });

  it('rejects a foreign child, a role mismatch, a busy child, and mismatched controls before creating anything', async () => {
    const foreign = reviewerPlaceholder();
    foreign.metadata.sessionOriginV1 = { v: 1, kind: 'agent', creatorSessionId: 'someone_else' };
    const t = setup({ reviewer_1: reviewerPlaceholder(), foreign_1: foreign, yolo_1: reviewerPlaceholder('yolo') });
    const reject = async (input: Record<string, unknown>) => await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, input);
    expect(await reject({ ...visibleReview, targetSessionId: 'foreign_1' })).toEqual(expect.objectContaining({ errorCode: 'execution_run_bind_rejected', reason: 'foreign_child' }));
    expect(await reject({ ...visibleReview, intent: 'delegate', permissionMode: 'read_only', targetSessionId: 'reviewer_1' }))
      .toEqual(expect.objectContaining({ errorCode: 'execution_run_bind_rejected', reason: 'role_mismatch' }));
    expect(await reject({ ...visibleReview, targetSessionId: 'yolo_1' })).toEqual(expect.objectContaining({ errorCode: 'execution_run_bind_rejected', reason: 'controls_mismatch' }));
    await reject({ ...visibleReview, targetSessionId: 'reviewer_1' });
    expect(await reject({ ...visibleReview, targetSessionId: 'reviewer_1' })).toEqual(expect.objectContaining({ errorCode: 'execution_run_bind_rejected', reason: 'child_busy' }));
    expect(t.created).toHaveLength(0);
  });
});

describe('visible runs: completion, relay, and delivery', () => {
  it('completes once on the first valid output after the task, relays once, and never relays post-terminal turns', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    expect(await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 0, kind: 'linked' })).toEqual({ ok: true, accepted: true });
    t.children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    expect(await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' })).toEqual({ ok: true, accepted: true });
    await settle();
    const got = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run.status).toBe('succeeded');
    expect(t.enqueued).toHaveLength(1);
    expect(t.enqueued[0]!.localId).toBe(`execution-run-completion:${started.runId}`);
    expect(t.enqueued[0]!.text).toContain('Linked session: reviewer_1');
    expect(await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 2, kind: 'turn_completed' }))
      .toEqual({ ok: true, accepted: false, reason: 'run_terminal' });
    await settle();
    expect(t.enqueued).toHaveLength(1);
    // R21: queued is not delivered; delivery only after this runner binds the input and its transcript holds the row.
    expect(t.children.reviewer_1!.metadata.executionRunLinkV1).toEqual(expect.objectContaining({ relay: expect.objectContaining({ status: 'queued' }) }));
    expect((t.children.reviewer_1!.metadata.executionRunLinkV1 as Record<string, unknown>).delivery).toBeUndefined();
    t.registration().notifyParentInputBound([`execution-run-completion:${started.runId}`]);
    await settle();
    expect((t.children.reviewer_1!.metadata.executionRunLinkV1 as Record<string, unknown>).delivery).toBeUndefined();
    t.hostTranscript.push({ seq: 77, role: 'user', text: 'completion', localId: null, meta: { happierStructuredInputV1: { v: 1, executionRunCompletion: { runId: started.runId } } } });
    t.registration().notifyParentInputBound([`execution-run-completion:${started.runId}`]);
    await settle();
    // A bind before the row was readable keeps the wait; the committed-row notification verifies it.
    expect((t.children.reviewer_1!.metadata.executionRunLinkV1 as Record<string, unknown>).delivery).toEqual(expect.objectContaining({ status: 'verified', transcriptSeq: 77 }));
  });

  it('records delivery from the one verification read when the row is present, and records a failed relay', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    t.children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' });
    await settle();
    t.hostTranscript.push({ seq: 88, role: 'user', text: 'completion', localId: null, meta: { happierStructuredInputV1: { v: 1, executionRunCompletion: { runId: started.runId } } } });
    t.registration().notifyParentInputBound([`execution-run-completion:${started.runId}`]);
    await settle();
    expect((t.children.reviewer_1!.metadata.executionRunLinkV1 as Record<string, unknown>).delivery).toEqual(expect.objectContaining({ status: 'verified', transcriptSeq: 88 }));
    const got = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run.linkState.delivery).toEqual(expect.objectContaining({ transcriptSeq: 88 }));

    const failing = setup({ reviewer_2: reviewerPlaceholder() });
    failing.failEnqueue();
    const second = await failing.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_2' });
    failing.children.reviewer_2!.transcript.push({ seq: 10, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    await report(failing.client, { runId: second.runId, linkedSessionId: 'reviewer_2', turnEpoch: 1, kind: 'turn_completed' });
    await settle();
    expect(failing.children.reviewer_2!.metadata.executionRunLinkV1).toEqual(expect.objectContaining({ relay: expect.objectContaining({ status: 'failed' }) }));
  });

  it('re-reads once when the committed-row signal lands during an in-flight verification read that misses the row', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    t.children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' });
    await settle();
    const localId = `execution-run-completion:${started.runId}`;
    // The bind starts a read before the server commits the row; the read is held in flight.
    const release = t.holdNextHostRead();
    t.registration().notifyParentInputBound([localId]);
    await settle();
    // The row commits and its signal arrives while that read is still in flight.
    t.hostTranscript.push({ seq: 51, role: 'user', text: 'completion', localId, meta: { happierStructuredInputV1: { v: 1, executionRunCompletion: { runId: started.runId } } } });
    t.registration().notifyParentInputBound([localId]);
    await settle();
    release();
    await settle();
    expect((t.children.reviewer_1!.metadata.executionRunLinkV1 as Record<string, unknown>).delivery).toEqual(expect.objectContaining({ status: 'verified', transcriptSeq: 51 }));
  });

  it('verifies delivery when the Lead binds the completion input before the relay enqueue settles', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() }, { holdEnqueue: true });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    t.children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' });
    await settle();
    expect(t.enqueued).toHaveLength(1);
    t.hostTranscript.push({ seq: 88, role: 'user', text: 'completion', localId: null, meta: { happierStructuredInputV1: { v: 1, executionRunCompletion: { runId: started.runId } } } });
    t.registration().notifyParentInputBound([`execution-run-completion:${started.runId}`]);
    await settle();
    t.releaseEnqueue();
    await settle();
    expect((t.children.reviewer_1!.metadata.executionRunLinkV1 as Record<string, unknown>).delivery).toEqual(expect.objectContaining({ status: 'verified', transcriptSeq: 88 }));
  });

  it('repairs invalid output once through the child, then completes on the repaired output', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    t.children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: 'Prose without the contract.', localId: null, meta: null });
    await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' });
    await settle();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.text).toContain('ONLY valid JSON');
    t.children.reviewer_1!.transcript.push({ seq: 20, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 2, kind: 'turn_completed' });
    await settle();
    expect((await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId })).run.status).toBe('succeeded');
  });

  it('steers through the child without overrides, then completes on the next valid output', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    expect(await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, { runId: started.runId, message: 'Focus on tests.', delivery: 'steer_if_supported' })).toEqual({ ok: true });
    expect(t.sent[1]).toEqual(expect.objectContaining({ text: 'Focus on tests.', requestedAction: { v: 1, kind: 'steer_if_active' } }));
    t.children.reviewer_1!.transcript.push({ seq: 30, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' });
    await settle();
    expect((await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId })).run.status).toBe('succeeded');
  });
});

describe('visible runs: controls, timeouts, stop, and turn entries', () => {
  it('fails with controls_changed when the child mode changes in metadata or on a recorded steering message', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder(), reviewer_2: reviewerPlaceholder() });
    const first = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    t.children.reviewer_1!.metadata.permissionMode = 'yolo';
    t.children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    await report(t.client, { runId: first.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' });
    await settle();
    expect((await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: first.runId })).run.error.code).toBe('controls_changed');

    const second = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_2' });
    t.children.reviewer_2!.transcript.push({ seq: 10, role: 'user', text: 'Steer', localId: null, meta: { permissionMode: 'yolo' } });
    t.children.reviewer_2!.transcript.push({ seq: 11, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    await report(t.client, { runId: second.runId, linkedSessionId: 'reviewer_2', turnEpoch: 1, kind: 'turn_completed' });
    await settle();
    expect((await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: second.runId })).run.error.code).toBe('controls_changed');
    expect(t.children.reviewer_2!.metadata.permissionMode).toBe('read-only');
  });

  it('fails closed when the child never confirms the link, and recovers a lost report with the deadline re-read', async () => {
    process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS = '20';
    const silent = setup({ reviewer_1: reviewerPlaceholder() });
    const unresponsive = await silent.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await silent.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: unresponsive.runId })).run.error.code)
      .toBe('execution_run_visible_child_unresponsive');

    delete process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS;
    const lost = setup({ reviewer_1: reviewerPlaceholder() }, { boundedTimeoutMs: 40 });
    const run = await lost.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    await report(lost.client, { runId: run.runId, linkedSessionId: 'reviewer_1', turnEpoch: 0, kind: 'linked' });
    lost.children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect((await lost.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: run.runId })).run.status).toBe('succeeded');
  });

  it('stop cancels the run and leaves the child open; turn-stream entries are rejected on a visible run', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    for (const [method, body] of [
      [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, { runId: started.runId, message: 'x' }],
      [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2, { runId: started.runId, message: 'x', userTranscript: { mode: 'suppress' } }],
      [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, { runId: started.runId, streamId: 's', cursor: 0 }],
      [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL, { runId: started.runId, streamId: 's' }],
      [SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1, { runId: started.runId, message: 'x', localId: 'l1' }],
    ] as const) {
      expect(await t.client.call<any, any>(method, body)).toEqual(expect.objectContaining({ errorCode: 'execution_run_visible_turn_entry_unsupported' }));
    }
    expect(await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId, reason: 'child_archived' })).toEqual({ ok: true });
    const got = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run.status).toBe('cancelled');
    expect(got.run.error.code).toBe('child_archived');
    expect(t.children.reviewer_1).toBeDefined();
  });
});

describe('visible runs: recovery without a configured deadline', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const runOf = async (t: ReturnType<typeof setup>, runId: string) => (await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId })).run;

  it('re-reads the child transcript at the scheduled offsets after the last accepted wake-up, then stops', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() }, { recoveryReReadDelaysMs: [20, 40, 60] });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    expect(await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 0, kind: 'linked' })).toEqual({ ok: true, accepted: true });
    await sleep(120);
    expect(t.transcriptReads.reviewer_1).toBe(3);
    await sleep(80);
    expect(t.transcriptReads.reviewer_1).toBe(3);
    expect((await runOf(t, started.runId)).status).toBe('running');
  });

  it('completes a run whose turn report was lost, and records the relay at the child\'s reported epoch', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() }, { recoveryReReadDelaysMs: [20, 40, 60] });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 0, kind: 'linked' });
    // The child finished its turn, but every report attempt failed; its own record says so.
    t.children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: reviewOutput, localId: null, meta: null });
    const childLink = t.children.reviewer_1!.metadata.executionRunLinkV1 as Record<string, unknown>;
    t.children.reviewer_1!.metadata.executionRunLinkV1 = { ...childLink, report: { turnEpoch: 1, reportedAt: 5, ack: 'failed', attempts: 6 } };
    await sleep(60);
    expect((await runOf(t, started.runId)).status).toBe('succeeded');
    expect(t.enqueued).toHaveLength(1);
    const link = t.children.reviewer_1!.metadata.executionRunLinkV1 as Record<string, any>;
    expect(link.relay).toEqual(expect.objectContaining({ turnEpoch: 1, status: 'queued' }));
    expect(resolveExecutionRunLinkDeliveryStateV1(link)).toBe('queued');
  });

  it('fails the run with a typed error when a child turn fails without a valid result and no recovery is pending', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder(), reviewer_2: reviewerPlaceholder() }, { recoveryReReadDelaysMs: [20, 40, 60] });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    expect(await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed', turnStatus: 'failed' }))
      .toEqual({ ok: true, accepted: true });
    await settle();
    // The decision waits for the first scheduled re-read, so the child's own recovery can arm first.
    expect((await runOf(t, started.runId)).status).toBe('running');
    await sleep(30);
    const run = await runOf(t, started.runId);
    expect(run.status).toBe('failed');
    expect(run.error.code).toBe('execution_run_visible_child_turn_failed');

    // A child whose usage-limit recovery is waiting keeps the run open for the resumed turn.
    const waiting = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_2' });
    t.children.reviewer_2!.metadata.sessionUsageLimitRecoveryV1 = {
      v: 1, status: 'waiting', issueFingerprint: 'usage-limit:reviewer_2:reset', armedAtMs: 1, resetAtMs: 2, nextCheckAtMs: 2,
      attemptCount: 0, maxAttempts: 3, lastProbeError: null, selectedAuth: { kind: 'native', serviceId: 'anthropic' },
    };
    await report(t.client, { runId: waiting.runId, linkedSessionId: 'reviewer_2', turnEpoch: 1, kind: 'turn_completed', turnStatus: 'failed' });
    await sleep(100);
    expect((await runOf(t, waiting.runId)).status).toBe('running');
  });

  it('fails the run with a typed error when the repair prompt cannot be delivered', async () => {
    const t = setup({ reviewer_1: reviewerPlaceholder() });
    const started = await t.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    t.children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: 'Prose without the contract.', localId: null, meta: null });
    t.failNextSend();
    await report(t.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' });
    await settle();
    const run = await runOf(t, started.runId);
    expect(run.status).toBe('failed');
    expect(run.error.code).toBe('execution_run_visible_repair_undelivered');
  });

  it('persists the link confirmation and re-arms the handshake when a rehydrated run was never confirmed', async () => {
    const children: Record<string, FakeChild> = { reviewer_1: reviewerPlaceholder(), reviewer_2: reviewerPlaceholder() };
    const first = setup(children);
    const confirmed = await first.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    const unconfirmed = await first.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_2' });
    await report(first.client, { runId: confirmed.runId, linkedSessionId: 'reviewer_1', turnEpoch: 0, kind: 'linked' });
    await settle();
    const markers = await listExecutionRunMarkers();
    const markerOf = (runId: string) => markers.find((candidate) => candidate.runId === runId) as any;
    try {
      expect(markerOf(confirmed.runId).visibleRunV1.linked).toBe(true);
      expect(markerOf(unconfirmed.runId).visibleRunV1.linked).toBe(false);
      process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS = '30';
      const restarted = setup(children);
      expect(await restarted.registration().rehydrateVisibleRuns([markerOf(unconfirmed.runId)])).toBe(1);
      await sleep(80);
      const run = await runOf(restarted, unconfirmed.runId);
      expect(run.status).toBe('failed');
      expect(run.error.code).toBe('execution_run_visible_child_unresponsive');
    } finally {
      await removeExecutionRunMarker(confirmed.runId);
      await removeExecutionRunMarker(unconfirmed.runId);
    }
  });
});

describe('visible runs: parent restart', () => {
  it('keeps only identifiers in the marker and restores the role and task from the child on rehydration', async () => {
    const children: Record<string, FakeChild> = { reviewer_1: reviewerPlaceholder() };
    const first = setup(children);
    const started = await first.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, role: 'reviewer', roleSource: 'explicit', targetSessionId: 'reviewer_1' });
    await settle();
    const marker = (await listExecutionRunMarkers()).find((candidate) => candidate.runId === started.runId) as any;
    try {
      const serialized = JSON.stringify(marker);
      expect(serialized).not.toContain(visibleReview.instructions);
      expect(serialized).not.toContain('Review.');
      expect(marker.visibleRunV1).not.toHaveProperty('instructions');
      expect(marker.visibleRunV1.role).toEqual({ id: 'reviewer', assignmentId: 'a1', roleSource: 'explicit' });
      await removeExecutionRunMarker(started.runId);
      const restarted = setup(children);
      expect(await restarted.registration().rehydrateVisibleRuns([marker])).toBe(1);
      await settle();
      const got = (await restarted.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId })).run;
      expect(got.role).toEqual({ id: 'reviewer', name: readSessionLineageReadbackV1(children.reviewer_1!.metadata).role!.name, assignmentId: 'a1' });
      expect(JSON.stringify((await listExecutionRunMarkers()).find((candidate) => candidate.runId === started.runId))).not.toContain(visibleReview.instructions);
    } finally {
      await removeExecutionRunMarker(started.runId);
    }
  });

  it('rehydrates a running visible run from its marker and completes it exactly once', async () => {
    const children: Record<string, FakeChild> = { reviewer_1: reviewerPlaceholder() };
    const first = setup(children, { boundedTimeoutMs: 600_000 });
    const started = await first.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, { ...visibleReview, targetSessionId: 'reviewer_1' });
    await settle();
    // A child turn without output: the run keeps running and the accepted epoch is persisted.
    expect(await report(first.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' }))
      .toEqual({ ok: true, accepted: true });
    await settle();
    const marker = (await listExecutionRunMarkers()).find((candidate) => candidate.runId === started.runId);
    expect(marker).toEqual(expect.objectContaining({
      visibleRunV1: expect.objectContaining({ linkedSessionId: 'reviewer_1', binding: 'reused', lastReportedTurnEpoch: 1, deadlineAtMs: expect.any(Number) }),
    }));
    const deadlineAtMs = (marker as any).visibleRunV1.deadlineAtMs as number;
    try {
      // A restarted parent runner: a new manager with no memory of the run, only its marker, and
      // without the original timeout; the run keeps the deadline it started with.
      await removeExecutionRunMarker(started.runId);
      // The restarted runner's execution budget is new and empty; the rehydrated run counts in it again.
      const budgetRegistry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentEphemeralTasks: null });
      const restarted = setup(children, { budgetRegistry });
      expect(await restarted.registration().rehydrateVisibleRuns([marker!])).toBe(1);
      expect(budgetRegistry.tryAcquireExecutionRun('another_run', 'review')).toBe(false);
      expect(await restarted.registration().rehydrateVisibleRuns([marker!])).toBe(0);
      await settle();
      // The restarted runner rewrites the marker under its own process.
      expect((await listExecutionRunMarkers()).find((candidate) => candidate.runId === started.runId))
        .toEqual(expect.objectContaining({ pid: process.pid, visibleRunV1: expect.objectContaining({ deadlineAtMs, lastReportedTurnEpoch: 1 }) }));
      expect(await report(restarted.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 1, kind: 'turn_completed' }))
        .toEqual({ ok: true, accepted: false, reason: 'stale_epoch' });
      children.reviewer_1!.transcript.push({ seq: 10, role: 'assistant', text: reviewOutput, localId: null, meta: null });
      expect(await report(restarted.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 2, kind: 'turn_completed' }))
        .toEqual({ ok: true, accepted: true });
      await settle();
      const got = await restarted.client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
      expect(got.run).toEqual(expect.objectContaining({ status: 'succeeded', visibility: 'session', linkedSessionId: 'reviewer_1', binding: 'reused' }));
      expect(restarted.enqueued).toHaveLength(1);
      expect(budgetRegistry.tryAcquireExecutionRun('another_run', 'review')).toBe(true);
      expect(await report(restarted.client, { runId: started.runId, linkedSessionId: 'reviewer_1', turnEpoch: 3, kind: 'turn_completed' }))
        .toEqual({ ok: true, accepted: false, reason: 'run_terminal' });
    } finally {
      await removeExecutionRunMarker(started.runId);
    }
  });
});
