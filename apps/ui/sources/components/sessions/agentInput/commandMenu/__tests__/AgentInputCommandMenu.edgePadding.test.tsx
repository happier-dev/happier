import * as React from 'react';
import { View } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { CommandMenuProps } from '@/components/ui/commandMenu';

let mockWindowWidth = 1440;
const capturedCommandMenuProps: { current: CommandMenuProps | null } = { current: null };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (value: any) => value.web ?? value.default ?? value.native ?? null,
        },
        useWindowDimensions: () => ({ width: mockWindowWidth, height: 900 }),
    });
});

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/ui/commandMenu', () => ({
    CommandMenu: (props: CommandMenuProps) => {
        capturedCommandMenuProps.current = props;
        return React.createElement(View, { testID: 'captured-command-menu' });
    },
}));

function buildProps(overrides: Partial<CommandMenuProps> = {}): CommandMenuProps {
    return {
        open: true,
        anchor: { kind: 'view', ref: React.createRef() },
        query: '@',
        items: [],
        selectedIndex: -1,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        maxHeight: 240,
        testID: 'agent-input-command-menu',
        ...overrides,
    };
}

/**
 * Edge padding is a property of the agent-input popover surface, not of one
 * menu component: the command menu and the chip/selection popover must not be
 * able to disagree about it. It also has to shrink on a narrow web viewport,
 * where 16pt on both sides measurably narrows a suggestion list that already
 * has to fit paths.
 *
 * The responsive behaviour originated here and was reverse-ported to the sibling
 * repo, which is where it first acquired a test — the mobile-width arm was live
 * and unpinned in this repo until now.
 */
describe('AgentInputCommandMenu edge padding', () => {
    beforeEach(() => {
        capturedCommandMenuProps.current = null;
        mockWindowWidth = 1440;
    });

    it('narrows the edge padding on a mobile-width web viewport', async () => {
        mockWindowWidth = 390;
        const { AgentInputCommandMenu } = await import('../AgentInputCommandMenu');

        await renderScreen(<AgentInputCommandMenu {...buildProps()} />);

        expect(capturedCommandMenuProps.current?.edgePadding).toEqual({ horizontal: 12 });
    });

    it('keeps the default edge padding on a wide web viewport', async () => {
        const { AgentInputCommandMenu } = await import('../AgentInputCommandMenu');

        await renderScreen(<AgentInputCommandMenu {...buildProps()} />);

        expect(capturedCommandMenuProps.current?.edgePadding).toEqual({ horizontal: 16 });
    });

    it('lets an explicit caller override win over the layout owner', async () => {
        mockWindowWidth = 390;
        const { AgentInputCommandMenu } = await import('../AgentInputCommandMenu');

        await renderScreen(
            <AgentInputCommandMenu {...buildProps({ edgePadding: { horizontal: 4 } })} />,
        );

        expect(capturedCommandMenuProps.current?.edgePadding).toEqual({ horizontal: 4 });
    });
});
