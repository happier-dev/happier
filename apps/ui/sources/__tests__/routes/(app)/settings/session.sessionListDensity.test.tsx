import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView as renderBaseSettingsView, standardCleanup } from '@/dev/testkit';
import 'fake-indexeddb/auto';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


installDisconnectedServerSocketBoundary();
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

async function renderSettingsView(element: React.ReactElement, options?: Parameters<typeof renderBaseSettingsView>[1]) {
    if (!account) {
        const fixture = Object.fromEntries(Object.entries(settingsDefaults).map(([key, value]) => [
            key, readSessionSettingFixture(key) ?? value,
        ]));
        account = await createSecretSettingsTestHarness({ settings: settingsParse(fixture), sharedEnabled: false });
        storage.setState({ localSettings: localSettingsParse({ sessionsRightPaneDefaultOpen: false, uiMultiPanePanelsEnabled: true }) });
    }
    const credentials = account.credentials;
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return renderBaseSettingsView(element, { ...options, wrapper });
}

async function expectPersistedSettings(delta: Partial<Settings>) {
    await vi.waitFor(() => expect(storage.getState().settings).toMatchObject(delta));
    await vi.waitFor(() => expect(account?.persistedSettings).toMatchObject(delta));
}

let translationPrefix = 'en';
let sessionListOrderingModeSetting: 'custom' | 'created' | 'updated' = 'custom';
let sessionListFolderSortModeSetting: 'foldersFirst' | 'mixed' = 'foldersFirst';

// Folder display and folder sort are offered only while the server enables session folders.
const foldersEnabled = (featureId: string) => featureId === 'sessions.folders';

