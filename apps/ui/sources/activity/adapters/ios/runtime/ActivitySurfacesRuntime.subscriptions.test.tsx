import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import * as iosPolicies from './resolveIosActivitySurfacePolicies';
import { ActivitySurfacesRuntime } from './ActivitySurfacesRuntime';

// Native widgets are an OS boundary. Web still mounts the same policy and settings subscriptions.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('expo-widgets', async (importOriginal) => {
    const { createExpoWidgetsModuleMock } = await import('@/dev/testkit/mocks/expoWidgets');
    return createExpoWidgetsModuleMock({
        importOriginal,
        addUserInteractionListener: () => ({ remove() {} }),
    });
});

await import('./iosActivityWidgetModules');

describe('ActivitySurfacesRuntime settings subscriptions', () => {
    beforeEach(async () => {
        getPersistenceStorage().clearAll();
        await storage.getState().activateSettingsScope({ serverId: 'activity-home', accountId: 'activity-account' });
        storage.getState().applySettings(settingsDefaults, 1);
    });

    it('ignores unrelated local settings and refreshes consumed surface policy', async () => {
        const commits = vi.fn();
        const resolvePolicies = vi.spyOn(iosPolicies, 'resolveIosActivitySurfacePolicies');
        await renderScreen(<React.Profiler id="activity-local" onRender={commits}>
            <ActivitySurfacesRuntime />
        </React.Profiler>);
        const baseline = commits.mock.calls.length;
        const computations = resolvePolicies.mock.calls.length;
        await act(async () => {
            storage.getState().applyLocalSettings({ petsCompanionSizeScale: 1.5 }, { persist: false });
        });
        expect({ renders: commits.mock.calls.length - baseline,
            computations: resolvePolicies.mock.calls.length - computations }).toEqual({ renders: 0, computations: 0 });
        await act(async () => {
            storage.getState().applyLocalSettings({ widgetsEnabled: !storage.getState().localSettings.widgetsEnabled }, { persist: false });
        });
        expect({ renders: commits.mock.calls.length - baseline,
            computations: resolvePolicies.mock.calls.length - computations }).toEqual({ renders: 1, computations: 1 });
    });

    it('ignores unrelated account settings and refreshes for feature preferences', async () => {
        const commits = vi.fn();
        const resolvePolicies = vi.spyOn(iosPolicies, 'resolveIosActivitySurfacePolicies');
        await renderScreen(
            <React.Profiler id="activity-surfaces" onRender={commits}>
                <ActivitySurfacesRuntime />
            </React.Profiler>,
        );
        const baseline = commits.mock.calls.length;
        const computationBaseline = resolvePolicies.mock.calls.length;
        await act(async () => {
            storage.getState().applySettingsLocal({ favoriteDirectories: ['~/code'] });
        });
        expect(commits.mock.calls.length).toBe(baseline);
        expect(resolvePolicies.mock.calls.length).toBe(computationBaseline);
        await act(async () => {
            storage.getState().applySettingsLocal({ experiments: !storage.getState().settings.experiments });
        });
        expect({
            commits: commits.mock.calls.length - baseline,
            computations: resolvePolicies.mock.calls.length - computationBaseline,
        }).toEqual({ commits: 1, computations: 1 });
    });
});
