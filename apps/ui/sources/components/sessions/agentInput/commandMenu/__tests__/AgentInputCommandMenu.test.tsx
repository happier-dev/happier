import * as React from 'react';
import { View } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { CommandMenuProps } from '@/components/ui/commandMenu';

let mockKeyboardHeight = 0;
const capturedCommandMenuProps: { current: CommandMenuProps | null } = { current: null };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: (value: any) => value.android ?? value.native ?? value.default ?? value.ios ?? null,
        },
        useWindowDimensions: () => ({ width: 2400, height: 1080 }),
    });
});

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => mockKeyboardHeight,
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
        query: '/',
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

describe('AgentInputCommandMenu', () => {
    beforeEach(() => {
        mockKeyboardHeight = 0;
        capturedCommandMenuProps.current = null;
    });

    it('applies the agent-input keyboard-safe popover contract on native', async () => {
        mockKeyboardHeight = 320;
        const { AgentInputCommandMenu } = await import('../AgentInputCommandMenu');

        await renderScreen(<AgentInputCommandMenu {...buildProps()} />);

        expect(capturedCommandMenuProps.current?.placement).toBe('top');
        expect(capturedCommandMenuProps.current?.gap).toBe(32);
        expect(capturedCommandMenuProps.current?.keyboardBottomInset).toBe(320);
        expect(capturedCommandMenuProps.current?.edgePadding).toEqual({ horizontal: 16 });
        expect(capturedCommandMenuProps.current?.consumeOutsidePointerDown).toBe(false);
        expect(capturedCommandMenuProps.current?.containerStyle).toEqual({ paddingHorizontal: 0 });
        expect(capturedCommandMenuProps.current?.backdrop).toEqual({
            style: { backgroundColor: 'transparent' },
            blockOutsidePointerEvents: 'above-anchor',
        });
    });
});
