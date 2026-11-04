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
import { settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import {
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


installDisconnectedServerSocketBoundary();
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { Item } = await import('@/components/ui/lists/Item');
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

async function renderSettingsView(element: React.ReactElement, options?: Parameters<typeof renderBaseSettingsView>[1]) {
    if (!account) {
        const fixture = Object.fromEntries(Object.entries(settingsDefaults).map(([key, value]) => [
            key, readSessionSettingFixture(key) ?? value,
        ]));
        const features = createRootLayoutFeaturesResponse();
        for (const featureId of ['sessions', 'sessions.folders'] as const) {
            if (!tryWriteServerEnabledBitInPlace(features, featureId, true)) throw new Error(`Missing fixture feature ${featureId}`);
        }
        account = await createSecretSettingsTestHarness({ features, settings: settingsParse({ ...fixture,
            featureToggles: { 'sessions.folders': true }, experiments: true,
        }), sharedEnabled: false });
        storage.setState({ localSettings: localSettingsParse({ sessionsRightPaneDefaultOpen: false, uiMultiPanePanelsEnabled: true }) });
    }
    const credentials = account.credentials;
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return renderBaseSettingsView(element, { ...options, wrapper });
}

async function expectPersistedSettings(delta: Partial<Settings>) {
    await vi.waitFor(() => expect(storage.getState().settings).toMatchObject(delta));
    await vi.waitFor(() => expect(account?.persistedSettings, JSON.stringify(account?.settingsWrites.map(write => {
        const record = write as { expectedVersion?: number; content?: { t?: string; v?: Record<string, unknown> } };
        return { expectedVersion: record.expectedVersion, layout: record.content?.v?.sessionListLayoutV1,
            attention: record.content?.v?.sessionListAttentionPlacementV1 };
    }))).toMatchObject(delta));
}

let translationPrefix = 'en';

await vi.hoisted(async () => {
    const { installSessionSettingsEntryModuleMocks } = await import('./sessionSettingsEntryTestHelpers');
    installSessionSettingsEntryModuleMocks({
        textModule: async () => {
            const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
            return createTextModuleMock({
                translate: (key: string) => `${translationPrefix}:${key}`,
                translateLoose: (key: string) => `${translationPrefix}:${key}`,
                getPreferredLanguage: () => translationPrefix,
            });
        },
    });
});

/** The Account settings this screen reads, with the setter each test observes; `undefined` when not fixed here. */
function readSessionSettingFixture(key: string): unknown {
    if (key === 'sessionTagsEnabled') return true;
    if (key === 'sessionListDensity') return 'narrow';
    if (key === 'sessionListIdentityDisplay') return 'agentLogo';
    if (key === 'sessionHeaderIdentityDisplay') return 'avatar';
    if (key === 'sessionListActiveColorModeV1') return 'activityAndAttention';
    if (key === 'sessionListAttentionPlacementV1') return 'both';
    if (key === 'sessionListLayoutV1') return 'projects';
    if (key === 'workspaceFaviconsEnabled') return true;
    if (key === 'workspaceMachineSubtitlesEnabled') return true;
    if (key === 'hideInactiveSessions') return false;
    if (key === 'agentInputActionBarLayout') return 'auto';
    if (key === 'agentInputChipDensity') return 'auto';
    if (key === 'alwaysShowContextSize') return false;
    if (key === 'sessionUseTmux') return false;
    if (key === 'sessionTmuxSessionName') return 'happy';
    if (key === 'sessionTmuxIsolated') return true;
    if (key === 'sessionTmuxTmpDir') return null;
    if (key === 'sessionMessageSendMode') return 'agent_queue';
    if (key === 'sessionBusySteerSendPolicy') return 'steer_immediately';
    if (key === 'agentInputEnterToSend') return true;
    if (key === 'agentInputHistoryScope') return 'perSession';
    if (key === 'terminalConnectLegacySecretExportEnabled') return false;
    if (key === 'sessionReplayEnabled') return false;
    if (key === 'sessionReplayStrategy') return 'recent_messages';
    if (key === 'sessionReplayRecentMessagesCount') return 250;
    if (key === 'sessionReplayMaxSeedChars') return 120000;
    if (key === 'sessionReplaySummaryRunnerV1') return null;
    if (key === 'usageLimitRecoverySettingsV1') return { v: 1, mode: 'ask' };
    return undefined;
}


afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
    translationPrefix = 'en';
});

