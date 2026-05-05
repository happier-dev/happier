import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setMobileWorkspaceExperience = vi.fn();
let translationPrefix = 'en';

installSessionSettingsEntryModuleMocks({
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => `${translationPrefix}:${key}`,
            translateLoose: (key: string) => `${translationPrefix}:${key}`,
            getPreferredLanguage: () => translationPrefix,
        });
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Boundary fixture: settings route tests only need keyed mutable storage semantics.
                useSettingMutable: ((key: string) => {
                    if (key === 'mobileWorkspaceExperienceV1') return ['cockpit', setMobileWorkspaceExperience];
                    if (key === 'sessionTagsEnabled') return [true, vi.fn()];
                    if (key === 'sessionListDensity') return ['cozy', vi.fn()];
                    if (key === 'sessionListOrderingModeV1') return ['custom', vi.fn()];
                    if (key === 'hideInactiveSessions') return [false, vi.fn()];
                    if (key === 'sessionListActiveGroupingV1') return ['project', vi.fn()];
                    if (key === 'sessionListInactiveGroupingV1') return ['date', vi.fn()];
                    if (key === 'agentInputActionBarLayout') return ['auto', vi.fn()];
                    if (key === 'agentInputChipDensity') return ['auto', vi.fn()];
                    if (key === 'alwaysShowContextSize') return [false, vi.fn()];
                    if (key === 'sessionUseTmux') return [false, vi.fn()];
                    if (key === 'sessionTmuxSessionName') return ['happy', vi.fn()];
                    if (key === 'sessionTmuxIsolated') return [true, vi.fn()];
                    if (key === 'sessionTmuxTmpDir') return [null, vi.fn()];
                    if (key === 'sessionMessageSendMode') return ['agent_queue', vi.fn()];
                    if (key === 'sessionBusySteerSendPolicy') return ['steer_immediately', vi.fn()];
                    if (key === 'agentInputEnterToSend') return [true, vi.fn()];
                    if (key === 'agentInputEnterToSendNative') return [true, vi.fn()];
                    if (key === 'agentInputHistoryScope') return ['perSession', vi.fn()];
                    if (key === 'terminalConnectLegacySecretExportEnabled') return [false, vi.fn()];
                    if (key === 'sessionReplayEnabled') return [false, vi.fn()];
                    if (key === 'sessionReplayStrategy') return ['recent_messages', vi.fn()];
                    if (key === 'sessionReplayRecentMessagesCount') return [250, vi.fn()];
                    if (key === 'sessionReplayMaxSeedChars') return [120000, vi.fn()];
                    if (key === 'sessionReplaySummaryRunnerV1') return [null, vi.fn()];
                    return [null, vi.fn()];
                }) as unknown as typeof import('@/sync/domains/state/storage')['useSettingMutable'],
                // Boundary fixture: this route must not read the synced cockpit setting from local storage.
                useLocalSettingMutable: ((key: string) => {
                    if (key === 'sessionsRightPaneDefaultOpen') return [false, vi.fn()];
                    if (key === 'uiMultiPanePanelsEnabled') return [true, vi.fn()];
                    if (key === 'mobileWorkspaceExperienceV1') {
                        throw new Error('mobileWorkspaceExperienceV1 must use synced account settings');
                    }
                    return [null, vi.fn()];
                }) as unknown as typeof import('@/sync/domains/state/storage')['useLocalSettingMutable'],
            },
        });
    },
});

afterEach(() => {
    standardCleanup();
    setMobileWorkspaceExperience.mockClear();
    resetSessionSettingsEntryState();
    translationPrefix = 'en';
});

describe('Session settings mobile workspace experience', () => {
    it('surfaces cockpit/classic selection as a synced account setting', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = (mod.default as unknown as {
            type: React.ComponentType<Record<string, never>>;
        }).type;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdown = screen.findAllByType('DropdownMenu' as never).find(
            (node) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-mobileWorkspaceExperience-trigger',
        );

        expect(dropdown).toBeTruthy();
        expect(dropdown?.props?.selectedId).toBe('cockpit');
        expect(dropdown?.props?.items?.map((item: { id: string }) => item.id)).toEqual(['cockpit', 'classic']);

        await act(async () => {
            dropdown!.props.onSelect('classic');
        });

        expect(setMobileWorkspaceExperience).toHaveBeenCalledWith('classic');
    });

    it('refreshes the mobile workspace dropdown labels when the language changes and the screen rerenders', async () => {
        translationPrefix = 'en';
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = (mod.default as unknown as {
            type: React.ComponentType<Record<string, never>>;
        }).type;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const readDropdownTitles = () => {
            const dropdown = screen.findAllByType('DropdownMenu' as never).find(
                (node) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-mobileWorkspaceExperience-trigger',
            );
            return dropdown?.props?.items?.map((item: { title: string }) => item.title) ?? [];
        };

        expect(readDropdownTitles()).toEqual([
            'en:settingsSession.mobileWorkspaceExperience.options.cockpitTitle',
            'en:settingsSession.mobileWorkspaceExperience.options.classicTitle',
        ]);

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(React.createElement(SessionSettingsScreen));
        });

        expect(readDropdownTitles()).toEqual([
            'fr:settingsSession.mobileWorkspaceExperience.options.cockpitTitle',
            'fr:settingsSession.mobileWorkspaceExperience.options.classicTitle',
        ]);
    });
});
