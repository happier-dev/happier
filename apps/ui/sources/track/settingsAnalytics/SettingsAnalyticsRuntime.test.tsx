import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import * as accountSnapshots from './buildAccountSettingsSnapshot';

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

// The device_user key is analytics-only: keyed by the person's anonymous id, never the raw installation id.
const deviceUserKey = (anonymousUserId: string) => expect.stringMatching(new RegExp(`^${anonymousUserId}:[0-9a-f]{32}$`));


describe('SettingsAnalyticsRuntime', () => {
    beforeEach(async () => {
        getPersistenceStorage().clearAll();
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
        };
        analyticsRuntimeState.mainSelectionSnapshot = {
            status: 'ready',
            serverIds: [],
            snapshotsByServerId: {},
        };
        await storage.getState().activateSettingsScope({ serverId: 'analytics-home', accountId: 'analytics-account' });
        storage.getState().applySettings(analyticsRuntimeState.settings, 1);
        storage.getState().applyLocalSettings(analyticsRuntimeState.localSettings, { persist: false });
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
            deviceUserKey('anon-user'),
            expect.objectContaining({
                local_setting__themePreference: 'dark',
                local_derived__uiFontScaleBucket: 'large',
            }),
        );
        expect(trackingMock.flush).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(trackingMock.group.mock.calls)).not.toContain('install-123');
    });

    it('does not resync unchanged snapshots on equivalent rerenders', async () => {
        trackingMock.identify.mockReset();
        trackingMock.group.mockReset();
        trackingMock.flush.mockReset();
        trackingMock.flush.mockResolvedValue(undefined);

        const screen = await renderScreen(<SettingsAnalyticsRuntime />);

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
            storage.getState().applySettings(analyticsRuntimeState.settings!, 2);
            storage.getState().applyLocalSettings(analyticsRuntimeState.localSettings!, { persist: false });
        });
        await screen.update(<SettingsAnalyticsRuntime />);

        expect(trackingMock.identify).toHaveBeenCalledTimes(1);
        expect(trackingMock.group).toHaveBeenCalledTimes(1);
        expect(trackingMock.flush).toHaveBeenCalledTimes(1);
    });

    it('does not render for untracked account state and updates tracked preferences', async () => {
        const commits = vi.fn();
        const buildSnapshot = vi.spyOn(accountSnapshots, 'buildAccountSettingsSnapshot');
        trackingMock.identify.mockClear();
        await renderScreen(
            <React.Profiler id="settings-analytics" onRender={commits}>
                <SettingsAnalyticsRuntime />
            </React.Profiler>,
        );
        const baseline = commits.mock.calls.length;
        const computationBaseline = buildSnapshot.mock.calls.length;
        await act(async () => {
            storage.getState().applySettingsLocal({ sessionTmuxSessionName: 'analytics-test' });
        });
        expect(commits.mock.calls.length).toBe(baseline);
        expect(buildSnapshot.mock.calls.length).toBe(computationBaseline);
        await act(async () => {
            storage.getState().applySettingsLocal({ sessionListDensity: 'narrow' });
        });
        expect(commits.mock.calls.length).toBe(baseline + 1);
        expect(buildSnapshot.mock.calls.length).toBe(computationBaseline + 1);
        expect(trackingMock.identify).toHaveBeenLastCalledWith('anon-user', expect.objectContaining({
            acct_setting__sessionListDensity: 'narrow',
        }));
    });

    it('does not render for untracked local state and updates tracked device preferences', async () => {
        const commits = vi.fn();
        trackingMock.group.mockClear();
        await renderScreen(<React.Profiler id="settings-analytics-local" onRender={commits}>
            <SettingsAnalyticsRuntime />
        </React.Profiler>);
        const baseline = commits.mock.calls.length;
        await act(async () => {
            storage.getState().applyLocalSettings({ paneArrangement: 'editor' }, { persist: false });
        });
        expect(commits.mock.calls.length - baseline).toBe(0);
        await act(async () => {
            storage.getState().applyLocalSettings({ themePreference: 'light' }, { persist: false });
        });
        expect(commits.mock.calls.length - baseline).toBe(1);
        expect(trackingMock.group).toHaveBeenLastCalledWith('device_user', deviceUserKey('anon-user'),
            expect.objectContaining({ local_setting__themePreference: 'light' }));
    });

    it('resets cached snapshots when the tracking identity changes', async () => {
        trackingMock.identify.mockReset();
        trackingMock.group.mockReset();
        trackingMock.flush.mockReset();
        trackingMock.flush.mockResolvedValue(undefined);

        const screen = await renderScreen(<SettingsAnalyticsRuntime />);

        trackingAnonymousUserId = 'anon-user-2';
        await act(async () => {
            trackingIdentityListeners.forEach((listener) => listener());
        });
        await screen.update(<SettingsAnalyticsRuntime />);

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
            deviceUserKey('anon-user-2'),
            expect.objectContaining({
                local_setting__themePreference: 'dark',
            }),
        );
        expect(trackingMock.flush).toHaveBeenCalledTimes(2);
        const [firstKey, secondKey] = trackingMock.group.mock.calls.map((call) => String(call[1]).split(':')[1]);
        expect(firstKey).not.toBe(secondKey);
    });
});
