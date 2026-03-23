import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await createReactNativeWebMock({
    Platform: {
        OS: 'web',
        select: <T,>(values: { web?: T; ios?: T; default?: T }) => values.web ?? values.ios ?? values.default,
    },
    View: (props: any) => React.createElement('View', props, props.children),
}));

describe('PopoverPortalTargetProvider (web)', () => {
    it('creates a screen-local web portal host for popovers', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<PopoverPortalTargetProvider>
                    <ViewMarker />
                </PopoverPortalTargetProvider>)).tree;

        // In unit tests we run without a DOM, so we assert the provider still renders its marker
        // and doesn't depend on `document` at render time.
        const divs = tree.root.findAllByType('div');
        expect(divs.some((node) => node.props['data-happy-popover-portal-anchor'] === '')).toBe(true);
    });
});

function ViewMarker() {
    return React.createElement('ViewMarker');
}
