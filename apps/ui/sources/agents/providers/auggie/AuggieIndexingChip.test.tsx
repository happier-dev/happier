import React from 'react';
import { describe, expect, it, vi } from 'vitest';

type CollapsedActionItem = Readonly<{
    label: string;
    onPress?: () => void;
}>;

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const PRESSABLE_TEST_ID = 'auggie-indexing-chip.pressable';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode; testID?: string }) =>
            React.createElement(
                'Pressable',
                {
                    ...props,
                    testID: props.testID ?? PRESSABLE_TEST_ID,
                },
                props.children,
            ),
    });
});

vi.mock('@expo/vector-icons', async () => ({
    ...(await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
    Octicons: () => null,
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: vi.fn(),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('createAuggieAllowIndexingChip', () => {
    it('registers as a provider-option control and exposes a collapsed toggle action', async () => {
        const { createAuggieAllowIndexingChip } = await import('./AuggieIndexingChip');
        const { renderScreen } = await import('@/dev/testkit');
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

        collapsedActionItem?.onPress?.();
        expect(setAllowIndexing).toHaveBeenCalledWith(true);

        const screen = await renderScreen(chip.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement);

        expect(screen.findByTestId(PRESSABLE_TEST_ID)).toBeTruthy();
        screen.pressByTestId(PRESSABLE_TEST_ID);
        expect(setAllowIndexing).toHaveBeenCalledWith(true);
    });
});
