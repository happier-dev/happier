import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';

const modalWheelState = vi.hoisted(() => ({
    scrollTo: vi.fn(),
}));

function createRadixHostComponent(tagName: string) {
    return (props: Record<string, unknown>) => {
        const { children, ...rest } = props as Record<string, unknown> & { children?: React.ReactNode };
        return React.createElement(tagName, rest, children);
    };
}

vi.mock('@/utils/web/radixCjs', () => {
    return {
        requireRadixDialog: () => ({
            Root: createRadixHostComponent('DialogRoot'),
            Portal: createRadixHostComponent('DialogPortal'),
            Overlay: createRadixHostComponent('DialogOverlay'),
            Content: createRadixHostComponent('DialogContent'),
            Title: createRadixHostComponent('DialogTitle'),
        }),
        requireRadixDismissableLayer: () => ({
            Branch: createRadixHostComponent('DismissableLayerBranch'),
            DismissableLayerBranch: createRadixHostComponent('DismissableLayerBranch'),
        }),
    };
});

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const rn = await createReactNativeWebMock();
        const ScrollView = React.forwardRef((props: any, ref: any) => {
            React.useImperativeHandle(ref, () => ({ scrollTo: modalWheelState.scrollTo }));
            return React.createElement('ScrollView', props, props.children);
        });
        ScrollView.displayName = 'ScrollView';
        return { ...rn, ScrollView };
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

describe('ItemList (web modal wheel fix)', () => {
    it('translates wheel deltas into scrollTo when rendered inside BaseModal', async () => {
        const { BaseModal } = await import('@/modal/components/BaseModal');
        const { ItemList } = await import('./ItemList');

        modalWheelState.scrollTo.mockClear();
        const onScroll = vi.fn();

        const screen = await renderScreen(
            <BaseModal visible={true} onClose={() => {}}>
                <ItemList onScroll={onScroll} scrollEventThrottle={16}>
                    <React.Fragment />
                </ItemList>
            </BaseModal>,
        );

        const scrollView = screen.tree.findByType('ScrollView');
        expect(scrollView.props.onWheel).toBeTypeOf('function');

        scrollView.props.onScroll?.({ nativeEvent: { contentOffset: { y: 40 } } });
        expect(onScroll).toHaveBeenCalledTimes(1);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        scrollView.props.onWheel({ deltaY: 80, cancelable: true, preventDefault, stopPropagation });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(modalWheelState.scrollTo).toHaveBeenCalledWith({ y: 120, animated: false });
    });

    it('does not install a wheel handler when rendered outside BaseModal', async () => {
        const { ItemList } = await import('./ItemList');

        const screen = await renderScreen(
            <ItemList>
                <React.Fragment />
            </ItemList>,
        );

        const scrollView = screen.tree.findByType('ScrollView');
        expect(scrollView.props.onWheel).toBeUndefined();
    });
});

