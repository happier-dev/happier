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
    it('renders a screen-local web portal host inside the screen subtree', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<PopoverPortalTargetProvider>
                    <ViewMarker />
                </PopoverPortalTargetProvider>)).tree;

        const hosts = tree.root.findAllByType('div');
        expect(hosts.some((node) => node.props['data-happy-popover-portal-host'] === '')).toBe(true);
    });
});

function ViewMarker() {
    return React.createElement('ViewMarker');
}
