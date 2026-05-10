import React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { WizardStepDots } from './WizardStepDots';

describe('WizardStepDots', () => {
    it('always renders dot indicators instead of compact numeric text', async () => {
        const screen = await renderScreen(<WizardStepDots currentStepIndex={0} stepCount={8} />);

        expect(screen.getTextContent()).not.toContain('1 / 8');
    });
});
