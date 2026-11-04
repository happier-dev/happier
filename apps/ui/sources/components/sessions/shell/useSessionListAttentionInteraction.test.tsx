import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    SessionListAttentionInteractionContext,
    useSessionListAttentionActivity,
    useSessionListAttentionInteractionHeld,
    useSessionListAttentionInteractionOwner,
} from './useSessionListAttentionInteraction';

async function mountInteraction() {
    return renderHook(() => {
        const controller = useSessionListAttentionInteractionOwner();
        return { controller, held: useSessionListAttentionInteractionHeld(controller) };
    });
}

describe('mounted Session list attention interaction', () => {
    afterEach(standardCleanup);

    it('holds mouse and pen presence, then releases a clicked row on leave even while focused', async () => {
        const hook = await mountInteraction();
        const zone = hook.getCurrent().controller.zoneProps;
        act(() => zone.onPointerEnter({ pointerType: 'mouse' }));
        expect(hook.getCurrent().held).toBe(true);
        act(() => {
            zone.onPointerDownCapture();
            zone.onFocus({ target: { matches: () => false } });
            zone.onPointerLeave();
        });
        expect(hook.getCurrent().held).toBe(false);
        act(() => zone.onPointerEnter({ pointerType: 'pen' }));
        expect(hook.getCurrent().held).toBe(true);
        act(() => zone.onPointerLeave());
        act(() => zone.onPointerEnter({ pointerType: 'touch' }));
        expect(hook.getCurrent().held).toBe(false);
        act(() => zone.onTouchStart());
        expect(hook.getCurrent().held).toBe(true);
        act(() => zone.onTouchEnd());
        expect(hook.getCurrent().held).toBe(false);
    });

    it('holds visible keyboard navigation across nested focus, releases on navigation and ignores clicked focus', async () => {
        const hook = await mountInteraction();
        const { controller } = hook.getCurrent();
        act(() => controller.zoneProps.onFocus({ target: { matches: () => true } }));
        expect(hook.getCurrent().held).toBe(true);
        act(() => controller.zoneProps.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} }));
        expect(hook.getCurrent().held).toBe(true);
        act(() => controller.releaseKeyboard());
        expect(hook.getCurrent().held).toBe(false);
        act(() => controller.zoneProps.onFocus({ target: { matches: () => false } }));
        expect(hook.getCurrent().held).toBe(false);
        act(() => controller.zoneProps.onKeyDownCapture({ key: 'ArrowDown' }));
        expect(hook.getCurrent().held).toBe(true);
        act(() => controller.zoneProps.onBlur({}));
        expect(hook.getCurrent().held).toBe(false);
    });

    it('keeps overlapping menu, peek and move lifetimes held and publishes only the final release without timers', async () => {
        vi.useFakeTimers();
        try {
            const hook = await mountInteraction();
            const { controller } = hook.getCurrent();
            const menu = {}, peek = {}, move = {};
            const notifications = vi.fn();
            const unsubscribe = controller.subscribe(notifications);
            act(() => {
                controller.setActivity(menu, true);
                controller.setActivity(peek, true);
                controller.setActivity(move, true);
                controller.zoneProps.onBlur({});
                controller.zoneProps.onPointerLeave();
            });
            expect(hook.getCurrent().held).toBe(true);
            act(() => { controller.setActivity(menu, false); controller.setActivity(move, false); });
            expect(hook.getCurrent().held).toBe(true);
            act(() => controller.setActivity(peek, false));
            expect(hook.getCurrent().held).toBe(false);
            expect(notifications).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
            unsubscribe();
        } finally { vi.useRealTimers(); }
    });

    it('releases unmounted overlay owners without rerendering unrelated row consumers', async () => {
        const hook = await mountInteraction();
        const controller = hook.getCurrent().controller;
        const rowRendered = vi.fn();
        const overlay = { setHeld: (_active: boolean) => {} };
        function Row() {
            useSessionListAttentionActivity();
            rowRendered();
            return null;
        }
        function Overlay() {
            overlay.setHeld = useSessionListAttentionActivity();
            return null;
        }
        const rows = Array.from({ length: 1_000 }, (_, key) => <Row key={key} />);
        const screen = await renderScreen(
            <SessionListAttentionInteractionContext.Provider value={controller}>
                {rows}<Overlay />
            </SessionListAttentionInteractionContext.Provider>,
        );
        rowRendered.mockClear();
        act(() => overlay.setHeld(true));
        expect(hook.getCurrent().held).toBe(true);
        act(() => controller.zoneProps.onPointerEnter({ pointerType: 'mouse' }));
        act(() => controller.zoneProps.onPointerLeave());
        expect(rowRendered).not.toHaveBeenCalled();
        await act(async () => screen.unmount());
        expect(hook.getCurrent().held).toBe(false);
    });

    it('shares the pane owner with a shell below an already resolved pane', async () => {
        const pane = await mountInteraction();
        const owner = pane.getCurrent().controller;
        const Wrapper = ({ children }: React.PropsWithChildren) => (
            <SessionListAttentionInteractionContext.Provider value={owner}>{children}</SessionListAttentionInteractionContext.Provider>
        );
        const shell = await renderHook(() => {
            const controller = useSessionListAttentionInteractionOwner();
            return { controller, held: useSessionListAttentionInteractionHeld(controller) };
        }, { wrapper: Wrapper });

        act(() => shell.getCurrent().controller.zoneProps.onPointerEnter({ pointerType: 'mouse' }));

        expect(shell.getCurrent().held).toBe(true);
        expect(pane.getCurrent().held).toBe(true);
        expect(shell.getCurrent().controller).toBe(owner);
    });
});
