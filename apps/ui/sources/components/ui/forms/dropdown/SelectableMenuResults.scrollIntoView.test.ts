import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollIntoViewSpy = vi.fn();

installDropdownCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: React.forwardRef((props: any, ref: any) => {
                React.useImperativeHandle(ref, () => ({ scrollIntoView: scrollIntoViewSpy }));
                return React.createElement('View', props, props.children);
            }),
            Text: (props: any) => React.createElement('Text', props, props.children),
        });
    },
});

const { SelectableMenuResults } = await import('./SelectableMenuResults');

describe('SelectableMenuResults (web)', () => {
    beforeEach(() => {
        scrollIntoViewSpy.mockClear();
    });

    it('does not call DOM scrollIntoView (prevents scrolling the underlying page when opening dropdowns)', async () => {
        const categories = [
            {
                id: 'general',
                title: 'General',
                items: [
                    { id: 'a', title: 'A', disabled: false, left: null, right: null },
                    { id: 'b', title: 'B', disabled: false, left: null, right: null },
                ],
            },
        ] as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(SelectableMenuResults, {
                    categories,
                    selectedIndex: 0,
                    onSelectionChange: () => {},
                    onPressItem: () => {},
                    rowVariant: 'slim',
                    emptyLabel: 'empty',
                    rowKind: 'item',
                }))).tree;

        act(() => {
            tree?.update(
                React.createElement(SelectableMenuResults, {
                    categories,
                    selectedIndex: 1,
                    onSelectionChange: () => {},
                    onPressItem: () => {},
                    rowVariant: 'slim',
                    emptyLabel: 'empty',
                    rowKind: 'item',
                }),
            );
        });

        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });

    it('does not call DOM scrollIntoView for item-row rendering mode either', async () => {
        const categories = [
            {
                id: 'general',
                title: 'General',
                items: [{ id: 'a', title: 'A', disabled: false, left: null, right: null }],
            },
        ] as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(SelectableMenuResults, {
                    categories,
                    selectedIndex: 0,
                    onSelectionChange: () => {},
                    onPressItem: () => {},
                    rowVariant: 'slim',
                    emptyLabel: 'empty',
                    rowKind: 'item',
                }))).tree;

        act(() => {
            tree?.update(
                React.createElement(SelectableMenuResults, {
                    categories,
                    selectedIndex: 0,
                    onSelectionChange: () => {},
                    onPressItem: () => {},
                    rowVariant: 'slim',
                    emptyLabel: 'empty',
                    rowKind: 'item',
                }),
            );
        });

        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });
});
