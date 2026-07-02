/**
 * Module-scoped registry of mounted surfaces that render live transcript content for a session
 * without going through the main `SessionView` surface-visibility tracking.
 *
 * Some session sub-routes (e.g. the message/tool detail route and the execution-run detail route on
 * mobile) display transcript-derived content for a session but are separate navigation screens that
 * do not mark the session surface visible. When realtime projection routing is enabled, hidden
 * durable messages are deferred (projection-only) and these panes would show stale transcript content
 * while the session is streaming. Registering them here marks the session as an explicit full-content
 * transcript consumer so durable realtime routing keeps materializing transcript content.
 *
 * This mirrors `sessionRealtimeScmConsumers.ts` (refcount-style registry) but is keyed purely by
 * session id because the consumer simply needs the session's own transcript, not project-scope
 * mutation transcripts.
 */

import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

let nextConsumerId = 1;
const mountedTranscriptConsumerIdentitiesByConsumerId = new Map<number, Readonly<{
    sessionId: string;
    serverId: string | null;
}>>();

function normalizeSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeServerId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveRegisteredServerId(sessionId: string, serverId?: string | null): string | null {
    return normalizeServerId(serverId) ?? resolveServerIdForSessionIdFromLocalCache(sessionId) ?? null;
}

function resolveMountedConsumerServerId(consumerId: number, sessionId: string, serverId: string | null): string | null {
    if (serverId) return serverId;
    const resolvedServerId = resolveRegisteredServerId(sessionId);
    if (!resolvedServerId) return null;
    mountedTranscriptConsumerIdentitiesByConsumerId.set(consumerId, {
        sessionId,
        serverId: resolvedServerId,
    });
    return resolvedServerId;
}

export function registerSessionRealtimeTranscriptConsumer(sessionId: string, serverId?: string | null): () => void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
        return () => {};
    }
    const consumerId = nextConsumerId;
    nextConsumerId += 1;
    mountedTranscriptConsumerIdentitiesByConsumerId.set(consumerId, {
        sessionId: normalizedSessionId,
        serverId: resolveRegisteredServerId(normalizedSessionId, serverId),
    });
    return () => {
        mountedTranscriptConsumerIdentitiesByConsumerId.delete(consumerId);
    };
}

export function readMountedSessionRealtimeTranscriptConsumerSessionIds(serverId?: string | null): string[] {
    if (mountedTranscriptConsumerIdentitiesByConsumerId.size === 0) return [];
    const normalizedServerId = normalizeServerId(serverId);
    const sessionIds = new Set<string>();

    for (const [consumerId, entry] of mountedTranscriptConsumerIdentitiesByConsumerId.entries()) {
        const resolvedServerId = resolveMountedConsumerServerId(consumerId, entry.sessionId, entry.serverId);
        if (normalizedServerId && !areServerProfileIdentifiersEquivalent(resolvedServerId, normalizedServerId)) {
            continue;
        }
        sessionIds.add(entry.sessionId);
    }

    return Array.from(sessionIds);
}

export function clearMountedSessionRealtimeTranscriptConsumers(): void {
    mountedTranscriptConsumerIdentitiesByConsumerId.clear();
}
