import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

describe('WizardCardLayout', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('constrains the card container by maxHeight to prevent footer overflow in short web viewports', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const card = screen.findByTestId('wizard-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }

        const styleProp = card.props.style as unknown;
        const styleEntries = Array.isArray(styleProp) ? styleProp : [styleProp];
        const flattened = styleEntries.reduce<Record<string, unknown>>((acc, entry) => {
            if (entry && typeof entry === 'object') {
                Object.assign(acc, entry);
            }
            return acc;
        }, {});

        expect(flattened.maxHeight).toEqual(expect.any(Number));
        expect(Number(flattened.maxHeight)).toBeGreaterThan(0);
    });
});