describe('Session settings session list density', () => {
    it('persists all background-work attention choices through the declared setting', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const screen = await renderSettingsView(React.createElement(mod.default));
        const dropdown = () => screen.findAllByType(DropdownMenu).find(node =>
            node.props.itemTrigger?.itemProps?.testID === 'settings-session-backgroundWorkAttentionMode-trigger');
        expect(dropdown()).toBeTruthy();
        expect(dropdown()!.props.selectedId).toBe('keepWorking');
        expect(dropdown()!.props.items.map((item: { id: string }) => item.id)).toEqual(['keepWorking', 'keepWorkingUnread', 'showUnread']);
        for (const value of ['keepWorkingUnread', 'showUnread', 'keepWorking'] as const) {
            await act(async () => { dropdown()!.props.onSelect(value); });
            await expectPersistedSettings({ sessionListBackgroundWorkAttentionModeV1: value });
            expect(dropdown()!.props.selectedId).toBe(value);
        }
    });

    it('defaults to the narrow density option and updates only the canonical density setting', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType(DropdownMenu);
        const densityTiles = screen.findByProps({ testID: 'settings-session-sessionListDensity' }).props.rightElement;
        const headerIdentityDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionHeaderIdentityDisplay-trigger');
        const orderingDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListOrderingMode-trigger');
        const folderDisplayDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionFolderViewMode-trigger');
        const folderSortDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListFolderSortMode-trigger');
        expect(densityTiles.props.variant).toBe('visual');
        expect(headerIdentityDropdown).toBeTruthy();
        expect(densityTiles.props.value).toBe('narrow');
        // P5-R05/U2: one layout scalar replaces ordering, grouping and folder-sort controls.
        expect(orderingDropdown).toBeUndefined();
        expect(folderDisplayDropdown).toBeUndefined();
        expect(folderSortDropdown).toBeUndefined();

        expect(densityTiles.props.options.map((option: any) => option.id)).toEqual(['detailed', 'cozy', 'narrow']);

        await act(async () => {
            densityTiles.props.onChange('cozy');
        });

        await expectPersistedSettings({ sessionListDensity: 'cozy' });

        await act(async () => {
            headerIdentityDropdown!.props.onSelect('agentLogo');
        });
        await expectPersistedSettings({ sessionHeaderIdentityDisplay: 'agentLogo' });

        expect(storage.getState().settings.sessionListLayoutV1).toBe('projects');
    });

    it('refreshes density and canonical layout labels when the language changes and the screen rerenders', async () => {
        translationPrefix = 'en';
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const readDropdowns = () => {
            const dropdowns = screen.findAllByType(DropdownMenu);
            return {
                density: screen.findByProps({ testID: 'settings-session-sessionListDensity' }).props.rightElement,
                layout: screen.findByProps({ testID: 'settings-session-sessionListLayout' }).props.rightElement,
            };
        };

        expect(readDropdowns().density?.props?.options?.map((option: { title: string }) => option.title)).toEqual([
            'en:settingsAppearance.sessionListDensity.detailed',
            'en:settingsAppearance.sessionListDensity.cozy',
            'en:settingsAppearance.sessionListDensity.narrow',
        ]);
        expect(readDropdowns().layout.props.options.map((item: { title: string }) => item.title)).toEqual([
            'en:settingsSession.sessionList.layoutProjectsTitle',
            'en:settingsSession.sessionList.layoutRecentActivityTitle',
        ]);
        const preview = await renderSettingsView(readDropdowns().density);
        expect(preview.getTextContent()).toContain('en:settingsSessionPages.preview.userMessage');

        translationPrefix = 'fr';
        const { sync } = await import('@/sync/sync');
        await act(async () => {
            sync.applySettings({ preferredLanguage: 'fr' }, { expectedSettingsScope: account!.scope });
        });
        await expectPersistedSettings({ preferredLanguage: 'fr' });
        await act(async () => {
            await preview.update(readDropdowns().density);
        });
        expect(preview.getTextContent()).toContain('fr:settingsSessionPages.preview.userMessage');
        expect(preview.getTextContent()).not.toContain('en:settingsSessionPages.preview.userMessage');

        expect(readDropdowns().density?.props?.options?.map((option: { title: string }) => option.title)).toEqual([
            'fr:settingsAppearance.sessionListDensity.detailed',
            'fr:settingsAppearance.sessionListDensity.cozy',
            'fr:settingsAppearance.sessionListDensity.narrow',
        ]);
        expect(readDropdowns().layout.props.options.map((item: { title: string }) => item.title)).toEqual([
            'fr:settingsSession.sessionList.layoutProjectsTitle',
            'fr:settingsSession.sessionList.layoutRecentActivityTitle',
        ]);
    });

    it('has no retired folder-sort control and does not rewrite organization on mount', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType(DropdownMenu);
        const folderSortDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListFolderSortMode-trigger');
        expect(folderSortDropdown).toBeUndefined();
        expect(account?.settingsWrites).toEqual([]);
    });

    it('retains favicons and Machine names without retired animation, indicator or path controls', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType(DropdownMenu);
        expect(screen.findAllByType(Item).some(node =>
            node.props.testID === 'settings-session-workingStatusAnimatedText-item')).toBe(false);
        expect(dropdowns.find(node => node.props.itemTrigger?.itemProps?.testID ===
            'settings-session-workingIndicator-trigger')).toBeUndefined();
        expect(account?.settingsWrites).toEqual([]);
        const workspaceNameDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-workspacePathDisplay-trigger');
        expect(workspaceNameDropdown).toBeUndefined();

        const faviconItem = screen.findAllByType(Item).find((node: any) =>
            node.props?.title === 'en:settingsSession.sessionList.workspaceFaviconsTitle');
        expect(faviconItem).toBeTruthy();
        await act(async () => {
            faviconItem!.props.onPress();
        });
        await expectPersistedSettings({ workspaceFaviconsEnabled: false });

        const machineSubtitleItem = screen.findAllByType(Item).find((node: any) =>
            node.props?.title === 'en:settingsSession.sessionList.workspaceMachineSubtitlesTitle');
        expect(machineSubtitleItem).toBeTruthy();
        await act(async () => {
            machineSubtitleItem!.props.onPress();
        });
        await expectPersistedSettings({ workspaceMachineSubtitlesEnabled: false });



    });

    it('offers the list menu\'s leading marks and places Show where it runs beside them', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const identityDropdown = screen.findAllByType(DropdownMenu).find((node: any) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListIdentityDisplay-trigger');
        expect(identityDropdown?.props?.selectedId).toBe('identity:agentLogo');
        expect(identityDropdown?.props?.items?.map((item: any) => item.id)).toEqual([
            'identity:auto', 'identity:agentLogo', 'identity:project', 'identity:projectWithAgent',
            'identity:agentWithTrailingProject', 'identity:avatar', 'identity:none',
        ]);
        await act(async () => { identityDropdown!.props.onSelect('identity:projectWithAgent'); });
        await expectPersistedSettings({ sessionListIdentityDisplay: 'projectWithAgent' });

        const rowContext = screen.findAllByType(Item).find((node: any) => node.props?.testID === 'settings-session-rowContext-item');
        expect(rowContext?.props.rightElement.props.value).toBe(true);
        await act(async () => { rowContext!.props.onPress(); });
        await expectPersistedSettings({ sessionListRowContextV1: false });

        const statusWords = screen.findAllByType(Item).find((node: any) => node.props?.testID === 'settings-session-statusWords-item');
        expect(statusWords?.props.rightElement.props.value).toBe(false);
        await act(async () => { statusWords!.props.onPress(); });
        await expectPersistedSettings({ sessionListStatusWords: true });
    });

    it('exposes the session list active color mode selector', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType(DropdownMenu);
        const activeColorDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListActiveColorMode-trigger');
        expect(activeColorDropdown).toBeTruthy();
        expect(activeColorDropdown?.props?.selectedId).toBe('activityAndAttention');
        expect(activeColorDropdown?.props?.itemTrigger?.title).toBe('en:settingsSession.sessionList.activeColorTitle');
        expect(activeColorDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['activityAndAttention', 'attentionOnly', 'allActive']);

        await act(async () => {
            activeColorDropdown!.props.onSelect('attentionOnly');
        });

        await expectPersistedSettings({ sessionListActiveColorModeV1: 'attentionOnly' });
    });

    it('chooses where Needs you and Working sit with one set of visual tiles', async () => {
        const { SelectionTiles } = await import('@/components/ui/forms/SelectionTiles');
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        expect(screen.findAllByType(DropdownMenu).some((node: any) => /attentionPromotionMode|workingPlacementMode/
            .test(String(node.props?.itemTrigger?.itemProps?.testID)))).toBe(false);
        const placement = screen.findAllByType(SelectionTiles).find((node: any) =>
            node.props.testIdPrefix === 'settings-session-attentionPromotionMode');
        expect(placement?.props.variant).toBe('visual');
        expect(placement?.props.value).toBe('attention:both');
        expect(placement?.props.options.map((option: any) => option.id)).toEqual(['attention:both', 'attention:top', 'attention:inPlace']);

        await act(async () => { placement!.props.onChange('attention:inPlace'); });

        await expectPersistedSettings({ sessionListAttentionPlacementV1: 'inPlace' });
    });

    it('offers all layout previews as visible choices and applies the canonical atomic settings delta', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const layoutRow = screen.findByTestId('settings-session-sessionListLayout');
        expect(layoutRow).not.toBeNull();
        const picker = screen;
        const projects = picker.findByTestId('settings-session-sessionListLayout:layout:projects');
        const recent = picker.findByTestId('settings-session-sessionListLayout:layout:recent_activity');
        const activeInactive = picker.findByTestId('settings-session-sessionListLayout:layout:active_inactive');
        expect(projects?.props.accessibilityRole).toBe('radio');
        expect(recent?.props.accessibilityRole).toBe('radio');
        expect(activeInactive).toBeNull();
        expect(projects?.props['aria-checked']).toBe(true);
        expect(recent?.props['aria-checked']).toBe(false);

        await picker.pressByTestIdAsync('settings-session-sessionListLayout:layout:recent_activity');

        await expectPersistedSettings({
            sessionListLayoutV1: 'recent_activity',
        });
        expect(account?.settingsWrites).toHaveLength(1);
        expect(account?.settingsWrites[0]).toMatchObject({ expectedVersion: 1, content: { t: 'plain', v: {
            sessionListLayoutV1: 'recent_activity',
        } } });
    });
});
