import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '../../../dev/testkit';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedSimpleOptionsPopoverProps = Readonly<{
    title: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
    open: boolean;
    anchorRef: unknown;
    onSelect: (selectedId: string) => void;
}>;

const mocks = vi.hoisted(() => ({
    modalShowMock: vi.fn(),
    capturedSimpleOptionsPopoverProps: null as CapturedSimpleOptionsPopoverProps | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: <T,>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) =>
                options?.web ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
        },
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', { testID: 'pi-thinking-level-chip-trigger', ...props }, props.children),
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: vi.fn(),
}));

vi.mock('@/components/sessions/agentInput/chipOptionInteraction', async () => {
    const actual = await import('../../../components/sessions/agentInput/chipOptionInteraction');
    return actual;
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (...args: any[]) => mocks.modalShowMock(...args),
        },
    }).module;
});

vi.mock('@/components/sessions/agentInput/components/AgentInputSimpleOptionsPopover', () => ({
    AgentInputSimpleOptionsPopover: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        mocks.capturedSimpleOptionsPopoverProps = props as unknown as CapturedSimpleOptionsPopoverProps;
        return React.createElement('AgentInputSimpleOptionsPopover', props, props.children);
    },
}));

describe('createPiThinkingLevelChip', () => {
    it('opens the shared simple-options popover when available thinking levels exceed cycle threshold', async () => {
        vi.resetModules();
        mocks.modalShowMock.mockReset();
        mocks.capturedSimpleOptionsPopoverProps = null;
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

        const rendered = chip.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null } as any,
        });
        expect(rendered).toBeTruthy();

        const screen = await renderScreen(rendered as React.ReactElement);
        await screen.pressByTestIdAsync('pi-thinking-level-chip-trigger');

        expect(setThinkingLevel).not.toHaveBeenCalled();
        expect(mocks.modalShowMock).not.toHaveBeenCalled();
        expect(mocks.capturedSimpleOptionsPopoverProps).toBeTruthy();
        const popoverProps = mocks.capturedSimpleOptionsPopoverProps as unknown as CapturedSimpleOptionsPopoverProps;
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
