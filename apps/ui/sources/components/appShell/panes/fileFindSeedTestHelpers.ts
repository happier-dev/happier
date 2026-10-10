import { vi } from 'vitest';

const fileFindAccountBoundary = vi.hoisted(() => ({ serverId: 'home-a', accountId: 'account-a' }));

/** Mocks applied-runtime/storage adapters while retaining the real Account lifetime owner. */
export function installFileFindAccountBoundaryMocks(serverId = 'home-a', accountId = 'account-a') {
    fileFindAccountBoundary.serverId = serverId;
    fileFindAccountBoundary.accountId = accountId;
    vi.mock('@/sync/runtime/orchestration/appliedActiveServerRuntime', () => ({
        getAppliedActiveServerSnapshot: () => ({ serverId: fileFindAccountBoundary.serverId, serverUrl: 'https://home.test', generation: 0 }),
        isAppliedActiveServerRuntimeAvailable: () => true,
    }));
    vi.mock('@/sync/domains/state/storageStateReaderBridge', async (importOriginal) => ({
        ...await importOriginal<typeof import('@/sync/domains/state/storageStateReaderBridge')>(),
        readRegisteredStorageState: () => ({ profileScope: { ...fileFindAccountBoundary } }),
    }));
}
