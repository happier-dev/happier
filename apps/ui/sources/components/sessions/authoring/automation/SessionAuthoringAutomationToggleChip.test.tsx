import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, children),
}));

describe('SessionAuthoringAutomationToggleChip', () => {
    it('renders a real switch and toggles via both the switch and label press', async () => {
        const { SessionAuthoringAutomationToggleChip } = await import('./SessionAuthoringAutomationToggleChip');

        const onValueChange = vi.fn();
        const chipStyle = vi.fn(() => ({ paddingHorizontal: 8 }));

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionAuthoringAutomationToggleChip
                    value={true}
                    label="Every 60m"
                    onValueChange={onValueChange}
                    chipStyle={chipStyle}
                    showLabel={true}
                    textStyle={{ color: '#111' }}
                />,
            );
        });

        const toggle = tree.root.findByType('Switch' as any);
        await act(async () => {
            toggle.props.onValueChange(false);
        });
        expect(onValueChange).toHaveBeenCalledWith(false);

        const labelPressable = tree.root.findByProps({ testID: 'session-authoring-automation-toggle-label' });
        await act(async () => {
            labelPressable.props.onPress();
        });
        expect(onValueChange).toHaveBeenCalledWith(false);
    });
});

