import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    resolveSessionAttentionReminderDeadline,
    type SessionAttentionReminderInventoryRefreshResult,
    type SessionAttentionReminderDeadline,
    listSessionAttentionReminderHomeIds,
    useSessionAttentionReminderRefresh,
} from '@/activity/attention/runtime/sessionAttentionReminderScheduler';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import {
    listServerProfiles,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { createSessionListOrganizationSnapshotRequest } from '@/sync/engine/sessions/sessionListOrganizationSnapshotRequest';
import { invalidateSessionListQueryHome } from '@/sync/domains/session/listing/sessionListQueryInvalidation';
import { storage } from '@/sync/domains/state/storage';
import { fetchAndApplySessionOrganizationSnapshot } from '@/sync/ops/sessionOrganization';
import { sync } from '@/sync/sync';
import { useSessionOrganizationProjections, useSocketStatus } from '@/sync/store/hooks';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { parseToken } from '@/utils/auth/parseToken';

function readCredentialAccountId(token: string): string | null {
    try {
        return parseToken(token);
    } catch {
        return null;
    }
}

/**
 * Refreshes one exact Home's private organization inventory for the reminder clock.
 *
 * The inventory belongs to the Account whose credential sent the request, so the
 * exact Home/Account request guard fences it: a credential replacement on that
 * Home (Account A → B, including an offscreen Home) or a retired Account lifetime
 * discards A's response before it can reach B's Home-scoped organization state.
 * A superseded refresh rejects so the scheduler does not record it as loaded.
 */
export async function refreshSessionAttentionReminderInventory(params: Readonly<{
    serverId: string;
    serverUrl: string;
}>): Promise<SessionAttentionReminderInventoryRefreshResult> {
    const credentials = await TokenStorage.getCredentialsForServerUrl(params.serverUrl, { serverId: params.serverId });
    if (!credentials) return { kind: 'retryable_failure' };
    const scope = createServerAccountScope(params.serverId, readCredentialAccountId(credentials.token));
    if (!scope) return { kind: 'retryable_failure' };
    const staleError = () => new Error('Reminder inventory Account is no longer current for this Home');
    await runWithServerAccountScopeRequestGuard({ scope, staleError }, async ({ check, isCurrent }) => {
        // The guard subscribes after the first read; re-read so a replacement that
        // landed in between cannot be answered with the captured credential.
        const current = await TokenStorage.getCredentialsForServerUrl(params.serverUrl, { serverId: params.serverId });
        if (current?.token !== credentials.token) throw staleError();
        await fetchAndApplySessionOrganizationSnapshot({
            credentials,
            serverId: params.serverId,
            serverUrl: params.serverUrl,
            request: createSessionListOrganizationSnapshotRequest(),
            shouldContinue: isCurrent,
        });
        check();
    });
    return { kind: 'loaded' };
}

export function SessionAttentionReminderRuntime(): React.ReactElement | null {
    const activeServer = useActiveServerSnapshot();
    const activeServerId = activeServer.serverId.trim();
    const serverProfilesGeneration = useServerProfilesGeneration();
    const activeSocket = useSocketStatus();
    const serverProfiles = React.useMemo(() => listServerProfiles(), [serverProfilesGeneration]);
    const serverProfilesByScopeId = React.useMemo(() => new Map(
        serverProfiles.map((profile) => [resolveServerProfileScopeId(profile), profile] as const),
    ), [serverProfiles]);
    const serverIds = React.useMemo(() => listSessionAttentionReminderHomeIds(serverProfiles, activeServerId),
        [activeServerId, serverProfiles]);
    const organizationByServerId = useSessionOrganizationProjections(serverIds);
    const secondaryConnectedByServerId = storage(useShallow(React.useCallback((state) => (
        Object.fromEntries(serverIds.map((serverId) => [
            serverId,
            state.concurrentSessionListCacheByServerId?.[serverId]?.listObservation?.phase === 'ready',
        ]))
    ), [serverIds])));

    const connectedByServerId = React.useMemo(() => ({
        ...secondaryConnectedByServerId,
        ...(activeServerId
            ? { [activeServerId]: activeSocket.status === 'connected' }
            : {}),
    }), [activeServerId, activeSocket.status, secondaryConnectedByServerId]);
    const reminders = React.useMemo(() => Object.entries(organizationByServerId).flatMap(
        ([serverId, organization]) => Object.values(organization.attentionStandingsBySessionId).flatMap((standing) => {
            const reminder = resolveSessionAttentionReminderDeadline(serverId, standing);
            return reminder ? [reminder] : [];
        }),
    ), [organizationByServerId]);
    const refreshSession = React.useCallback(async (address: SessionAddress) => {
        return await sync.ensureSessionVisibleForMessageRoute(address.sessionId, {
            serverId: address.serverId,
            forceRefresh: true,
        });
    }, []);
    const refreshReminderInventory = React.useCallback(async (serverId: string) => {
        const profile = serverProfilesByScopeId.get(serverId);
        const serverUrl = profile?.serverUrl
            ?? (activeServerId === serverId ? activeServer.serverUrl : null);
        if (!serverUrl) return { kind: 'retryable_failure' as const };
        return await refreshSessionAttentionReminderInventory({ serverId, serverUrl });
    }, [activeServer.serverUrl, activeServerId, serverProfilesByScopeId]);

    useSessionAttentionReminderRefresh({
        connectedByServerId,
        // Sync's changes catch-up follows every lost connection of the active Home.
        catchUpServerId: activeServerId || null,
        invalidateSessionListQueryHome,
        refreshReminderInventory,
        refreshSession,
        reminders,
    });
    return null;
}
