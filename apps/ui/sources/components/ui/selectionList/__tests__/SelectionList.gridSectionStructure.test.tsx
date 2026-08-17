/**
 * A `grid` may own only `row`, `rowgroup` or `caption`.
 *
 * The section header is the one piece of the popup that is neither an option
 * nor a layout box: it renders TEXT. A role-less container is flattened out of
 * the accessibility tree, so its children get re-parented onto the grid — which
 * is fine for the empty layout wrappers, and is exactly why a TEXT-BEARING
 * role-less container is not: the header's own content becomes a direct child
 * of the grid that is not a row.
 *
 * The header therefore becomes a grid row of its own, holding a single
 * `columnheader` that spans the declared columns — the same shape a data table
 * uses for `<tbody><tr><th colspan>`. `aria-rowcount` counts it and every
 * option row is numbered after it, because `aria-rowindex` is a position in the
 * whole grid, header rows included.
 *
 * (The rejected alternative was a `rowgroup` per section with the header as its
 * `caption`: `caption` is an owned element of `grid`/`table`, never of
 * `rowgroup`, so that shape is invalid too. A `rowgroup` also cannot exist in
 * the flat virtualized renderer, where each section header is an independent
 * list item with no section wrapper to promote — while a header ROW is a legal
 * direct child of the grid in both renderers, which is what keeps the two
 * paths emitting one structure.)
 */

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type { SelectionListOption, SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Only the per-section virtualized case below mounts a list; the mapped cases
// never reach it, so the capturing mock is inert for them.
const { module: capturedLegendList } = createCapturingLegendListMock({ renderItems: true });

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

import { Pressable } from 'react-native';

/** Wide enough for two 250px columns plus the shared 12px gutter. */
const TWO_COLUMN_WIDTH_PX = 546;

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Node = ReturnType<Screen['tree']['root']['findAll']>[number];

function sectionOptions(
    prefix: string,
    count: number,
    expandedContent?: React.ReactNode,
): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        label: `${prefix.toUpperCase()} ${index}`,
        ...(index === 0 && expandedContent !== undefined ? { expandedContent } : {}),
    }));
}

function twoSectionStep(params: Readonly<{
    optionsPerSection?: number;
    expandedContent?: React.ReactNode;
}> = {}): SelectionListStep {
    const count = params.optionsPerSection ?? 2;
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [
            {
                kind: 'static',
                id: 'favorites',
                title: 'FAVORITES',
                options: sectionOptions('fav', count, params.expandedContent),
            },
            { kind: 'static', id: 'models', title: 'MODELS', options: sectionOptions('mod', count) },
        ],
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: twoSectionStep(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

async function measureContainer(screen: Screen, widthPx: number): Promise<void> {
    const onLayout = screen.findByTestId('sl')?.props.onLayout as
        | ((event: unknown) => void)
        | undefined;
    if (typeof onLayout !== 'function') {
        throw new Error('expected the columned SelectionList to measure itself');
    }
    await act(async () => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: widthPx, height: 600 } } });
    });
}

function isRoleHost(node: Node): boolean {
    return typeof node.type === 'string' && typeof node.props?.role === 'string';
}

/**
 * A host element that renders text of its own. This is the class of node that
 * a role-less container cannot hide: an empty wrapper is flattened out of the
 * accessibility tree, but the text it wraps is still exposed, and it is exposed
 * as a child of whatever role-carrying ancestor survives.
 */
function isTextHost(node: Node): boolean {
    return typeof node.type === 'string'
        && node.children.some((child) => typeof child === 'string' && child.length > 0);
}

function body(screen: Screen): Node {
    const found = screen.findByTestId('sl:body');
    if (!found) throw new Error('expected a rendered body');
    return found as Node;
}

/**
 * What the grid actually OWNS: every role-carrying host element — and every
 * host element that renders bare text — whose nearest role-carrying ancestor is
 * the grid container itself. Role-less wrappers (the fade host, the scroll
 * container, the section wrapper) are transparent in the accessibility tree, so
 * what shows up here is what a screen reader reads as a child of the grid.
 *
 * Text with no role-carrying ancestor is reported as `'(bare text)'`, because
 * that is precisely the shape ARIA forbids and precisely what a role-less
 * section header produced.
 */
function ownedRoles(screen: Screen): ReadonlyArray<string> {
    const container = body(screen);
    const roles: string[] = [];
    for (const node of container.findAll((n) => isRoleHost(n) || isTextHost(n))) {
        if (node === container) continue;
        let ancestor = node.parent as Node | null;
        let nearest: Node | null = null;
        while (ancestor && ancestor !== container) {
            if (isRoleHost(ancestor)) {
                nearest = ancestor;
                break;
            }
            ancestor = ancestor.parent as Node | null;
        }
        if (nearest !== null) continue;
        roles.push(isRoleHost(node) ? node.props.role as string : '(bare text)');
    }
    return roles;
}

function rows(screen: Screen): ReadonlyArray<Node> {
    return body(screen).findAll((node) => isRoleHost(node) && node.props.role === 'row');
}

