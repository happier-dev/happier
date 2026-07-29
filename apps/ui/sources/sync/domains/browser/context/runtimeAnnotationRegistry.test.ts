import { afterEach, describe, expect, it } from 'vitest';

import type { BrowserContextAnnotationAdapter } from './runtimeAnnotationExecutor';
import {
    clearBrowserContextAnnotationRegistryForTests,
    readRegisteredBrowserContextAnnotationAdapter,
    registerBrowserContextAnnotationAdapter,
} from './runtimeAnnotationRegistry';

function makeAdapter(label: string): BrowserContextAnnotationAdapter {
    return {
        dispatch: () => ({ status: 'unavailable', reason: label }),
    };
}

afterEach(() => {
    clearBrowserContextAnnotationRegistryForTests();
});

describe('browser context annotation registry (UX-7 keyed map)', () => {
    it('keeps distinct adapters per (browserSessionId, viewId) without eviction (multi-tab isolation)', () => {
        const adapterA = makeAdapter('A');
        const adapterB = makeAdapter('B');

        registerBrowserContextAnnotationAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: adapterA,
        });
        registerBrowserContextAnnotationAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_b',
            adapter: adapterB,
        });

        // The single-slot registry evicted view_a on the second register; the keyed map must not.
        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_a',
            }),
        ).toBe(adapterA);
        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_b',
            }),
        ).toBe(adapterB);
    });

    it('isolates identical viewIds across different browser sessions', () => {
        const adapterA = makeAdapter('A');
        const adapterB = makeAdapter('B');
        registerBrowserContextAnnotationAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_x',
            adapter: adapterA,
        });
        registerBrowserContextAnnotationAdapter({
            browserSessionId: 'session_2',
            viewId: 'view_x',
            adapter: adapterB,
        });

        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                browserSessionId: 'session_2',
                viewId: 'view_x',
            }),
        ).toBe(adapterB);
        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_x',
            }),
        ).toBe(adapterA);
    });

    it('returns null for an unregistered key', () => {
        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                browserSessionId: 'absent',
                viewId: 'absent',
            }),
        ).toBeNull();
    });

    it('unregister only clears its own slot (token-checked)', () => {
        const adapterA = makeAdapter('A');
        const adapterB = makeAdapter('B');
        const disposeA = registerBrowserContextAnnotationAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: adapterA,
        });
        registerBrowserContextAnnotationAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_b',
            adapter: adapterB,
        });

        disposeA();

        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_a',
            }),
        ).toBeNull();
        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_b',
            }),
        ).toBe(adapterB);
    });

    it('a stale disposer does not clobber a re-registered key', () => {
        const stale = makeAdapter('stale');
        const fresh = makeAdapter('fresh');
        const disposeStale = registerBrowserContextAnnotationAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: stale,
        });
        // Remount registers a new token under the same key before the stale disposer fires.
        registerBrowserContextAnnotationAdapter({
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: fresh,
        });

        disposeStale();

        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                browserSessionId: 'session_1',
                viewId: 'view_a',
            }),
        ).toBe(fresh);
    });
});
