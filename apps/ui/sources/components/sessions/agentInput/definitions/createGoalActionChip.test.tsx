import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) =>
            key === 'session.workState.badge.goal' ? `Goal: ${params?.title ?? ''}` : key,
    });
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

vi.mock('@/components/ui/theme/haptics', () => ({ hapticsLight: vi.fn() }));

vi.mock('@/components/sessions/agentInput/components/AgentInputChipLabel', () => ({
    AgentInputChipLabel: (props: { label?: string }) =>
        React.createElement('AgentInputChipLabel', props, props.label),
}));

// Stub the shared goal/work-state body so the chip test stays focused on the chip contract; the body
// itself is covered by SessionWorkStatePopover.test.tsx (same component).
vi.mock('@/components/sessions/workState/SessionWorkStateContent', () => ({
    SessionWorkStateContent: (props: Record<string, unknown>) =>
        React.createElement('SessionWorkStateContent', props),
}));

const ACTIVE_GOAL_SNAPSHOT: SessionWorkStateSnapshot = {
    v: 1,
    backendId: 'claude',
    updatedAt: 10,
    primaryItemId: 'goal:claude',
    items: [
        { id: 'goal:claude', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship the goal chip', updatedAt: 10 },
    ],
};

const renderContext = (overrides?: Partial<Record<string, unknown>>) => ({
    chipStyle: () => ({}),
    showLabel: true,
    iconColor: '#000',
    textStyle: {},
    countTextStyle: {},
    chipAnchorRef: { current: null },
    popoverAnchorRef: { current: null },
    toggleCollapsedPopover: vi.fn(),
    ...overrides,
});

describe('createGoalActionChip', () => {
    it('renders the "Set goal" first-goal entry point when there is no goal item yet (QA-CHIP-1)', async () => {
        const { createGoalActionChip } = await import('./createGoalActionChip');
        const chip = createGoalActionChip({
            snapshot: null,
            editableGoal: true,
            goalActionCapabilityProfile: null,
            currentObjective: null,
        });

        expect(chip.key).toBe('session-goal');
        expect(chip.controlId).toBe('goal');

        const screen = await renderScreen(
            <React.Fragment>{chip.render(renderContext())}</React.Fragment>,
        );
        const pressable = screen.findByTestId('agent-input-goal-chip');
        expect(pressable?.props.accessibilityState).toEqual({ disabled: false });
        // The empty-state label uses the "Set goal" key.
        expect(pressable?.props.accessibilityLabel).toBe('session.workState.goal.set');
        // The bullseye stands in for the goal.
        expect(screen.findAllByType('Icon')[0]?.props.name).toBe('target');
        expect(screen.findAllByType('AgentInputChipLabel')).toHaveLength(0);
    });

    it('shows the current objective + a "Goal:" accessibility label when a goal exists', async () => {
        const { createGoalActionChip } = await import('./createGoalActionChip');
        const chip = createGoalActionChip({
            snapshot: ACTIVE_GOAL_SNAPSHOT,
            editableGoal: true,
            goalActionCapabilityProfile: null,
            currentObjective: 'Ship the goal chip',
        });

        const screen = await renderScreen(
            <React.Fragment>{chip.render(renderContext())}</React.Fragment>,
        );
        const pressable = screen.findByTestId('agent-input-goal-chip');
        expect(pressable?.props.accessibilityLabel).toBe('Goal: Ship the goal chip');
        expect(screen.findAllByType('AgentInputChipLabel')).toHaveLength(0);
    });

    it('marks the chip disabled for screen readers when the goal is not editable (read-only, D4)', async () => {
        const { createGoalActionChip } = await import('./createGoalActionChip');
        const chip = createGoalActionChip({
            snapshot: ACTIVE_GOAL_SNAPSHOT,
            editableGoal: false,
            goalActionCapabilityProfile: null,
            currentObjective: 'Ship the goal chip',
        });

        const screen = await renderScreen(
            <React.Fragment>{chip.render(renderContext())}</React.Fragment>,
        );
        expect(screen.findByTestId('agent-input-goal-chip')?.props.accessibilityState).toEqual({ disabled: true });
    });

    it('routes the popover through the shared SessionWorkStateContent with the chip props (no provider parsing)', async () => {
        const { createGoalActionChip } = await import('./createGoalActionChip');
        const onSetGoal = vi.fn();
        const onClearGoal = vi.fn();
        const profile = { canEdit: true, canStop: false, canClear: true, canConfigureBudget: false } as const;
        const chip = createGoalActionChip({
            snapshot: ACTIVE_GOAL_SNAPSHOT,
            editableGoal: true,
            goalActionCapabilityProfile: profile,
            currentObjective: 'Ship the goal chip',
            onSetGoal,
            onClearGoal,
        });

        const renderContent = chip.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') {
            throw new Error('Expected collapsedContentPopover.renderContent to be a function');
        }
        const requestClose = vi.fn();
        const contentScreen = await renderScreen(
            <React.Fragment>{renderContent({ requestClose, maxHeight: 420 }) as React.ReactNode}</React.Fragment>,
        );
        const content = contentScreen.findByType('SessionWorkStateContent');
        expect(content?.props.snapshot).toBe(ACTIVE_GOAL_SNAPSHOT);
        expect(content?.props.editableGoal).toBe(true);
        expect(content?.props.goalActionCapabilityProfile).toBe(profile);
        expect(content?.props.onSetGoal).toBe(onSetGoal);
        expect(content?.props.onClearGoal).toBe(onClearGoal);
        expect(content?.props.requestClose).toBe(requestClose);
    });
});
