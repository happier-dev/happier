import { createScmCapabilities } from '@happier-dev/protocol/scm';
import { installSessionOpsNetworkBoundary, type SessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

type ScmNetworkTestHarness = {
    network: SessionOpsNetworkBoundary;
    serverId: string;
    storage: typeof import('@/sync/domains/state/storage').storage;
    reset: () => void;
    dispose: () => void;
};

// Keep policy, target selection, locking, crypto and RPC orchestration real. The
// existing testkit replaces only Socket.IO/HTTP and saved device credentials.
export async function createScmNetworkTestHarness(): Promise<ScmNetworkTestHarness> {
    const network = await installSessionOpsNetworkBoundary();
    await loadSyncSingletonForTests();
    const { storage } = await import('@/sync/domains/state/storage');
    const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    const home = await network.addHome('https://scm-tests.example.test', 'scm-account');
    const initialState = storage.getState();
    return {
        network,
        serverId: home.id,
        storage,
        reset() {
            network.resetRequests();
            resetScopedMachineTransportCacheForTests();
            projectManager.clear();
            const machine = createMachineFixture();
            storage.setState(initialState, true);
            storage.setState({ machineListByServerId: { [home.id]: [machine] } });
            storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: home.id, active: true,
                metadata: { machineId: machine.id, host: 'tester.local', path: '/repo' } })]);
        },
        dispose() {
            resetScopedMachineTransportCacheForTests();
            projectManager.clear();
            storage.setState(initialState, true);
            network.dispose();
        },
    };
}

export const scmNetworkSnapshot = {
    fetchedAt: 1,
    projectKey: 'machine-1:/repo',
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git',
        remotes: [{ name: 'origin', fetchUrl: 'git@example.com:origin.git' }] },
    capabilities: createScmCapabilities({ writeRemoteFetch: true, writeRemotePush: true, writeRemotePull: true, writeRemotePublish: true }),
    branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
    stashCount: 0,
    hasConflicts: false,
    entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
} satisfies ScmWorkingSnapshot;
