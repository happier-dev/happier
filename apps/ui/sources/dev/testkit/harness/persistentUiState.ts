import type { createPersistentUiState } from '@/sync/domains/state/persistentUiState';
import { z } from 'zod/mini';
import { PersistedPaneScopeSchema } from '@/components/appShell/panes/model/paneScopePersistenceSchema';
import { vi } from 'vitest';
import type { MMKV } from 'react-native-mmkv';

export const PersistedPaneScopesSchema = z._default(z.record(z.string(), PersistedPaneScopeSchema), {});

/** Native-only legacy migration vectors predate the web key constraint. */
export async function installLegacyNativeMmkvBoundaryForTest(): Promise<Pick<MMKV, 'set' | 'getString' | 'delete' | 'getAllKeys' | 'clearAll'>> {
    const { createMockMMKV } = await import('../../../../../../node_modules/react-native-mmkv/src/createMMKV.mock');
    const { getPersistenceStorage } = await vi.importActual<typeof import('@/sync/domains/state/persistenceStorage')>('@/sync/domains/state/persistenceStorage');
    const storage = getPersistenceStorage();
    const native = createMockMMKV();
    vi.spyOn(storage, 'set').mockImplementation(native.set);
    vi.spyOn(storage, 'getString').mockImplementation(native.getString);
    vi.spyOn(storage, 'delete').mockImplementation(native.delete);
    vi.spyOn(storage, 'getAllKeys').mockImplementation(native.getAllKeys);
    vi.spyOn(storage, 'clearAll').mockImplementation(native.clearAll);
    return native;
}

/** Seed the real keyed persistence owner; production has no test-only reset API. */
export function replacePersistentUiStateForTest<T>(
    state: ReturnType<typeof createPersistentUiState<T>>, values: Readonly<Record<string, T>>,
): void {
    for (const key of Object.keys(state.readAll())) if (!Object.hasOwn(values, key)) state.remove(key);
    for (const [key, value] of Object.entries(values)) state.set(key, value);
}
