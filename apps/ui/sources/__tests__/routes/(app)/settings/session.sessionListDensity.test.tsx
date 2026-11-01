import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setSessionListDensity = vi.fn();
const setWorkspacePathDisplayMode = vi.fn();
const setWorkspaceFaviconsEnabled = vi.fn();
const setWorkspaceMachineSubtitlesEnabled = vi.fn();
const setSessionListIdentityDisplay = vi.fn();
const setSessionListActiveColorMode = vi.fn();
const setSessionListAttentionPromotionMode = vi.fn();
const setSessionListBackgroundWorkAttentionMode = vi.fn();
const setSessionListWorkingPlacementMode = vi.fn();
const setSessionListSeparateBackgroundWork = vi.fn();
const setSessionListFolderSortMode = vi.fn();
const setSessionListSectionMode = vi.fn();
const setSessionListOrderingMode = vi.fn();

installSessionSettingsEntryModuleMocks({
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: ((key: string) => {
                    if (key === 'sessionTagsEnabled') return [true, vi.fn()];
                    if (key === 'sessionListDensity') return ['narrow', setSessionListDensity];
                    if (key === 'sessionListIdentityDisplay') return ['agentLogo', setSessionListIdentityDisplay];
                    if (key === 'sessionListActiveColorModeV1') return ['activityAndAttention', setSessionListActiveColorMode];
                    if (key === 'sessionListAttentionPromotionModeV1') return ['off', setSessionListAttentionPromotionMode];
                    if (key === 'sessionListBackgroundWorkAttentionModeV1') return ['keepWorking', setSessionListBackgroundWorkAttentionMode];
                    if (key === 'sessionListWorkingPlacementModeV1') return ['off', setSessionListWorkingPlacementMode];
                    if (key === 'sessionListSeparateBackgroundWork') return [false, setSessionListSeparateBackgroundWork];
                    if (key === 'sessionListOrderingModeV1') return ['custom', setSessionListOrderingMode];
                    if (key === 'workspacePathDisplayModeV1') return ['name', setWorkspacePathDisplayMode];
                    if (key === 'workspaceFaviconsEnabled') return [true, setWorkspaceFaviconsEnabled];
                    if (key === 'workspaceMachineSubtitlesEnabled') return [true, setWorkspaceMachineSubtitlesEnabled];
                    if (key === 'sessionListNarrowWorkingIndicatorStyle') return ['spinner', vi.fn()];
                    if (key === 'hideInactiveSessions') return [false, vi.fn()];
                    if (key === 'sessionListSectionModeV1') return ['activity', setSessionListSectionMode];
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
                    if (key === 'agentInputHistoryScope') return ['perSession', vi.fn()];
                    if (key === 'terminalConnectLegacySecretExportEnabled') return [false, vi.fn()];
                    if (key === 'sessionReplayEnabled') return [false, vi.fn()];
                    if (key === 'sessionReplayStrategy') return ['recent_messages', vi.fn()];
                    if (key === 'sessionReplayRecentMessagesCount') return [250, vi.fn()];
                    if (key === 'sessionReplayMaxSeedChars') return [120000, vi.fn()];
                    if (key === 'sessionReplaySummaryRunnerV1') return [null, vi.fn()];
                    return [null, vi.fn()];
                }) as any,
                useLocalSettingMutable: ((key: string) => {
                    if (key === 'sessionsRightPaneDefaultOpen') return [false, vi.fn()];
                    if (key === 'uiMultiPanePanelsEnabled') return [true, vi.fn()];
                    if (key === 'sessionListFolderSortModeV1') return ['foldersFirst', setSessionListFolderSortMode];
                    return [null, vi.fn()];
                }) as any,
            },
        });
    },
});

afterEach(() => {
    standardCleanup();
    setSessionListDensity.mockClear();
    setWorkspacePathDisplayMode.mockClear();
    setWorkspaceFaviconsEnabled.mockClear();
    setWorkspaceMachineSubtitlesEnabled.mockClear();
    setSessionListIdentityDisplay.mockClear();
    setSessionListActiveColorMode.mockClear();
    setSessionListAttentionPromotionMode.mockClear();
    setSessionListBackgroundWorkAttentionMode.mockClear();
    setSessionListWorkingPlacementMode.mockClear();
    setSessionListSeparateBackgroundWork.mockClear();
    setSessionListFolderSortMode.mockClear();
    setSessionListSectionMode.mockClear();
    setSessionListOrderingMode.mockClear();
    resetSessionSettingsEntryState();
});