installSessionSettingsEntryModuleMocks({
    featureEnabled: foldersEnabled,
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

/** The Account settings this screen reads, with the setter each test observes; `undefined` when not fixed here. */
function readSessionSettingFixture(key: string): unknown {
    if (key === 'sessionTagsEnabled') return true;
    if (key === 'sessionListDensity') return 'narrow';
    if (key === 'sessionListIdentityDisplay') return 'agentLogo';
    if (key === 'sessionHeaderIdentityDisplay') return 'avatar';
    if (key === 'sessionListActiveColorModeV1') return 'activityAndAttention';
    if (key === 'sessionListAttentionPromotionModeV1') return 'global';
    if (key === 'sessionListWorkingPlacementModeV1') return 'off';
    if (key === 'sessionListSeparateBackgroundWorkV1') return false;
    if (key === 'sessionListOrderingModeV1') return sessionListOrderingModeSetting;
    if (key === 'sessionListFolderSortModeV1') return sessionListFolderSortModeSetting;
    if (key === 'sessionFolderViewModeV1') return 'tree';
    if (key === 'workspacePathDisplayModeV1') return 'name';
    if (key === 'workspaceFaviconsEnabled') return true;
    if (key === 'workspaceMachineSubtitlesEnabled') return true;
    if (key === 'sessionListNarrowWorkingIndicatorStyle') return 'spinner';
    if (key === 'hideInactiveSessions') return false;
    if (key === 'sessionListSectionModeV1') return 'activity';
    if (key === 'sessionListActiveGroupingV1') return 'project';
    if (key === 'sessionListInactiveGroupingV1') return 'date';
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


beforeEach(() => {
    sessionSettingsEntryState.options.featureEnabled = foldersEnabled;
});

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
    translationPrefix = 'en';
    sessionListOrderingModeSetting = 'custom';
    sessionListFolderSortModeSetting = 'foldersFirst';
});

describe('Session settings session list density', () => {
    it('defaults to the narrow density option and updates only the canonical density setting', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const densityTiles = screen.findByProps({ testID: 'settings-session-sessionListDensity' }).props.rightElement;
        const headerIdentityDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionHeaderIdentityDisplay-trigger');
        const orderingDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListOrderingMode-trigger');
        const folderDisplayDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionFolderViewMode-trigger');
        const folderSortDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListFolderSortMode-trigger');
        expect(densityTiles.props.variant).toBe('visual');
        expect(headerIdentityDropdown).toBeTruthy();
        expect(densityTiles.props.value).toBe('narrow');
        expect(orderingDropdown).toBeTruthy();
        expect(orderingDropdown?.props?.selectedId).toBe('ordering:custom');
        expect(folderDisplayDropdown).toBeTruthy();
        expect(folderDisplayDropdown?.props?.selectedId).toBe('folderDisplay:tree');
        expect(folderSortDropdown).toBeTruthy();
        expect(folderSortDropdown?.props?.selectedId).toBe('folderSort:foldersFirst');

        expect(densityTiles.props.options.map((option: any) => option.id)).toEqual(['detailed', 'cozy', 'narrow']);
        expect(orderingDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['ordering:custom', 'ordering:updated', 'ordering:created']);
        expect(folderDisplayDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['folderDisplay:off', 'folderDisplay:tree']);
        expect(folderSortDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['folderSort:foldersFirst', 'folderSort:mixed']);

        await act(async () => {
            densityTiles.props.onChange('cozy');
        });

        await expectPersistedSettings({ sessionListDensity: 'cozy' });

        await act(async () => {
            headerIdentityDropdown!.props.onSelect('agentLogo');
        });
        await expectPersistedSettings({ sessionHeaderIdentityDisplay: 'agentLogo' });

        await act(async () => {
            orderingDropdown!.props.onSelect('ordering:updated');
        });

        await expectPersistedSettings({ sessionListOrderingModeV1: 'updated' });

        await act(async () => {
            folderDisplayDropdown!.props.onSelect('folderDisplay:off');
        });

        await expectPersistedSettings({ sessionFolderViewModeV1: 'off' });

        await act(async () => {
            folderSortDropdown!.props.onSelect('folderSort:mixed');
        });

        await expectPersistedSettings({ sessionListFolderSortModeV1: 'mixed' });
    });

    it('refreshes the density, ordering, and grouping dropdown labels when the language changes and the screen rerenders', async () => {
        translationPrefix = 'en';
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const readDropdowns = () => {
            const dropdowns = screen.findAllByType('DropdownMenu' as any);
            return {
                density: screen.findByProps({ testID: 'settings-session-sessionListDensity' }).props.rightElement,
                ordering: dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListOrderingMode-trigger'),
                folderSort: dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListFolderSortMode-trigger'),
                grouping: dropdowns.find((node: any) => String(node.props?.itemTrigger?.title).endsWith('settingsFeatures.sessionListActiveGrouping')),
            };
        };

        expect(readDropdowns().density?.props?.options?.map((option: { title: string }) => option.title)).toEqual([
            'en:settingsAppearance.sessionListDensity.detailed',
            'en:settingsAppearance.sessionListDensity.cozy',
            'en:settingsAppearance.sessionListDensity.narrow',
        ]);
        expect(readDropdowns().ordering?.props?.items?.map((item: { title: string }) => item.title)).toEqual([
            'en:settingsSession.sessionList.orderingOptions.custom',
            'en:settingsSession.sessionList.orderingOptions.updated',
            'en:settingsSession.sessionList.orderingOptions.created',
        ]);
        expect(readDropdowns().folderSort?.props?.items?.map((item: { title: string }) => item.title)).toEqual([
            'en:settingsSession.sessionList.folderSortModeFoldersFirstTitle',
            'en:settingsSession.sessionList.folderSortModeMixedTitle',
        ]);
        expect(readDropdowns().grouping?.props?.items?.map((item: { title: string }) => item.title)).toEqual([
            'en:settingsFeatures.sessionListGrouping.projectTitle',
            'en:settingsFeatures.sessionListGrouping.dateTitle',
        ]);
        const preview = await renderSettingsView(readDropdowns().density);
        expect(preview.getTextContent()).toContain('en:settingsSessionPages.preview.userMessage');

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(React.createElement(SessionSettingsScreen));
        });
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
        expect(readDropdowns().ordering?.props?.items?.map((item: { title: string }) => item.title)).toEqual([
            'fr:settingsSession.sessionList.orderingOptions.custom',
            'fr:settingsSession.sessionList.orderingOptions.updated',
            'fr:settingsSession.sessionList.orderingOptions.created',
        ]);
        expect(readDropdowns().folderSort?.props?.items?.map((item: { title: string }) => item.title)).toEqual([
            'fr:settingsSession.sessionList.folderSortModeFoldersFirstTitle',
            'fr:settingsSession.sessionList.folderSortModeMixedTitle',
        ]);
        expect(readDropdowns().grouping?.props?.items?.map((item: { title: string }) => item.title)).toEqual([
            'fr:settingsFeatures.sessionListGrouping.projectTitle',
            'fr:settingsFeatures.sessionListGrouping.dateTitle',
        ]);
    });

    it('shows folders-first as the effective folder sort mode while mixed is dormant in date ordering mode', async () => {
        sessionListOrderingModeSetting = 'updated';
        sessionListFolderSortModeSetting = 'mixed';

        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const folderSortDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListFolderSortMode-trigger');
        expect(folderSortDropdown?.props?.selectedId).toBe('folderSort:foldersFirst');

        const mixedItem = folderSortDropdown?.props?.items?.find((item: any) => item.id === 'folderSort:mixed');
        expect(mixedItem?.disabled).toBe(true);
        expect(mixedItem?.subtitle).toBe('en:settingsSession.sessionList.folderSortModeMixedDisabledInDateModeSubtitle');

        await act(async () => {
            folderSortDropdown!.props.onSelect('folderSort:mixed');
        });
        expect(account?.settingsWrites).toEqual([]);
    });

    it('exposes workspace name and favicon controls in the session list settings', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const workspaceNameDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-workspacePathDisplay-trigger');
        expect(workspaceNameDropdown).toBeTruthy();
        expect(workspaceNameDropdown?.props?.selectedId).toBe('name');
        expect(workspaceNameDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['name', 'path']);

        await act(async () => {
            workspaceNameDropdown!.props.onSelect('path');
        });
        await expectPersistedSettings({ workspacePathDisplayModeV1: 'path' });

        const faviconItem = screen.findAllByType('Item' as any).find((node: any) =>
            node.props?.title === 'en:settingsSession.sessionList.workspaceFaviconsTitle');
        expect(faviconItem).toBeTruthy();
        await act(async () => {
            faviconItem!.props.onPress();
        });
        await expectPersistedSettings({ workspaceFaviconsEnabled: false });

        const machineSubtitleItem = screen.findAllByType('Item' as any).find((node: any) =>
            node.props?.title === 'en:settingsSession.sessionList.workspaceMachineSubtitlesTitle');
        expect(machineSubtitleItem).toBeTruthy();
        await act(async () => {
            machineSubtitleItem!.props.onPress();
        });
        await expectPersistedSettings({ workspaceMachineSubtitlesEnabled: false });

        const workingIndicatorDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-workingIndicator-trigger');
        expect(workingIndicatorDropdown).toBeTruthy();
        expect(workingIndicatorDropdown?.props?.selectedId).toBe('spinner');
        expect(workingIndicatorDropdown?.props?.itemTrigger?.title).toBe('en:settingsSession.sessionList.workingIndicatorTitle');

        await act(async () => {
            workingIndicatorDropdown!.props.onSelect('pulse');
        });
        await expectPersistedSettings({ sessionListNarrowWorkingIndicatorStyle: 'pulse' });
    });

    it('exposes the session list identity display selector near density', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const identityDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-sessionListIdentityDisplay-trigger');
        expect(identityDropdown).toBeTruthy();
        expect(identityDropdown?.props?.selectedId).toBe('agentLogo');
        expect(identityDropdown?.props?.itemTrigger?.title).toBe('en:settingsSession.sessionList.identityDisplayTitle');
        expect(identityDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['avatar', 'agentLogo', 'none']);
        expect(identityDropdown?.props?.items?.[1]?.title).toBe('en:settingsSession.sessionList.identityDisplayAgentLogoTitle');

        await act(async () => {
            identityDropdown!.props.onSelect('agentLogo');
        });

        await expectPersistedSettings({ sessionListIdentityDisplay: 'agentLogo' });
    });

    it('exposes the session list active color mode selector', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
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

    it('exposes the session list attention promotion selector', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const attentionPromotionDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-attentionPromotionMode-trigger');
        expect(attentionPromotionDropdown).toBeTruthy();
        expect(attentionPromotionDropdown?.props?.selectedId).toBe('attention:global');
        expect(attentionPromotionDropdown?.props?.itemTrigger?.title).toBe('en:settingsSession.sessionList.attentionPromotionModeTitle');
        expect(attentionPromotionDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['attention:off', 'attention:global', 'attention:withinGroups']);

        await act(async () => {
            attentionPromotionDropdown!.props.onSelect('attention:withinGroups');
        });

        await expectPersistedSettings({ sessionListAttentionPromotionModeV1: 'withinGroups' });
    });

    it('exposes the session list working placement selector', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const workingPlacementDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-workingPlacementMode-trigger');
        expect(workingPlacementDropdown).toBeTruthy();
        expect(workingPlacementDropdown?.props?.selectedId).toBe('working:off');
        expect(workingPlacementDropdown?.props?.itemTrigger?.title).toBe('en:settingsSession.sessionList.workingPlacementModeTitle');
        expect(workingPlacementDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['working:off', 'working:global', 'working:withinGroups']);

        await act(async () => {
            workingPlacementDropdown!.props.onSelect('working:global');
        });

        await expectPersistedSettings({ sessionListWorkingPlacementModeV1: 'global' });
    });

    it('offers all layout previews as visible choices and applies the canonical atomic settings delta', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const layoutRow = screen.findByTestId('settings-session-sessionListLayout');
        expect(layoutRow).not.toBeNull();
        // The route harness keeps Item opaque. Mount its real picker to exercise
        // the visible radio controls, not a callback on a mocked menu.
        const picker = await renderSettingsView(layoutRow!.props.rightElement);
        const projects = picker.findByTestId('settings-session-sessionListLayout:layout:projects');
        const recent = picker.findByTestId('settings-session-sessionListLayout:layout:recent_activity');
        const activeInactive = picker.findByTestId('settings-session-sessionListLayout:layout:active_inactive');
        expect(projects?.props.accessibilityRole).toBe('radio');
        expect(recent?.props.accessibilityRole).toBe('radio');
        expect(activeInactive?.props['aria-checked']).toBe(true);
        expect(recent?.props['aria-checked']).toBe(false);

        await picker.pressByTestIdAsync('settings-session-sessionListLayout:layout:recent_activity');

        await expectPersistedSettings({
            sessionListSectionModeV1: 'single',
            sessionListActiveGroupingV1: 'date',
        });
        expect(account?.settingsWrites).toHaveLength(1);
        expect(account?.settingsWrites[0]).toMatchObject({ expectedVersion: 1, content: { t: 'plain', v: {
            sessionListSectionModeV1: 'single', sessionListActiveGroupingV1: 'date',
        } } });
    });
});
