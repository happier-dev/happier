import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const featureDecisionState = vi.hoisted(() => ({
    state: 'enabled' as 'enabled' | 'disabled' | 'unknown' | null,
}));
const featureDecisionSpy = vi.hoisted(() => vi.fn());
const daemonProjectionSpy = vi.hoisted(() => vi.fn(() => ({
    phase: 'ready' as const,
    inputs: { pluginProjectionV2: null },
})));
const browseScreenRenderSpy = vi.hoisted(() => vi.fn());
const routeParamsState = vi.hoisted(() => ({
    value: {} as Record<string, string>,
}));

const routerMock = createExpoRouterMock({
    params: () => routeParamsState.value,
    // A Browse deep link can be the first entry in its stack; the gate's exit has to
    // work there too, so this mock deliberately reports "nowhere to go back to".
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSettings: () => ({}),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({}),
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: daemonProjectionSpy,
}));

vi.mock('@/components/sessions/external/browse/ExternalSessionsBrowseScreen', () => ({
    ExternalSessionsBrowseScreen: () => {
        browseScreenRenderSpy();
        return React.createElement('ExternalSessionsBrowseScreen');
    },
}));

vi.mock('@/components/ui/surfaces/SurfaceStateCard', () => ({
    SurfaceStateCard: (props: Readonly<Record<string, unknown>>) =>
        React.createElement('SurfaceStateCard', props),
}));

describe('External Sessions Browse route feature gate', () => {
    beforeEach(() => {
        featureDecisionState.state = 'enabled';
        featureDecisionSpy.mockReset();
        daemonProjectionSpy.mockClear();
        browseScreenRenderSpy.mockReset();
        routeParamsState.value = {};
    });

    afterEach(() => {
        standardCleanup();
    });

    it.each([
        ['disabled', 'disabled', 'external-sessions-browse-route-gate-unavailable', 'unavailable'],
        ['unknown', 'unknown', 'external-sessions-browse-route-gate-unknown', 'error'],
        ['missing', null, 'external-sessions-browse-route-gate-checking', 'loading'],
    ] as const)(
        'fails closed for a %s External Sessions decision with an exitable state instead of a blank route',
        async (_label, state, expectedTestID, expectedKind) => {
            featureDecisionState.state = state;
            const Route = (await import('@/app/(app)/external/browse')).default;

            const screen = await renderScreen(<Route />);

            const card = screen.tree.findByType('SurfaceStateCard' as never);
            expect(card.props.testID).toBe(expectedTestID);
            expect(card.props.kind).toBe(expectedKind);
            expect(card.props.title).toBeTruthy();
            expect(card.props.accessibilitySemantics).toBe(
                expectedKind === 'loading' ? 'status' : 'alert',
            );
            const exitAction = card.props.action ?? card.props.secondaryAction;
            expect(exitAction?.label).toBe(t('common.close'));
            exitAction.onPress();
            expect(routerMock.spies.replace).toHaveBeenCalledWith('/');
            expect(featureDecisionSpy).toHaveBeenCalledWith('sessions.direct', undefined);
            expect(daemonProjectionSpy).not.toHaveBeenCalled();
            expect(browseScreenRenderSpy).not.toHaveBeenCalled();
        },
    );

    it('mounts the canonical Browse screen only when sessions.direct is enabled', async () => {
        const Route = (await import('@/app/(app)/external/browse')).default;

        const screen = await renderScreen(<Route />);

        expect(screen.tree.findByType('ExternalSessionsBrowseScreen' as never)).toBeTruthy();
        expect(featureDecisionSpy).toHaveBeenCalledWith('sessions.direct', undefined);
        expect(browseScreenRenderSpy).toHaveBeenCalledOnce();
    });

    it('resolves a qualified Browse deep link against its spawn server scope', async () => {
        routeParamsState.value = {
            machineId: 'machine-1',
            serverId: 'server-1',
            agentId: 'acme-agent',
            agentPluginId: 'acme.external',
            agentLocalId: 'reviewer',
        };
        const Route = (await import('@/app/(app)/external/browse')).default;

        await renderScreen(<Route />);

        expect(featureDecisionSpy).toHaveBeenCalledWith('sessions.direct', {
            scopeKind: 'spawn',
            serverId: 'server-1',
        });
        expect(daemonProjectionSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            enabled: true,
        });
    });

    it('keeps the predecessor route only as a gated redirect to the canonical Browse route', async () => {
        const LegacyRoute = (await import('@/app/(app)/direct/browse')).default;

        const enabledScreen = await renderScreen(<LegacyRoute />);
        expect(enabledScreen.tree.findByType('Redirect' as never).props.href).toBe('/external/browse');
        expect(browseScreenRenderSpy).not.toHaveBeenCalled();

        standardCleanup();
        featureDecisionState.state = 'unknown';
        featureDecisionSpy.mockClear();
        const disabledScreen = await renderScreen(<LegacyRoute />);
        expect(disabledScreen.tree.findAllByType('Redirect' as never)).toHaveLength(0);
        expect(
            disabledScreen.tree.findByType('SurfaceStateCard' as never).props.testID,
        ).toBe('external-sessions-browse-route-gate-unknown');
        expect(featureDecisionSpy).toHaveBeenCalledWith('sessions.direct', undefined);
        expect(browseScreenRenderSpy).not.toHaveBeenCalled();
    });
});
