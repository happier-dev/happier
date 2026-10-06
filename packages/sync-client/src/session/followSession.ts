import { EphemeralUpdateSchema, UpdateContainerSchema } from '@happier-dev/protocol/updates';
import type { EphemeralUpdate, UpdateBody } from '@happier-dev/protocol/updates';
import type { SessionMessageV1, SessionMessagesPageV1 } from '@happier-dev/protocol';
import { openSessionStateValue, openSessionStoredContent, type OpenSessionStoredContentResult, type SessionStoredContentContext } from '../content/sessionStoredContent.js';
import { drainSessionMessagesAfter } from '../messages/drainSessionMessagesAfter.js';
import { repairSessionMessagesTargets, type SessionMessageRepairTarget } from '../messages/repairSessionMessagesTargets.js';
import { throwIfAborted } from '../abortSignal.js';

export type OpenedSessionMessage = Readonly<SessionMessageV1 & { opened: OpenSessionStoredContentResult }>;
export type SessionUpdateBody = Extract<UpdateBody, { t: 'update-session' }>;
export type TranscriptStreamSegmentEphemeralMessage = Extract<EphemeralUpdate, { type: 'transcript-stream-segment' }>;
export type TranscriptStreamSegmentDeltaEphemeralMessage = Extract<EphemeralUpdate, { type: 'transcript-stream-segment-delta' }>;
export type FollowedSessionEvent =
  | Readonly<{ kind: 'messages'; messages: readonly OpenedSessionMessage[]; source: 'history' | 'catch-up' | 'live' }>
  | Readonly<{ kind: 'message-updated'; message: OpenedSessionMessage }>
  | Readonly<{ kind: 'session-updated'; update: SessionUpdateBody; agentState?: OpenSessionStoredContentResult }>
  | Readonly<{ kind: 'stream-segment'; segment: TranscriptStreamSegmentEphemeralMessage | TranscriptStreamSegmentDeltaEphemeralMessage }>;
export type FollowSessionParams = Readonly<{
  connection: Readonly<{
    on(event: 'update' | 'ephemeral', handler: (data: unknown) => void): () => void;
    onConnected(listener: () => void): () => void;
  }>;
  sessionId: string; afterSeq: number;
  fetchPage: (afterSeq: number, signal: AbortSignal) => Promise<SessionMessagesPageV1>;
  content: SessionStoredContentContext;
  onEvent: (event: FollowedSessionEvent) => void;
  onError: (error: unknown) => void;
  signal: AbortSignal;
}>;

