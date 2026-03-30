import type { Socket } from 'socket.io-client';

import { createSessionScopedSocket } from '@/api/session/sockets';
import { SessionMessageContentSchema } from '@/api/types';
import { UpdateContainerSchema, type UpdateContainer } from '@happier-dev/protocol/updates';
import { decodeBase64, decrypt } from '@/api/encryption';
import {
  isSessionUserMessage,
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
  recheckTurnActivity?: () => Promise<SessionTurnActivity>;
  // Seed with the latest agentState ciphertext from snapshot, if available.
  initialAgentStateCiphertextBase64: string | null;
}>): Promise<{ idle: true; observedAt: number }> {
  const initial = (() => {
    if (!params.initialAgentStateCiphertextBase64) return null;
    try {
      const decrypted =
        params.sessionEncryptionMode === 'plain'
          ? JSON.parse(params.initialAgentStateCiphertextBase64)
          : decrypt(
              params.ctx.encryptionKey,
              params.ctx.encryptionVariant,
              decodeBase64(params.initialAgentStateCiphertextBase64, 'base64'),
            );
      return summarizeAgentState(decrypted);
    } catch {
      return null;
    }
  })();
  let latestSummary = initial;
  let pendingUserTurns = params.initialTurnActivity.pendingUserTurns;
  let activeTaskInFlight = params.initialTurnActivity.activeTaskInFlight;
  const hasTurnInFlight = () => activeTaskInFlight || pendingUserTurns > 0;
  const initiallyIdle = isIdle(initial) && !hasTurnInFlight();
  const idleConfirmMs = initiallyIdle ? resolveSessionControlWaitIdleConfirmMs() : 0;

  const socket = createSessionScopedSocket({ token: params.token, sessionId: params.sessionId }) as unknown as Socket;

  const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
  const deadlineMs = Date.now() + timeoutMs;

  const result = await new Promise<{ idle: true; observedAt: number }>((resolve, reject) => {
    let settled = false;
    let waitingForIdleAfterFreshBusy = !initiallyIdle;
    let idleConfirmTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (idleConfirmTimer) {
        clearTimeout(idleConfirmTimer);
        idleConfirmTimer = null;
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
        } catch {
          return;
        }

        clearTimeout(timer);
        cleanup();
        resolve({ idle: true, observedAt: Math.min(Date.now(), deadlineMs) });
        return;
      }

      if (update.body?.t !== 'new-message') return;
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
      if (lifecycleEvent === 'ready') {
        latestSummary = { ...(latestSummary ?? {}), pendingRequestsCount: 0 };
      }

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

      clearTimeout(timer);
      cleanup();
      resolve({ idle: true, observedAt: Math.min(Date.now(), deadlineMs) });
    };

    socket.on('connect_error', onConnectError as any);
    socket.on('update', onUpdate as any);
    socket.connect();

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
                waitingForIdleAfterFreshBusy = true;
                return;
              }
            } catch {
              // Fall through and use the best available socket state.
            }
          }

          clearTimeout(timer);
          cleanup();
          resolve({ idle: true, observedAt: Math.min(Date.now(), deadlineMs) });
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
