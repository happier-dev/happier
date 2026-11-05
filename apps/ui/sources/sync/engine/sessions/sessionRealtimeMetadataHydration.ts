import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { resolveSessionLiveConsumption } from '@/sync/runtime/sessionLiveConsumption';
import { isSessionListRowVisible } from '@/sync/domains/session/sessionSurfaceVisibility';
import {
    captureServerRequestAuthorityForServerAccountScope,
    type ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { parseToken } from '@/utils/auth/parseToken';

/** Metadata demand stays exact-Home: visible rows borrow display; actual consumers borrow full documents. */
export async function hydrateSessionMetadataForHome(params: Readonly<{
    sessionId: string;
    serverId: string;
    credentials: AuthCredentials;
    isCurrent: () => boolean;
    activeRequest: Parameters<typeof captureServerRequestAuthorityForServerAccountScope>[0]['activeRequest'];
    hydrate: (authority: ServerAccountRequestAuthority, isCurrent: () => boolean,
        contentDemand: 'session' | 'list-projection') => Promise<unknown>;
}>): Promise<void> {
    const fullContentDemand = () => resolveSessionLiveConsumption(params.sessionId, params.serverId).isFullContentConsumer
        && areServerProfileIdentifiersEquivalent(storage.getState().sessions[params.sessionId]?.serverId, params.serverId);
    const currentDemand = () => params.isCurrent()
        && (fullContentDemand() || isSessionListRowVisible(params.sessionId, params.serverId));
    if (!currentDemand()) return;
    const scope = createServerAccountScope(params.serverId, parseToken(params.credentials.token));
    if (!scope) return;
    const authority = await captureServerRequestAuthorityForServerAccountScope({ scope, activeRequest: params.activeRequest });
    try {
        if (currentDemand()) await params.hydrate(authority, currentDemand, fullContentDemand() ? 'session' : 'list-projection');
    } finally { await authority.release(); }
}
