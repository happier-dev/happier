import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { CommandMenuProps } from '@/components/ui/commandMenu';
import { Popover } from '@/components/ui/popover';

let mockWindowWidth = 1440;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (value: Record<string, unknown>) => value.web ?? value.default ?? value.native ?? null,
        },
        useWindowDimensions: () => ({ width: mockWindowWidth, height: 900 }),
    });
});

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Real layout and menu owners run below the portal/window measurement boundary.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

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
        mockWindowWidth = 1440;
    });

    it('narrows the edge padding on a mobile-width web viewport', async () => {
        mockWindowWidth = 390;
        const { AgentInputCommandMenu } = await import('../AgentInputCommandMenu');

        const screen = await renderScreen(<AgentInputCommandMenu {...buildProps()} />);
        expect(screen.findAllByType(Popover)[0]?.props.edgePadding).toEqual({ horizontal: 12, vertical: 12 });
    });

    it('keeps the default edge padding on a wide web viewport', async () => {
        const { AgentInputCommandMenu } = await import('../AgentInputCommandMenu');

        const screen = await renderScreen(<AgentInputCommandMenu {...buildProps()} />);

        // The desktop title strip stays clear above (`DESKTOP_MAIN_CONTENT_DRAG_HEIGHT_PX`).
        expect(screen.findAllByType(Popover)[0]?.props.edgePadding).toEqual({ horizontal: 16, vertical: 16, top: 56 });
    });

    it('centres a menu that may grow past its composer', async () => {
        const { AgentInputCommandMenu } = await import('../AgentInputCommandMenu');

        const screen = await renderScreen(<AgentInputCommandMenu {...buildProps({ centerOnAnchorMaxWidth: 860 })} />);
        const popover = screen.findAllByType(Popover)[0]!;
        expect(popover.props.maxWidthCap).toBe(860);
        expect(popover.props.portal).toMatchObject({ matchAnchorWidth: false, anchorAlign: 'center' });
    });

    it('lets an explicit caller override win over the layout owner', async () => {
        mockWindowWidth = 390;
        const { AgentInputCommandMenu } = await import('../AgentInputCommandMenu');

        const screen = await renderScreen(
            <AgentInputCommandMenu {...buildProps({ edgePadding: { horizontal: 4 } })} />,
        );

        expect(screen.findAllByType(Popover)[0]?.props.edgePadding).toEqual({ horizontal: 4 });
    });
});
