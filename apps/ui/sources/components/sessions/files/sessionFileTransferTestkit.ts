import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol';
import { createMachineFixture, createSessionFixture } from '@/dev/testkit';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { setActiveServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { invalidateCachedTransferRoutesForServer } from '@/sync/domains/transfers/runtime/transferRouteCache';

export const TRANSFER_ENDPOINT = { endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] };

export function transferFeatures(overrides: Partial<FeaturesResponse['features']['machines']> = {}): FeaturesResponse {
    return FeaturesResponseSchema.parse({ features: { machines: {
        enabled: true,
        transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } },
        peerMediation: { enabled: true },
        ...overrides,
    } }, capabilities: { machines: { transfer: { serverRouted: { maxBytes: 128 } } } } });
}

export function transferMachine(overrides: Partial<Machine> = {}): Machine {
    return createMachineFixture({
        kind: 'persistent', revokedAt: null,
        operationProtocolCapabilities: { finiteTransferRpc: { protocolVersions: [1] }, irohMachineEndpoint: { protocolVersions: [1], ...TRANSFER_ENDPOINT } },
        operationProtocolCapabilitiesRevision: 1,
        daemonState: { transfer: {
            supported: { import: true, export: true },
            listenerClasses: {
                loopback_http: { enabled: false, configured: false, active: false },
                tailscale_serve_https: { enabled: false, configured: false, active: false },
            },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
        } },
        ...overrides,
    });
}

/** Real server/store/projection owners; callers substitute only host and transport boundaries. */
export async function resetTransferFixture(): Promise<void> {
    resetServerFeaturesClientForTests();
    for (const serverId of ['server-1', 'server-a', 'server-b', 'server-explicit']) {
        const serverUrl = `https://${serverId}.transfer.example.test`;
        await upsertServerProfile({ serverUrl });
        await setServerProfileIdentityForUrl(serverUrl, serverId);
        invalidateCachedTransferRoutesForServer({ serverId });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: transferFeatures() } });
    }
    await setActiveServer({ serverId: 'server-1' });
    storage.setState({
        sessions: {}, machines: {}, machineListByServerId: {}, sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {}, concurrentSessionListCacheByServerId: {}, sessionListIndexByServerId: {},
        profileScope: { serverId: 'server-1', accountId: 'alice' },
    });
}

export function installTransferProjection(input: Readonly<{
    serverId?: string;
    sessionId?: string;
    session?: Session | null;
    machine?: Machine | null;
    globalMachine?: Machine | null;
    features?: FeaturesResponse;
}> = {}): void {
    const serverId = input.serverId ?? 'server-1';
    const sessionId = input.sessionId ?? input.session?.id ?? 's1';
    const machine = input.machine === undefined ? transferMachine() : input.machine;
    const session = input.session === undefined
        ? createSessionFixture({ id: sessionId, serverId, active: true, metadata: { machineId: machine?.id ?? 'machine-1', path: '/repo', host: 'tester.local' } })
        : input.session;
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: input.features ?? transferFeatures() } });
    storage.setState((state) => ({
        sessions: session ? { [sessionId]: session } : {},
        machines: input.globalMachine ? { [input.globalMachine.id]: input.globalMachine } : machine ? { [machine.id]: machine } : {},
        machineListByServerId: { ...state.machineListByServerId, [serverId]: machine ? [machine] : null },
        profileScope: { serverId, accountId: 'alice' },
    }));
}