export function followSession(params: FollowSessionParams): Readonly<{ lastSeq(): number; repair(targets: readonly SessionMessageRepairTarget[]): Promise<void> }> {
  let lastSeq = params.afterSeq;
  let alive = !params.signal.aborted;
  let needsDrain = true;
  let initial = true;
  let processing = false;
  let gapTarget: number | null = null;
  const controller = new AbortController();
  const messages = new Map<number, SessionMessageV1>();
  const revisions: SessionMessageV1[] = [];
  const otherEvents: Array<Readonly<{ kind: 'session'; update: SessionUpdateBody }> | Readonly<{ kind: 'stream'; segment: TranscriptStreamSegmentEphemeralMessage | TranscriptStreamSegmentDeltaEphemeralMessage }>> = [];
  const detach: Array<() => void> = [];
  const stop = () => {
    if (!alive) return;
    alive = false;
    controller.abort();
    for (const dispose of detach.splice(0)) dispose();
    messages.clear(); revisions.length = 0; otherEvents.length = 0;
    params.signal.removeEventListener('abort', stop);
  };
  const fail = (error: unknown) => {
    if (!alive) return;
    stop();
    params.onError(error);
  };
  const opened = async (message: SessionMessageV1): Promise<OpenedSessionMessage> => ({ ...message, opened: await openSessionStoredContent(params.content, message.content) });
  const emit = (event: FollowedSessionEvent) => { if (alive && !params.signal.aborted) params.onEvent(event); };

  const pump = async () => {
    if (processing || !alive) return;
    processing = true;
    try {
      while (alive) {
        if (needsDrain) {
          needsDrain = false;
          const source = initial ? 'history' as const : 'catch-up' as const;
          initial = false;
          await drainSessionMessagesAfter({
            afterSeq: lastSeq, fetchPage: params.fetchPage, signal: controller.signal,
            onPage: async (page) => {
              const batch = await Promise.all(page.map(opened));
              throwIfAborted(controller.signal);
              if (batch.length) lastSeq = batch[batch.length - 1].seq;
              emit({ kind: 'messages', messages: batch, source });
            },
          });
          if (gapTarget !== null && lastSeq >= gapTarget) gapTarget = null;
          if (needsDrain) continue;
        }
        for (const seq of messages.keys()) if (seq <= lastSeq) messages.delete(seq);
        let nextSeq: number | null = null;
        for (const seq of messages.keys()) if (nextSeq === null || seq < nextSeq) nextSeq = seq;
        if (nextSeq !== null) {
          if (nextSeq !== lastSeq + 1 && nextSeq !== gapTarget) {
            gapTarget = nextSeq;
            needsDrain = true;
            continue;
          }
          const message = messages.get(nextSeq)!;
          messages.delete(nextSeq);
          const row = await opened(message);
          throwIfAborted(controller.signal);
          lastSeq = row.seq;
          gapTarget = null;
          emit({ kind: 'messages', messages: [row], source: 'live' });
          continue;
        }
        if (revisions.length) {
          revisions.sort((left, right) => left.seq - right.seq);
          const message = revisions.shift()!;
          const row = await opened(message);
          throwIfAborted(controller.signal);
          emit({ kind: 'message-updated', message: row });
          continue;
        }
        const event = otherEvents.shift();
        if (event) {
          if (event.kind === 'stream') emit({ kind: 'stream-segment', segment: event.segment });
          else {
            const agentState = event.update.agentState ? await openSessionStateValue(params.content, event.update.agentState.value) : undefined;
            throwIfAborted(controller.signal);
            emit({ kind: 'session-updated', update: event.update, ...(agentState ? { agentState } : {}) });
          }
          continue;
        }
        break;
      }
    } catch (error) { fail(error); }
    finally { processing = false; }
  };
  const wake = () => { void pump(); };
  if (alive) {
    detach.push(params.connection.on('update', (data) => {
      // Routing precedes full payload validation: another Session's malformed
      // content cannot stop this follower. Our own rows remain strictly parsed.
      if (data && typeof data === 'object' && 'body' in data) {
        const body = data.body;
        if (body && typeof body === 'object' && 't' in body) {
          const id = (body.t === 'new-message' || body.t === 'message-updated') && 'sid' in body ? body.sid
            : body.t === 'update-session' && 'id' in body ? body.id : undefined;
          if (typeof id === 'string' && id !== params.sessionId) return;
        }
      }
      const parsed = UpdateContainerSchema.safeParse(data);
      if (!parsed.success) { fail(parsed.error); return; }
      const body = parsed.data.body;
      if (body.t === 'new-message' || body.t === 'message-updated') {
        if (body.sid !== params.sessionId) return;
        if (body.message.seq > lastSeq && !messages.has(body.message.seq)) messages.set(body.message.seq, body.message);
        if (body.t === 'message-updated') revisions.push(body.message);
      } else if (body.t === 'update-session' && body.id === params.sessionId) otherEvents.push({ kind: 'session', update: body });
      wake();
    }));
    detach.push(params.connection.on('ephemeral', (data) => {
      if (data && typeof data === 'object' && 'type' in data && 'sessionId' in data
        && (data.type === 'transcript-stream-segment' || data.type === 'transcript-stream-segment-delta')
        && typeof data.sessionId === 'string' && data.sessionId !== params.sessionId) return;
      const parsed = EphemeralUpdateSchema.safeParse(data);
      if (!parsed.success) { fail(parsed.error); return; }
      const event = parsed.data;
      if ((event.type === 'transcript-stream-segment' || event.type === 'transcript-stream-segment-delta') && event.sessionId === params.sessionId) {
        otherEvents.push({ kind: 'stream', segment: event });
        wake();
      }
    }));
    detach.push(params.connection.onConnected(() => {
      needsDrain = true;
      wake();
    }));
    params.signal.addEventListener('abort', stop, { once: true });
    if (params.signal.aborted) stop(); else wake();
  } else controller.abort();
  return {
    lastSeq: () => lastSeq,
    async repair(targets) {
      throwIfAborted(controller.signal);
      try {
        await repairSessionMessagesTargets({
          targets, fetchPage: params.fetchPage, signal: controller.signal,
          onPage: async (page, targetIds) => {
            const batch = await Promise.all(page.filter((message) => targetIds.has(message.id)).map(opened));
            throwIfAborted(controller.signal);
            for (const message of batch) emit({ kind: 'message-updated', message });
          },
        });
      } catch (error) { fail(error); throw error; }
    },
  };
}
