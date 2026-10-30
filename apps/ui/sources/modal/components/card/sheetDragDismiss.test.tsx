import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import type { GestureResponderEvent, LayoutChangeEvent, PanResponderGestureState } from 'react-native';

import { installModalComponentCommonModuleMocks } from '../modalComponentTestHelpers';

installModalComponentCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }),
});

afterEach(() => standardCleanup());

/**
 * A bottom sheet dismisses by dragging it down (lab `widget-add` A2p): far enough, or flung, it
 * closes; otherwise it settles back. The grabber shows only where the sheet can be dismissed.
 */
describe('sheet drag to dismiss', () => {
    it('leaves a tap to the close button and preserves drag, cancel, and dismiss at the responder boundary', async () => {
        const { act, renderHook } = await import('@/dev/testkit');
        const { PanResponder } = await import('react-native');
        const { useSheetDrag } = await import('./sheetDragDismiss');
        // PanResponder is the native input boundary; capture its handlers, keeping sheet logic real.
        const create = vi.spyOn(PanResponder, 'create');
        const dismiss = vi.fn();
        const hook = await renderHook(() => useSheetDrag(dismiss));
        const handlers = create.mock.calls.at(-1)![0];
        const gesture: PanResponderGestureState = {
            stateID: 1, moveX: 0, moveY: 0, x0: 0, y0: 0,
            dx: 0, dy: 0, vx: 0, vy: 0, numberActiveTouches: 1, _accountsForMovesUpTo: 0,
        };
        // Only geometry/gesture state is consumed; the OS supplies the remaining synthetic-event fields.
        const event = {} as GestureResponderEvent;
        hook.getCurrent().onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } } } as LayoutChangeEvent);
        try {
            expect(handlers.onStartShouldSetPanResponder?.(event, gesture)).toBe(false);
            expect(handlers.onMoveShouldSetPanResponder?.(event, { ...gesture, dx: 30, dy: 10 })).toBe(false);
            expect(handlers.onMoveShouldSetPanResponder?.(event, { ...gesture, dy: 60 })).toBe(true);
            await act(async () => {
                handlers.onPanResponderMove?.(event, { ...gesture, dy: 60 });
                handlers.onPanResponderRelease?.(event, { ...gesture, dy: 60 });
            });
            expect(dismiss).not.toHaveBeenCalled();
            await act(async () => {
                handlers.onPanResponderMove?.(event, { ...gesture, dy: 240 });
                handlers.onPanResponderTerminate?.(event, gesture);
            });
            expect(dismiss).not.toHaveBeenCalled();
            await act(async () => {
                handlers.onPanResponderMove?.(event, { ...gesture, dy: 240 });
                handlers.onPanResponderRelease?.(event, { ...gesture, dy: 240 });
            });
            expect(dismiss).toHaveBeenCalledOnce();
        } finally {
            await hook.unmount();
            create.mockRestore();
        }
    });

    it('dismisses past a third of the sheet or on a downward fling, and settles back otherwise', async () => {
        const { resolveSheetDragRelease } = await import('./sheetDragDismiss');
        const sheet = 600;
        expect(resolveSheetDragRelease({ translationY: 60, velocityY: 0.1, sheetHeightPx: sheet })).toBe('settle');
        expect(resolveSheetDragRelease({ translationY: 199, velocityY: 0, sheetHeightPx: sheet })).toBe('settle');
        expect(resolveSheetDragRelease({ translationY: 201, velocityY: 0, sheetHeightPx: sheet })).toBe('dismiss');
        // A quick downward flick closes a short drag; an upward one never does.
        expect(resolveSheetDragRelease({ translationY: 40, velocityY: 0.9, sheetHeightPx: sheet })).toBe('dismiss');
        expect(resolveSheetDragRelease({ translationY: 220, velocityY: -0.9, sheetHeightPx: sheet })).toBe('settle');
        // Dragging up does not lift the sheet past its rest.
        expect(resolveSheetDragRelease({ translationY: -80, velocityY: 0, sheetHeightPx: sheet })).toBe('settle');
    });

    it('draws the grabber on a dismissible sheet only', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');
        const { SheetDismissProvider } = await import('./sheetDragDismiss');
        const dismiss = vi.fn();
        const dismissible = await renderScreen(
            <SheetDismissProvider onDismiss={dismiss}>
                <ModalCardFrame title="Add to Home" header="none" presentation="sheet" testID="sheet">{React.createElement('Child')}</ModalCardFrame>
            </SheetDismissProvider>,
        );
        const grabber = dismissible.findByTestId('sheet.grabber');
        expect(grabber).not.toBeNull();
        // A direct tap and assistive technology use the same dismissal owner.
        await dismissible.pressByTestIdAsync('sheet.grabber');
        expect(dismiss).toHaveBeenCalledTimes(1);
        grabber!.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
        expect(dismiss).toHaveBeenCalledTimes(2);
        standardCleanup();

        const fixed = await renderScreen(
            <ModalCardFrame title="Add to Home" header="none" presentation="sheet" testID="sheet">{React.createElement('Child')}</ModalCardFrame>,
        );
        expect(fixed.findByTestId('sheet.grabber')).toBeNull();
        standardCleanup();

        const card = await renderScreen(
            <SheetDismissProvider onDismiss={dismiss}>
                <ModalCardFrame title="Add to Home" presentation="card" testID="card">{React.createElement('Child')}</ModalCardFrame>
            </SheetDismissProvider>,
        );
        expect(card.findByTestId('card.grabber')).toBeNull();
    });
});
