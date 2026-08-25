import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';

export type PluginEventAutomationExistingSessionOption = Readonly<{
    sessionId: string;
    serverId: string | null;
    label: string;
}>;

export type ExistingSessionOptionSource = Readonly<{
    id: string;
    serverId?: unknown;
    metadata: unknown;
    metadataLayoutVersion?: number;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
    metadataUnavailable?: boolean;
}>;

export function buildPluginEventAutomationExistingSessionOptions(input: Readonly<{
    sessionListItems: ReadonlyArray<Extract<SessionListIndexItem, { type: 'session' }>>;
    sessionListRowRenderablesByKey: ReadonlyMap<string, SessionListRenderableSession>;
    sessions: ReadonlyArray<ExistingSessionOptionSource>;
}>): readonly PluginEventAutomationExistingSessionOption[] {
    const options: PluginEventAutomationExistingSessionOption[] = [];
    const seen = new Set<string>();
    for (const item of input.sessionListItems) {
        const sessionId = normalizeSessionTargetId(item.sessionId);
        const serverId = normalizeSessionTargetId(item.serverId);
        if (!sessionId || !serverId) continue;
        const row = input.sessionListRowRenderablesByKey.get(`${serverId}:${sessionId}`);
        if (!row) continue;
        const key = `${serverId}\u0000${sessionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push(Object.freeze({
            sessionId,
            serverId,
            label: getSessionName(row),
        }));
    }
    for (const session of input.sessions) {
        if (!isUserFacingSession(session)) continue;
        const sessionId = normalizeSessionTargetId(session.id);
        const serverId = normalizeSessionTargetId(session.serverId)
            ?? resolveServerIdForSessionIdFromLocalCache(sessionId ?? '');
        if (!sessionId || !serverId) continue;
        const key = `${serverId}\u0000${sessionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push(Object.freeze({
            sessionId,
            serverId,
            label: getSessionName(session),
        }));
    }
    return Object.freeze(options);
}

function normalizeSessionTargetId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
