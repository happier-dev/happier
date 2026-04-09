import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

export function resolveSessionTargetServerId(
    sessionId: string,
    fallbackServerId?: string | null,
): string | null {
    const resolvedServerId = resolvePreferredServerIdForSessionId(normalizeSessionId(sessionId)) ?? fallbackServerId ?? '';
    const normalizedServerId = String(resolvedServerId).trim();
    return normalizedServerId || null;
}
