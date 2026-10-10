import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { flattenTestStyle, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => ({ width: 1000, height: 800 }),
    }),
});
let restoreGlobals: (() => void) | undefined;
beforeEach(() => { restoreGlobals = withPopoverWebGlobals(); });
afterEach(() => { standardCleanup(); restoreGlobals?.(); });

describe('command menu requested side', () => {
    it('keeps a top-only composer picker above its anchor when the opposite side has more room', async () => {
        const { CommandMenu } = await import('../CommandMenu');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('@/components/ui/popover/OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('@/components/ui/popover/PopoverPortalTarget');
        const root = {
            measureInWindow: (callback: (left: number, top: number, width: number, height: number) => void) => callback(0, 0, 1000, 800),
            measure: (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 1000, 800, 0, 0),
        };
        const screen = await renderScreen(<PopoverPortalTargetContextProvider value={{
            rootRef: { current: root }, layout: { width: 1000, height: 800 },
        }}><OverlayPortalProvider>
            <CommandMenu open anchor={{ kind: 'rect', rect: { left: 100, top: 80, width: 500, height: 100 }, coordinateSpace: 'window' }}
                boundaryRef={null} placement="top" flip={false} fillHeight maxHeight={380} query="" items={[]} selectedIndex={-1}
                onMoveUp={() => {}} onMoveDown={() => {}} onSelect={() => {}} onRequestClose={() => {}} testID="top-picker" />
            <OverlayPortalHost />
        </OverlayPortalProvider></PopoverPortalTargetContextProvider>);
        await act(async () => { await flushHookEffects({ cycles: 1, turns: 6, frames: 1 }); });
        let parent = screen.findByTestId('top-picker:surface')?.parent;
        while (parent && flattenTestStyle(parent.props.style).position !== 'absolute') parent = parent.parent;
        expect(parent).not.toBeNull();
        const style = flattenTestStyle(parent?.props.style);
        expect(style.top).toBeUndefined();
        expect(style.bottom).toBeGreaterThanOrEqual(720);
    });
});
