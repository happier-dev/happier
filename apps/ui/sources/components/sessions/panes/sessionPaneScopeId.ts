import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { qualifyPaneScopeId, readResourcePaneScopeId } from '@/components/appShell/panes/paneScopeIdentity';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

const QUALIFIED_SESSION_SCOPE_PREFIX = 'session:address:';
const LEGACY_SESSION_SCOPE_PREFIX = 'session:';

/** The phone Browser scene retains its tabs separately from the Session's File scene. */
export function createSessionBrowserPaneScopeId(sessionPaneScopeId: string): string {
    return `${sessionPaneScopeId}:browser`;
}

export function createSessionPaneScopeId(
    sessionIdRaw: string,
    serverIdRaw?: string | null,
    instanceKey?: string | null,
): string {
    const sessionId = normalizeSessionId(sessionIdRaw);
    const address = normalizeSessionAddress(resolveServerProfileScopeIdForIdentifier(serverIdRaw), sessionId);
    const scopeId = address
        ? `${QUALIFIED_SESSION_SCOPE_PREFIX}${encodeURIComponent(address.serverId)}:${encodeURIComponent(address.sessionId)}`
        : `${LEGACY_SESSION_SCOPE_PREFIX}${sessionId}`;
    return qualifyPaneScopeId(scopeId, instanceKey);
}

export function parseSessionPaneScopeId(scopeId: string): Readonly<{
    sessionId: string;
    address: SessionAddress | null;
}> | null {
    const resourceScopeId = readResourcePaneScopeId(scopeId);
    if (resourceScopeId !== scopeId) return parseSessionPaneScopeId(resourceScopeId);
    if (scopeId.startsWith(QUALIFIED_SESSION_SCOPE_PREFIX)) {
        const payload = scopeId.slice(QUALIFIED_SESSION_SCOPE_PREFIX.length);
        const separatorIndex = payload.indexOf(':');
        if (separatorIndex <= 0) return null;
        try {
            const address = normalizeSessionAddress(
                decodeURIComponent(payload.slice(0, separatorIndex)),
                decodeURIComponent(payload.slice(separatorIndex + 1)),
            );
            return address ? { sessionId: address.sessionId, address } : null;
        } catch {
            return null;
        }
    }
    if (!scopeId.startsWith(LEGACY_SESSION_SCOPE_PREFIX)) return null;
    const sessionId = normalizeSessionId(scopeId.slice(LEGACY_SESSION_SCOPE_PREFIX.length));
    return sessionId ? { sessionId, address: null } : null;
}
