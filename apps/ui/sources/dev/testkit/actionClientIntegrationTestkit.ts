import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { authGetTokenAtEndpoint } from '@/auth/flows/getToken';
import { encodeBase64 } from '@/encryption/base64';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { loadSyncSingletonForTests } from './harness/syncSingletonLoader';
import { createPublishedHomeOutputFetch } from './machineClientEnrollmentOutputFixture';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
export { allowRealServerSocketBoundary as allowRealActionServerSocketBoundary } from './harness/serverAccountConnectionHarness';
export { createMachineClientEnrollmentOutputFixture } from './machineClientEnrollmentOutputFixture';
export { createAccountOutputFixture } from './machineAccountOutputContractFixture';
export { createUiMachineOutputFixture } from './machinesOutputContractFixture';

/** Real UI client for cross-app journeys; only the platform lock API is substituted. */
export async function connectUiActionClient(params: Readonly<{ serverUrl: string; publicEndpoint?: string; credentials: AuthCredentials }>) {
    const locks = installWebLockManagerMock();
    if (params.publicEndpoint) setRuntimeFetch(createPublishedHomeOutputFetch({
        publishedOrigin: params.publicEndpoint, loopbackUrl: params.serverUrl }));
    let bridge: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | undefined;
    const close = async () => {
        try {
            if (bridge) await disconnectActiveServerConnection();
        } finally {
            try { await bridge?.dispose(); } finally {
                if (params.publicEndpoint) resetRuntimeFetch();
                locks.restore();
            }
        }
    };
    try {
        const { id: configuredServerId } = await upsertServerProfile({ name: 'Composed Action client', serverUrl: params.serverUrl });
        if (!await TokenStorage.setCredentialsForServerUrl(params.serverUrl, { serverId: configuredServerId }, params.credentials)) {
            throw new Error('UI credential storage failed');
        }
        await setActiveServerId(configuredServerId, { scope: 'device' });
        if ((await getServerFeaturesSnapshot({ serverId: configuredServerId, force: true })).status !== 'ready') {
            throw new Error('UI Home discovery did not become ready');
        }
        bridge = await loadSyncSingletonForTests();
        await restoreConnectionToActiveServer(params.credentials);
        // Cold restore prepares transport; bootstrap publishes Account readiness
        // separately. A composed caller starts after that real initial read.
        await getSyncSingleton().awaitBootstrapForegroundAcquisition();
        if (!storage.getState().isDataReady) await new Promise<void>(resolve => {
            const unsubscribe = storage.subscribe(state => {
                if (!state.isDataReady) return;
                unsubscribe();
                resolve();
            });
        });
        await getSyncSingleton().refreshMachines();
        const serverId = getActiveServerSnapshot().serverId;
        const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
        return {
            serverId,
            execute,
            // The composed fixture supplies the designed user's explicit Confirm.
            executeConfirmed: execute.confirmed,
            isAccountReady: () => Boolean(getActiveServerAccountScope()),
            isMachineActive: (machineId: string) => {
                const machine = storage.getState().machines[machineId];
                return machine ? readMachineActivity(machine).active === true : false;
            },
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}

/** Sign in as the person through the UI's Account flow, never a terminal bearer. */
export async function connectUiPersonActionClient(params: Readonly<{
    serverUrl: string;
    accountSecret: Uint8Array;
}>): ReturnType<typeof connectUiActionClient> {
    const credentials = await authGetTokenAtEndpoint({
        endpointUrl: params.serverUrl,
        secret: params.accountSecret,
        requireKeyChallengeV2: true,
        requireExistingAccount: true,
    });
    return connectUiActionClient({ serverUrl: params.serverUrl,
        credentials: { ...credentials, secret: encodeBase64(params.accountSecret) } });
}