function ancestorRoles(node: Node, stopAtTestId: string): ReadonlyArray<string> {
    const found: string[] = [];
    let current = node.parent as Node | null;
    while (current) {
        if (current.props?.testID === stopAtTestId) break;
        if (isRoleHost(current)) found.push(current.props.role as string);
        current = current.parent as Node | null;
    }
    return found;
}

function expectHeaderIsAnExposedGridRow(
    screen: Screen,
    sectionId: string,
    declaredColumnCount: number,
): void {
    const header = screen.findByTestId(`sl:section:${sectionId}:header`) as Node | null;
    expect(header).not.toBeNull();
    // The header's own box becomes the single cell of its row, so the visible
    // title text stays exactly where it was AND is announced as a header —
    // never silenced into a presentational box.
    expect(header?.props.role).toBe('columnheader');
    expect(header?.props['aria-colindex']).toBe(1);
    expect(header?.props['aria-colspan']).toBe(
        declaredColumnCount > 1 ? declaredColumnCount : undefined,
    );
    expect(ancestorRoles(header!, 'sl:body')).toEqual(['row']);
}

/**
 * `aria-rowindex` is a position in the WHOLE grid. Reading the rows in tree
 * order and demanding `1..n` catches both halves of the numbering contract at
 * once: a header that forgot to take an index, and option rows that forgot to
 * make room for one.
 */
function expectContiguousRowNumbering(screen: Screen): void {
    const found = rows(screen);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((row) => row.props['aria-rowindex'])).toEqual(
        found.map((_, index) => index + 1),
    );
    expect(body(screen).props['aria-rowcount']).toBe(found.length);
}

describe('SelectionList — a columned grid owns nothing but rows', () => {
    it('exposes each section header as a full-width header row of the grid', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ columns: { max: 2, minColumnWidthPx: 250 } })} />,
        );
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);

        expect(body(screen).props.role).toBe('grid');
        expect(body(screen).props['aria-colcount']).toBe(2);
        expect(new Set(ownedRoles(screen))).toEqual(new Set(['row']));

        expectHeaderIsAnExposedGridRow(screen, 'favorites', 2);
        expectHeaderIsAnExposedGridRow(screen, 'models', 2);
        // Two sections of two options at two columns: header, row, header, row.
        expect(rows(screen)).toHaveLength(4);
        expectContiguousRowNumbering(screen);
    });

    it('keeps the same structure in a single-column grid built from inline row controls', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: twoSectionStep({
                        expandedContent: <Pressable testID="inline-controls" onPress={() => {}} />,
                    }),
                    selectedOptionId: 'fav-0',
                    optionsHostInlineControls: true,
                })}
            />,
        );

        expect(body(screen).props.role).toBe('grid');
        expect(body(screen).props['aria-colcount']).toBe(1);
        expect(new Set(ownedRoles(screen))).toEqual(new Set(['row']));

        // One column, so the header spans exactly its one column and says so by
        // omitting `aria-colspan` — the same rule the option cells follow.
        expectHeaderIsAnExposedGridRow(screen, 'favorites', 1);
        expectHeaderIsAnExposedGridRow(screen, 'models', 1);
        // Two headers plus four one-option rows.
        expect(rows(screen)).toHaveLength(6);
        expectContiguousRowNumbering(screen);
    });

    it('numbers a per-section virtualized list from the same sequence', async () => {
        // A lone virtualization-eligible section keeps its OWN scroll owner
        // (`SelectionListVirtualizedSection`) instead of collapsing into the
        // flat list, and that renderer numbers its rows from a section offset
        // rather than from the popup-wide item list. It is the one path where a
        // header row could be counted by the container and skipped by the rows.
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: {
                        id: 'root',
                        inputPlaceholder: 'Search',
                        sections: [{
                            kind: 'static',
                            id: 'models',
                            title: 'MODELS',
                            virtualization: 'force',
                            options: sectionOptions('mod', 3),
                        }],
                    },
                    optionsHostInlineControls: true,
                })}
            />,
        );

        expect(screen.findByTestId('sl:section:models:virtualized')).not.toBeNull();
        expect(body(screen).props.role).toBe('grid');
        expectHeaderIsAnExposedGridRow(screen, 'models', 1);
        expect(rows(screen)).toHaveLength(4);
        expectContiguousRowNumbering(screen);
    });
});

describe('SelectionList — a listbox owns named section groups and options', () => {
    it('keeps each text-bearing section inside a named group rather than exposing it directly to the listbox', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);

        expect(body(screen).props.role).toBe('listbox');
        expect(ownedRoles(screen)).toEqual(['group', 'group']);
        for (const sectionId of ['favorites', 'models']) {
            const section = screen.findByTestId(`sl:section:${sectionId}`);
            expect(section?.props.role).toBe('group');
            expect(section?.props['aria-label']).toBe(sectionId.toUpperCase());
            expect(section?.props.accessibilityLabel).toBe(sectionId.toUpperCase());
        }
        const header = screen.findByTestId('sl:section:favorites:header');
        expect(header?.props.role).toBeUndefined();
        expect(header?.props['aria-colindex']).toBeUndefined();
        expect(rows(screen)).toHaveLength(0);
    });
});
