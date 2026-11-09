import { describe, expect, it, vi } from 'vitest';

import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';
import type { RuntimeTranscriptProjectionSession } from './projectRuntimeTranscriptEvent';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { assertCommittedTranscriptAdmission } from '@/api/session/transcriptPort';
import {
  applyReducedMessages,
  createRawMessageNormalizationSequenceState,
  createReducer,
  createTranscriptStreamSegmentAssembler,
  interpretTranscriptStreamSegment,
  rawRecordSchema,
  reducer,
  type OrderedTranscript,
} from '@happier-dev/session-core';
import { createCodexAppServerRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime';
import { createCodexNativeAppServerSessionRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/native';
import type { DisposableCodexAppServerClient } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client';

type EnqueueAgentMessageCommitted = NonNullable<
  RuntimeTranscriptProjectionSession['enqueueAgentMessageCommitted']
>;
type CommittedAgentMessageBody = Parameters<EnqueueAgentMessageCommitted>[1];
type CommittedToolCallBody = Extract<CommittedAgentMessageBody, { type: 'tool-call' }>;

it('retains the host Turn stamp when failure diagnostic metadata accompanies a provider marker', async () => {
  const { commitRuntimeTurnFailureMarker } = await import('./projectRuntimeTranscriptEvent');
  const writes: unknown[] = [];
  const session: RuntimeTranscriptProjectionSession = { sessionId: 'session-1',
    enqueueAgentMessageCommitted: async (_provider, _body, options) => {
      writes.push(options);
      return { persisted: true, delivered: true, committedSequence: 7 };
    } };
  await commitRuntimeTurnFailureMarker({ session, provider: 'codex',
    event: { turnId: 'host-turn', agentTurnId: 'provider-turn', emittedAtMs: 1 },
    meta: { source: 'runtime', runtimeIssueCode: 'native_failed' } });
  expect(writes).toEqual([expect.objectContaining({ meta: expect.objectContaining({
    runtimeTurnId: 'host-turn', runtimeIssueCode: 'native_failed' }) })]);
});

function createCommittedAgentMessageCapture() {
  const bodies: CommittedAgentMessageBody[] = [];
  const enqueueAgentMessageCommitted = vi.fn<EnqueueAgentMessageCommitted>(async (_provider, body) => {
    bodies.push(body);
    return { persisted: true, delivered: false };
  });
  return { bodies, enqueueAgentMessageCommitted };
}

function findCanonicalDiffCall(bodies: readonly CommittedAgentMessageBody[]): CommittedToolCallBody {
  const body = bodies.find(
    (candidate): candidate is CommittedToolCallBody => candidate.type === 'tool-call' && candidate.name === 'Diff',
  );
  expect(body).toBeDefined();
  if (!body) throw new Error('Expected a committed canonical Diff tool call');
  return body;
}

let nextRuntimeEventSequence = 0;

function canonicalRuntimeEvent(input: Readonly<Record<string, unknown>>): AgentSessionRuntimeEventV1 {
  return AgentSessionRuntimeEventV1Schema.parse({
    sequence: ++nextRuntimeEventSequence,
    ...input,
  });
}

describe('projectRuntimeTranscriptEvent', () => {
  it('validates a tool payload once at ingress across transcript, turn and terminal consumers', async () => {
    const { AgentSessionRuntimeEventSchema } = await import('@happier-dev/protocol/runtime/agentSessionV1');
    const { createAgentSessionTurnInvariant } = await import('../turn/agentSessionTurnInvariant');
    const { createSessionTurnLifecycle } = await import('../turn/lifecycle');
    const { mapRuntimeMessageToTerminalLifecycleObservation } = await import('../../terminal/runtimeMessageObservationAdapter');
    const { createRuntimeTranscriptProjector } = await import('./projectRuntimeTranscriptEvent');
    const invariant = createAgentSessionTurnInvariant({ sessionId: 'session-1' });
    const project = createRuntimeTranscriptProjector();
    const capture = createCommittedAgentMessageCapture();
    const session = { sessionId: 'session-1', enqueueAgentMessageCommitted: capture.enqueueAgentMessageCommitted };
    const lifecycle = createSessionTurnLifecycle({ session });
    for (const input of [
      { kind: 'input-accepted', inputIds: ['input-1'], delivery: { kind: 'newTurn', turnId: 'turn-1' } },
      { kind: 'turn-start', turnId: 'turn-1', startedBy: 'host' },
      { kind: 'tool-call', turnId: 'turn-1', toolCallId: 'call-1', toolName: 'Read', input: {} },
    ]) {
      const observation = invariant.observe({ ...input, sessionId: 'session-1', emittedAtMs: 1, sequence: ++nextRuntimeEventSequence });
      if (observation.status !== 'accepted') throw new Error('Expected valid ingress');
      await project({ session, provider: 'codex', event: observation.event });
      lifecycle.observeRuntimeEvent(observation.event);
    }
    // Instrument the real parser without replacing it: this measures repeated
    // payload traversal, not collaborator wiring or a mocked schema verdict.
    const parses = vi.spyOn(AgentSessionRuntimeEventSchema, 'safeParse');
    try {
      const output = { text: 'large valid tool content '.repeat(10_000) };
      const observation = invariant.observe({ kind: 'tool-result', sessionId: 'session-1',
        turnId: 'turn-1', toolCallId: 'call-1', output, emittedAtMs: 2, sequence: ++nextRuntimeEventSequence });
      if (observation.status !== 'accepted') throw new Error('Expected valid tool result');
      await project({ session, provider: 'codex', event: observation.event });
      lifecycle.observeRuntimeEvent(observation.event);
      expect(mapRuntimeMessageToTerminalLifecycleObservation({ agentId: 'codex', message: observation.event })).toBeNull();
      expect(capture.bodies).toContainEqual(expect.objectContaining({ type: 'tool-result', output }));
      expect(parses).toHaveBeenCalledTimes(1);
    } finally {
      parses.mockRestore();
    }
  });

  it('preserves large committed text and file edits below the runtime event envelope through admission and projection', async () => {
    const { createRuntimeTranscriptProjector } = await import('./projectRuntimeTranscriptEvent');
    const capture = createCommittedAgentMessageCapture();
    const session: RuntimeTranscriptProjectionSession = {
      sessionId: 'large-content',
      enqueueAgentMessageCommitted: capture.enqueueAgentMessageCommitted,
    };
    const project = createRuntimeTranscriptProjector();
    const text = 'x'.repeat(512 * 1_024 + 1);
    const oldContent = 'o'.repeat(1_000_001);
    const newContent = 'n'.repeat(1_000_001);

    const committed = canonicalRuntimeEvent({ kind: 'transcript-message-committed',
      sessionId: session.sessionId, emittedAtMs: 1, messageId: 'large-message',
      role: 'assistant', text });
    const edit = canonicalRuntimeEvent({ kind: 'file-edit', sessionId: session.sessionId,
      emittedAtMs: 2, editId: 'large-edit', path: '/tmp/large-file', oldContent, newContent });

    expect(await project({ session, provider: 'codex', event: committed })).toMatchObject({ projected: true });
    expect(await project({ session, provider: 'codex', event: edit })).toMatchObject({ projected: true });
    expect(capture.bodies).toEqual([
      expect.objectContaining({ type: 'message', message: text }),
      expect.objectContaining({ type: 'file-edit', oldContent, newContent }),
    ]);
  });

  it('stores Provider credential guidance once through public failure publication', async () => {
    const { surfacePrimarySessionRuntimeIssue } = await import('../errors/surfacePrimarySessionRuntimeIssue');
    const { createProviderErrorV1 } = await import('@happier-dev/protocol/providers/errors');
    const { createRuntimeFailureTranscriptProjector } = await import('./runtimeFailureTranscript');
    const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
    const stored: NonNullable<ReturnType<typeof normalizeRawMessage>>[] = [];
    const project = createRuntimeFailureTranscriptProjector({ provider: 'codex', providerName: 'Codex', session: {
      sessionId: 'provider-auth', enqueueAgentMessageCommitted: async (provider, body, opts) => {
        const normalized = normalizeRawMessage(opts.localId, opts.localId, 1,
          buildAcpAgentMessageEnvelope({ provider, body, meta: opts.meta }), { seq: 1 });
        if (normalized) stored.push(normalized);
        return { persisted: true, delivered: true, committedSequence: 1 };
      },
    } });
    await surfacePrimarySessionRuntimeIssue({ provider: 'codex', cause: 'session_error',
      sessionTurnId: 'provider-turn', occurredAt: 1, error: createProviderErrorV1('provider_endpoint_auth_required'),
      publishRuntimeEvent: async event => { await project({ ...event, sessionId: 'provider-auth' }); },
    });
    expect(reducer(createReducer(), stored, null).messages).toEqual([expect.objectContaining({ kind: 'agent-text',
      text: expect.stringContaining('The Provider endpoint requires a credential.'),
      meta: expect.objectContaining({ runtimeIssueV1: expect.objectContaining({ source: 'agent_session_error',
        code: 'provider_endpoint_auth_required' }) }),
    })]);
    expect(JSON.stringify(stored)).toContain('Add a Saved Secret to the Provider connection.');
  });

  it('stores one visible native sign-in issue per real Codex 401 without republishing an observed failure', async () => {
    const { createRuntimeFailureTranscriptProjector } = await import('./runtimeFailureTranscript');
    const { createRuntimeTranscriptProjector } = await import('./projectRuntimeTranscriptEvent');
    const { createExecutionRunDiagnosticError, projectExecutionRunError } = await import('../../bridges/executionRun/errors');
    const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
    const history: Array<{ body: CommittedAgentMessageBody; localId: string; meta?: Record<string, unknown> }> = [];
    const session: RuntimeTranscriptProjectionSession = { sessionId: 'codex-native-auth',
      enqueueAgentMessageCommitted: async (_provider, body, opts) => {
        history.push({ body, localId: opts.localId, meta: opts.meta });
        return { persisted: true, delivered: true, committedSequence: history.length };
      } };
    const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
    let turnStarts = 0;
    const client: DisposableCodexAppServerClient = {
      launchFeatures: { realtimeConversationAdvertised: false },
      onNativeEvent: () => () => undefined,
      request: async method => {
        if (method === 'thread/start') return { thread: { id: 'native-thread' } };
        if (method === 'turn/start') return { turnId: `native-turn-${++turnStarts}` };
        if (method === 'account/read') return { account: null };
        if (method === 'account/rateLimits/read') return { rateLimits: null };
        throw new Error(`Unexpected native request: ${method}`);
      },
      notify: async () => undefined,
      registerRequestHandler: () => () => undefined,
      registerNotificationHandler: (method, handler) => { handlers.set(method, handler); return () => handlers.delete(method); },
      onExit: () => () => undefined,
      dispose: async () => undefined,
    };
    // Substitute only the external Codex JSON-RPC process and transcript storage.
    const runtime = createCodexAppServerRuntime({ happierSessionId: session.sessionId, directory: '/tmp',
      host: { baseProcessEnv: {}, logger: { debug() {}, warn() {} }, createClient: async () => client } });
    const native = createCodexNativeAppServerSessionRuntime(runtime, session.sessionId);
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session,
      initialCheckpointDelayMs: null, checkpointIntervalMs: null, checkpointMinChars: null,
      liveSnapshotIntervalMs: null, liveSnapshotMinChars: null });
    const project = createRuntimeTranscriptProjector();
    const projectFailure = createRuntimeFailureTranscriptProjector({ session, provider: 'codex', providerName: 'Codex' });
    const failures: Extract<AgentSessionRuntimeEventV1, { kind: 'turn-failed' }>[] = [];
    let projection = Promise.resolve();
    native.watch(event => {
      if (event.kind === 'turn-failed') failures.push(event);
      projection = projection.then(async () => {
        await project({ session, provider: 'codex', runtimeMessageDeltaBridge: bridge, event });
        await projectFailure(event);
      });
    });
    try {
      for (let turn = 1; turn <= 2; turn += 1) {
        await native.send({ inputIds: [`input-${turn}`], input: { text: 'hello' },
          delivery: { kind: 'newTurn', turnId: `host-turn-${turn}` } });
        const complete = handlers.get('turn/completed');
        if (!complete) throw new Error('Missing native completion handler');
        await complete({ threadId: 'native-thread', turn: { id: `native-turn-${turn}`, status: 'failed', error: {
          message: 'Missing bearer authentication. PRIVATE_BODY',
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
        } } });
        await vi.waitFor(() => expect(failures).toHaveLength(turn));
        await projection;
        const failure = failures[turn - 1]!;
        expect(failure.diagnostic).toMatchObject({ code: 'provider_endpoint_auth_required', details: { source: 'auth_error' } });
        expect(projectExecutionRunError(createExecutionRunDiagnosticError(failure.diagnostic, failure.emittedAtMs, 'codex')))
          .toMatchObject({ code: 'provider_endpoint_auth_required', runtimeIssueV1: { source: 'auth_error',
            sanitizedPreview: 'Sign in to Codex or choose a Codex account.' } });
        const writesBeforeReplay = history.length;
        for (let replay = 0; replay < 10; replay += 1) await projectFailure(failure);
        expect(history).toHaveLength(writesBeforeReplay);
        const normalized = history.flatMap(({ body, localId, meta }, index) => {
          const row = normalizeRawMessage(localId, localId, index + 1,
            buildAcpAgentMessageEnvelope({ provider: 'codex', body, meta }), { seq: index + 1 });
          return row ? [row] : [];
        });
        const visible = reducer(createReducer(), normalized, null).messages;
        expect(visible).toHaveLength(turn);
        expect(visible).toEqual(Array.from({ length: turn }, () => expect.objectContaining({ kind: 'agent-text',
          text: 'Sign in to Codex or choose a Codex account.', meta: expect.objectContaining({ runtimeIssueV1:
            expect.objectContaining({ code: 'provider_endpoint_auth_required', source: 'auth_error' }) }) })));
        expect(history.filter(row => row.body.type === 'message')).toHaveLength(turn);
        expect(history.filter(row => row.body.type === 'turn_failed')).toHaveLength(turn);
        expect(JSON.stringify(history)).not.toContain('PRIVATE_');
        expect(turnStarts).toBe(turn);
      }
    } finally {
      await native.dispose();
      await projection;
      bridge.clear();
    }
  });

  it.each(['direct', 'stateful'] as const)('admits each delta once through the %s projector at transcript scale', async (mode) => {
    const { createRuntimeTranscriptProjector, projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const capture = createCommittedAgentMessageCapture();
    const session = { sessionId: `admission-cost-${mode}`, enqueueAgentMessageCommitted: capture.enqueueAgentMessageCommitted,
      sendAgentMessageEphemeral: () => ({ accepted: true as const, epoch: 0 }) };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session,
      initialCheckpointDelayMs: null, checkpointIntervalMs: null, checkpointMinChars: null,
      liveSnapshotIntervalMs: null, liveSnapshotMinChars: null });
    const project = mode === 'direct' ? projectRuntimeTranscriptEvent : createRuntimeTranscriptProjector();
    let sourceTextReads = 0;
    try {
      for (let sequence = 0; sequence < 1_000; sequence += 1) {
        // Observe the raw ingress field without replacing the schema, projector or writer.
        const event: AgentSessionRuntimeEventV1 = { kind: 'message-delta', sessionId: session.sessionId, turnId: 'turn-cost',
          messageId: 'message-cost', channel: 'assistant', sequence, emittedAtMs: sequence,
          get text() { sourceTextReads += 1; return 'a'; } };
        expect(await project({ session, provider: 'codex', runtimeMessageDeltaBridge: bridge, event }))
          .toMatchObject({ projected: true, kind: 'message-delta' });
      }
      expect(sourceTextReads).toBe(1_000);
      await bridge.flushAll({ reason: 'turn-end' });
      expect(capture.bodies).toContainEqual(expect.objectContaining({ type: 'message', message: 'a'.repeat(1_000) }));
    } finally { bridge.clear(); }
  });

  it('replaces an unfinished Codex answer on native retry without replaying input or removing completed messages', async () => {
    const { createRuntimeTranscriptProjector } = await import('./projectRuntimeTranscriptEvent');
    const stored = new Map<string, CommittedAgentMessageBody>();
    const live = new Map<string, CommittedAgentMessageBody>();
    const liveErrors: unknown[] = [];
    const assembler = createTranscriptStreamSegmentAssembler();
    const rawMessageNormalizationState = createRawMessageNormalizationSequenceState();
    const reducerState = createReducer();
    let transcript: OrderedTranscript = { messageIdsOldestFirst: [], messagesById: {} };
    const renderedText = () => transcript.messageIdsOldestFirst.flatMap(id => {
      const message = transcript.messagesById[id];
      return message?.kind === 'agent-text' && message.text ? [message.text] : [];
    });
    const session = { sessionId: 'codex-retry-session',
      enqueueAgentMessageCommitted: vi.fn<EnqueueAgentMessageCommitted>(async (_provider, body, opts) => {
        stored.set(opts.localId, body);
        return { persisted: true, delivered: false };
      }),
      sendAgentMessageEphemeral: vi.fn<NonNullable<RuntimeTranscriptProjectionSession['sendAgentMessageEphemeral']>>((_provider, body, opts) => {
        live.set(opts.localId, body);
        try {
          const normalized = interpretTranscriptStreamSegment({
            assembler,
            rawMessageNormalizationState,
            sessionId: 'codex-retry-session',
            type: 'transcript-stream-segment',
            record: rawRecordSchema.parse(buildAcpAgentMessageEnvelope({ provider: 'codex', body, meta: opts.meta })),
            message: { localId: opts.localId, createdAt: opts.createdAt },
          });
          expect(normalized).not.toBeNull();
          if (normalized) transcript = applyReducedMessages(transcript, reducer(reducerState, [normalized], null).messages);
        } catch (error) {
          liveErrors.push(error);
          throw error;
        }
        return { accepted: true, epoch: 0 };
      }),
    };
    // Only the external native JSON-RPC process and durable storage are substituted.
    const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
    const requests: string[] = [];
    const client: DisposableCodexAppServerClient = {
      launchFeatures: { realtimeConversationAdvertised: false },
      onNativeEvent: () => () => undefined,
      request: async method => {
        requests.push(method);
        if (method === 'thread/start') return { thread: { id: 'native-thread' } };
        if (method === 'turn/start') return { turnId: 'native-turn' };
        if (method === 'account/read') return { account: null };
        if (method === 'account/rateLimits/read') return { rateLimits: null };
        throw new Error(`Unexpected native request: ${method}`);
      },
      notify: async () => undefined,
      registerRequestHandler: () => () => undefined,
      registerNotificationHandler: (method, handler) => { handlers.set(method, handler); return () => handlers.delete(method); },
      onExit: () => () => undefined,
      dispose: async () => undefined,
    };
    const runtime = createCodexAppServerRuntime({ happierSessionId: session.sessionId, directory: '/tmp',
      host: { baseProcessEnv: {}, logger: { debug: vi.fn(), warn: vi.fn() }, createClient: async () => client } });
    const native = createCodexNativeAppServerSessionRuntime(runtime, session.sessionId);
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session,
      initialCheckpointDelayMs: 0 });
    const project = createRuntimeTranscriptProjector();
    const events: AgentSessionRuntimeEventV1[] = [];
    let projection = Promise.resolve();
    native.watch(event => {
      events.push(event);
      projection = projection.then(async () => {
        await project({ session, provider: 'codex', runtimeMessageDeltaBridge: bridge, event });
      });
    });
    const scope = { threadId: 'native-thread', turnId: 'native-turn' };
    const notify = async (method: string, params: Record<string, unknown>) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Missing native handler: ${method}`);
      await handler(params);
      await projection;
    };
    const text = (itemId: string, delta: string) => notify('item/agentMessage/delta', { ...scope, itemId, delta });
    try {
      await native.send({ inputIds: ['original-input'], input: { text: 'Write the answer' },
        delivery: { kind: 'newTurn', turnId: 'host-turn' } });
      await text('completed', 'Earlier complete message');
      await notify('item/completed', { ...scope, item: { type: 'agentMessage', id: 'completed', text: 'Earlier complete message' } });
      await text('interrupted', '1. able\n2. acid\n3');
      await vi.waitFor(() => expect([...stored.values()]).toContainEqual({ type: 'message', message: '1. able\n2. acid\n3' }));
      const interruptedLocalId = [...stored.entries()].find(([, body]) => body.type === 'message' && body.message === '1. able\n2. acid\n3')![0];
      expect(liveErrors).toEqual([]);
      expect(assembler.isTranscriptStreamSegmentAssemblyReady(session.sessionId, interruptedLocalId)).toBe(true);
      expect(renderedText()).toEqual(['Earlier complete message', '1. able\n2. acid\n3']);
      // An unrelated error and a diagnostic without a native retry must leave the active draft alone.
      await notify('error', { ...scope, threadId: 'foreign-thread', willRetry: true, error: { message: 'stream failed' } });
      await notify('error', { ...scope, willRetry: false, error: { message: 'diagnostic' } });
      expect([...stored.values()]).toContainEqual({ type: 'message', message: '1. able\n2. acid\n3' });
      // c40 daemon :74348 records this same native-turn willRetry=true boundary after Gateway SIGTERM.
      await notify('error', { ...scope, willRetry: true, error: { message: 'stream failed' } });
      // Retire the live snapshot as well as its durable checkpoint. Discarding
      // a writer alone leaves the already-published partial on connected clients.
      expect([...live.values()].filter(body => body.type === 'message' && body.message.includes('1. able'))).toEqual([]);
      expect(renderedText()).toEqual(['Earlier complete message']);
      expect(assembler.isTranscriptStreamSegmentAssemblyReady(session.sessionId, interruptedLocalId)).toBe(false);
      await text('retry-answer', '1. able\n2. acid\n3. acre');
      await notify('item/completed', { ...scope, item: { type: 'agentMessage', id: 'retry-answer', text: '1. able\n2. acid\n3. acre' } });
      await notify('turn/completed', { ...scope, turn: { id: scope.turnId, status: 'completed' } });
      await vi.waitFor(() => expect(events.filter(event => event.kind === 'turn-complete')).toHaveLength(1));
      await projection;
      expect([...stored.values()].flatMap(body => body.type === 'message' && body.message ? [body.message] : []))
        .toEqual(['Earlier complete message', '1. able\n2. acid\n3. acre']);
      expect(renderedText()).toEqual(['Earlier complete message', '1. able\n2. acid\n3. acre']);
      expect(liveErrors).toEqual([]);
      expect(requests.filter(method => method === 'turn/start')).toHaveLength(1);
      expect(events.some(event => event.kind === 'turn-failed' || event.kind === 'turn-cancelled')).toBe(false);
    } finally {
      await native.dispose();
      await projection;
      bridge.clear();
    }
  });

  it.each(['turn-cancelled', 'turn-complete'] as const)(
    'flushes a yielded question without publishing a false terminal marker after %s', async kind => {
      const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
      const { bodies, enqueueAgentMessageCommitted } = createCommittedAgentMessageCapture();
      const session = { sessionId: 'question-session', requiresDurableTurnCompletionMarker: true as const,
        enqueueAgentMessageCommitted };
      const bridge = createKeyedStreamedTranscriptBridge({ provider: 'opencode', createSessionForStream: () => session });
      const project = (input: Record<string, unknown>) => projectRuntimeTranscriptEvent({ session, provider: 'opencode',
        runtimeMessageDeltaBridge: bridge, questionWaitTurnId: 'question-turn', event: canonicalRuntimeEvent({ sessionId: session.sessionId,
          emittedAtMs: 1, turnId: 'question-turn', ...input }) });
      try {
        await project({ kind: 'message-delta', channel: 'assistant', text: 'Which option should I use?' });
        await project({ kind, ...(kind === 'turn-cancelled' ? { cause: 'user' } : {}) });
        expect(bodies.some(body => body.type === 'message' && body.message === 'Which option should I use?')).toBe(true);
        expect(bodies.filter(body => body.type === 'turn_cancelled' || body.type === 'task_complete')).toEqual([]);
        // Another exact turn still carries genuine terminal evidence.
        await project({ kind, turnId: 'other-turn', ...(kind === 'turn-cancelled' ? { cause: 'user' } : {}) });
        expect(bodies.filter(body => body.type === 'turn_cancelled' || body.type === 'task_complete')).toEqual([
          { type: kind === 'turn-cancelled' ? 'turn_cancelled' : 'task_complete', id: 'other-turn' },
        ]);
      } finally { bridge.clear(); }
    },
  );

  it.each([undefined, 'named-message'])('retains the checkpoint identity when native final custody is refused and retried (messageId=%s)', async messageId => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    let available = true;
    const stored = new Map<string, CommittedAgentMessageBody>();
    const session = { sessionId: 'session-1',
      enqueueAgentMessageCommitted: async (_provider: unknown, body: CommittedAgentMessageBody, opts: { localId: string }) => {
        if (available) stored.set(opts.localId, body);
        return { persisted: available, delivered: false };
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'agent', createSessionForStream: () => session });
    const project = async (event: Record<string, unknown>) => projectRuntimeTranscriptEvent({ session, provider: 'agent',
      runtimeMessageDeltaBridge: bridge, event: canonicalRuntimeEvent({ sessionId: session.sessionId, emittedAtMs: 1, turnId: 'turn-1', ...event }) });
    await project({ kind: 'message-delta', channel: 'assistant', messageId, text: 'Checkpoint' });
    await vi.waitFor(() => expect(stored.size).toBe(1));
    const checkpointLocalId = [...stored.keys()][0]!;
    available = false;
    const final = { kind: 'transcript-message-committed', role: 'assistant', messageId: messageId ?? 'native-final', text: 'Authoritative' };
    await expect(project(final)).rejects.toMatchObject({ code: 'runtime_transcript_required_admission_failed', reason: 'streamed_final_not_durable' });
    expect(stored.get(checkpointLocalId)).toEqual({ type: 'message', message: 'Checkpoint' });
    available = true;
    await project(final);
    expect([...stored.entries()]).toEqual([[checkpointLocalId, { type: 'message', message: 'Authoritative' }]]);
    bridge.clear();
  });

  it.each([undefined, 'child'])('keeps a named commit separate from a simultaneous unnamed stream (sidechainId=%s)', async sidechainId => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const stored = new Map<string, CommittedAgentMessageBody>();
    const metas = new Map<string, unknown>();
    const session = { sessionId: 'session-1',
      enqueueAgentMessageCommitted: async (_provider: unknown, body: CommittedAgentMessageBody, opts: { localId: string; meta?: Record<string, unknown> }) => {
        stored.set(opts.localId, body);
        metas.set(opts.localId, opts.meta);
        return { persisted: true, delivered: false };
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'agent', createSessionForStream: () => session });
    const project = async (event: Record<string, unknown>) => projectRuntimeTranscriptEvent({ session, provider: 'agent',
      runtimeMessageDeltaBridge: bridge, event: canonicalRuntimeEvent({ sessionId: session.sessionId, emittedAtMs: 1, turnId: 'turn-1', ...event }) });
    await project({ kind: 'message-delta', channel: 'assistant', text: 'Unnamed output' });
    await project({ kind: 'message-delta', channel: 'assistant', messageId: 'named', sidechainId, text: 'Named draft' });
    await project({ kind: 'transcript-message-committed', role: 'assistant', messageId: 'named', sidechainId, text: 'Named final' });
    await project({ kind: 'turn-complete' });
    expect(stored.get('named')).toEqual({ type: 'message', message: 'Named final', ...(sidechainId ? { sidechainId } : {}) });
    expect(metas.get('named')).toMatchObject({ happierStreamSegmentV1: { segmentLocalId: 'named', segmentState: 'complete' } });
    expect([...stored.values()]).toHaveLength(2);
    expect([...stored.values()]).toContainEqual({ type: 'message', message: 'Unnamed output' });
    bridge.clear();
  });

  it('commits peer-delivered agent text with its sender beside the message, outside any stream segment', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const stored = new Map<string, CommittedAgentMessageBody>();
    const session = { sessionId: 'session-1',
      enqueueAgentMessageCommitted: async (_provider: unknown, body: CommittedAgentMessageBody, opts: { localId: string }) => {
        stored.set(opts.localId, body);
        return { persisted: true, delivered: true };
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'claude', createSessionForStream: () => session });
    await expect(projectRuntimeTranscriptEvent({ session, provider: 'claude', runtimeMessageDeltaBridge: bridge,
      event: canonicalRuntimeEvent({ sessionId: session.sessionId, emittedAtMs: 1, kind: 'transcript-message-committed',
        role: 'assistant', messageId: 'claude-jsonl:main:user:handback', text: 'Report body',
        peer: { name: 'general-purpose', handback: true } }) })).resolves.toMatchObject({ projected: true });
    expect([...stored.entries()]).toEqual([['claude-jsonl:main:user:handback',
      { type: 'message', message: 'Report body', peer: { name: 'general-purpose', handback: true } }]]);
    bridge.clear();
  });

  it('drains a named live stream before durable finalization and retains its identity after cancellation', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    let releaseLive!: () => void;
    const pendingLive = new Promise<void>(resolve => { releaseLive = resolve; });
    const stored = new Map<string, CommittedAgentMessageBody>();
    const live: CommittedAgentMessageBody[] = [];
    const session = {
      sessionId: 'named-cancellation',
      sendAgentMessageEphemeral: async (_provider: unknown, body: CommittedAgentMessageBody) => {
        if (body.type === 'message' && body.message === 'Draft') await pendingLive;
        live.push(body);
        return { accepted: true as const, epoch: 0 };
      },
      enqueueAgentMessageCommitted: vi.fn<EnqueueAgentMessageCommitted>(async (_provider, body, opts) => {
        assertCommittedTranscriptAdmission(opts.admission);
        stored.set(opts.localId, body);
        return { persisted: true, delivered: true, committedSequence: 42 };
      }),
    };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session,
      initialCheckpointDelayMs: 60_000 });
    const project = async (input: Record<string, unknown>, signal?: AbortSignal) => projectRuntimeTranscriptEvent({
      session, provider: 'codex', runtimeMessageDeltaBridge: bridge,
      ...(signal ? { admission: { signal, requireDelivery: true } } : {}),
      event: canonicalRuntimeEvent({ sessionId: session.sessionId, emittedAtMs: 1, turnId: 'turn', ...input }),
    });
    const final = { kind: 'transcript-message-committed', role: 'assistant', messageId: 'named', text: 'Authoritative' };
    try {
      await project({ kind: 'message-delta', channel: 'assistant', messageId: 'named', text: 'Draft' });
      const abort = new AbortController();
      const publication = project(final, abort.signal);
      const cancelled = expect(publication).rejects.toMatchObject({ reason: 'admission_expired' });
      await Promise.resolve();
      expect(stored.size).toBe(0);
      abort.abort();
      releaseLive();
      await cancelled;
      expect(stored.size).toBe(0);
      expect(live).toEqual([{ type: 'message', message: 'Draft' }, { type: 'message', message: 'Authoritative' }]);
      await expect(project(final)).resolves.toMatchObject({ finalAssistantMessageSeq: 42 });
      expect([...stored.entries()]).toEqual([['named', { type: 'message', message: 'Authoritative' }]]);
      expect(session.enqueueAgentMessageCommitted).toHaveBeenLastCalledWith('codex',
        { type: 'message', message: 'Authoritative' }, expect.objectContaining({ localId: 'named',
          meta: expect.objectContaining({ happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }) }) }));
    } finally {
      releaseLive();
      bridge.clear();
    }
  });

  it.each(['assistant', 'reasoning'] as const)('finalizes the checkpoint for an unnamed %s output under its existing identity', async (channel) => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const stored = new Map<string, { body: CommittedAgentMessageBody; meta?: Record<string, unknown> }>();
    const session = { sessionId: 'session-1',
      enqueueAgentMessageCommitted: async (_provider: unknown, body: CommittedAgentMessageBody, opts: { localId: string; meta?: Record<string, unknown> }) => {
        stored.set(opts.localId, { body, meta: opts.meta });
        return { persisted: true, delivered: false };
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'agent', createSessionForStream: () => session });
    const project = async (event: Record<string, unknown>) => projectRuntimeTranscriptEvent({ session, provider: 'agent',
      runtimeMessageDeltaBridge: bridge, event: canonicalRuntimeEvent({ sessionId: session.sessionId, emittedAtMs: 1, turnId: 'turn-1', ...event }) });
    await project({ kind: 'message-delta', channel, text: 'Draft' });
    await vi.waitFor(() => expect(stored.size).toBe(1));
    const checkpointLocalId = [...stored.keys()][0]!;
    await project({ kind: 'message-delta', channel: channel === 'assistant' ? 'reasoning' : 'assistant', text: 'Other channel' });
    await project({ kind: 'transcript-message-committed', role: channel, messageId: 'native-fact', text: 'Authoritative' });
    await project({ kind: 'turn-complete' });
    expect(stored.size).toBe(2);
    expect(stored.get(checkpointLocalId)).toMatchObject({ body: channel === 'assistant'
      ? { type: 'message', message: 'Authoritative' } : { type: 'thinking', text: 'Authoritative' },
      meta: { happierStreamSegmentV1: { segmentLocalId: checkpointLocalId, segmentState: 'complete', sourceMessageId: 'native-fact' } },
    });
    expect([...stored.values()].some(({ body }) => channel === 'assistant'
      ? body.type === 'thinking' && body.text === 'Other channel'
      : body.type === 'message' && body.message === 'Other channel')).toBe(true);
    bridge.clear();
  });

  it('durably replaces a Pi draft by identity without dropping an earlier artifact or adding the draft prefix', async () => {
    const { createPiRuntimeEventProjector } = await import('@happier-dev/plugins-pi/agent/runtime/rpc/events');
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const rows = new Map<string, CommittedAgentMessageBody>();
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted: async (_provider: unknown, body: CommittedAgentMessageBody, options: { localId: string }) => {
        rows.set(options.localId, body);
        return { persisted: true, delivered: false };
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'pi', createSessionForStream: () => session });
    const projector = createPiRuntimeEventProjector();
    const context = { turnId: 'turn-1', agentSessionId: 'native-pi-session', nowMs: () => 1 };
    const project = async (record: unknown, turnId = context.turnId) => {
      for (const event of projector.project(record, { ...context, turnId })) {
        await projectRuntimeTranscriptEvent({ session, provider: 'pi', runtimeMessageDeltaBridge: bridge,
          event: canonicalRuntimeEvent({ ...event, sessionId: session.sessionId }) });
      }
    };
    await project({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier artifact. ' }] } });
    await project({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'Read', args: {} });
    await project({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Draft' } });
    await project({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Corrected' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'Corrected' }] } });
    await project({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Corrected' }] } });
    await projectRuntimeTranscriptEvent({ session, provider: 'pi', runtimeMessageDeltaBridge: bridge,
      event: canonicalRuntimeEvent({ kind: 'turn-complete', turnId: 'turn-1', sessionId: session.sessionId, emittedAtMs: 2 }) });
    projector.resetTurn();
    await project({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Next turn artifact' }] } }, 'turn-2');
    expect([...rows.values()].filter((body) => body.type === 'message')).toEqual([
      { type: 'message', message: 'Earlier artifact. ' },
      { type: 'message', message: 'Corrected' },
      { type: 'message', message: 'Next turn artifact' },
    ]);
    bridge.clear();
  });

  it('retains native MCP counts only with the host selected binding identities and removes native names', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const capture = createCommittedAgentMessageCapture();
    const event = canonicalRuntimeEvent({ kind: 'mcp-tool-usage', sessionId: 'session-1', turnId: 'turn',
      emittedAtMs: 200, window: { startMs: 100, endMs: 200 }, coverage: 'complete',
      servers: [{ serverName: 'private-server-name', toolCallCount: 0, schemaBytes: null }] });
    if (event.kind !== 'mcp-tool-usage') throw new Error('Expected MCP usage fixture');
    const session = { sessionId: 'session-1', enqueueAgentMessageCommitted: capture.enqueueAgentMessageCommitted };
    await projectRuntimeTranscriptEvent({ session, provider: 'claude', event, mcpServerIdentities: {
      'private-server-name': { serverId: 'server', serverTitle: 'Private server', usage: { serverId: 'server', bindingId: 'binding', serverRevision: 10, bindingRevision: 20, catalogRevision: 40 } },
    } });
    expect(capture.bodies).toMatchObject([{ type: 'event', id: JSON.stringify([event.sessionId, event.turnId, event.sequence]), data: { type: 'mcp-binding-usage', usage: {
      sessionId: 'session-1', turnId: 'turn', coverage: 'complete', window: { startMs: 100, endMs: 200 },
      bindings: [{ serverId: 'server', bindingId: 'binding', serverRevision: 10, bindingRevision: 20, catalogRevision: 40,
        toolCallCount: 0, schemaBytes: null }],
    } } }]);
    expect(JSON.stringify(capture.bodies)).not.toContain('private-server-name');
    const retained = capture.bodies.map((body, index) => ({ id: `retained-${index}`, createdAt: 200,
      content: buildAcpAgentMessageEnvelope({ provider: 'claude', body }) }));
    const detail = projectSessionUsageWorkEvidence({ id: 'session-1', metadata: null, agentState: null }, retained);
    expect(detail.coach?.detail?.mcpUsage).toEqual([expect.objectContaining({ sessionId: 'session-1',
      turnId: 'turn', coverage: 'complete', bindings: [expect.objectContaining({ serverId: 'server', bindingId: 'binding',
        catalogRevision: 40, toolCallCount: 0 })] })]);
    const foreign = projectSessionUsageWorkEvidence({ id: 'other-session', metadata: null, agentState: null }, retained);
    expect(foreign.coach?.detail?.mcpUsage).toEqual([]);
    const absent = createCommittedAgentMessageCapture();
    await projectRuntimeTranscriptEvent({ session: { ...session, enqueueAgentMessageCommitted: absent.enqueueAgentMessageCommitted },
      provider: 'claude', event });
    expect(absent.bodies).toEqual([]);
  });
  it('preserves provider message identities from live deltas through durable commit and cold reconciliation', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { buildOpenCodeRuntimeTranscriptLocalId } = await import('../../../../../../../packages/plugins/opencode/src/agent/runtime/server/transcript/identity');
    const { openCodeTranscriptIdentityCodec } = await import('../../../../../../../packages/plugins/opencode/src/agent/runtime/server/transcript/committedIdentities');
    const stored = new Map<string, CommittedAgentMessageBody>();
    const liveIds: string[] = [];
    const session = {
      sessionId: 'session-1',
      sendAgentMessageEphemeral: (_provider: unknown, _body: unknown, opts: { localId: string }) => {
        liveIds.push(opts.localId);
        return { accepted: true as const, epoch: 0 };
      },
      enqueueAgentMessageCommitted: async (_provider: unknown, body: CommittedAgentMessageBody, opts: { localId: string }) => {
        stored.set(opts.localId, body);
        return { persisted: true, delivered: false };
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'opencode', createSessionForStream: () => session });
    const ids = ['assistant-one', 'assistant-two'].map((id) => buildOpenCodeRuntimeTranscriptLocalId('native-session', id));
    for (const [index, messageId] of ids.entries()) {
      for (const text of ['Live ', String(index)]) {
        await projectRuntimeTranscriptEvent({ session, provider: 'opencode', runtimeMessageDeltaBridge: bridge,
          event: canonicalRuntimeEvent({ kind: 'message-delta', sessionId: 'session-1', emittedAtMs: 1,
            turnId: 'same-host-turn', messageId, channel: 'assistant', text }) });
      }
    }
    expect(liveIds).toEqual(expect.arrayContaining(ids));
    await projectRuntimeTranscriptEvent({ session, provider: 'opencode', runtimeMessageDeltaBridge: bridge,
      event: canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 2, turnId: 'same-host-turn' }) });
    expect([...stored.entries()]).toEqual(ids.map((id, index) => [id, { type: 'message', message: `Live ${index}` }]));
    const facts = ids.map((localId, index) => ({ localId, sourceMessageId: ['assistant-one', 'assistant-two'][index]!, role: 'assistant' as const }));
    expect(openCodeTranscriptIdentityCodec.reconcile({ providerSessionId: 'native-session', facts, metadata: {},
      baseline: { complete: true, rows: [...stored.keys()].map((localId) => ({ localId, role: 'agent' as const, meta: {} })) } })).toEqual({
      committedSourceMessageIds: ['assistant-one', 'assistant-two'], hostAuthoredUserMessageIds: [],
      coverage: { complete: true, unmappedUsers: 0, unmappedAgents: 0 },
    });
  });

  it('persists typed completion evidence when a turn completes without streamed output', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      requiresDurableTurnCompletionMarker: true as const,
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: true as const, committedSequence: 41 })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'claude',
      createSessionForStream: () => session,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'claude',
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 3, turnId: 'turn-empty',
      }),
    })).resolves.toEqual({ projected: true, kind: 'turn-complete',
      terminalSourceMessage: { localId: 'turn-empty:task_complete', committedSequence: 41 } });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'task_complete', id: 'turn-empty' },
      expect.objectContaining({
        localId: 'turn-empty:task_complete',
        meta: { source: 'runtime', runtimeEventKind: 'turn-complete', runtimeTurnId: 'turn-empty' },
      }),
    );
  });

  it('returns the deferred committed failure anchor when a Run turn fails without streamed output', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      requiresDurableTurnCompletionMarker: true as const,
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const,
        whenCommitted: Promise.resolve({ localId: 'turn-empty:turn_failed', committedSequence: 42 }) })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'claude',
      createSessionForStream: () => session,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'claude',
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-failed', sessionId: 'session-1', emittedAtMs: 3, turnId: 'turn-empty',
        diagnostic: { code: 'provider_error', severity: 'error' },
      }),
    })).resolves.toMatchObject({ projected: true, kind: 'turn-failed',
      terminalSourceMessage: { localId: 'turn-empty:turn_failed', committedSequence: 42 } });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'turn_failed', id: 'turn-empty' },
      expect.objectContaining({
        localId: 'turn-empty:turn_failed',
        meta: { source: 'runtime', runtimeEventKind: 'turn-failed', runtimeTurnId: 'turn-empty' },
      }),
    );
  });

  it('projects public runtime message deltas through the canonical streamed transcript writer', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'cursor',
      createSessionForStream: () => session,
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: null,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        channel: 'assistant',
        text: 'Hello ',
      }),
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
        channel: 'assistant',
        text: 'world',
      }),
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 3,
        turnId: 'turn-1',
      }),
    })).resolves.toEqual({ projected: true, kind: 'turn-complete' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      { type: 'message', message: 'Hello world' },
      expect.objectContaining({
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({
            segmentKind: 'assistant',
            segmentState: 'complete',
          }),
        }),
      }),
    );
  });

  it('projects canonical assistant deltas through the same projection contract', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'claude',
      createSessionForStream: () => session,
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: null,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        channel: 'assistant',
        text: 'Claude delta shape',
      }),
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
      }),
    })).resolves.toEqual({ projected: true, kind: 'turn-complete' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'message', message: 'Claude delta shape' },
      expect.any(Object),
    );
  });

  it('routes runtime thinking deltas to thinking transcript segments instead of assistant text', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'antigravity',
      createSessionForStream: () => session,
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: null,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        channel: 'reasoning',
        text: 'Internal chain of thought',
      }),
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
      }),
    })).resolves.toEqual({ projected: true, kind: 'turn-complete' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'antigravity',
      { type: 'thinking', text: 'Internal chain of thought' },
      expect.objectContaining({
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({
            segmentKind: 'thinking',
            segmentState: 'complete',
          }),
        }),
      }),
    );
    expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith(
      'antigravity',
      { type: 'message', message: 'Internal chain of thought' },
      expect.any(Object),
    );
  });

  it('projects canonical runtime tool events through the durable transcript queue', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { createAcpToolIdentity } = await import('@/agent/acp/toolCalls');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session });

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        toolName: 'Bash',
        input: { command: 'pwd' },
      }),
    })).resolves.toEqual({ projected: true, kind: 'tool-call' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        output: { stdout: '/tmp/repo', exitCode: 0 },
      }),
    })).resolves.toEqual({ projected: true, kind: 'tool-result' });

    const toolIdentity = createAcpToolIdentity({
      sessionId: 'session-1',
      turnId: 'turn-1',
      sidechainId: null,
      toolCallId: 'call-1',
    });
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      {
        type: 'tool-call',
        callId: 'call-1',
        name: 'Bash',
        input: { command: 'pwd' },
        id: toolIdentity.callLocalId,
      },
      {
        localId: toolIdentity.callLocalId,
        meta: {
          source: 'runtime',
          runtimeEventKind: 'tool-call',
          runtimeTurnId: 'turn-1',
        },
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      {
        type: 'tool-result',
        callId: 'call-1',
        output: { stdout: '/tmp/repo', exitCode: 0 },
        id: toolIdentity.resultLocalId,
      },
      {
        localId: toolIdentity.resultLocalId,
        createdAt: 2,
        updatedAt: 2,
        meta: {
          source: 'runtime',
          runtimeEventKind: 'tool-result',
          runtimeTurnId: 'turn-1',
        },
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('publishes normalized runtime tool changes with provider turn correlation readable by Protocol', async () => {
    const {
      extractCanonicalDiffFiles,
      readTurnChangeToolMetadata,
    } = await import('../../../../../../../packages/protocol/src/sessions/messages/canonicalTurnDiffTool');
    const { NormalizedToolTurnChangeTracker } = await import('@/agent/tools/diff/normalizedToolTurnChangeTracker');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { bodies, enqueueAgentMessageCommitted } = createCommittedAgentMessageCapture();
    const session = { sessionId: 'session-1', enqueueAgentMessageCommitted };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session });
    const normalizedToolTurnChangeTracker = new NormalizedToolTurnChangeTracker({ provider: 'codex' });

    await projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'turn-start', sessionId: 'session-1', emittedAtMs: 1, turnId: 'host-turn-1',
        startedBy: 'provider',
      }),
    });
    await projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'tool-call', sessionId: 'session-1', emittedAtMs: 2, turnId: 'host-turn-1',
        toolCallId: 'edit-1', toolName: 'Edit',
        input: { file_path: 'src/runtime-edit.ts', old_string: 'before', new_string: 'after' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'tool-result', sessionId: 'session-1', emittedAtMs: 3, turnId: 'host-turn-1',
        toolCallId: 'edit-1', output: { status: 'completed' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 4, turnId: 'host-turn-1',
        agentTurnId: 'provider-turn-1',
      }),
    });

    const canonicalDiffCall = findCanonicalDiffCall(bodies);
    const metadata = readTurnChangeToolMetadata(canonicalDiffCall.input);
    expect(metadata).toMatchObject({ turnId: 'host-turn-1', provider: 'codex' });
    expect(extractCanonicalDiffFiles(canonicalDiffCall.input, metadata!)).toEqual([
      expect.objectContaining({
        filePath: 'src/runtime-edit.ts',
        source: 'provider_tool',
        confidence: 'exact',
        provider: 'codex',
        agentTurnId: 'provider-turn-1',
        providerMessageId: 'edit-1',
        oldText: 'before',
        newText: 'after',
      }),
    ]);
  });

  it('publishes Codex app-server Patch changes with provider turn correlation readable by Protocol', async () => {
    const {
      extractCanonicalDiffFiles,
      readTurnChangeToolMetadata,
    } = await import('../../../../../../../packages/protocol/src/sessions/messages/canonicalTurnDiffTool');
    const { NormalizedToolTurnChangeTracker } = await import('@/agent/tools/diff/normalizedToolTurnChangeTracker');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { bodies, enqueueAgentMessageCommitted } = createCommittedAgentMessageCapture();
    const common = {
      session: { sessionId: 'session-patch', enqueueAgentMessageCommitted },
      provider: 'codex' as const,
      runtimeMessageDeltaBridge: createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => ({ enqueueAgentMessageCommitted }) }),
      normalizedToolTurnChangeTracker: new NormalizedToolTurnChangeTracker({ provider: 'codex' }),
      toolNormalizationProtocol: 'codex' as const,
    };

    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-start', sessionId: 'session-patch', emittedAtMs: 1, turnId: 'host-turn-patch',
        startedBy: 'provider',
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'tool-call', sessionId: 'session-patch', emittedAtMs: 2, turnId: 'host-turn-patch',
        agentTurnId: 'codex-turn-patch', toolCallId: 'patch_1', toolName: 'Patch',
        input: {
          auto_approved: true,
          changes: [{
            path: 'src/file.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1,2 @@\n-old line\n+old line\n+new line\n',
          }],
        },
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'tool-result', sessionId: 'session-patch', emittedAtMs: 3, turnId: 'host-turn-patch',
        agentTurnId: 'codex-turn-patch', toolCallId: 'patch_1', output: { success: true },
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete', sessionId: 'session-patch', emittedAtMs: 4, turnId: 'host-turn-patch',
        agentTurnId: 'codex-turn-patch',
      }),
    });

    const canonicalDiffCall = findCanonicalDiffCall(bodies);
    const metadata = readTurnChangeToolMetadata(canonicalDiffCall.input);
    expect(metadata).toMatchObject({
      turnId: 'host-turn-patch',
      provider: 'codex',
    });
    expect(extractCanonicalDiffFiles(canonicalDiffCall.input, metadata!)).toEqual([
      expect.objectContaining({
        filePath: 'src/file.ts',
        source: 'provider_tool',
        confidence: 'exact',
        provider: 'codex',
        agentTurnId: 'codex-turn-patch',
        providerMessageId: 'patch_1',
        oldText: 'old line\n',
        newText: 'old line\nnew line\n',
      }),
    ]);
  });

  it.each([
    { kind: 'turn-failed' as const, expectedStatus: 'interrupted' as const },
    { kind: 'turn-cancelled' as const, expectedStatus: 'aborted' as const },
  ])('publishes pending normalized changes at the $kind terminal boundary', async ({ kind, expectedStatus }) => {
    const { readTurnChangeToolMetadata } = await import('../../../../../../../packages/protocol/src/sessions/messages/canonicalTurnDiffTool');
    const { NormalizedToolTurnChangeTracker } = await import('@/agent/tools/diff/normalizedToolTurnChangeTracker');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { bodies, enqueueAgentMessageCommitted } = createCommittedAgentMessageCapture();
    const common = {
      session: { sessionId: 'session-terminal', enqueueAgentMessageCommitted },
      provider: 'codex' as const,
      runtimeMessageDeltaBridge: createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => ({ enqueueAgentMessageCommitted }) }),
      normalizedToolTurnChangeTracker: new NormalizedToolTurnChangeTracker({ provider: 'codex' }),
      toolNormalizationProtocol: 'codex' as const,
    };

    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-start', sessionId: 'session-terminal', emittedAtMs: 1, turnId: 'host-turn-terminal',
        startedBy: 'provider',
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'tool-call', sessionId: 'session-terminal', emittedAtMs: 2, turnId: 'host-turn-terminal',
        toolCallId: 'edit-terminal', toolName: 'Edit',
        input: { file_path: 'src/terminal.ts', old_string: 'before', new_string: 'after' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'tool-result', sessionId: 'session-terminal', emittedAtMs: 3, turnId: 'host-turn-terminal',
        toolCallId: 'edit-terminal', output: { status: 'completed' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind, sessionId: 'session-terminal', emittedAtMs: 4, turnId: 'host-turn-terminal',
        ...(kind === 'turn-failed'
          ? { diagnostic: { code: 'provider_error', severity: 'error' } }
          : { cause: 'user' }),
      }),
    });

    const canonicalDiffCall = findCanonicalDiffCall(bodies);
    expect(readTurnChangeToolMetadata(canonicalDiffCall.input)).toMatchObject({
      turnId: 'host-turn-terminal',
      turnStatus: expectedStatus,
    });
  });

  it('publishes provider-native file edit events through the same durable turn change set', async () => {
    const {
      extractCanonicalDiffFiles,
      readTurnChangeToolMetadata,
    } = await import('../../../../../../../packages/protocol/src/sessions/messages/canonicalTurnDiffTool');
    const { NormalizedToolTurnChangeTracker } = await import('@/agent/tools/diff/normalizedToolTurnChangeTracker');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { bodies, enqueueAgentMessageCommitted } = createCommittedAgentMessageCapture();
    const session = { sessionId: 'session-1', enqueueAgentMessageCommitted };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', createSessionForStream: () => session });
    const normalizedToolTurnChangeTracker = new NormalizedToolTurnChangeTracker({ provider: 'codex' });
    const common = {
      session,
      provider: 'codex' as const,
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex' as const,
    };

    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-start', sessionId: 'session-1', emittedAtMs: 1, turnId: 'host-turn-1',
        startedBy: 'provider',
      }),
    });
    await expect(projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'file-edit', sessionId: 'session-1', emittedAtMs: 2, turnId: 'host-turn-1',
        agentTurnId: 'provider-turn-1', editId: 'native-edit-1', path: 'src/native-edit.ts',
        oldContent: 'before', newContent: 'after', description: 'native edit',
      }),
    })).resolves.toEqual({ projected: true, kind: 'file-edit' });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 3, turnId: 'host-turn-1',
        agentTurnId: 'provider-turn-1',
      }),
    });

    expect(bodies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'file-edit',
        filePath: 'src/native-edit.ts',
        oldContent: 'before',
        newContent: 'after',
      }),
    ]));
    const canonicalDiffCall = findCanonicalDiffCall(bodies);
    const metadata = readTurnChangeToolMetadata(canonicalDiffCall.input);
    expect(extractCanonicalDiffFiles(canonicalDiffCall.input, metadata!)).toEqual([
      expect.objectContaining({
        filePath: 'src/native-edit.ts',
        source: 'provider_native',
        confidence: 'exact',
        provider: 'codex',
        agentTurnId: 'provider-turn-1',
        providerMessageId: 'native-edit-1',
        oldText: 'before',
        newText: 'after',
        description: 'native edit',
      }),
    ]);
  });

  it('projects a committed external tool call without a streamed delta bridge', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { createAcpToolIdentity } = await import('@/agent/acp/toolCalls');
    const enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true as const,
      delivered: false as const,
    }));
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted,
    };
    const toolIdentity = createAcpToolIdentity({
      sessionId: 'session-1',
      turnId: 'external-call-1',
      sidechainId: null,
      toolCallId: 'external-call-1',
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'external-call-1',
        toolCallId: 'external-call-1',
        toolName: 'read_file',
        input: { path: '/tmp/a' },
      }),
    })).resolves.toEqual({ projected: true, kind: 'tool-call' });

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      {
        type: 'tool-call',
        callId: 'external-call-1',
        name: 'read_file',
        input: { path: '/tmp/a' },
        id: toolIdentity.callLocalId,
      },
      {
        localId: toolIdentity.callLocalId,
        meta: {
          source: 'runtime',
          runtimeEventKind: 'tool-call',
          runtimeTurnId: 'external-call-1',
        },
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
  });

  it('projects runtime user text evidence through the host session transcript port', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        text: 'terminal-origin prompt',
        messageId: 'runtime-user-1',
        role: 'user',
      }),
    })).resolves.toEqual({ projected: true, kind: 'transcript-message-committed' });

    expect(session.enqueueUserTextMessageCommitted).toHaveBeenCalledWith('terminal-origin prompt', {
      localId: 'runtime-user-1',
      meta: {
        happierProvenanceV1: {
          v: 1,
          kind: 'host',
          producer: 'runtimeTranscript',
        },
      },
      createdAt: 1,
      updatedAt: 1,
      provenance: { kind: 'non_dependent', source: 'external' },
    });
  });

  it('fences terminal durable transcript admission after its supplied deadline', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true as const,
      delivered: false as const,
    }));
    const controller = new AbortController();
    controller.abort();
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted,
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'claude',
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        messageId: 'terminal-agent-1',
        role: 'assistant',
        text: 'late terminal output',
      }),
      admission: {
        signal: controller.signal,
        deadlineAtMs: 2,
      },
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'admission_expired',
      eventKind: 'transcript-message-committed',
    });
    expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('maps a canonical durable admission expiry to the terminal resync reason', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { CommittedTranscriptAdmissionExpiredError } = await import('@/api/session/transcriptPort');
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted: vi.fn(async () => {
        throw new CommittedTranscriptAdmissionExpiredError();
      }),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'claude',
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        messageId: 'terminal-agent-expired-during-custody',
        role: 'assistant',
        text: 'terminal output that exceeded its admission window',
      }),
      admission: {
        signal: new AbortController().signal,
      },
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'admission_expired',
      eventKind: 'transcript-message-committed',
    });
  });

  it.each(['assistant', 'user'] as const)('retains the original %s durable enqueue failure as its standard cause', async (role) => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const failure = new Error('secret original durable failure');
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted: async () => { throw failure; },
      enqueueUserTextMessageCommitted: async () => { throw failure; },
    };
    const result = projectRuntimeTranscriptEvent({
      session, provider: 'claude',
      event: canonicalRuntimeEvent({ kind: 'transcript-message-committed', sessionId: 'session-1',
        emittedAtMs: 1, messageId: 'failed-custody-message', role, text: 'observed output' }),
    });
    const error = await result.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'runtime_transcript_required_admission_failed', reason: 'durable_enqueue_failed' });
    if (!(error instanceof Error)) throw new Error('Expected the typed durable admission failure');
    expect(error.cause).toBe(failure);
  });

  it.each(['assistant', 'user'] as const)('does not release ordered %s output from local custody without server delivery', async (role) => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
    };
    const admission = { signal: new AbortController().signal, requireDelivery: true };
    await expect(projectRuntimeTranscriptEvent({
      session, provider: 'opencode', admission,
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed', sessionId: 'session-1', emittedAtMs: 1,
        messageId: 'ordered-message', role, text: 'must precede acceptance',
      }),
    })).rejects.toMatchObject({ code: 'runtime_transcript_required_admission_failed' });
  });

  it('fails closed when runtime user text is rejected by durable custody', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: false as const, delivered: false as const })),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        text: 'terminal-origin prompt',
        messageId: 'runtime-user-1',
        role: 'user',
      }),
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'durable_custody_rejected',
      eventKind: 'transcript-message-committed',
    });
  });

  it('retains a deferred cancellation receipt without waiting beyond durable transcript custody', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    let commit!: (original: { localId: string; committedSequence: number }) => void;
    const whenCommitted = new Promise<{ localId: string; committedSequence: number }>(resolve => { commit = resolve; });
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const, whenCommitted })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({ provider: 'opencode', createSessionForStream: () => session });

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'opencode',
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        sessionId: 'session-1',
        emittedAtMs: 1,
        kind: 'turn-cancelled',
        turnId: 'turn-1',
        agentTurnId: 'agent-turn-1',
        cause: 'user',
      }),
    })).resolves.toEqual({ projected: true, kind: 'turn-cancelled', terminalSourceMessage: {
      localId: 'agent-turn-1:turn_cancelled', whenCommitted,
    } });
    commit({ localId: 'agent-turn-1:turn_cancelled', committedSequence: 42 });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'turn_cancelled', id: 'agent-turn-1' },
      {
        localId: 'agent-turn-1:turn_cancelled',
        meta: {
          source: 'runtime',
          runtimeEventKind: 'turn-cancelled',
          runtimeTurnId: 'turn-1',
        },
        createdAt: 1,
        updatedAt: 1,
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('rejects a final stable transcript event when the durable queue declines custody', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: false as const, delivered: false as const })),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'opencode',
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        messageId: 'turn-1:assistant',
        role: 'assistant',
        text: 'Required final answer',
      }),
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'durable_custody_rejected',
      eventKind: 'transcript-message-committed',
    });
  });

  it('rejects terminal settlement when a streamed final summary lacks durable custody', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: false, delivered: false })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({ provider: 'agent', createSessionForStream: () => session });
    runtimeMessageDeltaBridge.appendAssistantDelta({ streamKey: 'turn-1', sidechainId: null, foregroundTurnId: 'turn-1', deltaText: 'Required output' });

    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
      }),
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'streamed_final_not_durable',
      eventKind: 'turn-complete',
    });
  });

  it('fails closed for unknown event shapes and other sessions', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      event: { kind: 'provider-specific-row', sessionId: 'session-1', emittedAtMs: 1 },
    })).resolves.toEqual({ projected: false, reason: 'unsupported_event' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-2',
        emittedAtMs: 1,
        text: 'wrong session',
        messageId: 'wrong-session-user-1',
        role: 'user',
      }),
    })).resolves.toEqual({ projected: false, reason: 'session_mismatch' });

  });

  it('rejects a final stable transcript event when no durable queue is available', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'opencode',
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        messageId: 'turn-1:turn-failed',
        role: 'assistant',
        text: 'Required final failure marker',
      }),
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'durable_enqueue_unavailable',
      eventKind: 'transcript-message-committed',
    });

    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });
});
