import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type CollapsedActionItem = Readonly<{
    label: string;
    onPress?: () => void;
}>;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: () => null,
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: vi.fn(),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('createAuggieAllowIndexingChip', () => {
    it('registers as a provider-option control and exposes a collapsed toggle action', async () => {
        const { createAuggieAllowIndexingChip } = await import('./AuggieIndexingChip');
        const setAllowIndexing = vi.fn();
        const chip = createAuggieAllowIndexingChip({
            allowIndexing: false,
            setAllowIndexing,
        });

        expect(chip.controlId).toBe('providerOption');
        expect(typeof chip.collapsedAction).toBe('function');

        const collapsedAction = chip.collapsedAction?.({
            tint: '#fff',
            dismiss: vi.fn(),
            blurInput: () => {},
        });
        expect(Array.isArray(collapsedAction)).toBe(false);
        const collapsedActionItem = collapsedAction as CollapsedActionItem | undefined;
        expect(collapsedActionItem?.label).toBe('agentInput.auggieIndexingChip.off');

        await act(async () => {
            collapsedActionItem?.onPress?.();
        });
        expect(setAllowIndexing).toHaveBeenCalledWith(true);

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(chip.render({
                chipStyle: () => ({}),
                showLabel: true,
                iconColor: '#fff',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null } as any,
            }) as React.ReactElement);
        });

        await act(async () => {
            tree!.root.findByType('Pressable').props.onPress();
        });
        expect(setAllowIndexing).toHaveBeenCalledWith(true);
    });
});
