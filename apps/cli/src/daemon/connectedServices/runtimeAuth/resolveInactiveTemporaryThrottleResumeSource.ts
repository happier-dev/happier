import type { TrackedSession } from '@/daemon/types';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import { buildInactiveUsageLimitResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveUsageLimitResumeSpawnOptions';

/**
 * Minimal resume source for temporary-throttle recovery. Tracked children satisfy it
 * structurally; metadata-driven fallbacks rebuild it after a daemon restart.
 */
export type TemporaryThrottleResumeSource = Readonly<
    Pick<TrackedSession, 'happySessionId' | 'vendorResumeId' | 'spawnOptions'>
>;

/**
 * RD-REC-16 port: the temporary-throttle intent is durable but its in-memory resume
 * snapshot is not (and must not be persisted: spawn options can carry secret
 * environment values). After a daemon restart, rebuild the resume source from
 * persisted session metadata — the same inactive-session resume shape the
 * usage-limit recovery path uses — instead of dead-lettering the hydrated intent
 * with `temporary_throttle_session_not_found`.
 */
export async function resolveInactiveTemporaryThrottleResumeSource(input: Readonly<{
    sessionId: string;
    fallbackMachineId: string;
    fetchSession: (sessionId: string) => Promise<RawSessionRecord | null>;
    decryptSessionMetadata: (rawSession: RawSessionRecord) => Record<string, unknown> | null;
}>): Promise<TemporaryThrottleResumeSource | null> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) return null;
    const rawSession = await input.fetchSession(sessionId).catch(() => null);
    if (!rawSession) return null;
    const metadata = input.decryptSessionMetadata(rawSession);
    if (!metadata) return null;
    const spawnOptions = buildInactiveUsageLimitResumeSpawnOptions({
        sessionId,
        fallbackMachineId: input.fallbackMachineId,
        rawSession,
        metadata,
    });
    if (!spawnOptions) return null;
    return { happySessionId: sessionId, spawnOptions };
}
