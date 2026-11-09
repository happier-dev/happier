import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));
vi.mock('react-native-svg', () => ({
    default: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Path: (props: Record<string, unknown>) => React.createElement('Path', props),
}));

const renderContext = () => ({
    chipStyle: () => ({}),
    showLabel: true,
    iconColor: '#000',
    textStyle: {},
    countTextStyle: {},
    chipAnchorRef: { current: null },
    popoverAnchorRef: { current: null },
    toggleCollapsedPopover: vi.fn(),
});

const { createAutomationEditorActionChip } = await import('./createAutomationEditorActionChip');

describe('createAutomationEditorActionChip', () => {
    it('opens the shared Automation editor instead of embedding a settings popover', async () => {
        const onPress = vi.fn();
        const chip = createAutomationEditorActionChip({ label: 'Automate', onPress });

        // No collapsed popover: the chip is navigation, so the composed draft
        // is authored in one place rather than in a second inline editor.
        expect(chip.collapsedContentPopover).toBeUndefined();

        const screen = await renderScreen(
            <>{chip.render(renderContext() as never)}</>,
        );
        const pressable = screen.findByProps({ testID: 'new-session-automation-chip' });
        expect(pressable.props.accessibilityLabel).toBe('Automate');
        await (async () => pressable.props.onPress())();

        expect(onPress).toHaveBeenCalledTimes(1);

        // P3 §3.4 puts Automation in + by default; both entry points keep the
        // same draft handoff instead of introducing a second editor.
        const dismiss = vi.fn();
        const action = chip.collapsedAction?.({ dismiss, tint: '#000', blurInput: vi.fn(), openCollapsedPopover: vi.fn() });
        if (!action || !('onPress' in action)) throw new Error('Expected the Automation navigation action');
        action.onPress?.();
        expect(dismiss).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(2);
    });
});
