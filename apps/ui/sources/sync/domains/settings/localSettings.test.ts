import { describe, expect, it } from 'vitest';

import { THEME_PROFILE_MAX_OVERRIDES_PER_MODE } from '@/theme/profiles/themeProfileConstants';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';

describe('localSettingsParse', () => {
    it('defaults system tabs on, preserves the device opt-out, and catches malformed values without resetting preferences', () => {
        expect(localSettingsParse({})).toMatchObject({ systemTabBarEnabled: true });
        expect(localSettingsParse({ systemTabBarEnabled: false, themePreference: 'dark' })).toMatchObject({
            systemTabBarEnabled: false,
            themePreference: 'dark',
        });
        expect(localSettingsParse({ systemTabBarEnabled: 'off', themePreference: 'dark' })).toMatchObject({
            systemTabBarEnabled: true,
            themePreference: 'dark',
        });
    });
    it('defaults haptics on and keeps its opt-out device-local without coupling visual preferences', () => {
        expect(localSettingsParse({})).toMatchObject({ hapticsEnabled: true });
        const parsed = localSettingsParse({ hapticsEnabled: false, uiBackdropBlurEnabled: false, themePreference: 'dark' });
        expect(parsed).toMatchObject({ hapticsEnabled: false, uiBackdropBlurEnabled: false, themePreference: 'dark' });
        expect(applyLocalSettings(parsed, { hapticsEnabled: true })).toMatchObject({
            hapticsEnabled: true,
            uiBackdropBlurEnabled: false,
            themePreference: 'dark',
        });
    });

    it('defaults malformed haptics values without resetting other local preferences', () => {
        expect(localSettingsParse({ hapticsEnabled: 'disabled', uiItemDensity: 'compact', themePreference: 'dark' })).toMatchObject({
            hapticsEnabled: true,
            uiItemDensity: 'compact',
            themePreference: 'dark',
        });
    });

    it('defaults the loading indicator to Normal speed with a Short pause, and degrades unknown values without resetting other local settings', () => {
        const defaults = localSettingsParse(null);
        expect(defaults.loadingIndicatorSpeed).toBe('normal');
        expect(defaults.loadingIndicatorPause).toBe('short');
        expect(localSettingsParse({ loadingIndicatorSpeed: 'fast', loadingIndicatorPause: 'none' })).toMatchObject({
            loadingIndicatorSpeed: 'fast',
            loadingIndicatorPause: 'none',
        });

        const parsed = localSettingsParse({ loadingIndicatorSpeed: 'warp', loadingIndicatorPause: 3, uiItemDensity: 'compact' });
        expect(parsed.loadingIndicatorSpeed).toBe('normal');
        expect(parsed.loadingIndicatorPause).toBe('short');
        expect(parsed.uiItemDensity).toBe('compact');
    });

    it('defaults the mobile brand hero dismissal timestamp to null', () => {
        expect(localSettingsParse(null).brandHeroSeenAt).toBeNull();
    });

    it('includes multi-pane and pane tab defaults', () => {
        const parsed = localSettingsParse(null);
        expect(parsed.uiMultiPanePanelsEnabled).toBe(true);
        expect(parsed.uiBackdropBlurEnabled).toBe(true);
        expect(parsed.uiContentWidthMode).toBe('compact');
        expect(parsed.uiItemDensity).toBe('cozy');
        expect(parsed.detailsPaneTabsBehavior).toBe('preview');
        expect(parsed.sessionsListStorageTab).toBe('persisted');
        expect(parsed.activityBadgesEnabled).toBe(true);
        expect(parsed.activityBadgeShowUnread).toBe(true);
        expect(parsed.activityBadgeShowPendingPermissionRequests).toBe(true);
        expect(parsed.activityBadgeShowPendingUserActionRequests).toBe(true);
        expect(parsed.activityBadgeShowQueuedUserInput).toBe(true);
        expect(parsed.activityBadgeShowFriendRequestsInboxCount).toBe(true);
        expect(parsed.activityBadgeShowDesktopNonNumericDot).toBe(true);
        expect(parsed.localNotificationsEnabled).toBe(true);
        expect(parsed.localNotificationsShowReady).toBe(true);
        expect(parsed.localNotificationsShowReadyMessageText).toBe(true);
        expect(parsed.localNotificationsShowRequestMessageText).toBe(true);
        expect(parsed.localNotificationsShowPendingPermissionRequests).toBe(true);
        expect(parsed.localNotificationsShowPendingUserActionRequests).toBe(true);
        expect(parsed.localNotificationsForegroundBehavior).toBe('full');
        expect(parsed.collapsedGroupKeysV1).toEqual({});
        expect(typeof (parsed as any).sidebarWidthPx).toBe('number');
        expect(typeof (parsed as any).sidebarWidthBasisPx).toBe('number');
        expect((parsed as any).bottomPaneHeightPx).toBe(320);
        expect((parsed as any).bottomPaneHeightBasisPx).toBe(900);
        expect((parsed as any).embeddedTerminalDockLocation).toBe('bottom');
        expect(parsed).not.toHaveProperty('mobileWorkspaceExperienceV1');
        expect(parsed.sessionLastMobileSurfaceBySessionId).toEqual({});
    });

    it('returns defaults for non-object input', () => {
        expect(localSettingsParse(null)).toEqual(localSettingsDefaults);
        expect(localSettingsParse(undefined)).toEqual(localSettingsDefaults);
        expect(localSettingsParse('nope')).toEqual(localSettingsDefaults);
    });

    it('applies the mobile brand hero dismissal timestamp through local settings', () => {
        const applied = applyLocalSettings(localSettingsDefaults, {
            brandHeroSeenAt: 1_789_000_000_000,
        });

        expect(applied.brandHeroSeenAt).toBe(1_789_000_000_000);
    });

    it('keeps session list collapsed groups as local-only UI state', () => {
        const parsed = localSettingsParse({
            collapsedGroupKeysV1: {
                'server-a:project:/repo': true,
                'server-a:folder:planning': false,
            },
        });

        expect(parsed.collapsedGroupKeysV1).toEqual({
            'server-a:project:/repo': true,
            'server-a:folder:planning': false,
        });
    });

    it('falls back to null for malformed mobile brand hero dismissal timestamps', () => {
        expect(localSettingsParse({ brandHeroSeenAt: 'yesterday' }).brandHeroSeenAt).toBeNull();
    });

    it('defaults theme profiles to an empty local-only state', () => {
        expect(localSettingsParse(null).themeProfiles).toEqual({
            profiles: [],
            activeProfileIds: { light: null, dark: null },
        });
    });

    it('drops malformed theme profile state while preserving other local settings', () => {
        const parsed = localSettingsParse({
            themePreference: 'dark',
            themeProfiles: 'not a profile collection',
        });

        expect(parsed.themePreference).toBe('dark');
        expect(parsed.themeProfiles).toEqual({
            profiles: [],
            activeProfileIds: { light: null, dark: null },
        });
    });

    it('drops malformed theme profiles from the local profile collection', () => {
        const parsed = localSettingsParse({
            themeProfiles: {
                activeProfileId: 'valid-profile',
                profiles: [
                    { id: 'invalid-profile' },
                    {
                        schemaVersion: 1,
                        id: 'valid-profile',
                        name: 'Valid profile',
                        createdAt: '2026-05-11T00:00:00.000Z',
                        updatedAt: '2026-05-11T00:00:00.000Z',
                        base: { light: 'light', dark: 'dark' },
                        overrides: {
                            light: { 'background.canvas': '#fafafa' },
                            dark: {},
                        },
                    },
                ],
            },
        });

        expect(parsed.themeProfiles.profiles).toHaveLength(1);
        expect(parsed.themeProfiles.profiles[0]?.id).toBe('valid-profile');
        expect(parsed.themeProfiles.activeProfileIds).toEqual({ light: 'valid-profile', dark: 'valid-profile' });
    });

    it('accepts built-in theme preset ids as active without storing them in custom profiles', () => {
        const parsed = localSettingsParse({
            themeProfiles: {
                activeProfileId: 'premiumDark',
                profiles: [],
            },
        });

        expect(parsed.themeProfiles).toEqual({
            activeProfileIds: { light: 'premiumDark', dark: 'premiumDark' },
            profiles: [],
        });
    });

    it('drops persisted theme profiles with control-character names', () => {
        const parsed = localSettingsParse({
            themeProfiles: {
                activeProfileId: 'invalid-profile',
                profiles: [
                    {
                        schemaVersion: 1,
                        id: 'invalid-profile',
                        name: 'Bad\u0000Profile',
                        createdAt: '2026-05-11T00:00:00.000Z',
                        updatedAt: '2026-05-11T00:00:00.000Z',
                        base: { light: 'light', dark: 'dark' },
                        overrides: {
                            light: { 'background.canvas': '#fafafa' },
                            dark: {},
                        },
                    },
                ],
            },
        });

        expect(parsed.themeProfiles).toEqual({
            profiles: [],
            activeProfileIds: { light: null, dark: null },
        });
    });

    it('drops persisted theme profiles with route-unsafe ids', () => {
        const parsed = localSettingsParse({
            themeProfiles: {
                activeProfileId: '../bad/profile?x=1',
                profiles: [
                    {
                        schemaVersion: 1,
                        id: '../bad/profile?x=1',
                        name: 'Bad profile',
                        createdAt: '2026-05-11T00:00:00.000Z',
                        updatedAt: '2026-05-11T00:00:00.000Z',
                        base: { light: 'light', dark: 'dark' },
                        overrides: {
                            light: { 'background.canvas': '#fafafa' },
                            dark: {},
                        },
                    },
                ],
            },
        });

        expect(parsed.themeProfiles).toEqual({
            profiles: [],
            activeProfileIds: { light: null, dark: null },
        });
    });

    it('drops persisted theme profiles with too many overrides in one mode', () => {
        const parsed = localSettingsParse({
            themeProfiles: {
                activeProfileId: 'oversized-profile',
                profiles: [
                    {
                        schemaVersion: 1,
                        id: 'oversized-profile',
                        name: 'Oversized profile',
                        createdAt: '2026-05-11T00:00:00.000Z',
                        updatedAt: '2026-05-11T00:00:00.000Z',
                        base: { light: 'light', dark: 'dark' },
                        overrides: {
                            light: Object.fromEntries(
                                Array.from(
                                    { length: THEME_PROFILE_MAX_OVERRIDES_PER_MODE + 1 },
                                    (_, index) => [`unknown.${index}`, '#ffffff'],
                                ),
                            ),
                            dark: {},
                        },
                    },
                ],
            },
        });

        expect(parsed.themeProfiles).toEqual({
            profiles: [],
            activeProfileIds: { light: null, dark: null },
        });
    });

    it('migrates legacy uiFontSize to uiFontScale when uiFontScale is missing', () => {
        const parsed = localSettingsParse({ uiFontSize: 'large' });
        expect(parsed.uiFontScale).toBeCloseTo(1.1, 5);
    });

    it('prefers uiFontScale over legacy uiFontSize when both are present', () => {
        const parsed = localSettingsParse({ uiFontScale: 1.42, uiFontSize: 'xsmall' });
        expect(parsed.uiFontScale).toBeCloseTo(1.42, 5);
    });

    it('clamps uiFontScale to the supported range', () => {
        const tooSmall = localSettingsParse({ uiFontScale: 0.01 });
        expect(tooSmall.uiFontScale).toBeGreaterThanOrEqual(0.5);

        const tooBig = localSettingsParse({ uiFontScale: 100 });
        expect(tooBig.uiFontScale).toBeLessThanOrEqual(2.5);
    });

    it('accepts direct sessions list tab selection', () => {
        const parsed = localSettingsParse({ sessionsListStorageTab: 'direct' });
        expect(parsed.sessionsListStorageTab).toBe('direct');
    });

    it('stores the local session list folder sort mode selection', () => {
        expect(localSettingsParse(null).sessionListFolderSortModeV1).toBe('foldersFirst');
        expect(localSettingsParse({ sessionListFolderSortModeV1: 'mixed' }).sessionListFolderSortModeV1).toBe('mixed');
        expect(localSettingsParse({ sessionListFolderSortModeV1: 'invalid' }).sessionListFolderSortModeV1).toBe('foldersFirst');
    });

    it('accepts the middle ui item density selection', () => {
        const parsed = localSettingsParse({ uiItemDensity: 'cozy' });
        expect(parsed.uiItemDensity).toBe('cozy');
    });

    it('accepts explicit content width mode selection', () => {
        const parsed = localSettingsParse({ uiContentWidthMode: 'full' });
        expect(parsed.uiContentWidthMode).toBe('full');
    });

    it('accepts explicit badge and local notification toggles', () => {
        const parsed = localSettingsParse({
            activityBadgesEnabled: false,
            activityBadgeShowUnread: false,
            activityBadgeShowFriendRequestsInboxCount: false,
            localNotificationsEnabled: false,
            localNotificationsShowReady: false,
            localNotificationsShowReadyMessageText: false,
            localNotificationsShowRequestMessageText: false,
            localNotificationsShowPendingPermissionRequests: false,
            localNotificationsShowPendingUserActionRequests: false,
            localNotificationsForegroundBehavior: 'silent',
        });

        expect(parsed.activityBadgesEnabled).toBe(false);
        expect(parsed.activityBadgeShowUnread).toBe(false);
        expect(parsed.activityBadgeShowFriendRequestsInboxCount).toBe(false);
        expect(parsed.localNotificationsEnabled).toBe(false);
        expect(parsed.localNotificationsShowReady).toBe(false);
        expect(parsed.localNotificationsShowReadyMessageText).toBe(false);
        expect(parsed.localNotificationsShowRequestMessageText).toBe(false);
        expect(parsed.localNotificationsShowPendingPermissionRequests).toBe(false);
        expect(parsed.localNotificationsShowPendingUserActionRequests).toBe(false);
        expect(parsed.localNotificationsForegroundBehavior).toBe('silent');
    });

    it('strips obsolete local keyboard shortcut settings instead of preserving pre-release compatibility state', () => {
        const parsed = localSettingsParse({
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: true,
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open', '', 123],
            keyboardShortcutOverridesV1: {
                'commandPalette.open': [{ binding: 'Mod+K' }],
                'bad.command': [{ binding: '' }, { nope: true }],
            },
        });

        expect(parsed).not.toHaveProperty('commandPaletteEnabled');
        expect(parsed).not.toHaveProperty('keyboardShortcutsV2Enabled');
        expect(parsed).not.toHaveProperty('keyboardSingleKeyShortcutsEnabled');
        expect(parsed).not.toHaveProperty('keyboardShortcutDisabledCommandIdsV1');
        expect(parsed).not.toHaveProperty('keyboardShortcutOverridesV1');
        expect(localSettingsDefaults).not.toHaveProperty('commandPaletteEnabled');
        expect(localSettingsDefaults).not.toHaveProperty('keyboardShortcutsV2Enabled');
        expect(localSettingsDefaults).not.toHaveProperty('keyboardSingleKeyShortcutsEnabled');
        expect(localSettingsDefaults).not.toHaveProperty('keyboardShortcutDisabledCommandIdsV1');
        expect(localSettingsDefaults).not.toHaveProperty('keyboardShortcutOverridesV1');
    });

    it('parses session MRU order as a local string list without accepting malformed entries', () => {
        const parsed = localSettingsParse({
            sessionMruOrderV1: ['server-a:sess-2', '', 123, ' server-a:sess-1 '],
        });

        expect(parsed.sessionMruOrderV1).toEqual(['server-a:sess-2', 'server-a:sess-1']);
    });

    it('stores focused session folder state locally', () => {
        const focusedFolder = {
            serverId: 'server-a',
            workspace: {
                t: 'workspaceScope',
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: '/Users/lee/project',
            },
            renderWorkspaceKey: 'wl_old',
            folderId: 'folder-a',
        };

        expect(localSettingsParse(null).sessionListFocusedFolderV1).toBeNull();
        expect(localSettingsParse({ sessionListFocusedFolderV1: focusedFolder }).sessionListFocusedFolderV1).toEqual(focusedFolder);
        expect(localSettingsParse({ sessionListFocusedFolderV1: { ...focusedFolder, folderId: '' } }).sessionListFocusedFolderV1).toBeNull();
    });

    it('drops the deprecated persisted editor focus mode flag while parsing and applying settings', () => {
        const parsed = localSettingsParse({ editorFocusModeEnabled: true });
        expect(parsed).not.toHaveProperty('editorFocusModeEnabled');

        const staleDelta: Record<'editorFocusModeEnabled', boolean> = { editorFocusModeEnabled: true };
        const applied = applyLocalSettings(localSettingsDefaults, staleDelta);
        expect(applied).not.toHaveProperty('editorFocusModeEnabled');
    });

    it('preserves unknown local settings while continuing to strip deprecated keys', () => {
        const parsed = localSettingsParse({
            themePreference: 'dark',
            futureLocalSetting: 'kept',
            editorFocusModeEnabled: true,
        });

        expect(parsed).toMatchObject({
            themePreference: 'dark',
            futureLocalSetting: 'kept',
        });
        expect(parsed).not.toHaveProperty('editorFocusModeEnabled');

        const applied = applyLocalSettings(parsed, {
            anotherFutureLocalSetting: 42,
            editorFocusModeEnabled: true,
        });

        expect(applied).toMatchObject({
            futureLocalSetting: 'kept',
            anotherFutureLocalSetting: 42,
        });
        expect(applied).not.toHaveProperty('editorFocusModeEnabled');
    });
});
