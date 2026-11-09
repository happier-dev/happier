import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { PlanChecklistRow } = await import('./PlanChecklistRow');
afterEach(standardCleanup);

describe('checklist row disclosure controls', () => {
    it.each(['select', 'execute'] as const)('keeps disclosure separate from the %s row button', async (phase) => {
        const toggle = vi.fn();
        const expand = vi.fn();
        const screen = await renderScreen(<PlanChecklistRow testID="step" variant="default" phase={phase}
            item={{ id: 'deploy', title: 'Deploy log', satisfied: false, disabled: false, renderDetails: () => null }} selected={false}
            expanded onToggle={toggle} onToggleExpanded={expand} />);
        const buttons = screen.tree.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button');
        expect(buttons.length).toBeGreaterThan(0);
        for (const button of buttons) {
            expect(button.findAll(node => node !== button && typeof node.type === 'string'
                && node.props.accessibilityRole === 'button')).toHaveLength(0);
        }
        await screen.pressByTestIdAsync('step-details-toggle');
        expect(expand).toHaveBeenCalledTimes(1);
        expect(toggle).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('step');
        expect(phase === 'select' ? toggle : expand).toHaveBeenCalledTimes(phase === 'select' ? 1 : 2);
    });
});
