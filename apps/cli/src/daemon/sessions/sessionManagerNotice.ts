import { SESSION_MESSAGE_SEND_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { readSessionOwnerLocality, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { logger } from '@/ui/logger';

/** A committed manager projection is information for this child, never execution authority. */
export async function reconcileSessionManagerNotice(input: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  observation?: Readonly<{ rawSession: RawSessionRecord; accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse }>;
  machineId: string;
  signal: AbortSignal;
  machineAdmissionTransport: NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>;
}>): Promise<void> {
  const { credentials, signal } = input;
  let observation = input.observation;
  if (!observation) {
    const resolved = await resolveSessionTransportContext({ credentials, idOrPrefix: input.sessionId,
      exact: true, reason: 'session-control', signal });
    if (!resolved.ok) return;
    observation = resolved;
  }
  const { rawSession, accountEncryptionCurrentness } = observation;
  const metadata = tryDecryptSessionOwnerMetadataView({ credentials, rawSession, accountEncryptionMode: accountEncryptionCurrentness.mode });
  if (!metadata || readSessionOwnerLocality({ metadata, rawSession })?.machineId !== input.machineId) return;
  const managerSessionId = rawSession.manager?.sessionId ?? null;
  if ((metadata.lastNotifiedManagerSessionId ?? null) === managerSessionId) return;
  // Pending's existing idempotency handles duplicate observations of this
  // owner revision, including an acknowledgement lost before cursor publication.
  const localId = `manager-notice:${rawSession.id}:${rawSession.metadataVersion}:${managerSessionId ?? 'detached'}`;
  const message = managerSessionId
    ? `Your immediate manager is Session ${managerSessionId}. Report to that Session through the existing Session messaging route (${SESSION_MESSAGE_SEND_ACTION_ID_V1}). Your role, permissions and mode are unchanged.`
    : `You were detached from immediate manager Session ${metadata.lastNotifiedManagerSessionId}. You no longer report to that Session. Your role, permissions and mode are unchanged.`;
  const sent = await sendSessionMessage({ credentials, idOrPrefix: rawSession.id, message, localId,
    wait: false, timeoutMs: resolveSessionMessageAdmissionTimeoutMs(), resumeInactiveSession: false,
    requestedAction: { v: 1, kind: 'enqueue' }, inputAdmission: buildTrustedHostSessionInputAdmissionV1('agent'),
    machineAdmissionTransport: input.machineAdmissionTransport, signal });
  if (!sent.ok || sent.admissionResult?.status !== 'accepted' && sent.admissionResult?.status !== 'alreadyAccepted') {
    logger.warn('[DAEMON RUN] Manager notice admission unconfirmed; waiting for the next observation or reconnect', {
      sessionId: rawSession.id, admissionResult: sent.admissionResult, ...(!sent.ok ? { code: sent.code } : {}),
    });
    return;
  }
  await updateSessionMetadataWithRetry({ token: credentials.token, credentials, sessionId: rawSession.id, rawSession,
    accountEncryptionCurrentness, currentness: { signal },
    updater: current => ({ ...current, lastNotifiedManagerSessionId: managerSessionId }),
  });
}