describe('Session settings session list density', () => {
    it('lets unread replies during background work use each attention policy', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const screen = await renderSettingsView(React.createElement(mod.default));
        const dropdown = screen.findAllByType('DropdownMenu' as any).find((node) =>
            node.props?.itemTrigger?.itemProps?.testID === 'settings-session-backgroundWorkAttentionMode-trigger');

        expect(dropdown).toBeTruthy();
        expect(dropdown!.props.selectedId).toBe('keepWorking');
        expect(dropdown!.props.items.map((item: { id: string }) => item.id)).toEqual(['keepWorking', 'keepWorkingUnread', 'showUnread']);
        await act(async () => dropdown!.props.onSelect('keepWorkingUnread'));
        expect(setSessionListBackgroundWorkAttentionMode).toHaveBeenLastCalledWith('keepWorkingUnread');
        await act(async () => dropdown!.props.onSelect('showUnread'));
        expect(setSessionListBackgroundWorkAttentionMode).toHaveBeenLastCalledWith('showUnread');
        await act(async () => dropdown!.props.onSelect('keepWorking'));
        expect(setSessionListBackgroundWorkAttentionMode).toHaveBeenLastCalledWith('keepWorking');
    });

    it('defaults to the narrow density option and updates only the canonical density setting', async () => {
        setSessionListDensity.mockClear();
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const densityDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.sessionListDensity.title');
        expect(densityDropdown).toBeTruthy();
        expect(densityDropdown?.props?.selectedId).toBe('narrow');

        const itemIds = densityDropdown?.props?.items?.map((item: any) => item.id) ?? [];
        expect(itemIds).toEqual(['detailed', 'cozy', 'narrow']);

        await act(async () => {
            densityDropdown!.props.onSelect('cozy');
        });

        expect(setSessionListDensity).toHaveBeenCalledWith('cozy');
    });

    it('exposes workspace name and favicon controls in the session list settings', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const workspaceNameDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.workspacePathDisplayTitle');
        expect(workspaceNameDropdown).toBeTruthy();
        expect(workspaceNameDropdown?.props?.selectedId).toBe('name');
        expect(workspaceNameDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['name', 'path']);

        await act(async () => {
            workspaceNameDropdown!.props.onSelect('path');
        });
        expect(setWorkspacePathDisplayMode).toHaveBeenCalledWith('path');

        const faviconItem = screen.findAllByType('Item' as any).find((node: any) =>
            node.props?.title === 'settingsSession.sessionList.workspaceFaviconsTitle');
        expect(faviconItem).toBeTruthy();
        await act(async () => {
            faviconItem!.props.onPress();
        });
        expect(setWorkspaceFaviconsEnabled).toHaveBeenCalledWith(false);

        const machineSubtitleItem = screen.findAllByType('Item' as any).find((node: any) =>
            node.props?.title === 'settingsSession.sessionList.workspaceMachineSubtitlesTitle');
        expect(machineSubtitleItem).toBeTruthy();
        await act(async () => {
            machineSubtitleItem!.props.onPress();
        });
        expect(setWorkspaceMachineSubtitlesEnabled).toHaveBeenCalledWith(false);
    });

    it('exposes the session list identity display selector near density', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const identityDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.identityDisplayTitle');
        expect(identityDropdown).toBeTruthy();
        expect(identityDropdown?.props?.selectedId).toBe('agentLogo');
        expect(identityDropdown?.props?.itemTrigger?.itemProps?.testID).toBe('settings-session-sessionListIdentityDisplay-trigger');
        expect(identityDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['avatar', 'agentLogo', 'none']);
        expect(identityDropdown?.props?.items?.[1]?.title).toBe('settingsSession.sessionList.identityDisplayAgentLogoTitle');

        await act(async () => {
            identityDropdown!.props.onSelect('agentLogo');
        });

        expect(setSessionListIdentityDisplay).toHaveBeenCalledWith('agentLogo');
    });

    it('exposes the session list active color mode selector', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const activeColorDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.activeColorTitle');
        expect(activeColorDropdown).toBeTruthy();
        expect(activeColorDropdown?.props?.selectedId).toBe('activityAndAttention');
        expect(activeColorDropdown?.props?.itemTrigger?.itemProps?.testID).toBe('settings-session-sessionListActiveColorMode-trigger');
        expect(activeColorDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['activityAndAttention', 'attentionOnly', 'allActive']);

        await act(async () => {
            activeColorDropdown!.props.onSelect('attentionOnly');
        });

        expect(setSessionListActiveColorMode).toHaveBeenCalledWith('attentionOnly');
    });

    it('exposes the session list attention placement selector', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const attentionDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.attentionPromotionModeTitle');
        expect(attentionDropdown).toBeTruthy();
        expect(attentionDropdown?.props?.selectedId).toBe('off');
        expect(attentionDropdown?.props?.itemTrigger?.itemProps?.testID).toBe('settings-session-attentionPromotionMode-trigger');
        expect(attentionDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['off', 'global', 'withinGroups']);

        await act(async () => {
            attentionDropdown!.props.onSelect('withinGroups');
        });

        expect(setSessionListAttentionPromotionMode).toHaveBeenCalledWith('withinGroups');
    });

    it('exposes the session list working placement selector', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const workingPlacementDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.workingPlacementModeTitle');
        expect(workingPlacementDropdown).toBeTruthy();
        expect(workingPlacementDropdown?.props?.selectedId).toBe('off');
        expect(workingPlacementDropdown?.props?.itemTrigger?.itemProps?.testID).toBe('settings-session-workingPlacementMode-trigger');
        expect(workingPlacementDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['off', 'global', 'withinGroups']);

        await act(async () => {
            workingPlacementDropdown!.props.onSelect('global');
        });

        expect(setSessionListWorkingPlacementMode).toHaveBeenCalledWith('global');
    });

    it('exposes the session list section mode selector', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const sectionModeDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.sectionModeTitle');
        expect(sectionModeDropdown).toBeTruthy();
        expect(sectionModeDropdown?.props?.selectedId).toBe('activity');
        expect(sectionModeDropdown?.props?.itemTrigger?.itemProps?.testID).toBe('settings-session-sessionListSectionMode-trigger');
        expect(sectionModeDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['activity', 'single']);

        await act(async () => {
            sectionModeDropdown!.props.onSelect('single');
        });

        expect(setSessionListSectionMode).toHaveBeenCalledWith('single');
    });

    it('exposes the folder order selector in session list settings', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const folderOrderDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.folderSortModeTitle');
        expect(folderOrderDropdown).toBeTruthy();
        expect(folderOrderDropdown?.props?.selectedId).toBe('foldersFirst');
        expect(folderOrderDropdown?.props?.itemTrigger?.itemProps?.testID).toBe('settings-session-sessionListFolderSortMode-trigger');
        expect(folderOrderDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['foldersFirst', 'mixed']);

        await act(async () => {
            folderOrderDropdown!.props.onSelect('mixed');
        });

        expect(setSessionListFolderSortMode).toHaveBeenCalledWith('mixed');
    });

    it('exposes the session order selector in session list settings', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const orderingDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'sessionsList.orderingMode.title');
        expect(orderingDropdown).toBeTruthy();
        expect(orderingDropdown?.props?.selectedId).toBe('custom');
        expect(orderingDropdown?.props?.itemTrigger?.itemProps?.testID).toBe('settings-session-sessionListOrderingMode-trigger');
        expect(orderingDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['custom', 'created', 'updated']);

        await act(async () => {
            orderingDropdown!.props.onSelect('updated');
        });

        expect(setSessionListOrderingMode).toHaveBeenCalledWith('updated');
    });

    it('labels the loading style selector as the general working indicator setting', async () => {
        const mod = await import('../../../../app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const workingIndicatorDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.sessionList.workingIndicatorTitle');
        expect(workingIndicatorDropdown).toBeTruthy();
        expect(workingIndicatorDropdown?.props?.selectedId).toBe('spinner');
        expect(workingIndicatorDropdown?.props?.itemTrigger?.itemProps?.testID).toBe('settings-session-workingIndicator-trigger');
    });
});
