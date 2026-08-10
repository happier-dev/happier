/**
 * Native twin of the press-commit contract in `CommandMenu.test.tsx`.
 *
 * What it pins: a tap performs the action of the row that was TAPPED, not of the
 * highlighted one — a platform-independent guarantee, exercised here with
 * `Platform.OS === 'ios'` so the row/section rendering path is covered on native
 * too. Mutating `CommandMenu`'s `onSelect(items[index], index)` to commit
 * `selectedIndex` turns both cases RED.
 *
 * What it does NOT pin, deliberately: `CommandMenuSurface` is mocked away below,
 * so the surface's own `Platform.OS` branch never runs here. Its web arm is
 * covered by `CommandMenuSurface.webFocus.test.tsx` plus
 * `AgentInput.commandMenuPointerCommit.dom.test.tsx`; the native arm (an empty
 * spread — native has no focus-on-press default) has no unit gate at all and is
 * covered only by device QA. An earlier version of this header claimed the tap
 * path was pinned "on a native platform too" because the surface branches on
 * `Platform.OS`; that was false, and it is exactly the kind of overstated scope
 * that let a dead composer look covered.
 */
import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { CommandMenu } from '../CommandMenu';
import type { CommandMenuItem, CommandMenuProps } from '../commandMenuTypes';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
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
