import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storageStore';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installRealActionExecutorModuleLoader } from '../harness/actionHomesHttpHarness';
import { createWorkflowActionHttpTransport } from './workflowActionHttpTransport';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

/** Native fixture installer; the same HTTP response owner is consumed by real source browser journeys. */
export async function installWorkflowActionHttpBoundary(params: Readonly<{
    fixtureResponse: (actionId: string, input: Record<string, unknown>) => Promise<unknown>;
    accountId?: () => string;
    automationDefinitions?: (url: URL, init?: RequestInit) => Promise<Response | undefined>;
    automationRuns?: (url: URL, init?: RequestInit) => Promise<Response>;
}>) {
    const restoreExecutorLoader = await installRealActionExecutorModuleLoader();
    const accountId = params.accountId ?? (() => storage.getState().profileScope?.accountId ?? 'account-a');
    const home = getActiveServerSnapshot();
    const webLocks = typeof globalThis.navigator?.locks?.request === 'function' ? null : installWebLockManagerMock();
    const writes: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];
    let credentials = { token: '' };
    let disposed = false;
    const boundary = createWorkflowActionHttpTransport({ ...params, accountId });
    const features = boundary.features;
    const request: RuntimeFetch = async (url, init) => {
        if (disposed) throw new Error('Workflow HTTP boundary is disposed');
        const target = new URL(String(url));
        if (target.origin !== new URL(home.serverUrl).origin) throw new Error(`Unexpected Workflow Home: ${target.origin}`);
        return boundary.fetch(url, init);
    };
    setRuntimeFetch(request);
    const refreshAccount = async () => {
        if (disposed) throw new Error('Workflow HTTP boundary is disposed');
        const nextAccountId = accountId();
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const isAppliedHome = getActiveServerAccountScope()?.serverId === home.serverId;
        const { disconnectActiveServerConnection, restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        if (isAppliedHome) await disconnectActiveServerConnection();
        const next = { token: `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: nextAccountId })), 'base64url')}.signature` };
        const write = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: home.serverId }, next);
        if (!write) throw new Error('Workflow Home credentials could not be persisted');
        writes.push(write);
        credentials = next;
        if (isAppliedHome) await restoreConnectionToActiveServer(next);
    };
    await refreshAccount();
    return {
        request,
        serverId: home.serverId,
        serverUrl: home.serverUrl,
        get credentials() { return credentials; },
        refreshAccount,
        prime() { primeServerFeaturesSnapshot({ serverId: home.serverId, snapshot: { status: 'ready', features } }); },
        async dispose() {
            if (disposed) return;
            disposed = true;
            try {
                const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
                if (getActiveServerAccountScope()?.serverId === home.serverId) {
                    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
                    await disconnectActiveServerConnection();
                }
            } finally {
                restoreExecutorLoader();
                resetRuntimeFetch();
                deleteServerFeaturesSnapshot({ serverId: home.serverId });
                try { for (const write of writes.splice(0).reverse()) await write.rollback(); }
                finally { webLocks?.restore(); }
            }
        },
    };
}
