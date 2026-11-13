import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
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
        const { id: serverId } = await upsertServerProfile({ name: 'Composed Action client', serverUrl: params.serverUrl });
        if (!await TokenStorage.setCredentialsForServerUrl(params.serverUrl, { serverId }, params.credentials)) {
            throw new Error('UI credential storage failed');
        }
        await setActiveServerId(serverId, { scope: 'device' });
        if ((await getServerFeaturesSnapshot({ serverId, force: true })).status !== 'ready') {
            throw new Error('UI Home discovery did not become ready');
        }
        bridge = await loadSyncSingletonForTests();
        await restoreConnectionToActiveServer(params.credentials);
        const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
        return {
            serverId,
            execute,
            // The composed fixture supplies the designed user's explicit Confirm.
            executeConfirmed: execute.confirmed,
            isAccountReady: () => Boolean(getActiveServerAccountScope()),
            isMachineActive: (machineId: string) => storage.getState().machines[machineId]?.active === true,
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
