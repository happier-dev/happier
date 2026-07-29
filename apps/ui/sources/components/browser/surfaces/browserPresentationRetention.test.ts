import { describe, expect, it } from 'vitest';

import type { BrowserSurfaceLifecycleSnapshot } from './browserSurfaceLifecycle';
import { createBrowserPresentationRetentionStore } from './browserPresentationRetention';

const SLOT = 'session:s1:details:slot';
const VIEW = 'logical-view-1';

function snapshotFor(
    logicalViewId: string,
    lifecycleState: BrowserSurfaceLifecycleSnapshot['lifecycleState'],
    visible: boolean,
): BrowserSurfaceLifecycleSnapshot {
    return {
        logicalViewId,
        lifecycleState,
        slotsById: {
            [SLOT]: {
                presentationSlotId: SLOT,
                visible,
                active: visible,
                measuredRect: visible ? { x: 0, y: 0, width: 100, height: 100 } : null,
            },
        },
        cleanupReason: null,
    };
}

function snapshot(
    lifecycleState: BrowserSurfaceLifecycleSnapshot['lifecycleState'],
    visible: boolean,
): BrowserSurfaceLifecycleSnapshot {
    return snapshotFor(VIEW, lifecycleState, visible);
}

describe('browser presentation retention store (UX-6)', () => {
    it('retains a logical view per slot and survives a hide→show toggle', () => {
        const store = createBrowserPresentationRetentionStore();
        expect(store.isRetained(SLOT)).toBe(false);

        store.recordLifecycle(SLOT, snapshot('visible', true));
        expect(store.isRetained(SLOT)).toBe(true);

        // A transient hide keeps the view retained (visibility is not lifetime).
        store.recordLifecycle(SLOT, snapshot('hidden', false));
        expect(store.isRetained(SLOT)).toBe(true);
    });

    it('drops retention only on a real closed lifecycle', () => {
        const store = createBrowserPresentationRetentionStore();
        store.recordLifecycle(SLOT, snapshot('visible', true));
        store.recordLifecycle(SLOT, { ...snapshot('closed', false), cleanupReason: 'logical_view_closed' });
        expect(store.isRetained(SLOT)).toBe(false);
    });

    it('retains only the active logical view per slot (no per-viewId accumulation leak)', () => {
        // The route-stable store lives for the app's lifetime and the host never emits a `closed`
        // lifecycle, so a bucket keyed by every focused viewId would leak as tabs churn. A slot must
        // hold exactly its current logical view: after switching from view A to view B, closing B
        // leaves the slot un-retained (the stale A must not linger forever).
        const store = createBrowserPresentationRetentionStore();
        store.recordLifecycle(SLOT, snapshotFor('view-a', 'visible', true));
        store.recordLifecycle(SLOT, snapshotFor('view-b', 'visible', true));
        store.recordLifecycle(SLOT, { ...snapshotFor('view-b', 'closed', false), cleanupReason: 'logical_view_closed' });
        expect(store.isRetained(SLOT)).toBe(false);
    });

    it('scopes retention to each slot independently', () => {
        const store = createBrowserPresentationRetentionStore();
        const otherSlot = 'session:s2:details:slot';
        store.recordLifecycle(SLOT, snapshot('visible', true));
        expect(store.isRetained(SLOT)).toBe(true);
        expect(store.isRetained(otherSlot)).toBe(false);
    });

    it('survives a consumer remount because the store outlives the panel', () => {
        // The store models the route-stable provider: a panel mounting, recording lifecycle, then
        // fully unmounting (no further calls) leaves retention intact for the next mount.
        const store = createBrowserPresentationRetentionStore();
        store.recordLifecycle(SLOT, snapshot('visible', true));
        // ...panel unmounts (no teardown call against the store)...
        // ...new panel mounts and reads retention before emitting any lifecycle...
        expect(store.isRetained(SLOT)).toBe(true);
    });
});
