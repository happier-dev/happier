import type { Socket } from 'socket.io-client';
import { applyCliActionAutomationUpdateV1, reconnectCliActionAutomationsV1 } from '@/api/actionAutomations';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { createSessionScopedSocket, createSessionScopedSocketConnection, createUserScopedSocketConnection } from '@/api/session/sockets';
import { createManagedConnectionSupervisor, DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import { createAuthenticationHttpStatusError } from '@/api/client/httpStatusError';
import { SessionMessageContentSchema } from '@/api/types';
import { UpdateContainerSchema, EphemeralUpdateSchema } from '@happier-dev/protocol/updates';
import type { UpdateContainer } from '@happier-dev/protocol/updates';
import { decodeBase64, decrypt } from '@/api/encryption';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { summarizeAgentState, waitForIdleObservation, type AgentStateSummary, type IdleSocketObserver, type SessionTurnActivity } from '@happier-dev/session-core/transcript';
export { isIdle, summarizeAgentState, type AgentStateSummary } from '@happier-dev/session-core/transcript';
import type { SessionEncryptionContext, SessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionControlWaitIdleConfirmMs } from '@/session/transport/shared/sessionTimeouts';

/** The shared session event transport; consumers re-read their own canonical facts. */
export function observeSessionSocketEvents(
  opts: { token: string; sessionId?: string; serverUrl?: string; scope?: 'user' },
  handlers: { onUpdate?: (value: unknown) => void; onEphemeral?: (value: unknown) => void; onConnected?: () => void; onError: (error: unknown) => void },
): Readonly<{ dispose: () => Promise<void> }> {
  const supervisor = createManagedConnectionSupervisor({
    ...DEFAULT_MANAGED_CONNECTION_POLICY,
    createTransport: () => {
      const connection = (() => {
        if (opts.scope === 'user') return createUserScopedSocketConnection(opts);
        if (!opts.sessionId) throw new Error('session_observation_id_required');
        return createSessionScopedSocketConnection({ ...opts, sessionId: opts.sessionId });
      })();
      const update = (value: unknown) => {
        const parsed = UpdateContainerSchema.safeParse(value);
        if (parsed.success) applyCliActionAutomationUpdateV1({ token: opts.token,
          serverHttpBaseUrl: opts.serverUrl ?? resolveServerHttpBaseUrl(), body: parsed.data.body });
        handlers.onUpdate?.(value);
      };
      const ephemeral = (value: unknown) => handlers.onEphemeral?.(value);
      connection.socket.on('update', update);
      connection.socket.on('ephemeral', ephemeral);
      // Also consume connect directly so every reconnection invalidates a reader's baseline.
      const connected = () => handlers.onConnected?.();
      connection.socket.on('connect', connected);
      return { ...connection.transport, destroy: async () => {
        connection.socket.off('update', update);
        connection.socket.off('ephemeral', ephemeral);
        connection.socket.off('connect', connected);
        await connection.transport.destroy();
      } };
    },
    probeReadiness: async () => ({ status: 'ready' }),
    onConnected: ({ state }) => {
      if (state.lastDisconnectedAt !== null) reconnectCliActionAutomationsV1({ token: opts.token,
        serverHttpBaseUrl: opts.serverUrl ?? resolveServerHttpBaseUrl() });
    },
    classifyTransportErrorToProbeResult,
    onAuthFailed: ({ probe }) => handlers.onError(createAuthenticationHttpStatusError(
      probe.statusCode === 403 ? 403 : 401, 'Session observation authentication failed',
    )),
  });
  void supervisor.start().catch(handlers.onError);
  return { dispose: () => supervisor.stop() };
}

/** Transport invalidation only. Readers retain authority over every wait predicate. */
export function openSessionEventSource(opts: {
    token: string; sessionId: string; scope?: 'user';
    executionRun?: Readonly<{ runId: string; sidechainId: string | null }>;
    onSessionUpdate?: (body: Extract<UpdateContainer['body'], { t: 'update-session' }>) => void;
    onConnected?: () => void;
}): Readonly<{
    currentRevision: () => number;
    waitForChange: (observedRevision: number, params: { deadlineMs: number | null; signal?: AbortSignal }) => Promise<boolean>;
    close: () => Promise<void>;
}> {
    let revision = 0;
    let closed = false;
    let failure: unknown;
    const listeners = new Set<() => void>();
    const changed = () => {
        revision += 1;
        for (const listener of [...listeners]) listener();
    };
    const onUpdate = (raw: unknown) => {
        const parsed = UpdateContainerSchema.safeParse(raw);
        if (!parsed.success) return;
        const body = parsed.data.body;
        if (opts.executionRun) {
            // Finite collaborators can receive durable sidechain messages even
            // when the live Run projection is outside their delivery ceiling.
            if (((body.t === 'new-message' || body.t === 'message-updated') && body.sid === opts.sessionId
                && opts.executionRun.sidechainId !== null && body.message.sidechainId === opts.executionRun.sidechainId)
                || (body.t === 'delete-session' && body.sid === opts.sessionId)) changed();
            return;
        }
        if (body.t === 'update-session' && body.id === opts.sessionId) opts.onSessionUpdate?.(body);
        if ((body.t === 'new-session' || body.t === 'update-session' || body.t === 'delete-session')
            && body.id === opts.sessionId) changed();
        if ((body.t === 'new-message' || body.t === 'message-updated' || body.t === 'pending-changed')
            && (body.sid === opts.sessionId || ('sessionId' in body && body.sessionId === opts.sessionId))) changed();
    };
    const onEphemeral = (raw: unknown) => {
        const parsed = EphemeralUpdateSchema.safeParse(raw);
        if (!parsed.success) return;
        const event = parsed.data;
        if (opts.executionRun) {
            if (event.type === 'execution-run-updated' && event.sessionId === opts.sessionId
                && event.run.runId === opts.executionRun.runId) changed();
            return;
        }
        if (('sessionId' in event && event.sessionId === opts.sessionId
            && event.type !== 'transcript-stream-segment' && event.type !== 'transcript-stream-segment-delta')
            || (event.type === 'activity' && event.id === opts.sessionId)) changed();
    };
    const observation = observeSessionSocketEvents(opts, {
      onUpdate, onEphemeral, onConnected: () => { opts.onConnected?.(); changed(); },
      onError: (error) => { failure = error; changed(); },
    });
    return {
        currentRevision: () => revision,
        waitForChange: (observedRevision: number, params: { deadlineMs: number | null; signal?: AbortSignal }): Promise<boolean> => {
            if (failure !== undefined) return Promise.reject(failure);
            if (closed || params.signal?.aborted) return Promise.resolve(false);
            if (params.deadlineMs !== null && Date.now() >= params.deadlineMs) return Promise.resolve(false);
            if (revision !== observedRevision) return Promise.resolve(true);
            return new Promise((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const finish = () => {
                    if (timer !== undefined) clearTimeout(timer);
                    listeners.delete(finish);
                    params.signal?.removeEventListener('abort', finish);
                    if (failure !== undefined) reject(failure);
                    else resolve(!closed && !params.signal?.aborted && revision !== observedRevision
                        && (params.deadlineMs === null || Date.now() < params.deadlineMs));
                };
                listeners.add(finish);
                params.signal?.addEventListener('abort', finish, { once: true });
                const armDeadline = () => {
                    if (params.deadlineMs === null) return;
                    const remainingMs = params.deadlineMs - Date.now();
                    if (remainingMs <= 0) { finish(); return; }
                    // Node coerces delays above its signed 32-bit timer limit to 1ms.
                    // Re-arm the same absolute deadline rather than shortening the observation.
                    timer = setTimeout(armDeadline, Math.min(2_147_483_647, Math.max(1, remainingMs)));
                };
                armDeadline();
                if (closed || params.signal?.aborted || revision !== observedRevision) finish();
            });
        },
        close: async () => {
            if (closed) return;
            closed = true;
            for (const listener of [...listeners]) listener();
            await observation.dispose();
        },
    };
}

function openAgentState(params: Readonly<{
  ciphertextBase64: string | null;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext | null;
}>): unknown {
  if (!params.ciphertextBase64) return null;
  try {
    const decrypted = params.sessionEncryptionMode === 'plain'
      ? JSON.parse(params.ciphertextBase64)
      : params.ctx
        ? decrypt(
            params.ctx.encryptionKey,
            params.ctx.encryptionVariant,
            decodeBase64(params.ciphertextBase64, 'base64'),
          )
        : null;
    return decrypted;
  } catch {
    return null;
  }
}

function tryDecryptMessageEnvelope(params: Readonly<{
  content: unknown;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext | null;
}>): unknown | null {
  const parsed = SessionMessageContentSchema.safeParse(params.content);
  if (!parsed.success) return null;
  if (parsed.data.t === 'plain') return parsed.data.v;
  if (!params.ctx) return null;
  try {
    return decrypt(
      params.ctx.encryptionKey,
      params.ctx.encryptionVariant,
      decodeBase64(parsed.data.c, 'base64'),
    );
  } catch {
    return null;
  }
}

export async function waitForIdleViaSocket(params: Readonly<{
  token: string;
  sessionId: string;
  scope?: 'user';
  ctx: SessionEncryptionContext | null;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  timeoutMs: number;
  signal?: AbortSignal;
  initialTurnActivity: SessionTurnActivity;
  initialTurnActivityRequiresTranscriptIdleEvidence?: boolean;
  recheckTurnActivity?: () => Promise<SessionTurnActivity>;
  initialAgentStateSummary?: AgentStateSummary | null;
  preferProjectionUpdates?: boolean;
  readyCompletesPendingUserTurns?: boolean;
  // Seed with the latest agentState ciphertext from snapshot, if available.
  initialAgentStateCiphertextBase64: string | null;
  resolveAuthorizationHeaders?: Parameters<typeof fetchSessionById>[0]['resolveAuthorizationHeaders'];
}>): Promise<{ idle: true; observedAt: number }> {
  const observer = createCliIdleSocketObserver(params);
  return await waitForIdleObservation({
    ...params, ...observer,
    initialAgentState: observer.openAgentState(params.initialAgentStateCiphertextBase64),
  });
}

function createCliIdleSocketObserver(params: Readonly<{
  token: string;
  sessionId: string;
  scope?: 'user';
  ctx: SessionEncryptionContext | null;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  resolveAuthorizationHeaders?: Parameters<typeof fetchSessionById>[0]['resolveAuthorizationHeaders'];
}>) {
  const open = (ciphertextBase64: string | null) => openAgentState({
    ciphertextBase64, ctx: params.ctx, sessionEncryptionMode: params.sessionEncryptionMode,
  });
  const observe: IdleSocketObserver = handlers => observeSessionSocketEvents(params, {
    ...handlers,
    onUpdate: value => { void handlers.onUpdate(value).catch(handlers.onError); },
  });
  return {
    openAgentState: open,
    openMessage: (content: unknown) => tryDecryptMessageEnvelope({
      content, ctx: params.ctx, sessionEncryptionMode: params.sessionEncryptionMode,
    }),
    confirmMs: resolveSessionControlWaitIdleConfirmMs(),
    observe,
    readSnapshot: async () => {
      const projection = await fetchSessionById({
        reason: 'reconnect', token: params.token, sessionId: params.sessionId,
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      });
      return projection ? { projection, agentState: open(typeof projection.agentState === 'string' ? projection.agentState : null) } : null;
    },
  };
}

export async function readLatestAgentStateSummaryViaSocket(params: Readonly<{
  token: string;
  sessionId: string;
  ctx: SessionEncryptionContext | null;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  timeoutMs: number;
  onAgentStateObserved?: (value: unknown, observedAtMs: number) => void;
}>): Promise<AgentStateSummary | null> {
  const socket = createSessionScopedSocket({ token: params.token, sessionId: params.sessionId }) as unknown as Socket;
  const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));

  const result = await new Promise<AgentStateSummary | null>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      try {
        socket.off('update', onUpdate as any);
        socket.off('connect_error', onConnectError as any);
      } catch {
        // ignore
      }
      try {
        socket.disconnect();
        socket.close();
      } catch {
        // ignore
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onConnectError = (err: any) => {
      clearTimeout(timer);
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onUpdate = (raw: unknown) => {
      const parsed = UpdateContainerSchema.safeParse(raw);
      if (!parsed.success) return;
      const update: UpdateContainer = parsed.data;

      if (update.body?.t !== 'update-session') return;
      const body = update.body;
      if (String(body.id ?? '') !== params.sessionId) return;

      const agentStateCiphertext = body.agentState?.value;
      if (typeof agentStateCiphertext !== 'string' || agentStateCiphertext.trim().length === 0) return;

      try {
        const decrypted = params.sessionEncryptionMode === 'plain'
          ? JSON.parse(agentStateCiphertext)
          : params.ctx
            ? decrypt(
                params.ctx.encryptionKey,
                params.ctx.encryptionVariant,
                decodeBase64(agentStateCiphertext, 'base64'),
              )
            : null;
        if (decrypted === null) return;
        const summary = summarizeAgentState(decrypted);
        params.onAgentStateObserved?.(decrypted, update.createdAt);
        clearTimeout(timer);
        cleanup();
        resolve(summary);
      } catch {
        return;
      }
    };

    socket.on('connect_error', onConnectError as any);
    socket.on('update', onUpdate as any);
    socket.connect();
  });

  return result;
}
