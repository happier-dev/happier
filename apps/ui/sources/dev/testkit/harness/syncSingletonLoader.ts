import { vi } from 'vitest';

const loader = vi.hoisted(() => ({ current: null as typeof import('@/sync/sync').sync | null }));

// Metro's lazy require escapes Vitest's module graph. Replace only that loader;
// the singleton, its state, and all operations remain the production instances.
vi.mock('@/sync/runtime/getSyncSingleton', () => createSyncSingletonLoaderMock());

/** Install explicitly with vi.mock in suites that import consumers before this harness. */
export function createSyncSingletonLoaderMock(): {
    getSyncSingleton: () => typeof import('@/sync/sync').sync;
} {
    return {
        getSyncSingleton: () => {
            if (!loader.current) throw new Error('Load the real sync singleton before rendering its consumers');
            return loader.current;
        },
    };
}

/** Import directly, after installing transport boundaries, and call in setup. */
export async function loadSyncSingletonForTests(): Promise<void> {
    loader.current = (await import('@/sync/syncEngine')).sync;
}
