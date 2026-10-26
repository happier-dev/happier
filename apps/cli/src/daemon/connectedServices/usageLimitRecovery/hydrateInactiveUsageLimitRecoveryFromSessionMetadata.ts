import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionById as fetchSessionByIdDefault, fetchSessionsPage as fetchSessionsPageDefault, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';
import { hasSameUsageLimitRecoveryIdentity, isPendingUsageLimitRecoveryStatus } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';

type FetchSessionsPage = typeof fetchSessionsPageDefault;

type HydrateInactiveUsageLimitRecoveryResult = Readonly<{
  scanned: number;
  observed: number;
}>;

function readSessionId(rawSession: RawSessionRecord): string {
  const raw = (rawSession as Readonly<{ id?: unknown }>).id;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Persisted recovery intents may only be re-armed while the session's latest
 * turn is still interrupted. A completed/cancelled latest turn supersedes the
 * intent: rehydrating it would schedule an involuntary time-based resume into
 * a session that already moved on. Unknown turn status keeps the intent.
 */
function hasInterruptedTurnEvidence(rawSession: RawSessionRecord): boolean {
  const status = (rawSession as Readonly<{ latestTurnStatus?: unknown }>).latestTurnStatus;
  return status == null || status === 'failed';
}

function readActiveRecoveryIntent(metadata: Record<string, unknown> | null): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    metadata?.[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  if (!parsed.success) return null;
  const recovery = parsed.data;
  if (!isPendingUsageLimitRecoveryStatus(recovery.status)) return null;
  if (recovery.runtimeAuthRecoveryAttemptId) return null;
  return recovery;
}

export async function hydrateInactiveUsageLimitRecoveryFromSessionMetadata(params: Readonly<{
  credentials: Credentials;
  currentMachineId: string | null;
  currentMachineHost: string | null;
  currentMachineHomeDir: string | null;
  fetchSessionsPage?: FetchSessionsPage;
  fetchSessionById?: typeof fetchSessionByIdDefault;
  decryptMetadata?: (input: Readonly<{
    credentials: Credentials;
    rawSession: RawSessionRecord;
  }>) => Record<string, unknown> | null;
  /** Use the registered machine control so every wake resolves current session state. */
  runCheckNow: (sessionId: string) => Promise<unknown>;
  observe(input: Readonly<{
    sessionId: string;
    recovery: SessionUsageLimitRecoveryV1;
    runCheckNow: () => Promise<unknown>;
  }>): void | Promise<void>;
  maxPages?: number;
}>): Promise<HydrateInactiveUsageLimitRecoveryResult> {
  const fetchSessionsPage = params.fetchSessionsPage ?? fetchSessionsPageDefault;
  const decryptMetadata = params.decryptMetadata ?? ((input) => tryDecryptSessionMetadata(input));
  const maxPages = Math.max(1, Math.trunc(params.maxPages ?? 50));
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let scanned = 0;
  let observed = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchSessionsPage({
      token: params.credentials.token,
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    for (const rawSession of result.sessions as ReadonlyArray<RawSessionRecord>) {
      scanned += 1;
      if (rawSession.active === true) continue;
      const sessionId = readSessionId(rawSession);
      if (!sessionId) continue;
      if (!hasInterruptedTurnEvidence(rawSession)) continue;
      const metadata = decryptMetadata({
        credentials: params.credentials,
        rawSession,
      });
      const recovery = readActiveRecoveryIntent(metadata);
      if (!metadata || !recovery) continue;
      if (!await resolveMachineControlLocalityProof({
        sessionMachineId: metadata.machineId ?? rawSession.machineId,
        currentMachineId: params.currentMachineId,
        sessionHost: metadata.host ?? rawSession.host,
        sessionHomeDir: metadata.homeDir ?? rawSession.homeDir,
        currentMachineHost: params.currentMachineHost,
        currentMachineHomeDir: params.currentMachineHomeDir,
        credentials: params.credentials,
      })) continue;
      await params.observe({
        sessionId,
        recovery,
        runCheckNow: async () => {
          const currentSession = await (params.fetchSessionById ?? fetchSessionByIdDefault)({
            token: params.credentials.token, sessionId,
          });
          if (!currentSession) return { ok: false, errorCode: 'usage_limit_recovery_session_unavailable' };
          const currentMetadata = decryptMetadata({ credentials: params.credentials, rawSession: currentSession });
          if (!currentMetadata) return { ok: false, errorCode: 'usage_limit_recovery_session_unavailable' };
          const current = readActiveRecoveryIntent(currentMetadata);
          if (currentSession.archivedAt != null || !current || !hasSameUsageLimitRecoveryIdentity(current, recovery)) {
            return { ok: false, status: 'cancelled', errorCode: 'usage_limit_recovery_attempt_superseded' };
          }
          return await params.runCheckNow(sessionId);
        },
      });
      observed += 1;
    }
    if (!result.hasNext || !result.nextCursor) break;
    if (seenCursors.has(result.nextCursor)) break;
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  return { scanned, observed };
}
