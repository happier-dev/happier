import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const useFeatureEnabledMock = vi.fn<(featureId: string) => boolean>();
const routeParams = vi.hoisted(() => ({
    machineId: undefined as string | string[] | undefined,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: useFeatureEnabledMock,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return {
        ...createExpoRouterMock().module,
        useLocalSearchParams: () => ({
            machineId: routeParams.machineId,
        }),
    };
});

vi.mock('@/components/settings/externalSessions/ExternalSessionsSettingsView', () => ({
    default: (props: Record<string, unknown>) => React.createElement(
        'ExternalSessionsSettingsView',
        props,
    ),
}));

describe('External Sessions settings route feature gate', () => {
    afterEach(() => {
        standardCleanup();
        useFeatureEnabledMock.mockReset();
        routeParams.machineId = undefined;
    });

    it('returns null when the canonical External Sessions feature is disabled', async () => {
        useFeatureEnabledMock.mockReturnValue(false);
        const { default: ExternalSessionsSettingsRoute } = await import(
            '@/app/(app)/settings/external-sessions'
        );

        const tree = (await renderScreen(
            React.createElement(ExternalSessionsSettingsRoute),
        )).tree;

        expect(tree.toJSON()).toBeNull();
        expect(useFeatureEnabledMock).toHaveBeenCalledWith('sessions.direct');
    });

    it('renders the settings view when the canonical feature is enabled', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        const { default: ExternalSessionsSettingsRoute } = await import(
            '@/app/(app)/settings/external-sessions'
        );

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(
            React.createElement(ExternalSessionsSettingsRoute),
        )).tree;

        const settingsView = tree.findByType('ExternalSessionsSettingsView' as never);
        expect(settingsView.props.integrationInventoryEnabled).toBe(true);
        expect(settingsView.props.initialMachineId).toBeNull();
        expect(settingsView.props.autoLinkSources).toBeUndefined();
        expect(useFeatureEnabledMock).toHaveBeenCalledWith('sessions.direct');
    });

    it('passes the normalized machine query context into the global settings view', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        routeParams.machineId = [' machine-2 ', 'ignored-machine'];
        const { default: ExternalSessionsSettingsRoute } = await import(
            '@/app/(app)/settings/external-sessions'
        );

        const tree = (await renderScreen(
            React.createElement(ExternalSessionsSettingsRoute),
        )).tree;

        const settingsView = tree.findByType('ExternalSessionsSettingsView' as never);
        expect(settingsView.props.initialMachineId).toBe('machine-2');
    });
});
