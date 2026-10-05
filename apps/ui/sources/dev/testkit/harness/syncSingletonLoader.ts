import { afterAll } from 'vitest';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';

let dispose: (() => void) | undefined;
afterAll(() => { dispose?.(); });

/** Import directly, after installing transport boundaries, and call in setup. */
export async function loadSyncSingletonForTests(): Promise<void> {
    dispose?.();
    dispose = undefined;
    await import('@/sync/syncEngine');
    const bridge = await loadVitestModuleForNodeRequire(
        new URL('../../../sync/sync.ts', import.meta.url),
        () => import('@/sync/sync'),
    );
    dispose = bridge.dispose;
}
