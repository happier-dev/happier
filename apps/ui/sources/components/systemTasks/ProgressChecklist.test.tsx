import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ProgressChecklist, type ProgressChecklistStep } from './ProgressChecklist';

const steps: ProgressChecklistStep[] = [
    { stepId: 'create', title: 'Create VM', status: 'done', detail: '0:41' },
    { stepId: 'install', title: 'Install Happier', status: 'active' },
    { stepId: 'join', title: 'Join Personal Home', status: 'pending' },
];

describe('ProgressChecklist', () => {
    it('draws compact steps as quiet lines that keep each step addressable, its timing and the busy step', async () => {
        const screen = await renderScreen(<ProgressChecklist steps={steps} testIDPrefix="step" density="compact" />);
        const done = screen.findHostByTestId('step-done-create');
        const active = screen.findHostByTestId('step-active-install');
        expect(done?.props.accessibilityLabel).toBe('Create VM');
        expect(active?.props.accessibilityState).toEqual({ busy: true });
        expect(screen.findHostByTestId('step-pending-join')?.props.accessibilityState).toEqual({ busy: false });
        expect(screen.getTextContent()).toContain('0:41');
        // A compact step is a line, not a pressable list row.
        expect(done?.props.onPress).toBeUndefined();
        await screen.unmount();
    });
});
