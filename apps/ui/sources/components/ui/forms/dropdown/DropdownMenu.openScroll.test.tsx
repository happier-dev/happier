import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DropdownMenu } from './DropdownMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

afterEach(() => standardCleanup());

// Rows 36 px tall in a 100 px viewport; the first two are disabled, so the first enabled row ("c") lies below the fold.
const ROW = 36;
const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({
    id, title: id, disabled: index < 2, testID: `row:${id}`, category: index < 3 ? 'First' : 'Second',
}));

async function openMenu(selectedId: string | null) {
    const scrollTo = vi.fn();
    const screen = await renderScreen(
        <DropdownMenu open onOpenChange={() => {}} items={ITEMS} selectedId={selectedId} onSelect={() => {}} showCategoryTitles trigger={null} />,
        { createNodeMock: node => node.props && 'keyboardShouldPersistTaps' in node.props ? { scrollTo } : null },
    );
    const scroller = screen.root.findAll(node => node.props && 'keyboardShouldPersistTaps' in node.props && typeof node.props.onLayout === 'function')[0]!;
    await act(async () => {
        scroller.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 100 } } });
        scroller.props.onContentSizeChange(280, ITEMS.length * ROW);
    });
    // Rows report their frame in their scroll content, in order.
    await act(async () => {
        ITEMS.forEach((item, index) => screen.findByTestId(`row:${item.id}:scroll-frame`)?.props.onLayout({ nativeEvent: { layout: { y: index * ROW, height: ROW } } }));
    });
    return { screen, scrollTo, scroller };
}

describe('DropdownMenu opening scroll position', () => {
    it('opens at its top: a highlighted first row below the fold is not scrolled to by itself', async () => {
        const { scrollTo } = await openMenu(null);
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('reveals the current choice when the menu opens on it', async () => {
        const { scrollTo } = await openMenu('c');
        expect(scrollTo).toHaveBeenCalled();
    });

    it('follows the highlight once the user moves it with the keys', async () => {
        const { screen, scrollTo } = await openMenu(null);
        await act(async () => { screen.findByTestId('row:c:scroll-frame')!.props.onKeyDown({ nativeEvent: { key: 'ArrowDown' }, preventDefault() {}, stopPropagation() {} }); });
        expect(scrollTo).toHaveBeenCalled();
    });

    it.each([null, 'c'])('leaves manual scroll alone when pointer hover follows keyboard navigation (opening choice %s), then resumes following the keyboard', async selectedId => {
        const { screen, scrollTo, scroller } = await openMenu(selectedId);
        const key = (id: string, value: string) => screen.findByTestId(`row:${id}:scroll-frame`)!.props.onKeyDown({
            nativeEvent: { key: value }, preventDefault() {}, stopPropagation() {},
        });
        await act(async () => { key('c', 'ArrowDown'); });
        expect(scrollTo).toHaveBeenCalled();
        await act(async () => {
            scroller.props.onScroll({ nativeEvent: {
                contentOffset: { y: 90 }, layoutMeasurement: { height: 100 }, contentSize: { height: ITEMS.length * ROW },
            } });
        });
        scrollTo.mockClear();
        // "c" is partly visible at the top after the person's scroll. Hover may highlight it,
        // but must not pull the list back to reveal the whole row.
        await act(async () => { screen.findByTestId('row:c:scroll-frame')!.props.onPointerEnter({ pointerType: 'mouse' }); });
        expect(scrollTo).not.toHaveBeenCalled();
        await act(async () => { key('c', 'ArrowUp'); });
        expect(scrollTo).toHaveBeenCalled();
    });
});
