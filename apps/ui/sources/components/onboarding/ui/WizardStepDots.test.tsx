import React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { WizardStepDots } from './WizardStepDots';

describe('WizardStepDots', () => {
    it('caps long step counts to a small visible dot window', async () => {
        const screen = await renderScreen(<WizardStepDots currentStepIndex={7} stepCount={15} />);

        expect(screen.findAllByType('Animated.View' as never)).toHaveLength(5);
        expect(screen.findByTestId('wizard-step-dots')?.props.accessibilityValue).toEqual({
            now: 8,
            min: 1,
            max: 15,
        });
    });

    it('names its progress for a screen reader, which reads the bar by its label (C77 aria-progressbar-name)', async () => {
        const { t } = await import('@/text');
        const screen = await renderScreen(<WizardStepDots currentStepIndex={0} stepCount={5} />);
        expect(screen.findByTestId('wizard-step-dots')?.props.accessibilityLabel)
            .toBe(t('welcome.stepProgressAccessibilityLabel', { current: 1, total: 5 }));
    });
});
