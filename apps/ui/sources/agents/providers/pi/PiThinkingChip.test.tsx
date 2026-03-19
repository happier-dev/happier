import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalShowMock = vi.fn();
type CapturedSimpleOptionsPopoverProps = Readonly<{
    title: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
    open: boolean;
    anchorRef: unknown;
    onSelect: (selectedId: string) => void;
}>;

let capturedSimpleOptionsPopoverProps: CapturedSimpleOptionsPopoverProps | null = null;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: vi.fn(),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        show: (...args: any[]) => modalShowMock(...args),
    },
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputSimpleOptionsPopover', () => ({
    AgentInputSimpleOptionsPopover: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        capturedSimpleOptionsPopoverProps = props as unknown as CapturedSimpleOptionsPopoverProps;
        return React.createElement('AgentInputSimpleOptionsPopover', props, props.children);
    },
}));

describe('createPiThinkingLevelChip', () => {
    it('opens the shared simple-options popover when available thinking levels exceed cycle threshold', async () => {
        vi.resetModules();
        modalShowMock.mockReset();
        capturedSimpleOptionsPopoverProps = null;
        const { createPiThinkingLevelChip } = await import('./PiThinkingChip');
        const setThinkingLevel = vi.fn();
        const chip = createPiThinkingLevelChip({
            thinkingLevel: 'off',
            setThinkingLevel,
        });
        expect(chip.controlId).toBe('providerOption');
        expect(chip.collapsedOptionsPopover).toEqual(expect.objectContaining({
            title: 'sessionInfo.thinkingLevel',
            selectedOptionId: 'off',
        }));

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            const rendered = chip.render({
                chipStyle: () => ({}),
                showLabel: true,
                iconColor: '#fff',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null } as any,
            });
            expect(rendered).toBeTruthy();
            tree = renderer.create(rendered as React.ReactElement);
        });

        const pressable = tree!.root.findByType('Pressable');
        await act(async () => {
            pressable.props.onPress();
        });

        expect(setThinkingLevel).not.toHaveBeenCalled();
        expect(modalShowMock).not.toHaveBeenCalled();
        expect(capturedSimpleOptionsPopoverProps).toBeTruthy();
        const popoverProps = capturedSimpleOptionsPopoverProps as unknown as CapturedSimpleOptionsPopoverProps;
        expect(popoverProps.title).toBe('sessionInfo.thinkingLevel');
        expect(popoverProps.options.length).toBeGreaterThan(3);
        expect(popoverProps.open).toBe(true);
        expect(popoverProps.anchorRef).toBeTruthy();

        await act(async () => {
            popoverProps.onSelect('high');
        });
        expect(setThinkingLevel).toHaveBeenCalledWith('high');
    });
});
