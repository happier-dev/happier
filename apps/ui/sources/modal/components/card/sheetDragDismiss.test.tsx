import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';

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
        // Assistive technology dismisses through the grabber's own action.
        grabber!.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
        expect(dismiss).toHaveBeenCalledTimes(1);
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
