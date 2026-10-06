import {
  AgentStateSchema, MetadataSchema, advanceSessionReceivedMessageCurrentness, applyReducedMessages,
  createRawMessageNormalizationSequenceState, createReducer, createTranscriptStreamSegmentAssembler,
  interpretTranscriptStreamSegment, isSessionMessageRowCurrent, listPendingRequests,
  normalizeRawMessageInSequence, rawRecordSchema, reducer,
  type NormalizedMessage, type OrderedTranscript, type PendingRequestFacts,
} from '@happier-dev/session-core';
import { readSharedMetadataActionConfirmationState, readSharedMetadataPresentationCompletedRequests } from '@happier-dev/session-core/pending';
import { ChangesResponseSchema, CurrentCursorResponseSchema, readSessionUpdatedMessageChangeHintV1 } from '@happier-dev/protocol/changes';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionEffectiveAccessV1Schema } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { TranscriptOpenedFollowOutputV1Schema } from '@happier-dev/protocol/actions/actionSpecs';
import type { SessionEffectiveAccessV1, SessionMessageV1, SessionMessagesPageV1, TranscriptOpenedFollowOutputV1 } from '@happier-dev/protocol';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import {
  callSocketRpc, createHappierSocket, fetchSessionMessagesPage, followSession,
  openSessionStateValue, openSessionStoredContent, repairSessionMessagesTargets,
  type FollowedSessionEvent, type OpenedSessionMessage, type SessionStoredContentContext,
} from '@happier-dev/sync-client';
import {
  createManagedConnectionSupervisor, DEFAULT_MANAGED_CONNECTION_POLICY,
  type ManagedConnectionTransport, type ManagedProbeReportScope, type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import { followTranscriptSourceWithFiniteActions } from '@happier-dev/agents/runtime/facets/transcriptSource';

import { HappierActionError, HappierClientClosedError, HappierTransportError } from '../errors.js';
import type { ActionExecute } from '../types.js';
import type { HappierSessionController, HappierSessionLiveOptions, HappierSessionSnapshot } from './types.js';

type SessionSnapshot = Record<string, unknown> & { encryptionMode: 'plain' | 'e2ee' };
type SnapshotPatch = { -readonly [K in keyof HappierSessionSnapshot]?: HappierSessionSnapshot[K] };
type LiveParams = Readonly<{
  endpoint: string; token: string; sessionId: string; hasContentCredential: boolean;
  read: (path: string, signal: AbortSignal) => Promise<unknown>;
  execute: ActionExecute;
  release: (leaseId: string) => Promise<void>;
  openContent: (snapshot: SessionSnapshot, signal: AbortSignal) => Promise<Readonly<{ context: SessionStoredContentContext; dispose: () => void }>>;
  closeSignal: AbortSignal;
  registerCloseCleanup: (close: () => Promise<void>) => () => void;
  options?: HappierSessionLiveOptions;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readSnapshot(value: unknown, sessionId: string): SessionSnapshot {
  const parsed = V2SessionByIdResponseSchema.safeParse(value);
  const session = parsed.success ? parsed.data.session : null;
  if (!session || session.id !== sessionId || (session.encryptionMode !== 'plain' && session.encryptionMode !== 'e2ee')) {
    throw new HappierTransportError('Invalid live Session snapshot.', { code: 'invalid_session_snapshot' });
  }
  return { ...session, encryptionMode: session.encryptionMode };
}

function probeFailure(error: unknown): Exclude<ReadinessProbeResult, { status: 'ready' }> {
  return error instanceof HappierTransportError && (error.status === 401 || error.status === 403)
    ? { status: 'auth_failed', statusCode: error.status, errorMessage: error.message }
    : { status: 'server_unreachable', errorMessage: error instanceof Error ? error.message : 'Live Session transport failed' };
}

const emptyTranscript = (): OrderedTranscript => ({ messageIdsOldestFirst: [], messagesById: {} });
const unavailableActions = { send: false, respondToPermission: false, answerUserAction: false, abort: false };

/** Both transports feed this one session-core interpretation. Wire readers own only transport state. */
export async function createSessionController(params: LiveParams): Promise<HappierSessionController> {
  const sessionPath = `/v2/sessions/${encodeURIComponent(params.sessionId)}?accessProjectionVersion=1`;
  const owner = new AbortController();
  const signal = AbortSignal.any([owner.signal, params.closeSignal, ...(params.options?.signal ? [params.options.signal] : [])]);
  const listeners = new Set<() => void>();
  let snapshot: HappierSessionSnapshot = {
    connection: 'connecting', history: { loading: true, hasMoreOlder: false }, transcript: emptyTranscript(),
    metadata: null, agentState: null, pendingRequests: [], actions: unavailableActions, lockedReason: null,
  };
  let rawState = createRawMessageNormalizationSequenceState();
  let reducerState = createReducer();
  let assembler = createTranscriptStreamSegmentAssembler();
  let received = new Map<string, Map<string, number>>();
  let interpretation = new AbortController();
  let facts: PendingRequestFacts = { sessionId: params.sessionId, active: false, agentState: null,
    actionConfirmations: null, presentationCompletedRequests: null, projected: null };
  let metadataVersion = -1;
  let agentStateVersion = -1;
  let metadataLayoutVersion: unknown;
  let capabilities: SessionEffectiveAccessV1['capabilities'] | null = null;
  let lastSeq = params.options?.history?.afterSeq ?? 0;
  let firstSeq: number | undefined = lastSeq > 0 ? lastSeq + 1 : undefined;
  let changesCursor = 0;
  let content: SessionStoredContentContext = { mode: 'plain' };
  let disposeContent: () => void = () => undefined;
  let selected: 'socket' | 'action' = 'socket';
  let socket: ReturnType<typeof createHappierSocket>['socket'] | undefined;
  let activeTransportSignal: AbortSignal | undefined;
  let supervisor: ReturnType<typeof createManagedConnectionSupervisor> | undefined;
  let unregisterCleanup: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  let streamOpening = Promise.resolve();

  const assertCurrent = (captured = signal) => {
    if (params.closeSignal.aborted || owner.signal.aborted) throw new HappierClientClosedError();
    captured.throwIfAborted();
    signal.throwIfAborted();
  };
  const publish = (patch: SnapshotPatch) => {
    if (signal.aborted) return;
    if (patch.history && patch.history.loading === snapshot.history.loading && patch.history.hasMoreOlder === snapshot.history.hasMoreOlder) patch.history = snapshot.history;
    if (patch.actions && Object.keys(snapshot.actions).every((key) => patch.actions![key as keyof typeof snapshot.actions] === snapshot.actions[key as keyof typeof snapshot.actions])) patch.actions = snapshot.actions;
    if (Object.entries(patch).every(([key, value]) => snapshot[key as keyof HappierSessionSnapshot] === value)) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const refreshPending = (transcript = snapshot.transcript) => {
    const messages = transcript.messageIdsOldestFirst.map((id) => transcript.messagesById[id]!);
    publish({ transcript, pendingRequests: listPendingRequests(facts, messages), actions: {
      send: facts.active && capabilities?.submitAgentInput === true,
      respondToPermission: facts.active && capabilities?.approveRuntimePermissions === true,
      answerUserAction: facts.active && capabilities?.submitAgentInput === true,
      abort: selected === 'socket' && facts.active && capabilities?.submitAgentInput === true,
    } });
  };
  const reduce = (messages: NormalizedMessage[]) => {
    const changed = reducer(reducerState, messages, facts.agentState);
    // The canonical read model preserves prior snapshots and unchanged
    // Message/order references.
    const transcript = applyReducedMessages(snapshot.transcript, changed.messages);
    refreshPending(transcript);
  };
  const applyRows = (rows: readonly OpenedSessionMessage[], authoritative: boolean) => {
    if (signal.aborted) return;
    const normalized: NormalizedMessage[] = [];
    for (const row of rows) {
      const updatedAt = row.updatedAt ?? row.createdAt;
      const previous = received.get(params.sessionId)?.get(row.id);
      if (!isSessionMessageRowCurrent({ existingUpdatedAt: previous, incomingUpdatedAt: updatedAt, isAuthoritativeUpdate: authoritative })) continue;
      // Failed stored content is still an authoritative row. The canonical
      // normalizer owns its visible unsupported-content representation.
      const message = normalizeRawMessageInSequence({ id: row.id, localId: row.localId ?? undefined,
        sidechainId: row.sidechainId ?? undefined, createdAt: row.createdAt, seq: row.seq,
        messageRole: row.messageRole ?? undefined, raw: row.opened.status === 'ready' ? row.opened.value : null }, rawState);
      if (message) normalized.push(authoritative ? { ...message, isAuthoritativeUpdate: true } : message);
      if (row.opened.status === 'locked') publish({ lockedReason: 'session_content_locked' });
      advanceSessionReceivedMessageCurrentness(received, params.sessionId, row.id, updatedAt);
      firstSeq = firstSeq === undefined ? row.seq : Math.min(firstSeq, row.seq);
      if (!authoritative) lastSeq = Math.max(lastSeq, row.seq);
    }
    if (normalized.length) reduce(normalized);
    publish({ history: { ...snapshot.history, loading: false } });
  };
  const openField = async (value: unknown, captured: AbortSignal): Promise<unknown> => {
    if (value === undefined) return null;
    if (value !== null && typeof value !== 'string') throw new HappierTransportError('Invalid Session stored field.', { code: 'invalid_session_snapshot' });
    const opened = await openSessionStateValue(content, value);
    assertCurrent(captured);
    if (opened.status !== 'ready') throw new HappierTransportError('The Session field could not be opened.', { code: opened.status });
    return opened.value;
  };
  const applyAgentState = (value: unknown, version: number) => {
    if (version <= agentStateVersion) return;
    const parsed = value === null ? null : AgentStateSchema.safeParse(value);
    if (parsed && !parsed.success) throw new HappierTransportError('Invalid opened Agent state.', { code: 'invalid_session_snapshot' });
    agentStateVersion = version;
    facts = { ...facts, agentState: parsed?.success ? parsed.data : null };
    publish({ agentState: facts.agentState });
    reduce([]);
  };
  const applyMetadata = (value: unknown, version: number) => {
    if (version <= metadataVersion) return;
    const parsed = value === null ? null : MetadataSchema.safeParse(value);
    if (parsed && !parsed.success) throw new HappierTransportError('Invalid opened Session metadata.', { code: 'invalid_session_snapshot' });
    metadataVersion = version;
    facts = { ...facts, actionConfirmations: readSharedMetadataActionConfirmationState(value, metadataLayoutVersion),
      presentationCompletedRequests: readSharedMetadataPresentationCompletedRequests(value, metadataLayoutVersion) };
    publish({ metadata: parsed?.success ? parsed.data : null });
    refreshPending();
  };
  const updateSnapshot = async (raw: SessionSnapshot, captured: AbortSignal) => {
    assertCurrent(captured);
    if (raw.encryptionMode !== content.mode && selected === 'socket') throw new HappierTransportError('The Session encryption mode changed.', { code: 'session_content_mode_mismatch' });
    if ((typeof raw.metadataVersion === 'number' ? raw.metadataVersion : 0) > metadataVersion) metadataLayoutVersion = raw.metadataLayoutVersion;
    const numberOrNull = (value: unknown) => typeof value === 'number' ? value : null;
    const projected = {
      permissionCount: numberOrNull(raw.pendingPermissionRequestCount), userActionCount: numberOrNull(raw.pendingUserActionRequestCount),
      observedAt: numberOrNull(raw.pendingRequestObservedAt), referenceAt: numberOrNull(raw.updatedAt),
    };
    const factsChanged = facts.active !== (raw.active === true) || !facts.projected
      || Object.keys(projected).some((key) => projected[key as keyof typeof projected] !== facts.projected![key as keyof typeof projected]);
    facts = { ...facts, active: raw.active === true, projected };
    const access = SessionEffectiveAccessV1Schema.safeParse(raw.effectiveAccess);
    const nextCapabilities = access.success ? access.data.capabilities : null;
    const capabilitiesChanged = capabilities?.submitAgentInput !== nextCapabilities?.submitAgentInput
      || capabilities?.approveRuntimePermissions !== nextCapabilities?.approveRuntimePermissions;
    capabilities = nextCapabilities;
    // C01's Send evaluator admits agent-question answers with message.send (R-X2).
    if (selected === 'socket') {
      applyMetadata(await openField(raw.metadata, captured), typeof raw.metadataVersion === 'number' ? raw.metadataVersion : 0);
      applyAgentState(await openField(raw.agentState, captured), typeof raw.agentStateVersion === 'number' ? raw.agentStateVersion : 0);
    }
    if (factsChanged || capabilitiesChanged) refreshPending();
  };
  const fetchPage = (afterSeq: number, captured: AbortSignal) => fetchSessionMessagesPage({
    sessionId: params.sessionId, scope: 'all', afterSeq, signal: captured,
    requestJson: (path, requestSignal) => params.read(path, requestSignal ?? captured),
  });
  const openRows = async (rows: readonly (SessionMessageV1 & { openFailure?: TranscriptOpenedFollowOutputV1['items'][number]['openFailure'] })[], captured: AbortSignal) => {
    const context: SessionStoredContentContext = selected === 'action' ? { mode: 'plain' } : content;
    const opened = await Promise.all(rows.map(async (row): Promise<OpenedSessionMessage> => ({ ...row,
      opened: row.openFailure ? { status: row.openFailure } : await openSessionStoredContent(context, row.content) })));
    assertCurrent(captured);
    return opened;
  };
  const openedFollow = async (cursor: string, leaseId: string, captured: AbortSignal, waitForChanges = false) => {
    const value = await params.execute('transcript.follow', { sessionId: params.sessionId, cursor, leaseId,
      projection: 'openedMessagesV1', agentStateVersion, sharedMetadataVersion: metadataVersion, waitForChanges }, { signal: captured });
    assertCurrent(captured);
    const parsedResult = TranscriptOpenedFollowOutputV1Schema.safeParse(value);
    if (!parsedResult.success) throw new HappierTransportError('The daemon did not return opened Session rows.', { code: 'opened_messages_projection_unavailable' });
    const parsed = parsedResult.data;
    if (parsed.agentState) applyAgentState(parsed.agentState.value, parsed.agentState.version);
    if (parsed.sharedMetadata && parsed.sharedMetadata.version > metadataVersion) {
      // The daemon returns the recipient-safe v1 projection, including for a
      // legacy stored layout. Its representation—not the ciphertext's layout—
      // is the canonical pending-facts reader's input.
      metadataLayoutVersion = SESSION_METADATA_LAYOUT_VERSION_V1;
      applyMetadata(parsed.sharedMetadata.value, parsed.sharedMetadata.version);
    }
    return parsed;
  };
  const reset = () => {
    interpretation.abort(); interpretation = new AbortController();
    rawState = createRawMessageNormalizationSequenceState(); reducerState = createReducer();
    assembler = createTranscriptStreamSegmentAssembler(); received = new Map();
    lastSeq = 0; firstSeq = undefined; metadataVersion = -1; agentStateVersion = -1;
    facts = { ...facts, agentState: null, actionConfirmations: null, presentationCompletedRequests: null };
    publish({ transcript: emptyTranscript(), metadata: null, agentState: null, pendingRequests: [], history: { loading: true, hasMoreOlder: false } });
  };
  const readChanges = async (captured: AbortSignal): Promise<Readonly<{ targets: readonly { messageId: string; seq: number }[]; cursor: number; reset: boolean; changed: boolean }>> => {
    try {
      let cursor = changesCursor;
      const targets: { messageId: string; seq: number }[] = [];
      let changed = false;
      for (;;) {
        const page = ChangesResponseSchema.parse(await params.read(`/v2/changes?after=${cursor}&sessionId=${encodeURIComponent(params.sessionId)}`, captured));
        assertCurrent(captured);
        changed ||= page.changes.some((change) => (change.kind === 'session' || change.kind === 'share') && change.entityId === params.sessionId);
        targets.push(...page.changes.flatMap((change) => { const hint = readSessionUpdatedMessageChangeHintV1(change); return hint ? [hint] : []; }));
        // The server filters only after paging raw Account changes. An empty
        // visible page is not the tail; its raw cursor must stop progressing.
        if (page.nextCursor <= cursor) return { targets, cursor, reset: false, changed };
        cursor = page.nextCursor;
      }
    } catch (error) {
      assertCurrent(captured);
      if (!(error instanceof HappierTransportError) || error.status !== 410) throw error;
      reset();
      const cursor = CurrentCursorResponseSchema.parse(await params.read('/v2/cursor', captured)).cursor;
      assertCurrent(captured);
      return { targets: [], cursor, reset: true, changed: true };
    }
  };
  const onEvent = (event: FollowedSessionEvent, captured: AbortSignal, scope: ManagedProbeReportScope | undefined) => {
    if (captured.aborted || signal.aborted) return;
    if (event.kind === 'messages') applyRows(event.messages, false);
    else if (event.kind === 'message-updated') applyRows([event.message], true);
    else if (event.kind === 'session-updated') {
      const update = event.update;
      if (update.metadataLayoutVersion !== undefined && update.metadata && update.metadata.version > metadataVersion) metadataLayoutVersion = update.metadataLayoutVersion;
      if (update.active !== undefined) facts = { ...facts, active: update.active };
      if (event.agentState?.status === 'ready' && update.agentState) applyAgentState(event.agentState.value, update.agentState.version);
      if (update.metadata) void openField(update.metadata.value, captured).then((value) => {
        if (!captured.aborted) applyMetadata(value, update.metadata!.version);
      }).catch((error: unknown) => { if (!captured.aborted) supervisor?.reportProbeResult?.(probeFailure(error), scope); });
      refreshPending();
    } else {
      streamOpening = streamOpening.then(async () => {
        if (captured.aborted || signal.aborted) return;
        const opened = await openSessionStoredContent(content, event.segment.message.content);
        if (captured.aborted || signal.aborted) return;
        const parsed = opened.status === 'ready' ? rawRecordSchema.safeParse(opened.value) : null;
        const frame = event.segment;
        const interpreted = interpretTranscriptStreamSegment({ assembler, sessionId: params.sessionId,
          record: parsed?.success ? parsed.data : null, message: event.segment.message,
          rawMessageNormalizationState: rawState,
          ...(frame.type === 'transcript-stream-segment-delta'
            ? { type: frame.type, tick: frame.message.tick, baseLength: frame.message.baseLength }
            : { type: frame.type, tick: frame.message.tick }) });
        if (interpreted) reduce([interpreted]);
      }).catch((error: unknown) => { if (!captured.aborted) supervisor?.reportProbeResult?.(probeFailure(error), scope); });
    }
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    owner.abort(new HappierClientClosedError());
    closePromise = Promise.resolve().then(async () => { await supervisor?.stop(); }).finally(() => {
      unregisterCleanup?.(); signal.removeEventListener('abort', onAbort); disposeContent();
      snapshot = { ...snapshot, connection: 'closed', actions: unavailableActions };
      for (const listener of listeners) listener();
      listeners.clear();
    });
    return closePromise;
  };
  const onAbort = () => { void close().catch(() => undefined); };
  unregisterCleanup = params.registerCloseCleanup(close);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    assertCurrent();
    // Capture invalidations before reading state so an activity/access change
    // during bootstrap is included in subsequent change-feed reconciliation.
    if (params.options?.transport !== 'action') changesCursor = CurrentCursorResponseSchema.parse(await params.read('/v2/cursor', signal)).cursor;
    assertCurrent();
    const initial = readSnapshot(await params.read(sessionPath, signal), params.sessionId);
    assertCurrent();
    selected = params.options?.transport === undefined || params.options.transport === 'auto'
      ? initial.encryptionMode === 'plain' || params.hasContentCredential ? 'socket' : 'action'
      : params.options.transport;
    const opened = selected === 'socket' ? await params.openContent(initial, signal) : { context: { mode: 'plain' } as const, dispose: () => undefined };
    if (signal.aborted) { opened.dispose(); assertCurrent(); }
    content = opened.context; disposeContent = opened.dispose;
    assertCurrent();
    await updateSnapshot(initial, signal);
    const initialAfterSeq = params.options?.history?.afterSeq ?? 0;
    if (initialAfterSeq > 0) {
      // Sequence numbers may be sparse. Only an authoritative page proves
      // that rows exist before the caller's selected history boundary.
      const older = await fetchSessionMessagesPage({ sessionId: params.sessionId, scope: 'all',
        beforeSeq: initialAfterSeq + 1, signal,
        requestJson: (path, requestSignal) => params.read(path, requestSignal ?? signal) });
      assertCurrent();
      publish({ history: { loading: true, hasMoreOlder: older.messages.length > 0 } });
    }
    let firstConnect = true;

    const repairOpenedMessages = async (targets: readonly { messageId: string; seq: number }[], captured: AbortSignal) => {
      if (!targets.length) return;
      const leaseId = crypto.randomUUID();
      try {
        await repairSessionMessagesTargets({ targets, signal: captured,
          fetchPage: async (afterSeq) => { const page = await openedFollow(String(afterSeq), leaseId, captured);
            return { messages: page.items, hasMore: page.truncated, nextAfterSeq: Number(page.nextCursor ?? afterSeq) }; },
          onPage: async (rows, targetIds) => applyRows(await openRows(rows.filter((row) => targetIds.has(row.id)), captured), true),
        });
      } finally { await params.release(leaseId); }
    };

    const createTransport = (): ManagedConnectionTransport => {
      const scope = supervisor?.captureProbeReportScope?.();
      const child = new AbortController();
      const captured = AbortSignal.any([signal, child.signal]);
      activeTransportSignal = captured;
      const beforeConnect = async () => {
        const changes = await readChanges(captured);
        if (!firstConnect || changes.changed || changes.reset) {
          await updateSnapshot(readSnapshot(await params.read(sessionPath, captured), params.sessionId), captured);
        }
        firstConnect = false;
        return changes;
      };
      if (selected === 'socket') {
        const viewer = createHappierSocket({ endpoint: params.endpoint, token: params.token,
          clientType: 'session-scoped', sessionId: params.sessionId, clientPurpose: 'sdk-live',
          authExtras: buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) });
        socket = viewer.socket;
        return {
          ...viewer.transport,
          connect: async () => {
            const followed = followSession({ sessionId: params.sessionId, afterSeq: lastSeq, content, signal: captured,
              connection: { on: (event, handler) => { viewer.socket.on(event, handler); return () => viewer.socket.off(event, handler); },
                onConnected: viewer.transport.onConnected },
              fetchPage, onEvent: (event) => onEvent(event, captured, scope),
              onError: (error) => { if (!captured.aborted) supervisor?.reportProbeResult?.(probeFailure(error), scope); },
            });
            // Bind first, connect, then read changes: repairs of old rows must
            // not fall between the change-feed read and viewer subscription.
            await viewer.transport.connect();
            const changes = await beforeConnect();
            changesCursor = changes.cursor;
            // This follower was bound before connection with the old message
            // watermark. A cursor reset invalidates that binding; the existing
            // supervisor recreates it from the reset canonical lastSeq.
            if (changes.reset) throw new HappierTransportError('The Session history cursor was reset.', { code: 'session_cursor_reset' });
            await followed.repair(changes.targets);
            assertCurrent(captured);
          },
          disconnect: async (options) => { child.abort(); await viewer.transport.disconnect(options); },
          destroy: async () => { child.abort(); await viewer.transport.destroy(); },
        };
      }
      let runner: Promise<void> | undefined;
      const connectedListeners = new Set<() => void>();
      let connected = false;
      return {
        isConnected: () => connected && !captured.aborted,
        onConnected: (listener) => { connectedListeners.add(listener); return () => { connectedListeners.delete(listener); }; },
        onDisconnected: () => () => {},
        onError: () => () => {},
        connect: async () => {
          if (!firstConnect) {
            reset();
            await updateSnapshot(readSnapshot(await params.read(sessionPath, captured), params.sessionId), captured);
          }
          firstConnect = false;
          assertCurrent(captured);
          const leaseId = crypto.randomUUID();
          runner = followTranscriptSourceWithFiniteActions<SessionMessageV1>({ initialCursor: String(lastSeq), leaseId,
            stopWhenInactive: false,
            follow: async ({ cursor }) => {
              const page = await openedFollow(cursor, leaseId, captured, true);
              if (page.changes?.some((change) => change.kind === 'reset')) {
                reset();
                throw new HappierTransportError('The Session observation reconnected; reload authoritative history.', { code: 'session_cursor_reset' });
              }
              const targets = page.changes?.flatMap((change) => change.kind === 'revision' ? [{ messageId: change.messageId, seq: change.seq }] : []) ?? [];
              await repairOpenedMessages(targets, captured);
              if (page.changes?.some((change) => change.kind === 'session')) {
                await updateSnapshot(readSnapshot(await params.read(sessionPath, captured), params.sessionId), captured);
              }
              applyRows(await openRows(page.items, captured), false);
              return page;
            }, release: async () => params.release(leaseId),
            isSessionActive: async () => {
              return facts.active;
            }, waitForNextPoll: async () => {},
            shouldContinue: () => !captured.aborted,
          }).then(() => undefined).catch((error: unknown) => {
            if (captured.aborted) return;
            supervisor?.reportProbeResult?.(probeFailure(error), scope);
          });
          connected = true;
          for (const listener of connectedListeners) listener();
        },
        disconnect: async () => { connected = false; child.abort(); },
        destroy: async () => { connected = false; child.abort(); await runner; },
      };
    };
    supervisor = createManagedConnectionSupervisor({ ...DEFAULT_MANAGED_CONNECTION_POLICY, createTransport,
      probeReadiness: async () => { try { readSnapshot(await params.read(sessionPath, signal), params.sessionId); return { status: 'ready' }; } catch (error) { return probeFailure(error); } },
      classifyTransportErrorToProbeResult: probeFailure,
      onStateChange: (state) => publish({ connection: state.phase === 'shutting_down' ? 'closed'
        : state.phase === 'connecting' || state.phase === 'idle' ? state.lastConnectedAt === null ? 'connecting' : 'reconnecting' : state.phase }),
    });
    await supervisor.start();
    assertCurrent();
  } catch (error) { await close(); throw error; }

  const call = async (method: string, value: unknown, callerSignal?: AbortSignal) => {
    const captured = AbortSignal.any([signal, ...(activeTransportSignal ? [activeTransportSignal] : []), ...(callerSignal ? [callerSignal] : [])]);
    assertCurrent(captured);
    if (!socket || !socket.connected) throw new HappierTransportError('The Session viewer is not connected.', { code: 'session_offline' });
    if (content.mode === 'e2ee' && !content.encryption) throw new HappierTransportError('The Session content is locked.', { code: 'session_content_locked' });
    const result = await callSocketRpc({ socket, target: { kind: 'session', id: params.sessionId }, method, params: value,
      content: content.mode === 'plain' ? content : { mode: 'e2ee', cipher: content.encryption! }, signal: captured });
    assertCurrent(captured);
    return result;
  };
  const actionOptions = (callerSignal?: AbortSignal) => ({ signal: AbortSignal.any([signal, ...(callerSignal ? [callerSignal] : [])]) });
  const controller: HappierSessionController = {
    sessionId: params.sessionId, transport: selected, getSnapshot: () => snapshot,
    subscribe: (listener) => { if (snapshot.connection !== 'closed') listeners.add(listener); return () => { listeners.delete(listener); }; },
    close,
    loadOlder: async (options) => {
      const captured = AbortSignal.any([actionOptions(options?.signal).signal, interpretation.signal]); assertCurrent(captured);
      if (!snapshot.history.hasMoreOlder || firstSeq === undefined) return { hasMore: false };
      // The Action transport uses the existing finite cursor owner for older pages.
      // Socket pages retain the canonical protocol page parser and content owner.
      if (selected === 'action') {
        const before = firstSeq;
        let reachedAnchor = false;
        const leaseId = crypto.randomUUID();
        await followTranscriptSourceWithFiniteActions<SessionMessageV1>({ initialCursor: '0', leaseId,
          follow: async ({ cursor }) => {
            const page = await openedFollow(cursor, leaseId, captured);
            reachedAnchor = page.items.some((row) => row.seq >= before) || !page.truncated;
            applyRows(await openRows(page.items.filter((row) => row.seq < before), captured), false);
            return page;
          }, release: async () => params.release(leaseId), isSessionActive: async () => false,
          waitForNextPoll: () => Promise.resolve(), shouldContinue: () => !captured.aborted && !reachedAnchor,
        });
        assertCurrent(captured);
        // The finite owner drained from the beginning through the anchor;
        // all older rows are now loaded, even if their sequences are sparse.
        publish({ history: { loading: false, hasMoreOlder: false } }); return { hasMore: false };
      }
      const page: SessionMessagesPageV1 = await fetchSessionMessagesPage({ sessionId: params.sessionId, scope: 'all', beforeSeq: firstSeq,
        signal: captured, requestJson: (path, requestSignal) => params.read(path, requestSignal ?? captured) });
      applyRows(await openRows(page.messages, captured), false); assertCurrent(captured);
      const hasMore = page.hasMore === true; publish({ history: { loading: false, hasMoreOlder: hasMore } }); return { hasMore };
    },
    send: async (message, options) => {
      const captured = actionOptions(options?.signal).signal; assertCurrent(captured);
      const result = await params.execute('session.message.send', { sessionId: params.sessionId, message,
        ...(options?.localId ? { localId: options.localId } : {}) }, { signal: captured }); assertCurrent(captured); return result;
    },
    respondToPermission: async (response, options) => {
      assertCurrent();
      if (selected === 'socket') await call(RPC_METHODS.SESSION_PERMISSION_RESPOND, response, options?.signal);
      else { const captured = actionOptions(options?.signal).signal;
        assertCurrent(captured);
        const result = await params.execute('session.permission.respond', { ...response, sessionId: params.sessionId,
          requestId: response.id, decision: response.decision ?? (response.approved ? 'approved' : 'denied') }, { signal: captured });
        assertCurrent(captured); if (record(result)?.ok === false) throw new HappierActionError('permission_response_rejected', 'Permission response rejected.'); }
    },
    answerUserAction: async (requestId, answers, options) => {
      assertCurrent();
      if (selected === 'socket') await call(RPC_METHODS.SESSION_USER_ACTION_ANSWER, { id: requestId, answers }, options?.signal);
      else { const captured = actionOptions(options?.signal).signal;
        await params.execute('session.user_action.answer', { sessionId: params.sessionId, requestId,
          answers: Object.entries(answers).map(([question, values]) => ({ question, values: [...values] })) }, { signal: captured }); assertCurrent(captured); }
    },
    abort: async (options) => { assertCurrent(actionOptions(options?.signal).signal); if (selected === 'action') throw new HappierActionError('session_abort_unavailable', 'The Action transport does not provide an abort Action.'); await call('abort', {}, options?.signal); },
  };
  return Object.freeze(controller);
}
