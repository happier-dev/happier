import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { fetchCurrentChangesCursor } from '@/sync/api/session/apiChanges';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import type { ServerFetch } from '@/sync/http/client';

/** The initial snapshot cut survives a same-authority runtime rebuild, not logout or a scope change. */
export class InitialChangesCursor {
    private acquisition: {
        scopeKey: string;
        cursor: string | null;
        pending: Promise<string | null> | null;
    } | null = null;

    reset(): void {
        this.acquisition = null;
    }

    async capture(params: Readonly<{
        serverId: string;
        serverUrl: string;
        accountId: string;
        sessionId?: string;
        credentials: AuthCredentials;
        currentCursor: string | null;
        request: ServerFetch;
        isCurrent: () => boolean;
    }>): Promise<string | null> {
        if (!params.isCurrent()) return null;
        const scopeKey = JSON.stringify([
            resolveServerProfileScopeIdForIdentifier(params.serverId), canonicalizeServerUrl(params.serverUrl),
            params.accountId, resolveAuthCredentialsScopeKey(params.credentials), params.sessionId ?? null,
        ]);
        if (this.acquisition?.scopeKey !== scopeKey) {
            this.acquisition = { scopeKey, cursor: null, pending: null };
        }
        const acquisition = this.acquisition;
        // A durable checkpoint/current replay is stronger than the initial cut.
        if (params.currentCursor !== null) return params.currentCursor;
        if (acquisition.cursor !== null) return acquisition.cursor;
        if (acquisition.pending) return acquisition.pending;
        const pending = fetchCurrentChangesCursor(params).then(result => {
            if (this.acquisition !== acquisition || !params.isCurrent() || result.status !== 'ok') return null;
            acquisition.cursor = result.cursor;
            return result.cursor;
        }).finally(() => { acquisition.pending = null; });
        acquisition.pending = pending;
        return pending;
    }
}
