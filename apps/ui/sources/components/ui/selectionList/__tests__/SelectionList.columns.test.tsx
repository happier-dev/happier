/**
 * Lane G3 — the `columns` prop end to end through the orchestrator.
 *
 * The interesting claim is that the column count comes from the LIST's own
 * measured width, not the window: a SelectionList lives in a `flex: 1` pane
 * beside a fixed rail inside a capped popover, so window width says nothing
 * about the room a row gets. These tests drive the container's `onLayout`
 * directly, which is the only signal the resolver reads.
 */

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const ROOT_STEP: SelectionListStep = {
    id: 'root',
    title: 'Models',
    inputPlaceholder: 'Search models',
    sections: [
        {
            kind: 'static',
            id: 'models',
            title: 'MODELS',
            options: [
                { id: 'm-0', label: 'Model 0' },
                { id: 'm-1', label: 'Model 1' },
                { id: 'm-2', label: 'Model 2' },
                { id: 'm-3', label: 'Model 3' },
            ],
        },
    ],
};

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: ROOT_STEP,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

type TestNode = { type: unknown; props: Record<string, unknown> };

async function fireContainerLayout(root: TestNode, widthPx: number): Promise<void> {
    const onLayout = root.props.onLayout as ((event: unknown) => void) | undefined;
    if (typeof onLayout !== 'function') {
        throw new Error('expected the SelectionList container to measure itself');
    }
    await act(async () => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: widthPx, height: 400 } } });
    });
}

/**
 * The visual row wrappers the columns variant introduces — the `flex-start`
 * flex rows. Matched by LAYOUT rather than by role: a columned pane is a grid,
 * so these carry `role="row"`, and matching on the role would make this helper
 * silently agree with whatever the a11y resolver decided. Restricted to HOST
 * elements because the composite that renders them receives the same props and
 * would otherwise double every count.
 */
function flattenRowStyle(style: unknown): Record<string, unknown> {
    return Array.isArray(style)
        ? Object.assign({}, ...style.filter(Boolean))
        : (style as Record<string, unknown> | undefined) ?? {};
}

function findColumnRows(
    screen: { root: { findAll: (p: (n: TestNode) => boolean) => unknown[] } },
): TestNode[] {
    return screen.root.findAll((node: TestNode) => {
        if (typeof node.type !== 'string') return false;
        const flat = flattenRowStyle(node.props.style);
        return flat.flexDirection === 'row' && flat.alignItems === 'flex-start';
    }) as TestNode[];
}

function countColumnRows(screen: { root: { findAll: (p: (n: TestNode) => boolean) => unknown[] } }): number {
    return findColumnRows(screen).length;
}

