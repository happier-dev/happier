import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (value: any) => value.ios ?? value.default ?? null,
            },
            useWindowDimensions: () => ({ width: 1000, height: 800 }),
            StyleSheet: {
                absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
            },
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
});

// The surface and rows are rendering leaves; the real DropdownMenu -> Popover sizing path runs beneath them.
vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => React.createElement('FloatingOverlay', props, props.children),
}));

vi.mock('@/components/ui/forms/dropdown/SelectableMenuResults', () => ({
    SelectableMenuResults: (props: any) => React.createElement('SelectableMenuResults', props),
}));

async function renderMenuMaxHeight(maxHeightCap: number | undefined): Promise<number> {
    const { DropdownMenu } = await import('./DropdownMenu');
    const { OverlayPortalProvider, OverlayPortalHost } = await import('@/components/ui/popover/OverlayPortal');
    const { PopoverPortalTargetContextProvider } = await import('@/components/ui/popover/PopoverPortalTarget');
    const portalTarget = {
        rootRef: { current: {
            measureInWindow: (cb: (...args: number[]) => void) => cb(0, 0, 1000, 800),
            measure: (cb: (...args: number[]) => void) => cb(0, 0, 1000, 800, 0, 0),
        } },
        layout: { width: 1000, height: 800 },
    };
    const screen = await renderScreen(
        <PopoverPortalTargetContextProvider value={portalTarget}>
            <OverlayPortalProvider>
                <DropdownMenu
                    open
                    onOpenChange={() => {}}
                    items={[{ id: 'a', title: 'A' }]}
                    onSelect={() => {}}
                    popoverAnchor={{ kind: 'rect', rect: { left: 100, top: 100, height: 18 } }}
                    maxHeightCap={maxHeightCap}
                />
                <OverlayPortalHost />
            </OverlayPortalProvider>
        </PopoverPortalTargetContextProvider>,
    );
    await act(async () => {
        await flushHookEffects({ cycles: 1, turns: 6 });
    });
    const overlay = screen.findByType('FloatingOverlay' as any) as any;
    return overlay.props.maxHeight;
}

describe('DropdownMenu (window height)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('lets an uncapped menu use the room below its trigger instead of stopping at 320px', async () => {
        // 800px window, anchor bottom at 118px, 8px edge padding: 674px of room below.
        expect(await renderMenuMaxHeight(undefined)).toBe(674);
    });

    it('keeps an explicit caller height cap', async () => {
        expect(await renderMenuMaxHeight(240)).toBe(240);
    });
});
