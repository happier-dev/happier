/**
 * The press-commit contract, driven through the REAL `SelectionList`.
 *
 * What it pins: the item → row/section mapping, both empty-state branches, and that a
 * tap performs the action of the row that was TAPPED, not of the highlighted one. The
 * real list renders the real rows, so the whole activation path (row press →
 * `activateSelectionListRow` → id→index resolution → `onSelect`) runs. Mutating
 * `CommandMenu`'s `onSelect(items[index], index)` to commit `selectedIndex` turns
 * the commit cases RED.
 *
 * `Platform.OS === 'ios'` so the row/section rendering path is covered on native
 * too.
 *
 * What it does NOT pin, deliberately: `CommandMenuSurface` is mocked away below,
 * so the surface's own `Platform.OS` branch never runs here. Its web arm — the
 * pointer-down focus preservation without which a web click is swallowed entirely
 * — is covered by `CommandMenuSurface.webFocus.test.tsx`; the native arm (an empty
 * spread, because native has no focus-on-press default action) has no unit gate and
 * is covered only by device QA.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { CommandMenu } from '../CommandMenu';
import type { CommandMenuItem, CommandMenuProps } from '../commandMenuTypes';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

// Popover positioning/portalling is covered by the Popover suite; keep this test
// on CommandMenu's own row rendering and activation path.
vi.mock('../CommandMenuSurface', () => ({
    CommandMenuSurface: React.memo((props: { open: boolean; children: React.ReactNode; testID?: string }) => {
        if (!props.open) return null;
        return React.createElement(View, { testID: props.testID }, props.children);
    }),
}));

const ITEMS: readonly CommandMenuItem[] = [
    { id: 'heading1', label: 'Heading 1', description: 'Large heading', group: 'Format' },
    { id: 'heading2', label: 'Heading 2', description: 'Medium heading', group: 'Format' },
    { id: 'bullet', label: 'Bullet list', group: 'Lists' },
    { id: 'code', label: 'Code block' },
];

function defaultProps(overrides: Partial<CommandMenuProps> = {}): CommandMenuProps {
    return {
        open: true,
        anchor: { kind: 'view', ref: React.createRef() },
        query: '',
        items: ITEMS,
        selectedIndex: 0,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        testID: 'cmd-menu',
        ...overrides,
    };
}

function textUnder(node: ReactTestInstance | null | undefined, text: string): boolean {
    return (node?.findAll((child) => child.children.includes(text)).length ?? 0) > 0;
}

describe('CommandMenu (real list)', () => {
    it('maps each item to its row (label and description) under its group title', async () => {
        // An empty label is supplied so the empty branch could render: rows must win while items exist.
        const screen = await renderScreen(<CommandMenu {...defaultProps({ emptyStateLabel: 'No commands found' })} />);
        const list = screen.findByTestId('cmd-menu:list');
        for (const title of ['Format', 'Lists']) expect(textUnder(list, title)).toBe(true);
        const heading1 = screen.findByTestId('cmd-menu:row:heading1');
        expect(textUnder(heading1, 'Heading 1')).toBe(true);
        expect(textUnder(heading1, 'Large heading')).toBe(true);
        expect(textUnder(screen.findByTestId('cmd-menu:row:heading2'), 'Medium heading')).toBe(true);
        expect(textUnder(screen.findByTestId('cmd-menu:row:bullet'), 'Bullet list')).toBe(true);
        expect(textUnder(screen.findByTestId('cmd-menu:row:code'), 'Code block')).toBe(true);
        expect(screen.findAllByTestId('cmd-menu:empty')).toHaveLength(0);
    });

    it('shows the caller empty label when there are no items', async () => {
        const screen = await renderScreen(
            <CommandMenu {...defaultProps({ items: [], emptyStateLabel: 'No commands found' })} />,
        );
        expect(textUnder(screen.findByTestId('cmd-menu:empty'), 'No commands found')).toBe(true);
    });

    it('hands the command menu default empty wording to the list instead of the list fallback', async () => {
        const screen = await renderScreen(<CommandMenu {...defaultProps({ items: [] })} />);
        const text = screen.getTextContent();
        expect(text).toContain('commandMenu.empty');
        expect(text).not.toContain('selectionList.emptyMatch');
    });
});

describe('CommandMenu (native tap commit)', () => {
    it('renders an empty group invitation with the list while keeping keyboard selection on an option', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(<CommandMenu {...defaultProps({ onSelect })}
            leadingEmptyGroup={{ title: 'Favorites', hint: 'Star a prompt to keep it here' }} />);
        const list = screen.findByTestId('cmd-menu:list');
        expect(list?.findAll((node) => node.children.includes('Star a prompt to keep it here')).length).toBeGreaterThan(0);
        screen.pressByTestId('cmd-menu:list:command-menu-root:option:heading1');
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'heading1' }), 0);
    });

    it.each([false, true])('highlights the hovered row without activating it (custom=%s)', async (custom) => {
        const onSelect = vi.fn();
        function Menu() {
            const [highlighted, setHighlighted] = React.useState('heading1');
            const items: readonly CommandMenuItem[] = ITEMS.map((item) => ({
                ...item,
                onHighlight: () => setHighlighted(item.id),
                ...(custom ? { renderRow: () => <Text>{item.label}</Text> } : {}),
            }));
            return <CommandMenu {...defaultProps({ items, onSelect })}
                preview={{ content: <Text testID="highlighted-preview">{highlighted}</Text>, resizeKey: 'test',
                    minListWidthPx: 200, minPreviewWidthPx: 200, preferredListRatio: 0.4 }} />;
        }
        const screen = await renderScreen(<Menu />);
        await act(async () => {
            screen.findByTestId('cmd-menu:list:command-menu-root:option:bullet')?.props.onHoverIn?.();
        });
        expect(screen.findByTestId('highlighted-preview')?.props.children).toBe('bullet');
        expect(onSelect).not.toHaveBeenCalled();
        screen.pressByTestId('cmd-menu:list:command-menu-root:option:code');
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'code' }), 3);
    });

    it('commits the tapped row rather than the highlighted one', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <CommandMenu {...defaultProps({ onSelect, selectedIndex: 0 })} />,
        );

        screen.pressByTestId('cmd-menu:list:command-menu-root:option:bullet');

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'bullet', label: 'Bullet list' }),
            2,
        );
    });
});
