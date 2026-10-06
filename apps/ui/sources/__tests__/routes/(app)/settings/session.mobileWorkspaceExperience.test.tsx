import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView as renderBaseSettingsView, standardCleanup } from '@/dev/testkit';
import 'fake-indexeddb/auto';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installDisconnectedServerSocketBoundary();
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

async function renderSettingsView(element: React.ReactElement) {
    account = await createSecretSettingsTestHarness({
        settings: settingsParse({ mobileWorkspaceExperienceV1: 'cockpit' }), sharedEnabled: false,
    });
    storage.setState({ localSettings: localSettingsParse({ uiMultiPanePanelsEnabled: true }) });
    const credentials = account.credentials;
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return renderBaseSettingsView(element, { wrapper });
}
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
    storageModule: (importOriginal) => importOriginal<typeof import('@/sync/domains/state/storage')>(),
});

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
    translationPrefix = 'en';
});

function findNearestItemGroupTitle(node: { parent?: unknown } | null | undefined): unknown {
    let current = node?.parent as { type?: unknown; props?: { title?: unknown }; parent?: unknown } | undefined;
    while (current) {
        if (current.type === 'ItemGroup') return current.props?.title;
        current = current.parent as typeof current;
    }
    return undefined;
}

describe('Session settings mobile workspace experience', () => {
    it('surfaces cockpit mode as a synced account setting switch', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const item = screen.findRowByTitle('en:settingsSession.mobileWorkspaceExperience.title');
        const switchElement = item?.props?.rightElement;

        expect(item).toBeTruthy();
        expect(findNearestItemGroupTitle(item)).toBe('en:settingsSession.rootGroups.mobileLayout.title');
        expect(screen.findAllByType('DropdownMenu' as never).some(
            (node) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-mobileWorkspaceExperience-trigger',
        )).toBe(false);
        expect(switchElement?.type).toBe('Switch');
        expect(switchElement?.props?.value).toBe(true);

        await act(async () => {
            switchElement!.props.onValueChange(false);
        });

        await vi.waitFor(() => expect(storage.getState().settings.mobileWorkspaceExperienceV1).toBe('classic'));
        await vi.waitFor(() => expect(account?.persistedSettings.mobileWorkspaceExperienceV1).toBe('classic'));
        expect(storage.getState().localSettings).toEqual(localSettingsParse({ uiMultiPanePanelsEnabled: true }));
    });

    it('refreshes the cockpit mode row labels when the language changes and the screen rerenders', async () => {
        translationPrefix = 'en';
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const readCockpitRowLabels = () => {
            const item = screen.findRowByTitle(`${translationPrefix}:settingsSession.mobileWorkspaceExperience.title`);
            return {
                title: item?.props?.title,
                subtitle: item?.props?.subtitle,
            };
        };

        expect(readCockpitRowLabels()).toEqual({
            title: 'en:settingsSession.mobileWorkspaceExperience.title',
            subtitle: 'en:settingsSession.mobileWorkspaceExperience.options.cockpitSubtitle',
        });

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(React.createElement(SessionSettingsScreen));
        });

        expect(readCockpitRowLabels()).toEqual({
            title: 'fr:settingsSession.mobileWorkspaceExperience.title',
            subtitle: 'fr:settingsSession.mobileWorkspaceExperience.options.cockpitSubtitle',
        });
    });
});
