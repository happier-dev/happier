import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import type { DesktopAppWindowSurface } from './appWindowSurface';

const native = vi.hoisted(() => ({
    listener: undefined as ((surface: DesktopAppWindowSurface) => void) | undefined,
    snapshot: undefined as Promise<readonly DesktopAppWindowSurface[]> | undefined,
}));
// Native focus/events are the boundary; the renderer projection stays real.
vi.mock('@/utils/platform/desktopHost', () => ({
    invokeDesktopHost: () => native.snapshot,
    listenDesktopHostEvent: async (_event: string, listener: (surface: DesktopAppWindowSurface) => void) => {
        native.listener = listener;
        return () => { native.listener = undefined; };
    },
}));

import { getFocusedDesktopAppWindowSurface, observeDesktopAppWindowSurfaces, subscribeFocusedDesktopAppWindowSurface } from './appWindowSurface';
import { getDesktopAppWindowMountedSurfaces, subscribeDesktopAppWindowMountedSurfaces } from './appWindowSurface';

afterEach(() => { native.listener = undefined; native.snapshot = undefined; });

describe('native app-window focus projection', () => {
    it('retains unfocused mounted addresses, ignores unchanged focus events, and withdraws retired membership', async () => {
        const surface = { windowId: 'editor', homeId: 'home-b', accountId: 'alice', sessionId: null,
            focused: false, methods: ['mounted-workflow'] };
        const sibling = { ...surface, windowId: 'sibling', methods: ['sibling-command'] };
        native.snapshot = Promise.resolve([surface, sibling]);
        const stop = await observeDesktopAppWindowSurfaces();
        let publications = 0;
        const unsubscribe = subscribeDesktopAppWindowMountedSurfaces(() => { publications++; });
        try {
            expect(getDesktopAppWindowMountedSurfaces()).toEqual([surface, sibling]);
            const previous = getDesktopAppWindowMountedSurfaces();
            for (let index = 0; index < 20; index++) native.listener?.({ ...surface, focused: index % 2 === 0 });
            expect(getDesktopAppWindowMountedSurfaces()).toBe(previous);
            expect(publications).toBe(0);
            native.listener?.({ ...surface, methods: ['mounted-workflow', 'mounted-file-command'] });
            expect(getDesktopAppWindowMountedSurfaces()[0]?.methods).toEqual(['mounted-workflow', 'mounted-file-command']);
            expect(getDesktopAppWindowMountedSurfaces()[1]).toBe(sibling);
            expect(publications).toBe(1);
            native.listener?.({ ...surface, methods: [] });
            expect(getDesktopAppWindowMountedSurfaces()).toEqual([sibling]);
            expect(publications).toBe(2);
        } finally { unsubscribe(); stop(); }
    });

    it('adopts the focused snapshot after an unrelated blur and publishes only changed focus', async () => {
        const snapshot = createDeferred<readonly DesktopAppWindowSurface[]>();
        native.snapshot = snapshot.promise;
        const focused = { windowId: 'focused', homeId: 'home-b', accountId: 'alice', sessionId: 'colliding-session', focused: true };
        let changes = 0;
        const unsubscribe = subscribeFocusedDesktopAppWindowSurface(() => { changes++; });
        const observing = observeDesktopAppWindowSurfaces();
        await vi.waitFor(() => expect(native.listener).toBeDefined());
        native.listener?.({ ...focused, windowId: 'unrelated', focused: false });
        snapshot.resolve([focused]);
        const stop = await observing;
        try {
            expect(getFocusedDesktopAppWindowSurface()).toEqual(focused);
            const retained = getFocusedDesktopAppWindowSurface();
            native.listener?.({ ...focused });
            expect(getFocusedDesktopAppWindowSurface()).toBe(retained);
            expect(changes).toBe(1);
            native.listener?.({ ...focused, focused: false });
            expect(getFocusedDesktopAppWindowSurface()).toBeNull();
            expect(changes).toBe(2);
        } finally {
            stop(); unsubscribe();
        }
        expect(native.listener).toBeUndefined();
    });
});
