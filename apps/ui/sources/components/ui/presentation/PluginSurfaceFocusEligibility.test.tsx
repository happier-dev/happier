import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    followSignal,
    PluginSurfaceFocusEligibilityProvider,
    usePluginSurfaceFocusEligibilitySignal,
    usePluginSurfaceCurrentUiContextEligibility,
    usePluginSurfaceFocusEligibility,
    usePresentedValue,
} from './PluginSurfaceFocusEligibility';

function FocusEligibilityProbe(props: Readonly<{ testID: string }>): React.ReactElement {
    return React.createElement('PluginSurfaceFocusEligibilityProbe', {
        testID: props.testID,
        eligible: usePluginSurfaceFocusEligibility(),
        currentUiContextEligible: usePluginSurfaceCurrentUiContextEligibility(),
    });
}

describe('PluginSurfaceFocusEligibility', () => {
    it('retains the named presented page context while an overlay owns input, without reviving a withdrawn ancestor', async () => {
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
            <PluginSurfaceFocusEligibilityProvider active={false} presentationActive currentUiContextActive>
                <PluginSurfaceFocusEligibilityProvider active>
                    <FocusEligibilityProbe testID="covered-page" />
                </PluginSurfaceFocusEligibilityProvider>
            </PluginSurfaceFocusEligibilityProvider>
            <PluginSurfaceFocusEligibilityProvider active={false} currentUiContextActive={false}>
                <PluginSurfaceFocusEligibilityProvider active presentationActive currentUiContextActive>
                    <FocusEligibilityProbe testID="withdrawn-page" />
                </PluginSurfaceFocusEligibilityProvider>
            </PluginSurfaceFocusEligibilityProvider>
        </PluginSurfaceFocusEligibilityProvider>);
        expect(screen.findByTestId('covered-page')?.props.eligible).toBe(false);
        expect(screen.findByTestId('covered-page')?.props.currentUiContextEligible).toBe(true);
        expect(screen.findByTestId('withdrawn-page')?.props.currentUiContextEligible).toBe(false);
    });
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
    it('follows focus eligibility by subscription: a nested reader sees each flip without rendering for it', async () => {
        const followed: boolean[] = [];
        let renders = 0;
        const Reader = React.memo(function Reader() {
            renders += 1;
            const eligible = usePluginSurfaceFocusEligibilitySignal();
            React.useEffect(() => followSignal(eligible, value => { followed.push(value); }), [eligible]);
            return null;
        });
        const reader = <Reader />;
        const tree = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>
            <PluginSurfaceFocusEligibilityProvider active>{reader}</PluginSurfaceFocusEligibilityProvider>
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(tree(true));
        await screen.update(tree(false));
        await screen.update(tree(true));
        expect(followed).toEqual([true, false, true]);
        expect(renders).toBe(1);
        // Without a provider there is no proven owner: the signal fails closed like the hook.
        const orphan: boolean[] = [];
        function Orphan() {
            const eligible = usePluginSurfaceFocusEligibilitySignal();
            React.useEffect(() => followSignal(eligible, value => { orphan.push(value); }), [eligible]);
            return null;
        }
        await renderScreen(<Orphan />);
        expect(orphan).toEqual([false]);
    });
    it('presents a value without rendering for a hide or show, and presents a value changed while hidden when shown', async () => {
        const values: string[] = [];
        const Presented = React.memo(function Presented(props: Readonly<{ source: { value: string } }>) {
            const value = usePresentedValue(props.source.value);
            values.push(value);
            return React.createElement('PresentedProbe', { value });
        });
        const first = { value: 'first' };
        const tree = (presented: boolean, source: { value: string }) => <PluginSurfaceFocusEligibilityProvider active={presented}>
            <Presented source={source} />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(tree(true, first));
        expect(values).toEqual(['first']);
        // A retained surface hidden and shown again draws nothing new: the reader does not render.
        await screen.update(tree(false, first));
        await screen.update(tree(true, first));
        expect(values).toEqual(['first']);
        // A value that changes while hidden keeps what was last presented, and is presented on show.
        await screen.update(tree(false, first));
        await screen.update(tree(false, { value: 'second' }));
        expect(screen.findByType('PresentedProbe').props.value).toBe('first');
        await screen.update(tree(true, { value: 'second' }));
        expect(screen.findByType('PresentedProbe').props.value).toBe('second');
    });
});
