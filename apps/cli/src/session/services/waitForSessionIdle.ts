import type { Credentials } from '@/persistence';
import {
  detectSessionTurnActivity,
  detectSessionTurnActivityFromProjection,
  readSessionProjectedPendingRequestCount,
  type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { detectLatestSessionTurnActivity } from '@/session/query/detectLatestSessionTurnActivity';
import { waitForIdleViaSocket } from '@/session/transport/socket/sessionSocketAgentState';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

function unknownTranscriptTurnActivity(): SessionTurnActivity {
  return {
    pendingUserTurns: 1,
    activeTaskInFlight: false,
    turnInFlight: true,
  };
}

export async function waitForSessionIdle(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  timeoutMs: number;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; idle: true; observedAt: number }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported' | 'timeout'; candidates?: string[] }>
> {
  const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
  const deadlineMs = Date.now() + timeoutMs;
  const remainingTimeoutMs = () => Math.max(1, deadlineMs - Date.now());

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
  let initialTranscriptActivity: SessionTurnActivity | null = null;
  let initialTranscriptActivityUnavailable = false;
  if (!initialProjectedActivity) {
    try {
      initialTranscriptActivity = await detectSessionTurnActivity({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
        encryptionMode: sessionTarget.mode,
        encryptionKey: sessionTarget.ctx.encryptionKey,
        encryptionVariant: sessionTarget.ctx.encryptionVariant,
        transcriptFetchTimeoutMs: remainingTimeoutMs(),
      });
    } catch {
      initialTranscriptActivityUnavailable = true;
    }
  }
  const initialTurnActivity =
    initialProjectedActivity?.turnInFlight
      ? initialProjectedActivity
      : initialTranscriptActivity?.turnInFlight
        ? initialTranscriptActivity
        : initialTranscriptActivityUnavailable
          ? unknownTranscriptTurnActivity()
          : initialProjectedActivity ?? initialTranscriptActivity ?? {
            pendingUserTurns: 0,
            activeTaskInFlight: false,
            turnInFlight: false,
          };
  const initialTurnActivityRequiresTranscriptIdleEvidence =
    initialTranscriptActivityUnavailable
    || (
      initialProjectedActivity !== null
      && !initialProjectedActivity.turnInFlight
      && initialTranscriptActivity?.turnInFlight === true
    );
  const initialProjectedPendingRequestCount = readSessionProjectedPendingRequestCount(sessionTarget.rawSession);

  try {
    const result = await waitForIdleViaSocket({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      ctx: sessionTarget.ctx,
      sessionEncryptionMode: sessionTarget.mode,
      timeoutMs: remainingTimeoutMs(),
      initialTurnActivity,
      initialTurnActivityRequiresTranscriptIdleEvidence,
      recheckTurnActivity: async () =>
        initialProjectedActivity
          ? detectLatestSessionTurnActivity({
            token: params.credentials.token,
            sessionId: sessionTarget.sessionId,
            encryptionMode: sessionTarget.mode,
            encryptionKey: sessionTarget.ctx.encryptionKey,
            encryptionVariant: sessionTarget.ctx.encryptionVariant,
            transcriptFetchTimeoutMs: remainingTimeoutMs(),
          })
          : detectSessionTurnActivity({
            token: params.credentials.token,
            sessionId: sessionTarget.sessionId,
            encryptionMode: sessionTarget.mode,
            encryptionKey: sessionTarget.ctx.encryptionKey,
            encryptionVariant: sessionTarget.ctx.encryptionVariant,
            transcriptFetchTimeoutMs: remainingTimeoutMs(),
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
