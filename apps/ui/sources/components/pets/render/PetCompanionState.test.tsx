import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

describe('PetCompanionState', () => {
    it('renders a stable DOM state selector for e2e', async () => {
        const { PetCompanionState } = await import('./PetCompanionState');

        const screen = await renderScreen(
            <PetCompanionState state="review">
                <React.Fragment />
            </PetCompanionState>,
        );

        const node = screen.findByTestId('pet-companion-state');
        expect(node?.props['data-pet-state']).toBe('review');
        expect(node?.props.dataSet).toEqual({ petState: 'review' });
    });
});
