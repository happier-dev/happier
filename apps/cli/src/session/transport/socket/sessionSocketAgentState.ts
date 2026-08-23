import type { Socket } from 'socket.io-client';

import { createSessionScopedSocket } from '@/api/session/sockets';
import { SessionMessageContentSchema } from '@/api/types';
import { UpdateContainerSchema, type UpdateContainer } from '@happier-dev/protocol/updates';
import { decodeBase64, decrypt } from '@/api/encryption';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  detectSessionTurnActivityFromProjection,
  isSessionAgentMessage,
  isSessionUserMessage,
  readSessionProjectedPendingRequestCount,
  readSessionProjectedTurnStatus,
  type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import {
  applySessionTurnLifecycleEvent,
  detectSessionTurnLifecycleEvent,
  isBareSessionReadyEvent,
} from '@/session/shared/sessionTurnLifecycle';
import type { SessionEncryptionContext, SessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionControlWaitIdleConfirmMs } from '@/session/transport/shared/sessionTimeouts';

export type AgentStateSummary = Readonly<{
  controlledByUser?: boolean;
  pendingRequestsCount: number;
}>;

export function summarizeAgentState(value: unknown): AgentStateSummary {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as any) : null;
  const controlledByUser = typeof obj?.controlledByUser === 'boolean' ? obj.controlledByUser : undefined;
  const requests = obj?.requests;
  const pendingRequestsCount =
    requests && typeof requests === 'object' && !Array.isArray(requests) ? Object.keys(requests).length : 0;
  return { ...(controlledByUser !== undefined ? { controlledByUser } : {}), pendingRequestsCount };
}

export function isIdle(summary: AgentStateSummary | null): boolean {
  if (!summary) return true;
  if (summary.controlledByUser === true) return false;
  return summary.pendingRequestsCount === 0;
}

function summarizeProjectedPendingRequests(value: unknown): AgentStateSummary | null {
  const pendingRequestsCount = readSessionProjectedPendingRequestCount(value);
  if (pendingRequestsCount === null) {
    return null;
  }
  return { pendingRequestsCount };
}

/**
 * The Session projection only carries the pending-request count, so a projected observation may
 * replace that count and nothing else. Merging it onto the freshest AgentState observation keeps
 * `controlledByUser` intact; otherwise a Session held by a live local terminal would be summarized
 * as idle and could be stopped underneath its user.
 */
function mergeProjectedPendingRequestCount(
  projected: AgentStateSummary | null,
  observedAgentState: AgentStateSummary | null,
): AgentStateSummary | null {
  if (!projected) return null;
  const controlledByUser = projected.controlledByUser ?? observedAgentState?.controlledByUser;
  return {
    ...(controlledByUser !== undefined ? { controlledByUser } : {}),
    pendingRequestsCount: projected.pendingRequestsCount,
  };
}

function readUpdateBodyAgentStateCiphertext(body: unknown): string | null {
  const value = (body as { agentState?: { value?: unknown } } | null)?.agentState?.value;
  if (typeof value !== 'string') return null;
  return value.trim().length > 0 ? value : null;
}

