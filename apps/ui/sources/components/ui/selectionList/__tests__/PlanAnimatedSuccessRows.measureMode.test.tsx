import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { PlanAnimatedSuccessRows } from '../SelectionListOptionRow';
import type { SectionRenderPlan } from '../SelectionListRenderPlan';

const plan: SectionRenderPlan = {
    id: 'dir',
    options: [{ id: 'opt-0', label: 'Option 0' }],
};

/**
 * FR3-1 / FR3-8 — every row wrapper must forward `measureMode`, otherwise the
 * hidden measure mirror duplicates option testIDs / aria identity in the live
 * tree the moment a transition-animated section is measured.
 */
describe('PlanAnimatedSuccessRows measure-mode forwarding', () => {
    it('renders identity-free rows when measureMode is set', async () => {
        const screen = await renderScreen(
            <PlanAnimatedSuccessRows
                plan={plan}
                rootTestID="sl"
                stepId="root"
                selectedOptionId={null}
                focusedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
                transitionKey="dir:/tmp"
                sectionTestId="sl:section:dir"
                measureMode
            />,
        );

        expect(screen.findByTestId('sl:root:option:opt-0')).toBeNull();
        expect(screen.findByTestId('sl:root:option-wrapper:opt-0')).toBeNull();
    });

    it('keeps row identity when measureMode is not set', async () => {
        const screen = await renderScreen(
            <PlanAnimatedSuccessRows
                plan={plan}
                rootTestID="sl"
                stepId="root"
                selectedOptionId={null}
                focusedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
                transitionKey="dir:/tmp"
                sectionTestId="sl:section:dir"
            />,
        );

        expect(screen.findByTestId('sl:root:option:opt-0')).not.toBeNull();
    });
});
