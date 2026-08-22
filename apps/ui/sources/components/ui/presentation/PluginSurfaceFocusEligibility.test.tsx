import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    PluginSurfaceFocusEligibilityProvider,
    usePluginSurfaceCurrentUiContextEligibility,
    usePluginSurfaceFocusEligibility,
} from './PluginSurfaceFocusEligibility';

function FocusEligibilityProbe(props: Readonly<{ testID: string }>): React.ReactElement {
    return React.createElement('PluginSurfaceFocusEligibilityProbe', {
        testID: props.testID,
        eligible: usePluginSurfaceFocusEligibility(),
        currentUiContextEligible: usePluginSurfaceCurrentUiContextEligibility(),
    });
}

describe('PluginSurfaceFocusEligibility', () => {
    it('keeps presentation focus independent from current-context eligibility and fails current context closed until a named owner opts in', async () => {
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
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <FocusEligibilityProbe testID="current-ui-context-explicit-root" />
                    <PluginSurfaceFocusEligibilityProvider active={false}>
                        <FocusEligibilityProbe testID="current-ui-context-hidden-child" />
                    </PluginSurfaceFocusEligibilityProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </>,
        );

        expect(screen.findByTestId('focus-eligibility-without-owner')?.props.eligible).toBe(false);
        expect(screen.findByTestId('focus-eligibility-without-owner')?.props.currentUiContextEligible).toBe(false);
        expect(screen.findByTestId('focus-eligibility-active-root')?.props.eligible).toBe(true);
        expect(screen.findByTestId('focus-eligibility-active-root')?.props.currentUiContextEligible).toBe(false);
        expect(screen.findByTestId('focus-eligibility-hidden-child')?.props.eligible).toBe(false);
        expect(screen.findByTestId('focus-eligibility-hidden-child')?.props.currentUiContextEligible).toBe(false);
        expect(screen.findByTestId('focus-eligibility-reactivated-child')?.props.eligible).toBe(false);
        expect(screen.findByTestId('focus-eligibility-reactivated-child')?.props.currentUiContextEligible).toBe(false);
        expect(screen.findByTestId('current-ui-context-explicit-root')?.props.eligible).toBe(true);
        expect(screen.findByTestId('current-ui-context-explicit-root')?.props.currentUiContextEligible).toBe(true);
        expect(screen.findByTestId('current-ui-context-hidden-child')?.props.currentUiContextEligible).toBe(false);
    });
});
