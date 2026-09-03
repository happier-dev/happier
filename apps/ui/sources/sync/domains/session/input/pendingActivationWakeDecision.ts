import { PENDING_INPUT_PROTOCOL_VERSION_V2 } from '@happier-dev/protocol';

import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';

export function resolvePendingActivationWakeOwner(input: Readonly<{
    pendingInputProtocolVersion?: number | null;
    daemonPendingSessionActivationSupported?: boolean | null;
}>): 'daemon' | 'ui' {
    return input.pendingInputProtocolVersion !== undefined
        && input.pendingInputProtocolVersion !== null
        && input.pendingInputProtocolVersion >= PENDING_INPUT_PROTOCOL_VERSION_V2
        && input.daemonPendingSessionActivationSupported === true
        ? 'daemon'
        : 'ui';
}

export async function shouldDelegatePendingActivationToDaemon(input: Readonly<{
    session: Session;
    serverId?: string | null;
    machineId?: string | null;
    getServerFeaturesSnapshot: (params?: { serverId?: string }) => Promise<ServerFeaturesSnapshot>;
    getMachine: (machineId: string) => Machine | null | undefined;
}>): Promise<boolean> {
    const machineId = typeof input.machineId === 'string' && input.machineId.trim().length > 0
        ? input.machineId.trim()
        : typeof input.session.metadata?.machineId === 'string'
            ? input.session.metadata.machineId.trim()
            : '';
    if (!machineId) return false;

    try {
        const serverId = input.serverId ?? input.session.serverId;
        const snapshot = await input.getServerFeaturesSnapshot({
            ...(serverId ? { serverId } : {}),
        });
        if (snapshot.status !== 'ready') return false;
        return resolvePendingActivationWakeOwner({
            pendingInputProtocolVersion: snapshot.features.capabilities.session?.pendingInput?.protocolVersion,
            daemonPendingSessionActivationSupported:
                input.getMachine(machineId)?.daemonState?.daemonPendingSessionActivationSupported,
        }) === 'daemon';
    } catch {
        return false;
    }
}
