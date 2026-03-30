import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(values: { web?: T; ios?: T; default?: T }) => values.web ?? values.ios ?? values.default,
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

describe('PopoverPortalTargetProvider (web)', () => {
    it('creates a screen-local web portal host for popovers', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');

        const screen = await renderScreen(<PopoverPortalTargetProvider>
                    <ViewMarker />
                </PopoverPortalTargetProvider>);

        // In unit tests we run without a DOM, so we assert the provider still renders its marker
        // and doesn't depend on `document` at render time.
        const divs = screen.findAllByType('div');
        expect(divs.some((node) => node.props['data-happy-popover-portal-anchor'] === '')).toBe(true);
    });
});

function ViewMarker() {
    return React.createElement('ViewMarker');
}
