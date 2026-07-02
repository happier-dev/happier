import type { Credentials } from '@/persistence';
import {
  detectSessionTurnActivity,
  detectSessionTurnActivityFromProjection,
  readSessionProjectedPendingRequestCount,
} from '@/session/query/detectSessionTurnInFlight';
import { detectLatestSessionTurnActivity } from '@/session/query/detectLatestSessionTurnActivity';
import { waitForIdleViaSocket } from '@/session/transport/socket/sessionSocketAgentState';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export async function waitForSessionIdle(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  timeoutMs: number;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; idle: true; observedAt: number }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported' | 'timeout'; candidates?: string[] }>
> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  const agentStateCiphertext =
    typeof sessionTarget.rawSession.agentState === 'string' ? String(sessionTarget.rawSession.agentState).trim() : null;
  const initialProjectedActivity = detectSessionTurnActivityFromProjection(sessionTarget.rawSession);
  const initialTurnActivity = initialProjectedActivity
    ?? await detectSessionTurnActivity({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      encryptionMode: sessionTarget.mode,
      encryptionKey: sessionTarget.ctx.encryptionKey,
      encryptionVariant: sessionTarget.ctx.encryptionVariant,
    });
  const initialProjectedPendingRequestCount = readSessionProjectedPendingRequestCount(sessionTarget.rawSession);

  try {
    const result = await waitForIdleViaSocket({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      ctx: sessionTarget.ctx,
      sessionEncryptionMode: sessionTarget.mode,
      timeoutMs: params.timeoutMs,
      initialTurnActivity,
      recheckTurnActivity: async () =>
        initialProjectedActivity
          ? detectLatestSessionTurnActivity({
            token: params.credentials.token,
            sessionId: sessionTarget.sessionId,
            encryptionMode: sessionTarget.mode,
            encryptionKey: sessionTarget.ctx.encryptionKey,
            encryptionVariant: sessionTarget.ctx.encryptionVariant,
          })
          : detectSessionTurnActivity({
            token: params.credentials.token,
            sessionId: sessionTarget.sessionId,
            encryptionMode: sessionTarget.mode,
            encryptionKey: sessionTarget.ctx.encryptionKey,
            encryptionVariant: sessionTarget.ctx.encryptionVariant,
          }),
      ...(initialProjectedPendingRequestCount !== null
        ? { initialAgentStateSummary: { pendingRequestsCount: initialProjectedPendingRequestCount } }
        : {}),
      preferProjectionUpdates: initialProjectedActivity !== null,
      initialAgentStateCiphertextBase64:
        initialProjectedPendingRequestCount === null && agentStateCiphertext && agentStateCiphertext.length > 0
          ? agentStateCiphertext
          : null,
    });
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      ...result,
    };
  } catch {
    return {
      ok: false,
      code: 'timeout',
    };
  }
}
