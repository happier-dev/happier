/**
 * The press-commit contract, driven through the REAL `SelectionList`.
 *
 * What it pins: a tap performs the action of the row that was TAPPED, not of the
 * highlighted one. `CommandMenu.test.tsx` cannot pin this — it stubs
 * `@/components/ui/selectionList` down to plain `View`s, so no row in that suite is
 * pressable at all and its assertions stop at the item mapper. Here the real list
 * renders the real rows, so the whole activation path (row press →
 * `activateSelectionListRow` → id→index resolution → `onSelect`) runs. Mutating
 * `CommandMenu`'s `onSelect(items[index], index)` to commit `selectedIndex` turns
 * both cases RED.
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
import { act } from 'react-test-renderer';
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

describe('CommandMenu (native tap commit)', () => {
    it('renders an empty group invitation with the list while keeping keyboard selection on an option', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(<CommandMenu {...defaultProps({ onSelect })}
            leadingEmptyGroup={{ title: 'Favorites', hint: 'Star a prompt to keep it here' }} />);
        const list = screen.findByTestId('cmd-menu:list');
        expect(list?.findAll((node) => node.props.children === 'Star a prompt to keep it here').length).toBeGreaterThan(0);
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
                preview={<Text testID="highlighted-preview">{highlighted}</Text>} />;
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

    it('commits a row that carries no group section header', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <CommandMenu {...defaultProps({ onSelect, selectedIndex: 1 })} />,
        );

        screen.pressByTestId('cmd-menu:list:command-menu-root:option:code');

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'code', label: 'Code block' }),
            3,
        );
    });
});
