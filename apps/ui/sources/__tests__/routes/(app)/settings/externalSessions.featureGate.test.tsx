import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Checking, probe-failure/unknown, and genuinely disabled are three different
// facts, and the Settings route must present each of them instead of rendering
// a literal blank screen — the same contract the Browse route gate owns.
const featureDecisionState = vi.hoisted(() => ({
    state: 'enabled' as 'enabled' | 'disabled' | 'unknown' | null,
}));
const featureDecisionSpy = vi.hoisted(() => vi.fn());
const settingsViewRenderSpy = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({
    machineId: undefined as string | string[] | undefined,
}));

const routerMock = createExpoRouterMock({
    params: () => ({ machineId: routeParams.machineId }),
    // A deep link can be the first entry in its stack; the gate's exit has to
    // work there too.
    router: { canGoBack: () => false },
});

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (...args: unknown[]) => {
        featureDecisionSpy(...args);
        return featureDecisionState.state === null
            ? null
            : { state: featureDecisionState.state };
    },
}));

vi.mock('@/components/settings/externalSessions/ExternalSessionsSettingsView', () => ({
    default: (props: Record<string, unknown>) => {
        settingsViewRenderSpy();
        return React.createElement('ExternalSessionsSettingsView', props);
    },
}));

vi.mock('@/components/ui/surfaces/SurfaceStateCard', () => ({
    SurfaceStateCard: (props: Readonly<Record<string, unknown>>) =>
        React.createElement('SurfaceStateCard', props),
}));

describe('External Sessions settings route feature gate', () => {
    beforeEach(() => {
        featureDecisionState.state = 'enabled';
        featureDecisionSpy.mockReset();
        settingsViewRenderSpy.mockReset();
        routeParams.machineId = undefined;
    });

    afterEach(() => {
        standardCleanup();
    });

    it.each([
        ['disabled', 'disabled', 'external-sessions-browse-route-gate-unavailable', 'unavailable', 'alert'],
        ['unknown', 'unknown', 'external-sessions-browse-route-gate-unknown', 'error', 'alert'],
        ['checking', null, 'external-sessions-browse-route-gate-checking', 'loading', 'status'],
    ] as const)(
        'fails closed for a %s External Sessions decision with an exitable accessible state instead of a blank route',
        async (_label, state, expectedTestID, expectedKind, expectedSemantics) => {
            featureDecisionState.state = state;
            const { default: ExternalSessionsSettingsRoute } = await import(
                '@/app/(app)/settings/external-sessions'
            );

            const tree = (await renderScreen(
                React.createElement(ExternalSessionsSettingsRoute),
            )).tree;

            const gate = tree.findByProps({ testID: expectedTestID });
            expect(gate).toBeTruthy();
            expect(gate.props.kind).toBe(expectedKind);
            expect(gate.props.accessibilitySemantics).toBe(expectedSemantics);
            expect(gate.props.title).toBe(t(expectedSemantics === 'status'
                ? 'common.loading'
                : state === 'unknown'
                    ? 'externalSessions.browseRouteAvailabilityUnknownTitle'
                    : 'externalSessions.browseRouteUnavailableTitle'));
            const exitProps = expectedSemantics === 'status'
                ? gate.props.secondaryAction
                : gate.props.action;
            expect(exitProps).toEqual(expect.objectContaining({ label: t('common.close') }));
            // Settings children mount only in the admitted arm, so no Settings
            // RPCs run before admission.
            expect(settingsViewRenderSpy).not.toHaveBeenCalled();
            expect(featureDecisionSpy).toHaveBeenCalledWith('sessions.direct', undefined);
        },
    );

    it('renders the settings view only when the canonical feature decision is available', async () => {
        const { default: ExternalSessionsSettingsRoute } = await import(
            '@/app/(app)/settings/external-sessions'
        );

        const tree = (await renderScreen(
            React.createElement(ExternalSessionsSettingsRoute),
        )).tree;

        const settingsView = tree.findByType('ExternalSessionsSettingsView' as never);
        expect(settingsView.props.integrationInventoryEnabled).toBe(true);
        expect(settingsViewRenderSpy).toHaveBeenCalledTimes(1);
        expect(featureDecisionSpy).toHaveBeenCalledWith('sessions.direct', undefined);
        expect(tree.findByProps({ testID: 'external-sessions-browse-route-gate-unavailable' })).toBeUndefined();
    });

    it('does not give a machine query execution authority over the Administration settings view', async () => {
        routeParams.machineId = [' machine-2 ', 'ignored-machine'];
        const { default: ExternalSessionsSettingsRoute } = await import(
            '@/app/(app)/settings/external-sessions'
        );

        const tree = (await renderScreen(
            React.createElement(ExternalSessionsSettingsRoute),
        )).tree;

        const settingsView = tree.findByType('ExternalSessionsSettingsView' as never);
        expect(settingsView.props.initialMachineId).toBeUndefined();
    });
});
