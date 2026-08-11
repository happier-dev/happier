import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { AGENT_INPUT_CONTROL_REGISTRY } from '../controls/agentInputControlRegistry';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
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

const hapticsLight = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight,
}));

vi.mock('@/components/sessions/workState/SessionWorkStateContent', () => ({
    SessionWorkStateContent: (props: Record<string, unknown>) =>
        React.createElement('SessionWorkStateContent', props),
}));

const SNAPSHOT = {
    v: 1 as const,
    backendId: 'claude',
    updatedAt: 10,
    primaryItemId: 'goal:claude',
    items: [
        { id: 'goal:claude', kind: 'goal' as const, origin: 'vendor' as const, status: 'active' as const, title: 'Ship goals', updatedAt: 10 },
    ],
};

describe('createGoalActionChip', () => {
    it('registers the goal control on the primary line', () => {
        expect(AGENT_INPUT_CONTROL_REGISTRY).toContainEqual({ id: 'goal', line: 'primary' });
    });

    it('opens the shared work-state content popover anchored to the chip', async () => {
        const { createGoalActionChip } = await import('./createGoalActionChip');
        const onSetGoal = vi.fn();
        const onClearGoal = vi.fn();
        const chip = createGoalActionChip({
        sessionId: 'sess_1',
            snapshot: SNAPSHOT,
            editableGoal: true,
            currentObjective: 'Ship goals',
            onSetGoal,
            onClearGoal,
        });

        expect(chip.controlId).toBe('goal');
        expect(chip.collapsedContentPopover).toBeTruthy();

        const toggleCollapsedPopover = vi.fn();
        const screen = await renderScreen(
            <React.Fragment>
                {chip.render({
                    chipStyle: () => ({}),
                    showLabel: true,
                    iconColor: '#000',
                    textStyle: {},
                    countTextStyle: {},
                    chipAnchorRef: { current: null },
                    popoverAnchorRef: { current: null },
                    toggleCollapsedPopover,
                })}
            </React.Fragment>,
        );

        await screen.pressByTestIdAsync('agent-input-goal-chip');
        expect(toggleCollapsedPopover).toHaveBeenCalledWith('session-goal');
        expect(hapticsLight).toHaveBeenCalled();

        const requestClose = vi.fn();
        const renderContent = chip.collapsedContentPopover!.renderContent;
        if (typeof renderContent !== 'function') {
            throw new Error('Expected collapsedContentPopover.renderContent to be a function');
        }
        const contentScreen = await renderScreen(
            <React.Fragment>
                {renderContent({ requestClose, maxHeight: 420 }) as React.ReactNode}
            </React.Fragment>,
        );
        const content = contentScreen.findByType('SessionWorkStateContent');
        expect(content?.props.snapshot).toBe(SNAPSHOT);
        expect(content?.props.editableGoal).toBe(true);
        expect(content?.props.onSetGoal).toBe(onSetGoal);
        expect(content?.props.onClearGoal).toBe(onClearGoal);
    });

    it('renders the goal glyph without a visible set-goal label when no objective is set', async () => {
        const { createGoalActionChip } = await import('./createGoalActionChip');
        const chip = createGoalActionChip({
        sessionId: 'sess_1',
            snapshot: null,
            editableGoal: true,
            currentObjective: null,
        });

        const screen = await renderScreen(
            <React.Fragment>
                {chip.render({
                    chipStyle: () => ({}),
                    showLabel: true,
                    iconColor: '#000',
                    textStyle: {},
                    countTextStyle: {},
                    chipAnchorRef: { current: null },
                    popoverAnchorRef: { current: null },
                    toggleCollapsedPopover: vi.fn(),
                })}
            </React.Fragment>,
        );

        // The bullseye stands in for the goal; the chip stays unlabelled until one is set.
        expect(screen.findAllByType('Icon')[0]?.props.name).toBe('target');
        expect(screen.getTextContent()).not.toContain('session.workState.goal.set');
    });

    // G7: the chip's accessibility label distinguishes the empty "Set goal" affordance from an active
    // goal so screen-reader users can tell the two states apart.
    function renderChip(currentObjective: string | null, editableGoal = true) {
        return import('./createGoalActionChip').then(({ createGoalActionChip }) => {
            const chip = createGoalActionChip({
        sessionId: 'sess_1', snapshot: null, editableGoal, currentObjective });
            return renderScreen(
                <React.Fragment>
                    {chip.render({
                        chipStyle: () => ({}),
                        showLabel: true,
                        iconColor: '#000',
                        textStyle: {},
                        countTextStyle: {},
                        chipAnchorRef: { current: null },
                        popoverAnchorRef: { current: null },
                        toggleCollapsedPopover: vi.fn(),
                    })}
                </React.Fragment>,
            );
        });
    }

    it('labels the empty goal chip as "Set goal" for accessibility (QA-CHIP-1: before any goal item exists)', async () => {
        const screen = await renderChip(null);
        const pressable = screen.findByTestId('agent-input-goal-chip');
        expect(pressable?.props.accessibilityLabel).toBe('session.workState.goal.set');
        expect(pressable?.props.accessibilityState).toEqual({ disabled: false });
    });

    it('labels an active goal chip as "Current goal: <objective>" for accessibility', async () => {
        const screen = await renderChip('Ship the release');
        const pressable = screen.findByTestId('agent-input-goal-chip');
        // The text-module mock echoes the key; the parametrized current-goal key is distinct from
        // the empty set-goal key, proving the two states have different accessible labels.
        expect(pressable?.props.accessibilityLabel).toBe('session.workState.goal.accessibilityCurrent');
        expect(pressable?.props.accessibilityLabel).not.toBe('session.workState.goal.set');
    });

    it('marks the chip disabled in accessibilityState when goal editing is unavailable', async () => {
        const screen = await renderChip(null, false);
        const pressable = screen.findByTestId('agent-input-goal-chip');
        expect(pressable?.props.accessibilityState).toEqual({ disabled: true });
    });
});
