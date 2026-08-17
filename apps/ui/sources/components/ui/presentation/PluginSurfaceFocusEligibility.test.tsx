import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    PluginSurfaceFocusEligibilityProvider,
    usePluginSurfaceFocusEligibility,
} from './PluginSurfaceFocusEligibility';

function FocusEligibilityProbe(props: Readonly<{ testID: string }>): React.ReactElement {
    return React.createElement('PluginSurfaceFocusEligibilityProbe', {
        testID: props.testID,
        eligible: usePluginSurfaceFocusEligibility(),
    });
}

describe('PluginSurfaceFocusEligibility', () => {
    it('fails closed without a layout owner and composes every local active fact with its parent', async () => {
        const screen = await renderScreen(
            <>
                <FocusEligibilityProbe testID="focus-eligibility-without-owner" />
                <PluginSurfaceFocusEligibilityProvider active>
                    <FocusEligibilityProbe testID="focus-eligibility-active-root" />
                    <PluginSurfaceFocusEligibilityProvider active={false}>
                        <FocusEligibilityProbe testID="focus-eligibility-hidden-child" />
                        <PluginSurfaceFocusEligibilityProvider active>
                            <FocusEligibilityProbe testID="focus-eligibility-reactivated-child" />
                        </PluginSurfaceFocusEligibilityProvider>
                    </PluginSurfaceFocusEligibilityProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </>,
        );

        expect(screen.findByTestId('focus-eligibility-without-owner')?.props.eligible).toBe(false);
        expect(screen.findByTestId('focus-eligibility-active-root')?.props.eligible).toBe(true);
        expect(screen.findByTestId('focus-eligibility-hidden-child')?.props.eligible).toBe(false);
        expect(screen.findByTestId('focus-eligibility-reactivated-child')?.props.eligible).toBe(false);
    });
});