function readSessionSnapshotAgentStateCiphertext(session: unknown): string | null {
  const value = (session as { agentState?: unknown } | null)?.agentState;
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

function summarizeAgentStateCiphertext(params: Readonly<{
  ciphertextBase64: string | null;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext | null;
}>): AgentStateSummary | null {
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
    if (decrypted === null) return null;
    return summarizeAgentState(decrypted);
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
  ctx: SessionEncryptionContext | null;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  timeoutMs: number;
  initialTurnActivity: SessionTurnActivity;
  initialTurnActivityRequiresTranscriptIdleEvidence?: boolean;
  recheckTurnActivity?: () => Promise<SessionTurnActivity>;
  initialAgentStateSummary?: AgentStateSummary | null;
  preferProjectionUpdates?: boolean;
  readyCompletesPendingUserTurns?: boolean;
  // Seed with the latest agentState ciphertext from snapshot, if available.
  initialAgentStateCiphertextBase64: string | null;
}>): Promise<{ idle: true; observedAt: number }> {
  const initialObservedAgentState = summarizeAgentStateCiphertext({
    ciphertextBase64: params.initialAgentStateCiphertextBase64,
    sessionEncryptionMode: params.sessionEncryptionMode,
    ctx: params.ctx,
  });
  const initial =
    params.initialAgentStateSummary !== undefined
      ? mergeProjectedPendingRequestCount(params.initialAgentStateSummary, initialObservedAgentState)
      : initialObservedAgentState;
  let latestSummary = initial;
  let pendingUserTurns = params.initialTurnActivity.pendingUserTurns;
  let activeTaskInFlight = params.initialTurnActivity.activeTaskInFlight;
  let requiresTranscriptIdleEvidence = params.initialTurnActivityRequiresTranscriptIdleEvidence === true;
  const preferProjectionUpdates = params.preferProjectionUpdates === true;
  const readyCompletesPendingUserTurns = params.readyCompletesPendingUserTurns !== false;
  let observedTurnProgress = activeTaskInFlight;
  // `pendingCount` counts queue rows, not rows already claimed for delivery. Retain the known
  // input count until its successor is observed, otherwise the delivery transition can look idle.
  let pendingInputTurnsAwaitingMaterialization =
    preferProjectionUpdates && pendingUserTurns > 0 ? pendingUserTurns : 0;
  const hasTurnInFlight = () => activeTaskInFlight || pendingUserTurns > 0;
  const initiallyIdle = isIdle(initial) && !hasTurnInFlight();
  const idleConfirmMs = initiallyIdle ? resolveSessionControlWaitIdleConfirmMs() : 0;

  const socket = createSessionScopedSocket({ token: params.token, sessionId: params.sessionId }) as unknown as Socket;

  const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
  const deadlineMs = Date.now() + timeoutMs;

  const result = await new Promise<{ idle: true; observedAt: number }>((resolve, reject) => {
    let settled = false;
    let waitingForIdleAfterFreshBusy = !initiallyIdle;
    let hasFreshAgentStateObservation = false;
    let idleConfirmTimer: ReturnType<typeof setTimeout> | null = null;
    let busyRecheckTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (idleConfirmTimer) {
        clearTimeout(idleConfirmTimer);
        idleConfirmTimer = null;
      }
      if (busyRecheckTimer) {
        clearTimeout(busyRecheckTimer);
        busyRecheckTimer = null;
      }
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
      reject(new Error('timeout'));
    }, timeoutMs);

    const applyRecheckedTurnActivity = (latestTurnActivity: SessionTurnActivity): boolean => {
      if (!latestTurnActivity.turnInFlight && pendingInputTurnsAwaitingMaterialization > 0) {
        requiresTranscriptIdleEvidence = true;
        waitingForIdleAfterFreshBusy = true;
        return false;
      }
      pendingUserTurns = latestTurnActivity.pendingUserTurns;
      activeTaskInFlight = latestTurnActivity.activeTaskInFlight;
      if (latestTurnActivity.turnInFlight) {
        requiresTranscriptIdleEvidence = true;
        waitingForIdleAfterFreshBusy = true;
        return false;
      }
      requiresTranscriptIdleEvidence = false;
      return true;
    };

    const resolveIdle = () => {
      clearTimeout(timer);
      cleanup();
      resolve({ idle: true, observedAt: Math.min(Date.now(), deadlineMs) });
    };

    const recheckRequiredTranscriptIdleEvidence = async (): Promise<boolean> => {
      if (!requiresTranscriptIdleEvidence) return true;
      if (!params.recheckTurnActivity) return false;
      const latestTurnActivity = await params.recheckTurnActivity();
      return applyRecheckedTurnActivity(latestTurnActivity);
    };

    const resolveIdleAfterRequiredTranscriptEvidence = () => {
      void (async () => {
        try {
          if (!(await recheckRequiredTranscriptIdleEvidence())) {
            scheduleBusyTurnActivityRecheck();
            return;
          }
          resolveIdle();
        } catch {
          scheduleBusyTurnActivityRecheck();
        }
      })();
    };

    const scheduleBusyTurnActivityRecheck = () => {
      if (!params.recheckTurnActivity) return;
      if (settled) return;
      if (!waitingForIdleAfterFreshBusy) return;

      const remainingMs = Math.max(1, deadlineMs - Date.now());
      const delayMs = Math.min(resolveSessionControlWaitIdleConfirmMs(), remainingMs);

      if (busyRecheckTimer) {
        clearTimeout(busyRecheckTimer);
        busyRecheckTimer = null;
      }

      busyRecheckTimer = setTimeout(() => {
        busyRecheckTimer = null;
        void (async () => {
          if (settled) return;
          try {
            const latestTurnActivity = await params.recheckTurnActivity?.();
            if (!latestTurnActivity) {
              scheduleBusyTurnActivityRecheck();
              return;
            }
            if (!applyRecheckedTurnActivity(latestTurnActivity)) {
              scheduleBusyTurnActivityRecheck();
              return;
            }

            const refreshedSession = await fetchSessionById({
              token: params.token,
              sessionId: params.sessionId,
            }).catch(() => null);
            const refreshedProjectionActivity = preferProjectionUpdates
              ? detectSessionTurnActivityFromProjection(refreshedSession)
              : null;
            if (refreshedProjectionActivity) {
              pendingUserTurns = refreshedProjectionActivity.pendingUserTurns;
              activeTaskInFlight = refreshedProjectionActivity.activeTaskInFlight;
            }
            const refreshedProjectedSummary = preferProjectionUpdates
              ? summarizeProjectedPendingRequests(refreshedSession)
              : null;
            const refreshedObservedAgentState = summarizeAgentStateCiphertext({
              ciphertextBase64: readSessionSnapshotAgentStateCiphertext(refreshedSession),
              sessionEncryptionMode: params.sessionEncryptionMode,
              ctx: params.ctx,
            });
            latestSummary =
              mergeProjectedPendingRequestCount(
                refreshedProjectedSummary,
                refreshedObservedAgentState ?? latestSummary,
              )
              ?? refreshedObservedAgentState;
            if (refreshedProjectedSummary || refreshedObservedAgentState) {
              hasFreshAgentStateObservation = true;
            }

            const staleAgentStateSnapshot = !hasFreshAgentStateObservation;

            if ((!isIdle(latestSummary) && !staleAgentStateSnapshot) || hasTurnInFlight()) {
              scheduleBusyTurnActivityRecheck();
              return;
            }

            resolveIdle();
          } catch {
            scheduleBusyTurnActivityRecheck();
          }
        })();
      }, delayMs);
    };

    const onConnectError = (err: any) => {
      if (initiallyIdle && !waitingForIdleAfterFreshBusy) {
        resolveIdleAfterRequiredTranscriptEvidence();
        return;
      }
      clearTimeout(timer);
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onUpdate = (raw: unknown) => {
      const parsed = UpdateContainerSchema.safeParse(raw);
      if (!parsed.success) return;
      const update: UpdateContainer = parsed.data;

      if (update.body?.t === 'pending-changed') {
        if (!preferProjectionUpdates) return;
        const body = update.body;
        const sessionId = body.sid ?? body.sessionId;
        if (sessionId !== params.sessionId) return;

        const projectedActivity = detectSessionTurnActivityFromProjection(body);
        if (!projectedActivity?.turnInFlight) return;

        pendingUserTurns = projectedActivity.pendingUserTurns;
        activeTaskInFlight = projectedActivity.activeTaskInFlight;
        pendingInputTurnsAwaitingMaterialization = Math.max(
          pendingInputTurnsAwaitingMaterialization,
          projectedActivity.pendingUserTurns,
        );
        observedTurnProgress = true;
        waitingForIdleAfterFreshBusy = true;
        if (idleConfirmTimer) {
          clearTimeout(idleConfirmTimer);
          idleConfirmTimer = null;
        }
        return;
      }

      if (update.body?.t === 'update-session') {
        const body = update.body as any;
        if (String(body.id ?? '') !== params.sessionId) return;

        const shouldReadProjection = preferProjectionUpdates || !readyCompletesPendingUserTurns;
        const projectedActivity = shouldReadProjection ? detectSessionTurnActivityFromProjection(body) : null;
        const projectedSummary = shouldReadProjection
          ? mergeProjectedPendingRequestCount(
              summarizeProjectedPendingRequests(body),
              summarizeAgentStateCiphertext({
                ciphertextBase64: readUpdateBodyAgentStateCiphertext(body),
                sessionEncryptionMode: params.sessionEncryptionMode,
                ctx: params.ctx,
              }) ?? latestSummary,
            )
          : null;
        const projectedTurnStatus = shouldReadProjection ? readSessionProjectedTurnStatus(body.latestTurnStatus) : null;
        const canUseTerminalProjection =
          preferProjectionUpdates
          || readyCompletesPendingUserTurns
          || observedTurnProgress
          || activeTaskInFlight
          || projectedTurnStatus === 'in_progress';
        if (projectedActivity && projectedSummary) {
          const nextPendingUserTurns = projectedActivity.pendingUserTurns;
          const nextActiveTaskInFlight = projectedActivity.activeTaskInFlight;
          const nextTurnInFlight = nextActiveTaskInFlight || nextPendingUserTurns > 0;
          if (nextTurnInFlight || !isIdle(projectedSummary)) {
            pendingUserTurns = nextPendingUserTurns;
            activeTaskInFlight = nextActiveTaskInFlight;
            latestSummary = projectedSummary;
            hasFreshAgentStateObservation = true;
            observedTurnProgress = true;
            waitingForIdleAfterFreshBusy = true;
            if (idleConfirmTimer) {
              clearTimeout(idleConfirmTimer);
              idleConfirmTimer = null;
            }
            return;
          }
          if (pendingInputTurnsAwaitingMaterialization > 0) {
            return;
          }
          if (!canUseTerminalProjection) {
            return;
          }
          pendingUserTurns = nextPendingUserTurns;
          activeTaskInFlight = nextActiveTaskInFlight;
          latestSummary = projectedSummary;
          hasFreshAgentStateObservation = true;
          if (!waitingForIdleAfterFreshBusy) {
            return;
          }

          resolveIdleAfterRequiredTranscriptEvidence();
          return;
        }
        if (projectedTurnStatus || projectedSummary) {
          let nextPendingUserTurns = pendingUserTurns;
          let nextActiveTaskInFlight = activeTaskInFlight;
          if (projectedTurnStatus) {
            nextPendingUserTurns = 0;
            nextActiveTaskInFlight = projectedTurnStatus === 'in_progress';
          }
          const nextSummary = projectedSummary ?? latestSummary;
          const nextTurnInFlight = nextActiveTaskInFlight || nextPendingUserTurns > 0;

          if (nextTurnInFlight || !isIdle(nextSummary)) {
            pendingUserTurns = nextPendingUserTurns;
            activeTaskInFlight = nextActiveTaskInFlight;
            if (projectedSummary) {
              latestSummary = projectedSummary;
              hasFreshAgentStateObservation = true;
            }
            observedTurnProgress = true;
            waitingForIdleAfterFreshBusy = true;
            if (idleConfirmTimer) {
              clearTimeout(idleConfirmTimer);
              idleConfirmTimer = null;
            }
            return;
          }
          if (pendingInputTurnsAwaitingMaterialization > 0) {
            return;
          }
          if (!canUseTerminalProjection) {
            return;
          }
          pendingUserTurns = nextPendingUserTurns;
          activeTaskInFlight = nextActiveTaskInFlight;
          if (projectedSummary) {
            latestSummary = projectedSummary;
            hasFreshAgentStateObservation = true;
          }
          if (!waitingForIdleAfterFreshBusy || latestSummary === null) {
            return;
          }

          resolveIdleAfterRequiredTranscriptEvidence();
          return;
        }

        const agentStateCiphertext = body.agentState?.value;
        if (typeof agentStateCiphertext !== 'string' || agentStateCiphertext.trim().length === 0) return;

        const summary = summarizeAgentStateCiphertext({
          ciphertextBase64: agentStateCiphertext,
          sessionEncryptionMode: params.sessionEncryptionMode,
          ctx: params.ctx,
        });
        if (!summary) {
          return;
        }
        hasFreshAgentStateObservation = true;
        latestSummary = summary;
        if (!isIdle(summary)) {
          waitingForIdleAfterFreshBusy = true;
          if (idleConfirmTimer) {
            clearTimeout(idleConfirmTimer);
            idleConfirmTimer = null;
          }
          return;
        }
        if (!waitingForIdleAfterFreshBusy || hasTurnInFlight()) {
          return;
        }

        clearTimeout(timer);
        cleanup();
        resolve({ idle: true, observedAt: Math.min(Date.now(), deadlineMs) });
        return;
      }

      if (update.body?.t !== 'new-message') return;
      if (
        preferProjectionUpdates
        && !requiresTranscriptIdleEvidence
        && pendingInputTurnsAwaitingMaterialization === 0
      ) return;
      const body = update.body as any;
      if (String(body.sid ?? '') !== params.sessionId) return;

      const decrypted = tryDecryptMessageEnvelope({
        content: body.message?.content,
        sessionEncryptionMode: params.sessionEncryptionMode,
        ctx: params.ctx,
      });
      if (!decrypted) return;

      if (isSessionUserMessage(decrypted)) {
        pendingInputTurnsAwaitingMaterialization = Math.max(0, pendingInputTurnsAwaitingMaterialization - 1);
        pendingUserTurns += 1;
        requiresTranscriptIdleEvidence = true;
        waitingForIdleAfterFreshBusy = true;
        if (idleConfirmTimer) {
          clearTimeout(idleConfirmTimer);
          idleConfirmTimer = null;
        }
        return;
      }

      const lifecycleEvent = detectSessionTurnLifecycleEvent(decrypted);
      if (!lifecycleEvent) {
        if (isSessionAgentMessage(decrypted) && hasTurnInFlight()) {
          observedTurnProgress = true;
        }
        return;
      }
      if (
        lifecycleEvent === 'ready'
        && !readyCompletesPendingUserTurns
        && !activeTaskInFlight
        && !observedTurnProgress
        && isBareSessionReadyEvent(decrypted)
      ) {
        return;
      }
      if (lifecycleEvent === 'ready' && !isBareSessionReadyEvent(decrypted) && pendingUserTurns > 0) {
        observedTurnProgress = true;
      }
      if (lifecycleEvent === 'task_started') {
        pendingInputTurnsAwaitingMaterialization = Math.max(0, pendingInputTurnsAwaitingMaterialization - 1);
        observedTurnProgress = true;
      }

      ({
        pendingUserTurns,
        activeTaskInFlight,
      } = applySessionTurnLifecycleEvent({
        pendingUserTurns,
        activeTaskInFlight,
        event: lifecycleEvent,
      }));
      if (lifecycleEvent === 'ready') {
        latestSummary = { ...(latestSummary ?? {}), pendingRequestsCount: 0 };
      }

      const staleAgentStateSnapshot = !hasFreshAgentStateObservation;

      if (hasTurnInFlight() || (!isIdle(latestSummary) && !staleAgentStateSnapshot)) {
        waitingForIdleAfterFreshBusy = true;
        if (idleConfirmTimer) {
          clearTimeout(idleConfirmTimer);
          idleConfirmTimer = null;
        }
        return;
      }
      if (!waitingForIdleAfterFreshBusy) {
        return;
      }

      resolveIdleAfterRequiredTranscriptEvidence();
    };

    socket.on('connect_error', onConnectError as any);
    socket.on('update', onUpdate as any);
    socket.connect();

    scheduleBusyTurnActivityRecheck();

    if (initiallyIdle) {
      idleConfirmTimer = setTimeout(() => {
        idleConfirmTimer = null;
        void (async () => {
          if (params.recheckTurnActivity) {
            try {
              const latestTurnActivity = await params.recheckTurnActivity();
              pendingUserTurns = latestTurnActivity.pendingUserTurns;
              activeTaskInFlight = latestTurnActivity.activeTaskInFlight;
              if (latestTurnActivity.turnInFlight) {
                requiresTranscriptIdleEvidence = true;
                waitingForIdleAfterFreshBusy = true;
                return;
              }
              requiresTranscriptIdleEvidence = false;
            } catch {
              // Transcript confirmation is required before reporting idle. Keep the socket wait
              // alive until fresh positive evidence arrives or the deadline rejects.
              return;
            }
          }

          resolveIdleAfterRequiredTranscriptEvidence();
        })();
      }, Math.min(idleConfirmMs, timeoutMs));
    }
  });

  return result;
}

export async function readLatestAgentStateSummaryViaSocket(params: Readonly<{
  token: string;
  sessionId: string;
  ctx: SessionEncryptionContext | null;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  timeoutMs: number;
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
      const body = update.body as any;
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
