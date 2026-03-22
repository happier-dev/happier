import type { Credentials } from '@/persistence';
import { detectSessionTurnActivity } from '@/session/query/detectSessionTurnInFlight';
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
  const initialTurnActivity = await detectSessionTurnActivity({
    token: params.credentials.token,
    sessionId: sessionTarget.sessionId,
    encryptionMode: sessionTarget.mode,
    encryptionKey: sessionTarget.ctx.encryptionKey,
    encryptionVariant: sessionTarget.ctx.encryptionVariant,
  });

  try {
    const result = await waitForIdleViaSocket({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      ctx: sessionTarget.ctx,
      sessionEncryptionMode: sessionTarget.mode,
      timeoutMs: params.timeoutMs,
      initialTurnActivity,
      recheckTurnActivity: async () =>
        detectSessionTurnActivity({
          token: params.credentials.token,
          sessionId: sessionTarget.sessionId,
          encryptionMode: sessionTarget.mode,
          encryptionKey: sessionTarget.ctx.encryptionKey,
          encryptionVariant: sessionTarget.ctx.encryptionVariant,
        }),
      initialAgentStateCiphertextBase64:
        agentStateCiphertext && agentStateCiphertext.length > 0 ? agentStateCiphertext : null,
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
