import { afterAll } from 'vitest';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';

// File identities belong to Node, not Vite's client asset URL transform.
const { URL: NodeURL } = getVitestNodeBuiltin<typeof import('node:url')>('node:url');

let dispose: (() => void) | undefined;
afterAll(() => { dispose?.(); });

/** Import after installing transport boundaries; return the canonical cache restorer for per-test cleanup. */
export async function loadSyncSingletonForTests(): Promise<Readonly<{ dispose: () => void }>> {
    dispose?.();
    dispose = undefined;
    await import('@/sync/syncEngine');
    const bridge = await loadVitestModuleForNodeRequire(
        new NodeURL('../../../sync/sync.ts', import.meta.url),
        () => import('@/sync/sync'),
    );
    dispose = bridge.dispose;
    // Before hooks treat returned functions as automatic cleanup; keep existing hook callers inert.
    return { dispose: bridge.dispose };
}
