import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';
import type { PopoverRenderProps } from './_types';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => viewport,
        });
    },
});

// Safe-area measurements come from the device SDK; overlay policy remains real.
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }),
    initialWindowMetrics: null,
}));

afterEach(() => { viewport.width = 390; viewport.height = 844; });

describe('Popover phone presentation', () => {
    it('uses a form completion action as the single sheet header exit', async () => {
        const { Popover } = await import('./Popover');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const onComplete = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(<Popover open phonePresentation="sheet" accessibilityLabel="Trigger"
            sheetHeaderAction={<RoundButton testID="sheet-done" size="small" title="Done" onPress={onComplete} />}
            onRequestClose={onClose}>{() => React.createElement('Form')}</Popover>);
        expect(screen.findByTestId('popover-sheet.close')).toBeNull();
        await screen.pressByTestIdAsync('sheet-done');
        expect(onComplete).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();
    });
    it('presents content as a named, full-width sheet with the shared close action on a phone', async () => {
        const { Popover } = await import('./Popover');
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        const { View } = await import('react-native');
        const onClose = vi.fn();
        let renderedBounds: PopoverRenderProps | undefined;
        const screen = await renderScreen(
            <Popover
                open
                phonePresentation="sheet"
                accessibilityLabel="Board settings"
                maxWidthCap={400}
                maxHeightCap={640}
                onRequestClose={onClose}
            >
                {(bounds) => {
                    renderedBounds = bounds;
                    return <FloatingOverlay maxHeight={bounds.maxHeight}>
                        <View testID="sheet-content" />
                    </FloatingOverlay>;
                }}
            </Popover>,
        );

        const dialog = screen.findAll((node) => node.props.role === 'dialog')[0];
        expect(dialog?.props.accessibilityLabel).toBe('Board settings');
        expect(dialog?.props.accessibilityViewIsModal).toBe(true);
        expect(renderedBounds?.maxWidth).toBe(390);
        expect(Boolean(screen.findByTestId('sheet-content'))).toBe(true);
        await screen.pressByTestIdAsync('popover-sheet.close');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps the anchored presentation on a wide viewport when phone sheets are requested', async () => {
        viewport.width = 1200;
        viewport.height = 900;
        const { Popover } = await import('./Popover');
        const screen = await renderScreen(
            <Popover open phonePresentation="sheet" onRequestClose={() => {}}>
                {() => React.createElement('PopoverChild')}
            </Popover>,
        );

        expect(screen.findAll((node) => node.props.role === 'dialog').length).toBe(0);
        expect(Boolean(screen.findByType('PopoverChild'))).toBe(true);
    });
});
