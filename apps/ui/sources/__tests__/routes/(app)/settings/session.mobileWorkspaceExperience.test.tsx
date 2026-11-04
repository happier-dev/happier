import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { renderSettingsView as renderBaseSettingsView, standardCleanup } from '@/dev/testkit';
import 'fake-indexeddb/auto';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import {
    resetSessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installDisconnectedServerSocketBoundary();
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { Switch } = await import('@/components/ui/forms/Switch');
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
const translation = vi.hoisted(() => ({ prefix: 'en' }));

await vi.hoisted(async () => {
    const { installSessionSettingsEntryModuleMocks } = await import('./sessionSettingsEntryTestHelpers');
    installSessionSettingsEntryModuleMocks({
        textModule: async () => {
            const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
            return createTextModuleMock({
                translate: (key: string) => `${translation.prefix}:${key}`,
                translateLoose: (key: string) => `${translation.prefix}:${key}`,
                getPreferredLanguage: () => translation.prefix,
            });
        },
    });
});

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
    translation.prefix = 'en';
});

describe('Session settings mobile workspace experience', () => {
    it('surfaces cockpit mode as a synced account setting switch', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const item = screen.findRowByTitle('en:settingsSession.mobileWorkspaceExperience.title');
        const switchElement = item?.props?.rightElement;

        expect(item).toBeTruthy();
        expect(screen.findGroup('en:settingsSession.rootGroups.mobileLayout.title')?.findAll(node => node === item)).toHaveLength(1);
        expect(screen.findAllByType(DropdownMenu).some(
            (node) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-mobileWorkspaceExperience-trigger',
        )).toBe(false);
        expect(switchElement?.type).toBe(Switch);
        expect(switchElement?.props?.value).toBe(true);

        await act(async () => {
            switchElement!.props.onValueChange(false);
        });

        await vi.waitFor(() => expect(storage.getState().settings.mobileWorkspaceExperienceV1).toBe('classic'));
        await vi.waitFor(() => expect(account?.persistedSettings.mobileWorkspaceExperienceV1).toBe('classic'));
        expect(storage.getState().localSettings).toEqual(localSettingsParse({ uiMultiPanePanelsEnabled: true }));
    });
});
