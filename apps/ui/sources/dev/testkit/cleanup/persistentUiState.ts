import { vi } from 'vitest';

/** Match the device reset to its projection lifecycle without opening an unused durable adapter. */
export async function resetPersistentUiStateForTest(): Promise<void> {
    const native = await vi.importActual<typeof import('@/dev/reactNativeMmkvStub')>('@/dev/reactNativeMmkvStub');
    native.resetMmkvStoresForTests();
    const { publishPersistenceStorageCleared } = await vi.importActual<typeof import('@/sync/domains/state/persistenceStorage')>('@/sync/domains/state/persistenceStorage');
    publishPersistenceStorageCleared();
}
