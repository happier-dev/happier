import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

import type {
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

const scrollToSpy = vi.fn<(args: { y: number; animated?: boolean }) => void>();

vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        ScrollView: React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref) => {
            React.useImperativeHandle(ref, () => ({ scrollTo: scrollToSpy }));
            return React.createElement('ScrollView', { ...props, ref }, props.children);
        }),
    });
});

function makeOptions(count: number, prefix = 'opt'): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `Option ${i}`,
    }));
}

function defaultProps(rootStep: SelectionListStep, overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

/**
 * R9 — Blocker 1: Non-virtualized SelectionList rows can clip when the popover
 * sets `scrollEnabled={false}` and the list height exceeds maxHeight. The
 * orchestrator MUST own its own ScrollView around the non-virtualized body so
 * the user can scroll within the popover.
 *
 * The virtualized FlashList path manages its own scroll, so the wrapping
 * ScrollView must NOT swallow that path. The wrapper exposes a stable testID
 * (`sl:bodyScroll`) so other tests + the popover surface contract can rely on
 * the ownership boundary.
 */
describe('SelectionList non-virtualized body scroll wrapper (R9 blocker 1)', () => {
    beforeEach(() => {
        scrollToSpy.mockClear();
    });

    it('wraps non-virtualized rows in a ScrollView so all rows remain reachable', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'shorty',
                    title: 'SHORTY',
                    options: makeOptions(30, 'short'),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { maxHeight: 200 })} />,
        );
        // The orchestrator must mount a ScrollView around the non-virtualized
        // body so the user can scroll past maxHeight. Identified via stable
        // testID at the wrapper boundary.
        const scrollWrapper = screen.findByTestId('sl:bodyScroll');
        expect(scrollWrapper).not.toBeNull();
        // Every option in the section must still be present in the rendered
        // tree (ScrollView renders all children up-front; user scrolls).
        for (let i = 0; i < 30; i += 1) {
            const row = screen.findByTestId(`sl:root:option:short-${i}`);
            expect(row).not.toBeNull();
        }
    });

    /**
     * RUX-1 Issue 7: footer outside the scroll container. The user
     * screenshot showed the footer hints rendered AS PART OF the scrolling
     * list, only visible when scrolled to the bottom. The fix:
     *   - SelectionList layout = header (sticky) → body (flex: 1) → footer (sticky)
     *   - Footer must NOT be a descendant of the bodyScroll container.
     *   - Body must be constrained to flex: 1, minHeight: 0 so its
     *     contents scroll inside the bounded area instead of overflowing
     *     past the footer.
     */
    it('renders the footer OUTSIDE the bodyScroll container so it stays visible when the list scrolls', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'big',
                    title: 'BIG',
                    options: makeOptions(30, 'b'),
                },
            ],
            footerHints: [
                { id: 'enter', label: '↵', description: 'commit' },
                { id: 'tab', label: 'Tab', description: 'autocomplete' },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { maxHeight: 300, keyboardHintsEnabled: true })} />,
        );
        const bodyScroll = screen.findByTestId('sl:bodyScroll');
        const footer = screen.findByTestId('sl:footer');
        expect(bodyScroll).not.toBeNull();
        expect(footer).not.toBeNull();
        // Walk up the parent chain from `footer` — none of its ancestors
        // can be `bodyScroll`. Otherwise the footer scrolls with the body.
        let cur: any = footer;
        let isInsideScroll = false;
        // react-test-renderer instances expose `.parent`; walk the chain.
        while (cur && cur.parent) {
            cur = cur.parent;
            if (cur === bodyScroll) {
                isInsideScroll = true;
                break;
            }
        }
        expect(isInsideScroll).toBe(false);
    });

    it('constrains the body so its contents do not push the footer below maxHeight (flex: 1, minHeight: 0)', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'big',
                    title: 'BIG',
                    options: makeOptions(50, 'b'),
                },
            ],
            footerHints: [
                { id: 'enter', label: '↵', description: 'commit' },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { maxHeight: 300, keyboardHintsEnabled: true })} />,
        );
        // The scroll frame, not the outer content-sized popover frame, must
        // own the bounded body area so the persistent footer stays outside
        // the scrollable rows.
        const scrollHost = screen.findByTestId('sl:bodyScroll:fadeHost') as any;
        expect(scrollHost).not.toBeNull();
        const styleProp = scrollHost?.props?.style;
        const flatStyle = Array.isArray(styleProp)
            ? Object.assign({}, ...styleProp.filter(Boolean))
            : (styleProp ?? {});
        expect(flatStyle.flexGrow).toBe(1);
        expect(flatStyle.flexShrink).toBe(1);
    });

    it('does not mount the ScrollView wrapper when only a virtualized section is present (FlashList owns scroll)', async () => {
        // Force virtualization on a small section so the orchestrator picks
        // the FlashList path. The body MUST defer scrolling to FlashList and
        // skip the wrapping ScrollView (otherwise nested scrolling steals
        // gestures from FlashList).
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'big',
                    title: 'BIG',
                    options: makeOptions(60, 'b'),
                    virtualization: 'force',
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} />);
        expect(screen.findByTestId('sl:bodyScroll')).toBeNull();
    });

    it('scrolls the selected non-virtualized row into the body viewport', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'shorty',
                    title: 'SHORTY',
                    options: makeOptions(30, 'short'),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, {
                maxHeight: 200,
                selectedOptionId: 'short-20',
                activeScrollOptionId: 'short-20',
            })} />,
        );
        const bodyScroll = screen.findByTestId('sl:bodyScroll');
        const selectedRow = screen.findByTestId('sl:root:option-wrapper:short-20');

        expect(bodyScroll).not.toBeNull();
        expect(typeof bodyScroll?.props?.onLayout).toBe('function');
        expect(selectedRow).not.toBeNull();
        expect(typeof selectedRow?.props?.onLayout).toBe('function');

        await act(async () => {
            bodyScroll?.props?.onLayout?.({ nativeEvent: { layout: { height: 120 } } });
            bodyScroll?.props?.onContentSizeChange?.(320, 1200);
            selectedRow?.props?.onLayout?.({ nativeEvent: { layout: { y: 480, height: 40 } } });
        });
        await act(async () => {});

        expect(scrollToSpy).toHaveBeenCalledWith({ y: 432, animated: false });
    });

    it('uses section offsets when scrolling selected rows from later sections', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'quick-actions',
                    title: 'ACTIONS',
                    options: makeOptions(2, 'action'),
                },
                {
                    kind: 'static',
                    id: 'existing-worktrees',
                    title: 'EXISTING',
                    options: makeOptions(20, 'worktree'),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, {
                maxHeight: 200,
                selectedOptionId: 'worktree-12',
                activeScrollOptionId: 'worktree-12',
            })} />,
        );
        const bodyScroll = screen.findByTestId('sl:bodyScroll');
        const existingSection = screen.findByTestId('sl:section:existing-worktrees');
        const selectedRow = screen.findByTestId('sl:root:option-wrapper:worktree-12');

        expect(bodyScroll).not.toBeNull();
        expect(existingSection).not.toBeNull();
        expect(selectedRow).not.toBeNull();

        await act(async () => {
            bodyScroll?.props?.onLayout?.({ nativeEvent: { layout: { height: 120 } } });
            bodyScroll?.props?.onContentSizeChange?.(320, 1200);
            existingSection?.props?.onLayout?.({ nativeEvent: { layout: { y: 260, height: 840 } } });
            selectedRow?.props?.onLayout?.({ nativeEvent: { layout: { y: 300, height: 40 } } });
        });
        await act(async () => {});

        expect(scrollToSpy).toHaveBeenCalledWith({ y: 512, animated: false });
    });
});
