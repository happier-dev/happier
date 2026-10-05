import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

/** Exact message address wins; otherwise reuse the Session transport's preferred Home. */
export function resolveTranscriptMessageServerId(
    sessionId: string,
    exactServerId?: string | null,
    fallbackServerId?: string | null,
): string | null {
    const resolved = exactServerId
        ?? resolvePreferredServerIdForSessionId(normalizeSessionId(sessionId))
        ?? fallbackServerId
        ?? '';
    return String(resolved).trim() || null;
}
