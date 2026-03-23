import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';

const { trackingMock, analyticsRuntimeState } = vi.hoisted(() => ({
    trackingMock: {
        identify: vi.fn(),
        group: vi.fn(),
        flush: vi.fn(() => Promise.resolve()),
    },
    analyticsRuntimeState: {
        settings: null as Settings | null,
        localSettings: null as LocalSettings | null,
        mainSelectionSnapshot: {
            status: 'ready',
            serverIds: [],
            snapshotsByServerId: {},
        },
    },
}));
const trackingIdentityListeners = new Set<() => void>();
let trackingAnonymousUserId = 'anon-user';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/track/tracking', () => ({
    tracking: trackingMock,
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useSettings: () => analyticsRuntimeState.settings,
        useLocalSettings: () => analyticsRuntimeState.localSettings,
    };
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => ({ serverIds: [] }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/features/featureDecisionRuntime')>();
    return {
        ...actual,
        useServerFeaturesMainSelectionSnapshot: () => analyticsRuntimeState.mainSelectionSnapshot,
    };
});

vi.mock('@/track', () => ({
    getTrackingAnonymousUserId: () => trackingAnonymousUserId,
    subscribeTrackingAnonymousUserId: (listener: () => void) => {
        trackingIdentityListeners.add(listener);
        return () => trackingIdentityListeners.delete(listener);
    },
}));

vi.mock('expo-constants', () => ({
    default: {
        installationId: 'install-123',
    },
}));

import { SettingsAnalyticsRuntime } from './SettingsAnalyticsRuntime';
import { renderScreen } from '@/dev/testkit';


describe('SettingsAnalyticsRuntime', () => {
    beforeEach(() => {
        trackingAnonymousUserId = 'anon-user';
        trackingIdentityListeners.clear();
        analyticsRuntimeState.settings = {
            ...settingsDefaults,
            analyticsOptOut: false,
            crashReportsOptOut: false,
            experiments: true,
            sessionListDensity: 'cozy',
            featureToggles: { voice: true },
        };
        analyticsRuntimeState.localSettings = {
            ...localSettingsDefaults,
            themePreference: 'dark',
            uiItemDensity: 'cozy',
            uiFontScale: 1.24,
            embeddedTerminalDockLocation: 'bottom',
            sessionsListStorageTab: 'persisted',
        };
        analyticsRuntimeState.mainSelectionSnapshot = {
            status: 'ready',
            serverIds: [],
            snapshotsByServerId: {},
        };
    });

    it('syncs account properties to the person and local properties to the device_user group', async () => {
        trackingMock.identify.mockReset();
        trackingMock.group.mockReset();
        trackingMock.flush.mockReset();
        trackingMock.flush.mockResolvedValue(undefined);

        await renderScreen(<SettingsAnalyticsRuntime />);

        expect(trackingMock.identify).toHaveBeenCalledWith(
            'anon-user',
            expect.objectContaining({
                acct_setting__analyticsOptOut: false,
                acct_setting__sessionListDensity: 'cozy',
                feature_pref__voice: true,
            }),
        );
        expect(trackingMock.group).toHaveBeenCalledWith(
            'device_user',
            'anon-user:install-123',
            expect.objectContaining({
                local_setting__themePreference: 'dark',
                local_derived__uiFontScaleBucket: 'large',
            }),
        );
        expect(trackingMock.flush).toHaveBeenCalledTimes(1);
    });

    it('does not resync unchanged snapshots on equivalent rerenders', async () => {
        trackingMock.identify.mockReset();
        trackingMock.group.mockReset();
        trackingMock.flush.mockReset();
        trackingMock.flush.mockResolvedValue(undefined);

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SettingsAnalyticsRuntime />)).tree;

        analyticsRuntimeState.settings = {
            ...analyticsRuntimeState.settings!,
            featureToggles: { ...analyticsRuntimeState.settings!.featureToggles },
        };
        analyticsRuntimeState.localSettings = {
            ...analyticsRuntimeState.localSettings!,
        };
        analyticsRuntimeState.mainSelectionSnapshot = {
            ...analyticsRuntimeState.mainSelectionSnapshot,
            snapshotsByServerId: { ...analyticsRuntimeState.mainSelectionSnapshot.snapshotsByServerId },
        };

        await act(async () => {
            tree!.update(<SettingsAnalyticsRuntime />);
        });

        expect(trackingMock.identify).toHaveBeenCalledTimes(1);
        expect(trackingMock.group).toHaveBeenCalledTimes(1);
        expect(trackingMock.flush).toHaveBeenCalledTimes(1);
    });

    it('resets cached snapshots when the tracking identity changes', async () => {
        trackingMock.identify.mockReset();
        trackingMock.group.mockReset();
        trackingMock.flush.mockReset();
        trackingMock.flush.mockResolvedValue(undefined);

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SettingsAnalyticsRuntime />)).tree;

        trackingAnonymousUserId = 'anon-user-2';
        await act(async () => {
            trackingIdentityListeners.forEach((listener) => listener());
            tree!.update(<SettingsAnalyticsRuntime />);
        });

        expect(trackingMock.identify).toHaveBeenNthCalledWith(
            2,
            'anon-user-2',
            expect.objectContaining({
                acct_setting__analyticsOptOut: false,
            }),
        );
        expect(trackingMock.group).toHaveBeenNthCalledWith(
            2,
            'device_user',
            'anon-user-2:install-123',
            expect.objectContaining({
                local_setting__themePreference: 'dark',
            }),
        );
        expect(trackingMock.flush).toHaveBeenCalledTimes(2);
    });
});