describe('SelectionList — columns variant', () => {
    it('does not measure its own width at all when no columns are requested', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        const root = screen.findByTestId('sl') as unknown as TestNode;
        expect(root.props.onLayout).toBeUndefined();
        expect(countColumnRows(screen as never)).toBe(0);
    });

    it('attaches a layout listener as soon as columns are requested', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ columns: { max: 2, minColumnWidthPx: 250 } })} />,
        );
        const root = screen.findByTestId('sl') as unknown as TestNode;
        expect(typeof root.props.onLayout).toBe('function');
    });

    it('renders one column until a width has actually been measured', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ columns: { max: 2, minColumnWidthPx: 250 } })} />,
        );
        expect(countColumnRows(screen as never)).toBe(0);
        expect(screen.findByTestId('sl:root:option:m-0')).not.toBeNull();
        // The LAYOUT waits for the measurement; the ARIA pattern does not. A
        // caller that declared `columns` gets the grid from the first frame,
        // because promoting the container's role one frame later re-announces
        // the whole widget to a screen reader.
        expect((screen.findByTestId('sl:body') as unknown as TestNode).props.role).toBe('grid');
    });

    it('resolves two columns once the measured width fits two', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ columns: { max: 2, minColumnWidthPx: 250 } })} />,
        );
        // 2 * 250 + 12 gutter = 512.
        await fireContainerLayout(screen.findByTestId('sl') as unknown as TestNode, 546);
        expect(countColumnRows(screen as never)).toBe(2);
        for (const id of ['m-0', 'm-1', 'm-2', 'm-3']) {
            expect(screen.findByTestId(`sl:root:option:${id}`)).not.toBeNull();
        }
        // Two dimensions of movement is a grid, whether or not any row carries
        // inline controls — the visual rows ARE the grid's rows.
        expect((screen.findByTestId('sl:body') as unknown as TestNode).props.role).toBe('grid');
        expect(findColumnRows(screen as never).map((row) => row.props.role))
            .toEqual(['row', 'row']);
    });

    it('stays at one column when the measured pane is too narrow for two', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ columns: { max: 2, minColumnWidthPx: 250 } })} />,
        );
        await fireContainerLayout(screen.findByTestId('sl') as unknown as TestNode, 420);
        expect(countColumnRows(screen as never)).toBe(0);
    });

    it('collapses back to one column when the pane is measured narrower', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ columns: { max: 2, minColumnWidthPx: 250 } })} />,
        );
        const root = screen.findByTestId('sl') as unknown as TestNode;
        await fireContainerLayout(root, 546);
        expect(countColumnRows(screen as never)).toBe(2);
        await fireContainerLayout(root, 380);
        expect(countColumnRows(screen as never)).toBe(0);
    });

    it('paints the caller gutter it sized the columns against', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({ columns: { max: 2, minColumnWidthPx: 250, columnGapPx: 32 } })}
            />,
        );
        // 2 * 250 + 32 = 532: the caller's own gutter is what decides whether
        // two columns fit, so painting the shared default (12) instead would
        // hand every column 10px more than the caller asked the resolver for.
        await fireContainerLayout(screen.findByTestId('sl') as unknown as TestNode, 546);
        const rows = findColumnRows(screen as never);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(flattenRowStyle(row.props.style).columnGap).toBe(32);
        }
    });

    it('gives a section too short to fill a row the whole pane', async () => {
        const { SelectionList } = await import('../SelectionList');
        // The shipped model-picker shape: a one-option recovery section above
        // the real list. Chunked at the pane's column count its single card
        // rendered at half width with a blank half beside it.
        const step: SelectionListStep = {
            ...ROOT_STEP,
            sections: [
                {
                    kind: 'static',
                    id: 'current-selection-recovery',
                    title: '',
                    options: [{ id: 'current', label: 'Current selection' }],
                },
                {
                    kind: 'static',
                    id: 'models',
                    title: 'MODELS',
                    options: [
                        { id: 'm-0', label: 'Model 0' },
                        { id: 'm-1', label: 'Model 1' },
                    ],
                },
            ],
        };
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({ rootStep: step, columns: { max: 2, minColumnWidthPx: 250 } })}
            />,
        );
        await fireContainerLayout(screen.findByTestId('sl') as unknown as TestNode, 546);
        const rows = findColumnRows(screen as never);
        expect(rows).toHaveLength(2);
        // The short section's row has ONE child and no trailing spacer, so its
        // card stretches across the pane instead of leaving the gutter's worth
        // of empty surface beside it.
        const childrenOf = (row: TestNode): unknown[] =>
            (row as unknown as { children: unknown[] }).children;
        expect(childrenOf(rows[0])).toHaveLength(1);
        // The section that CAN fill a row is untouched.
        expect(childrenOf(rows[1])).toHaveLength(2);
    });

    it('keeps disabled rows on screen in the grid', async () => {
        const { SelectionList } = await import('../SelectionList');
        const step: SelectionListStep = {
            ...ROOT_STEP,
            sections: [{
                kind: 'static',
                id: 'models',
                title: 'MODELS',
                options: [
                    { id: 'm-0', label: 'Model 0' },
                    { id: 'locked', label: 'Locked', disabled: true },
                    { id: 'm-2', label: 'Model 2' },
                ],
            }],
        };
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({ rootStep: step, columns: { max: 2, minColumnWidthPx: 250 } })}
            />,
        );
        await fireContainerLayout(screen.findByTestId('sl') as unknown as TestNode, 546);
        // `flatVisibleOptionIds` excludes 'locked'; the LAYOUT must not.
        expect(screen.findByTestId('sl:root:option:locked')).not.toBeNull();
        expect(countColumnRows(screen as never)).toBe(2);
    });
});
