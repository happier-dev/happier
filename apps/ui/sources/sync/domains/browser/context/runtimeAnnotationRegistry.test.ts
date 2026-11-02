import { afterEach, describe, expect, it } from 'vitest';

import type { BrowserContextAnnotationAdapter } from './runtimeAnnotationExecutor';
import {
    clearBrowserContextAnnotationRegistryForTests,
    readRegisteredBrowserContextAnnotationAdapter,
    registerBrowserContextAnnotationAdapter,
} from './runtimeAnnotationRegistry';

const scope = { serverId: 'registry_home', accountId: 'registry_account' };

function makeAdapter(label: string): BrowserContextAnnotationAdapter {
    return {
        dispatch: () => ({ status: 'unavailable', reason: label }),
    };
}

afterEach(() => {
    clearBrowserContextAnnotationRegistryForTests();
});

describe('browser context annotation registry (UX-7 keyed map)', () => {
    it('isolates retained views by Account and Home even when their browser ids coincide', () => {
        const adapterA = makeAdapter('A');
        const adapterB = makeAdapter('B');
        const view = { browserSessionId: 'session_1', viewId: 'view_1' };
        const scopeA = { serverId: 'home_a', accountId: 'account_a' };
        const scopeB = { serverId: 'home_b', accountId: 'account_b' };
        const registrationA = { ...view, scope: scopeA, adapter: adapterA };
        const registrationB = { ...view, scope: scopeB, adapter: adapterB };
        registerBrowserContextAnnotationAdapter(registrationA);
        registerBrowserContextAnnotationAdapter(registrationB);

        expect(readRegisteredBrowserContextAnnotationAdapter(registrationA)).toBe(adapterA);
        expect(readRegisteredBrowserContextAnnotationAdapter(registrationB)).toBe(adapterB);
        const foreignAccount = { ...view, scope: { ...scopeA, accountId: 'other_account' } };
        const foreignHome = { ...view, scope: { ...scopeA, serverId: 'other_home' } };
        expect(readRegisteredBrowserContextAnnotationAdapter(foreignAccount)).toBeNull();
        expect(readRegisteredBrowserContextAnnotationAdapter(foreignHome)).toBeNull();
    });

    it('keeps distinct adapters per (browserSessionId, viewId) without eviction (multi-tab isolation)', () => {
        const adapterA = makeAdapter('A');
        const adapterB = makeAdapter('B');

        registerBrowserContextAnnotationAdapter({
            scope,
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: adapterA,
        });
        registerBrowserContextAnnotationAdapter({
            scope,
            browserSessionId: 'session_1',
            viewId: 'view_b',
            adapter: adapterB,
        });

        // The single-slot registry evicted view_a on the second register; the keyed map must not.
        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                scope,
                browserSessionId: 'session_1',
                viewId: 'view_a',
            }),
        ).toBe(adapterA);
        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                scope,
                browserSessionId: 'session_1',
                viewId: 'view_b',
            }),
        ).toBe(adapterB);
    });

    it('isolates identical viewIds across different browser sessions', () => {
        const adapterA = makeAdapter('A');
        const adapterB = makeAdapter('B');
        registerBrowserContextAnnotationAdapter({
            scope,
            browserSessionId: 'session_1',
            viewId: 'view_x',
            adapter: adapterA,
        });
        registerBrowserContextAnnotationAdapter({
            scope,
            browserSessionId: 'session_2',
            viewId: 'view_x',
            adapter: adapterB,
        });

        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                scope,
                browserSessionId: 'session_2',
                viewId: 'view_x',
            }),
        ).toBe(adapterB);
        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                scope,
                browserSessionId: 'session_1',
                viewId: 'view_x',
            }),
        ).toBe(adapterA);
    });

    it('unregister only clears its own slot (token-checked)', () => {
        const adapterA = makeAdapter('A');
        const adapterB = makeAdapter('B');
        const disposeA = registerBrowserContextAnnotationAdapter({
            scope,
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: adapterA,
        });
        registerBrowserContextAnnotationAdapter({
            scope,
            browserSessionId: 'session_1',
            viewId: 'view_b',
            adapter: adapterB,
        });

        disposeA();

        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                scope,
                browserSessionId: 'session_1',
                viewId: 'view_a',
            }),
        ).toBeNull();
        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                scope,
                browserSessionId: 'session_1',
                viewId: 'view_b',
            }),
        ).toBe(adapterB);
    });

    it('a stale disposer does not clobber a re-registered key', () => {
        const stale = makeAdapter('stale');
        const fresh = makeAdapter('fresh');
        const disposeStale = registerBrowserContextAnnotationAdapter({
            scope,
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: stale,
        });
        // Remount registers a new token under the same key before the stale disposer fires.
        registerBrowserContextAnnotationAdapter({
            scope,
            browserSessionId: 'session_1',
            viewId: 'view_a',
            adapter: fresh,
        });

        disposeStale();

        expect(
            readRegisteredBrowserContextAnnotationAdapter({
                scope,
                browserSessionId: 'session_1',
                viewId: 'view_a',
            }),
        ).toBe(fresh);
    });
});
