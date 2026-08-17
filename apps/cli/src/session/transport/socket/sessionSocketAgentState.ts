import type { Socket } from 'socket.io-client';

import { createSessionScopedSocket } from '@/api/session/sockets';
import { SessionMessageContentSchema } from '@/api/types';
import { UpdateContainerSchema, type UpdateContainer } from '@happier-dev/protocol/updates';
import { decodeBase64, decrypt } from '@/api/encryption';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  detectSessionTurnActivityFromProjection,
  isSessionUserMessage,
  readSessionProjectedPendingRequestCount,
  readSessionProjectedTurnStatus,
  type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import {
  applySessionTurnLifecycleEvent,
  detectSessionTurnLifecycleEvent,
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
  ctx: SessionEncryptionContext;
}>): AgentStateSummary | null {
  if (!params.ciphertextBase64) return null;
  try {
    const decrypted =
      params.sessionEncryptionMode === 'plain'
        ? JSON.parse(params.ciphertextBase64)
        : decrypt(
            params.ctx.encryptionKey,
            params.ctx.encryptionVariant,
            decodeBase64(params.ciphertextBase64, 'base64'),
          );
    return summarizeAgentState(decrypted);
  } catch {
    return null;
  }
}

function tryDecryptMessageEnvelope(params: Readonly<{
  content: unknown;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
}>): unknown | null {
  const parsed = SessionMessageContentSchema.safeParse(params.content);
  if (!parsed.success) return null;
  if (parsed.data.t === 'plain') return parsed.data.v;
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
  ctx: SessionEncryptionContext;
  sessionEncryptionMode: SessionStoredContentEncryptionMode;
  timeoutMs: number;
  initialTurnActivity: SessionTurnActivity;
  initialTurnActivityRequiresTranscriptIdleEvidence?: boolean;
  recheckTurnActivity?: () => Promise<SessionTurnActivity>;
  initialAgentStateSummary?: AgentStateSummary | null;
  preferProjectionUpdates?: boolean;
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
  let preferProjectionUpdates = params.preferProjectionUpdates === true;
  let requiresTranscriptIdleEvidence = params.initialTurnActivityRequiresTranscriptIdleEvidence === true;
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

    const applyRecheckedTurnActivity = (activity: SessionTurnActivity) => {
      pendingUserTurns = activity.pendingUserTurns;
      activeTaskInFlight = activity.activeTaskInFlight;
      requiresTranscriptIdleEvidence = activity.turnInFlight;
    };

    const resolveIdle = () => {
      clearTimeout(timer);
      cleanup();
      resolve({ idle: true, observedAt: Math.min(Date.now(), deadlineMs) });
    };

    const recheckRequiredTranscriptIdleEvidence = async (): Promise<boolean> => {
      if (!requiresTranscriptIdleEvidence) {
        return true;
      }
      if (!params.recheckTurnActivity) {
        return false;
      }
      try {
        const latestTurnActivity = await params.recheckTurnActivity();
        applyRecheckedTurnActivity(latestTurnActivity);
        return !latestTurnActivity.turnInFlight;
      } catch {
        return false;
      }
    };

    const resolveIdleAfterRequiredTranscriptEvidence = () => {
      void (async () => {
        if (settled) return;
        const transcriptIdle = await recheckRequiredTranscriptIdleEvidence();
        if (settled) return;
        if (!transcriptIdle || hasTurnInFlight() || !isIdle(latestSummary)) {
          waitingForIdleAfterFreshBusy = true;
          scheduleBusyTurnActivityRecheck();
          return;
        }
        resolveIdle();
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
            applyRecheckedTurnActivity(latestTurnActivity);
            if (latestTurnActivity.turnInFlight) {
              waitingForIdleAfterFreshBusy = true;
              scheduleBusyTurnActivityRecheck();
              return;
            }

            let refreshedSession: Awaited<ReturnType<typeof fetchSessionById>>;
            try {
              refreshedSession = await fetchSessionById({
                token: params.token,
                sessionId: params.sessionId,
              });
            } catch {
              scheduleBusyTurnActivityRecheck();
              return;
            }
            const refreshedProjectionActivity = detectSessionTurnActivityFromProjection(refreshedSession);
            if (refreshedProjectionActivity) {
              preferProjectionUpdates = true;
              pendingUserTurns = refreshedProjectionActivity.pendingUserTurns;
              activeTaskInFlight = refreshedProjectionActivity.activeTaskInFlight;
            }
            const refreshedProjectedSummary = summarizeProjectedPendingRequests(refreshedSession);
            const refreshedObservedAgentState = summarizeAgentStateCiphertext({
              ciphertextBase64: readSessionSnapshotAgentStateCiphertext(refreshedSession),
              sessionEncryptionMode: params.sessionEncryptionMode,
              ctx: params.ctx,
            });
            const refreshedSummary =
              mergeProjectedPendingRequestCount(
                refreshedProjectedSummary,
                refreshedObservedAgentState ?? latestSummary,
              )
              ?? refreshedObservedAgentState;
            latestSummary = refreshedSummary;
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
        clearTimeout(timer);
        cleanup();
        resolve({ idle: true, observedAt: Math.min(Date.now(), deadlineMs) });
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

      if (update.body?.t === 'update-session') {
        const body = update.body as any;
        if (String(body.id ?? '') !== params.sessionId) return;

        const projectedActivity = detectSessionTurnActivityFromProjection(body);
        const projectedSummary = mergeProjectedPendingRequestCount(
          summarizeProjectedPendingRequests(body),
          summarizeAgentStateCiphertext({
            ciphertextBase64: readUpdateBodyAgentStateCiphertext(body),
            sessionEncryptionMode: params.sessionEncryptionMode,
            ctx: params.ctx,
          }) ?? latestSummary,
        );
        const projectedTurnStatus = preferProjectionUpdates ? readSessionProjectedTurnStatus(body.latestTurnStatus) : null;
        if (projectedActivity && projectedSummary) {
          preferProjectionUpdates = true;
          pendingUserTurns = projectedActivity.pendingUserTurns;
          activeTaskInFlight = projectedActivity.activeTaskInFlight;
          latestSummary = projectedSummary;
          hasFreshAgentStateObservation = true;

          if (hasTurnInFlight() || !isIdle(latestSummary)) {
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
          return;
        }
        if (projectedTurnStatus || projectedSummary) {
          if (projectedTurnStatus) {
            pendingUserTurns = 0;
            activeTaskInFlight = projectedTurnStatus === 'in_progress';
          }
          if (projectedSummary) {
            latestSummary = projectedSummary;
            hasFreshAgentStateObservation = true;
          }

          if (hasTurnInFlight() || !isIdle(latestSummary)) {
            waitingForIdleAfterFreshBusy = true;
            if (idleConfirmTimer) {
              clearTimeout(idleConfirmTimer);
              idleConfirmTimer = null;
            }
            return;
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

        resolveIdle();
        return;
      }

      if (update.body?.t !== 'new-message') return;
      if (preferProjectionUpdates && !requiresTranscriptIdleEvidence) return;
      const body = update.body as any;
      if (String(body.sid ?? '') !== params.sessionId) return;

      const decrypted = tryDecryptMessageEnvelope({
        content: body.message?.content,
        sessionEncryptionMode: params.sessionEncryptionMode,
        ctx: params.ctx,
      });
      if (!decrypted) return;

      if (isSessionUserMessage(decrypted)) {
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
        return;
      }

      ({
        pendingUserTurns,
        activeTaskInFlight,
      } = applySessionTurnLifecycleEvent({
        pendingUserTurns,
        activeTaskInFlight,
        event: lifecycleEvent,
      }));
      requiresTranscriptIdleEvidence = hasTurnInFlight();
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

      resolveIdle();
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
              applyRecheckedTurnActivity(latestTurnActivity);
              if (latestTurnActivity.turnInFlight) {
                waitingForIdleAfterFreshBusy = true;
                scheduleBusyTurnActivityRecheck();
                return;
              }
            } catch {
              waitingForIdleAfterFreshBusy = true;
              scheduleBusyTurnActivityRecheck();
              return;
            }
          }

          resolveIdle();
        })();
      }, Math.min(idleConfirmMs, timeoutMs));
    }
  });

  return result;
}

export async function readLatestAgentStateSummaryViaSocket(params: Readonly<{
  token: string;
  sessionId: string;
  ctx: SessionEncryptionContext;
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
        const decrypted =
          params.sessionEncryptionMode === 'plain'
            ? JSON.parse(agentStateCiphertext)
            : decrypt(
                params.ctx.encryptionKey,
                params.ctx.encryptionVariant,
                decodeBase64(agentStateCiphertext, 'base64'),
              );
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
