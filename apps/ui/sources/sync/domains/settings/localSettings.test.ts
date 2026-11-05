import { describe, expect, it } from 'vitest';

import { THEME_PROFILE_MAX_OVERRIDES_PER_MODE } from '@/theme/profiles/themeProfileConstants';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';

describe('localSettingsParse', () => {
    it('keeps remote image consent device-local, tolerant and scoped to the chosen document', () => {
        expect(localSettingsParse({}).remoteImageConsentV1).toEqual([]);
        const input = { remoteImageConsentV1: [['workspace-a', 'README.md'], ['workspace-a', 'README.md'], ['workspace-b', 'README.md'], null, ['only-one'], ['', 'README.md']] };
        const parsed = localSettingsParse(input);
        expect(parsed.remoteImageConsentV1).toEqual([['workspace-a', 'README.md'], ['workspace-b', 'README.md']]);
        expect(localSettingsParse(parsed).remoteImageConsentV1).toEqual(parsed.remoteImageConsentV1);
        expect(localSettingsParse({ remoteImageConsentV1: 'malformed', themePreference: 'dark' })).toMatchObject({ remoteImageConsentV1: [], themePreference: 'dark' });
    });
    it('keeps Track opt-in and device-local when reading older or malformed settings', () => {
        expect(localSettingsParse({}).filesTrackAgentEdits).toBe(false);
        expect(localSettingsParse({ filesTrackAgentEdits: 'true', sidebarCollapsed: true })).toMatchObject({
            filesTrackAgentEdits: false, sidebarCollapsed: true,
        });
        expect(localSettingsParse(applyLocalSettings(localSettingsParse({}), { filesTrackAgentEdits: true })).filesTrackAgentEdits).toBe(true);
    });
    it('keeps arrangement and collection geometry device-local and tolerates an unknown arrangement', () => {
        expect(localSettingsParse({})).toMatchObject({ paneArrangement: 'session', sessionColumnWidthPx: 440, collectionRailWidthsV1: {} });
        const parsed = localSettingsParse({ paneArrangement: 'editor', sessionColumnWidthPx: 510, collectionRailWidthsV1: { machines: 310 } });
        expect(localSettingsParse(parsed)).toMatchObject({ paneArrangement: 'editor', sessionColumnWidthPx: 510, collectionRailWidthsV1: { machines: 310 } });
        expect(localSettingsParse({ paneArrangement: 'future', sidebarCollapsed: true })).toMatchObject({ paneArrangement: 'session', sidebarCollapsed: true });
    });

    it.each([
        ['sidebarWidthPx', 'sidebarWidthBasisPx', [320], 1200],
        ['rightPaneWidthPx', 'rightPaneWidthBasisPx', [360, 340], 1200],
        ['detailsPaneWidthPx', 'detailsPaneWidthBasisPx', [520], 1200],
        ['bottomPaneHeightPx', 'bottomPaneHeightBasisPx', [320], 900],
        ['settingsNavSidebarWidthPx', 'settingsNavSidebarWidthBasisPx', [230, 280], 1200],
    ] as const)('migrates scaled %s preferences once without rewriting chosen pixels', (pxKey, basisKey, oldDefaults, oldBasis) => {
        for (const oldDefault of oldDefaults) {
            const input = { [pxKey]: oldDefault, [basisKey]: oldBasis, sidebarCollapsed: true };
            const parsed = localSettingsParse(input);
            expect(parsed[pxKey]).toBe(localSettingsDefaults[pxKey]);
            expect(parsed).not.toHaveProperty(basisKey);
            expect(parsed.sidebarCollapsed).toBe(true);
            expect(input).toHaveProperty(basisKey, oldBasis);
            // A record without a basis was written as literal pixels, even when equal to an old default.
            expect(localSettingsParse({ [pxKey]: oldDefault })[pxKey]).toBe(oldDefault);
            expect(localSettingsParse({ [pxKey]: oldDefault, [basisKey]: oldBasis * 2 })[pxKey]).toBe(oldDefault);
        }
        const chosen = localSettingsParse({ [pxKey]: 777, [basisKey]: oldBasis * 2 });
        expect(chosen[pxKey]).toBe(777);
        expect(chosen).not.toHaveProperty(basisKey);
        expect(localSettingsParse(chosen)[pxKey]).toBe(777);
        expect(localSettingsParse({ [basisKey]: oldBasis })).not.toHaveProperty(basisKey);
    });

    it('preserves the 0.2 sidebar width the person saw at a larger basis', () => {
        expect(localSettingsParse({ sidebarWidthPx: 320, sidebarWidthBasisPx: 1200 }).sidebarWidthPx).toBe(272);
        expect(localSettingsParse({ sidebarWidthPx: 512, sidebarWidthBasisPx: 1920 }).sidebarWidthPx).toBe(512);
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

    it('retains nested local settings despite extras without replacing unrelated preferences with defaults', () => {
        const placement = { side: 'right', y: 0.7, tucked: true };
        expect(localSettingsParse({
            uiItemDensity: 'compact',
            terminalArrowPadPlacement: { portrait: { ...placement, retired: true }, landscape: null, retired: true },
            terminalNativeRendererQuarantine: { renderer: 'ios-ghosttykit', expiresAtMs: 1000, retired: true },
        })).toMatchObject({
            uiItemDensity: 'compact',
            terminalArrowPadPlacement: { portrait: placement, landscape: null },
            terminalNativeRendererQuarantine: { renderer: 'ios-ghosttykit', expiresAtMs: 1000 },
        });
    });

    it('retains canonical Project page preferences and every predecessor companion value in the existing map', () => {
        const values = { overview: 'overview', code: 'code', changes: 'changes', scripts: 'scripts', services: 'services', context: 'context',
            browse: 'browse', git: 'git', tabs: 'tabs', terminal: 'terminal', browser: 'browser' };
        expect(localSettingsParse({ projectLastMobileSurfaceByWorkspaceRefId: values }).projectLastMobileSurfaceByWorkspaceRefId).toEqual(values);
    });
    it('keeps connected-account identity privacy device-local and opt-in across old persisted settings', () => {
        expect(localSettingsParse({}).hideConnectedAccountIdentities).toBe(false);
        expect(localSettingsParse({ hideConnectedAccountIdentities: true }).hideConnectedAccountIdentities).toBe(true);
        expect(localSettingsParse({ hideConnectedAccountIdentities: 'true' }).hideConnectedAccountIdentities).toBe(false);
    });
    it('keeps remote alert enrollment independent of local notification overrides', () => {
        const settings = localSettingsParse({ localNotificationsEnabled: false });
        expect(settings.deviceRemoteAlertsEnabled).toBe(true);
        const optedOut = applyLocalSettings(settings, { deviceRemoteAlertsEnabled: false });
        expect(localSettingsParse(optedOut).deviceRemoteAlertsEnabled).toBe(false);
        expect(applyLocalSettings(optedOut, { localNotificationsEnabled: true }).deviceRemoteAlertsEnabled).toBe(false);
    });

    it('defaults focused session folder state to null', () => {
        expect(localSettingsParse(null).sessionListFocusedFolderV1).toBeNull();
    });
    it('restores known focused-folder fields from stored records with extras without accepting missing identity', () => {
        const focused = { serverId: 'home-a', workspace: { t: 'workspaceScope', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, folderId: 'folder-a' };
        const stored = { ...focused, savedBy: 'other-client', workspace: { ...focused.workspace, savedBy: 'other-client' } };
        expect(localSettingsParse({ sessionListFocusedFolderV1: stored }).sessionListFocusedFolderV1).toEqual(focused);
        expect(localSettingsParse({ sessionListFocusedFolderV1: { ...stored, workspace: { ...stored.workspace, rootPath: undefined } } }).sessionListFocusedFolderV1).toBeNull();
    });

    it('keeps interaction memory out of the current preference projection', () => {
        const selection = { v: 1, byAccountScope: { 'home/account': { sessionWork: { spaceId: 'my-work' }, workflow: { spaceId: 'flows' } } } };
        const restored = localSettingsParse({ collectionSpaceV1: selection, collapsedGroupKeysV1: { group_a: true },
            sessionInfoExpandedSectionsV1: { memory: true },
            sidebarCollapsed: true });
        for (const key of ['collectionSpaceV1', 'collapsedGroupKeysV1', 'sessionInfoExpandedSectionsV1']) {
            expect(restored).not.toHaveProperty(key);
        }
        expect(restored.sidebarCollapsed).toBe(true);
    });

    it('defaults the loading indicator to the wave, and degrades an unknown style id without resetting other local settings', () => {
        expect(localSettingsParse(null).loadingIndicatorStyle).toBe('wave');
        expect(localSettingsParse({ loadingIndicatorStyle: 'radar' }).loadingIndicatorStyle).toBe('radar');

        const parsed = localSettingsParse({ loadingIndicatorStyle: 'styleFromANewerBuild', uiItemDensity: 'compact' });
        expect(parsed.loadingIndicatorStyle).toBe('wave');
        expect(parsed.uiItemDensity).toBe('compact');
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
        expect(parsed.uiBackdropBlurEnabled).toBe(true);
        expect(parsed.uiMultiPanePanelsEnabled).toBe(true);
        expect(parsed.uiContentWidthMode).toBe('compact');
        expect(parsed.uiItemDensity).toBe('cozy');
        expect(parsed.detailsPaneTabsBehavior).toBe('preview');
        expect(parsed.settingsNavSidebarWidthPx).toBe(230);
        expect(parsed.sessionsListStorageFilter).toBe('all');
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
        expect(parsed.activitySurfacesEnabled).toBe(true);
        expect(parsed.liveActivitiesEnabled).toBe(true);
        expect(parsed.liveActivitiesStrategy).toBe('dynamic_primary');
        expect(parsed.iosLiveActivitiesEnabled).toBe(true);
        expect(parsed.widgetsEnabled).toBe(true);
        expect(parsed.liveActivitiesMode).toBe('focused');
        expect(parsed.liveActivitiesMaxConcurrent).toBe(1);
        expect(parsed.liveActivitiesShowPreviewText).toBe(true);
        expect(parsed.liveActivitiesAllowActionButtons).toBe(true);
        expect(parsed.liveActivitiesIncludeReady).toBe(true);
        expect(parsed.liveActivitiesIncludeThinking).toBe(true);
        expect(parsed.widgetsPresetMode).toBe('summary');
        expect(parsed.widgetsShowPreviewText).toBe(true);
        expect(parsed.widgetsShowMachinePath).toBe(true);
        expect(parsed.homeScreenWidgetsMode).toBe('summary');
        expect(parsed.homeScreenWidgetsShowPreviewText).toBe(true);
        expect(parsed.homeScreenWidgetsShowMachinePath).toBe(true);
        expect(parsed.activitySurfaceTapTarget).toBe('open_session');
        expect(parsed.activitySurfacePrivacyMode).toBe('title_only');
        expect(parsed.desktopOverlayEnabled).toBe(false);
        expect(parsed.desktopOverlayVisibilityMode).toBe('attention_only');
        expect(parsed.desktopOverlayAlwaysOnTop).toBe(true);
        expect(parsed.attentionDeviceOverridesV1).toMatchObject({
            v: 1,
            enabled: true,
            foregroundBehavior: 'account',
            localNotifications: {
                enabled: true,
                events: {
                    ready: true,
                    permission_request: true,
                    user_action_request: true,
                },
                previewBehavior: 'account',
                requestPreviewBehavior: 'account',
            },
            badge: {
                enabled: true,
                includeUnread: true,
                includePendingPermissionRequests: true,
                includePendingUserActionRequests: true,
                includeQueuedUserInput: true,
            },
            quietHoursOverride: {
                mode: 'account',
            },
            desktopOverlay: {
                hoverExpandDelay: 'normal',


                quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
            },
            liveActivities: {
                registerRemoteUpdateTargets: true,
                allowBackgroundWakeFallback: false,
                privacyMode: 'account',
                showFreshnessDiagnostics: false,
                remoteUpdateModeOverride: 'account',
            },
            terminalSmartSuppression: {
                enabled: true,
            },
        });
        expect(typeof (parsed as any).sidebarWidthPx).toBe('number');
        expect(parsed).not.toHaveProperty('sidebarWidthBasisPx');
        expect((parsed as any).bottomPaneHeightPx).toBe(320);
        expect(parsed).not.toHaveProperty('bottomPaneHeightBasisPx');
        expect((parsed as any).terminalRendererPreference).toBe('auto');
        expect(parsed).not.toHaveProperty('mobileWorkspaceExperienceV1');
    });

    it('keeps terminal renderer preference local and fail-safe', () => {
        expect(localSettingsParse({
            terminalRendererPreference: 'xterm-webview',
        }).terminalRendererPreference).toBe('xterm-webview');
        expect(localSettingsParse({
            terminalRendererPreference: 'native',
        }).terminalRendererPreference).toBe('native');
        expect(localSettingsParse({
            terminalRendererPreference: 'native-experimental',
        }).terminalRendererPreference).toBe('native');
        expect(localSettingsParse({
            terminalRendererPreference: 'ghostty-always',
        }).terminalRendererPreference).toBe('auto');
    });

    it('keeps a bounded native-renderer fatal quarantine local and self-healing', () => {
        const active = localSettingsParse({
            terminalNativeRendererQuarantine: {
                renderer: 'ios-ghosttykit',
                expiresAtMs: 1_800_000_000_000,
            },
        }) as Record<string, unknown>;
        const malformed = localSettingsParse({
            terminalNativeRendererQuarantine: {
                renderer: 'unknown-renderer',
                expiresAtMs: 'never',
            },
        }) as Record<string, unknown>;

        expect(active.terminalNativeRendererQuarantine).toEqual({
            renderer: 'ios-ghosttykit',
            expiresAtMs: 1_800_000_000_000,
        });
        expect(malformed.terminalNativeRendererQuarantine).toBeNull();
        expect((localSettingsDefaults as Record<string, unknown>).terminalNativeRendererQuarantine).toBeNull();
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

    it('falls back to null for malformed mobile brand hero dismissal timestamps', () => {
        expect(localSettingsParse({ brandHeroSeenAt: 'yesterday' }).brandHeroSeenAt).toBeNull();
    });

    it('defaults theme profiles to an empty local-only state', () => {
        expect(localSettingsParse(null)).toMatchObject({
            themeProfiles: {
                profiles: [],
                activeProfileIds: { light: null, dark: null },
            },
        });
    });

    it('drops malformed theme profile state while preserving other local settings', () => {
        expect(localSettingsParse({
            themePreference: 'dark',
            themeProfiles: 'not a profile collection',
        })).toMatchObject({
            themePreference: 'dark',
            themeProfiles: {
                profiles: [],
                activeProfileIds: { light: null, dark: null },
            },
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
        expect(localSettingsParse({
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
        })).toMatchObject({
            themeProfiles: {
                profiles: [],
                activeProfileIds: { light: null, dark: null },
            },
        });
    });

    it('drops persisted theme profiles with route-unsafe ids', () => {
        expect(localSettingsParse({
            themeProfiles: {
                activeProfileId: '../bad/profile?x=1',
                profiles: [
                    {
                        schemaVersion: 1,
                        id: '../bad/profile?x=1',
                        name: 'Unsafe route profile',
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
        })).toMatchObject({
            themeProfiles: {
                profiles: [],
                activeProfileIds: { light: null, dark: null },
            },
        });
    });

    it('drops persisted theme profiles with too many overrides in one mode', () => {
        expect(localSettingsParse({
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
        })).toMatchObject({
            themeProfiles: {
                profiles: [],
                activeProfileIds: { light: null, dark: null },
            },
        });
    });

    it('migrates legacy settings sidebar width defaults to the new fixed default', () => {
        const parsed = localSettingsParse({
            settingsNavSidebarWidthPx: 280,
            settingsNavSidebarWidthBasisPx: 1200,
        });
        expect(parsed.settingsNavSidebarWidthPx).toBe(230);
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
        expect(parsed.sessionsListStorageFilter).toBe('direct');
        expect(parsed).not.toHaveProperty('sessionsListStorageTab');
    });

    it('does not carry the retired persisted tab forward because the unified list defaults to all', () => {
        const parsed = localSettingsParse({ sessionsListStorageTab: 'persisted' });

        expect(parsed.sessionsListStorageFilter).toBe('all');
        expect(parsed).not.toHaveProperty('sessionsListStorageTab');
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
            localNotificationsShowPendingPermissionRequests: false,
            localNotificationsShowPendingUserActionRequests: false,
            localNotificationsForegroundBehavior: 'silent',
            activitySurfacesEnabled: false,
            liveActivitiesEnabled: false,
            liveActivitiesStrategy: 'session_specific',
            iosLiveActivitiesEnabled: false,
            widgetsEnabled: false,
            widgetsPresetMode: 'attention',
            liveActivitiesMode: 'running',
            liveActivitiesMaxConcurrent: 4,
            liveActivitiesShowPreviewText: false,
            liveActivitiesAllowActionButtons: false,
            liveActivitiesIncludeReady: false,
            liveActivitiesIncludeThinking: false,
            homeScreenWidgetsMode: 'attention',
            widgetsShowPreviewText: false,
            widgetsShowMachinePath: false,
            homeScreenWidgetsShowPreviewText: false,
            homeScreenWidgetsShowMachinePath: false,
            activitySurfaceTapTarget: 'open_sessions',
            activitySurfacePrivacyMode: 'include_preview',
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'always_when_enabled',

            desktopOverlayAlwaysOnTop: false,


            desktopOverlayPresentationMode: 'notch_integrated',
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 12,
            desktopOverlayOffsetY: -8,


        });

        expect(parsed.activityBadgesEnabled).toBe(false);
        expect(parsed.activityBadgeShowUnread).toBe(false);
        expect(parsed.activityBadgeShowFriendRequestsInboxCount).toBe(false);
        expect(parsed.localNotificationsEnabled).toBe(false);
        expect(parsed.localNotificationsShowReady).toBe(false);
        expect(parsed.localNotificationsShowReadyMessageText).toBe(false);
        expect(parsed.localNotificationsShowPendingPermissionRequests).toBe(false);
        expect(parsed.localNotificationsShowPendingUserActionRequests).toBe(false);
        expect(parsed.localNotificationsForegroundBehavior).toBe('silent');
        expect(parsed.activitySurfacesEnabled).toBe(false);
        expect(parsed.liveActivitiesEnabled).toBe(false);
        expect(parsed.liveActivitiesStrategy).toBe('session_specific');
        expect(parsed.iosLiveActivitiesEnabled).toBe(false);
        expect(parsed.widgetsEnabled).toBe(false);
        expect(parsed.widgetsPresetMode).toBe('attention');
        expect(parsed.liveActivitiesMode).toBe('running');
        expect(parsed.liveActivitiesMaxConcurrent).toBe(4);
        expect(parsed.liveActivitiesShowPreviewText).toBe(false);
        expect(parsed.liveActivitiesAllowActionButtons).toBe(false);
        expect(parsed.liveActivitiesIncludeReady).toBe(false);
        expect(parsed.liveActivitiesIncludeThinking).toBe(false);
        expect(parsed.homeScreenWidgetsMode).toBe('attention');
        expect(parsed.widgetsShowPreviewText).toBe(false);
        expect(parsed.widgetsShowMachinePath).toBe(false);
        expect(parsed.homeScreenWidgetsShowPreviewText).toBe(false);
        expect(parsed.homeScreenWidgetsShowMachinePath).toBe(false);
        expect(parsed.activitySurfaceTapTarget).toBe('open_sessions');
        expect(parsed.activitySurfacePrivacyMode).toBe('include_preview');
        expect(parsed.desktopOverlayEnabled).toBe(true);
        expect(parsed.desktopOverlayVisibilityMode).toBe('always_when_enabled');
        expect(parsed.desktopOverlayAlwaysOnTop).toBe(false);
    });

    it('strips obsolete local keyboard shortcut settings instead of preserving pre-release compatibility state', () => {
        const parsed = localSettingsParse({
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: true,
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open', '', 123],
            keyboardShortcutOverridesV1: {
                'commandPalette.open': [{ binding: 'Mod+K', conflictScope: 'global', nativeConsumable: false }],
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

    it('strips malformed obsolete local keyboard shortcut collections while preserving supported local settings', () => {
        const parsed = localSettingsParse({
            themePreference: 'dark',
            keyboardShortcutDisabledCommandIdsV1: 'not a command list',
            keyboardShortcutOverridesV1: 'not an override map',
        });

        expect(parsed.themePreference).toBe('dark');
        expect(parsed).not.toHaveProperty('keyboardShortcutDisabledCommandIdsV1');
        expect(parsed).not.toHaveProperty('keyboardShortcutOverridesV1');
    });

    it('keeps navigation history outside the local preference projection', () => {
        const parsed = localSettingsParse({
            sessionMruOrderV1: ['server-a:sess-2', '', 123, ' server-a:sess-1 '],
        });

        expect(parsed).not.toHaveProperty('sessionMruOrderV1');
    });

    it('accepts explicit attention device overrides and preserves a disabled quiet-hours override', () => {
        const parsed = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                enabled: true,
                foregroundBehavior: 'silent',
                localNotifications: {
                    enabled: false,
                    events: {
                        ready: false,
                        permission_request: true,
                        user_action_request: false,
                    },
                    previewBehavior: 'status_only',
                },
                quietHoursOverride: {
                    mode: 'disabled',
                },
                desktopOverlay: {
                    hoverExpandDelay: 'slow',


                    quickReplyPhrases: ['Ship', 'Explain', 'Retry', 'More', 'Stop', 'Thanks', 'Ignored'],
                },
                liveActivities: {
                    registerRemoteUpdateTargets: false,
                    allowBackgroundWakeFallback: true,
                    privacyMode: 'status_only',
                    showFreshnessDiagnostics: true,
                    remoteUpdateModeOverride: 'local_only',
                },
                terminalSmartSuppression: {
                    enabled: false,
                },
            },
        });

        expect(parsed.attentionDeviceOverridesV1).toMatchObject({
            foregroundBehavior: 'silent',
            localNotifications: {
                enabled: false,
                events: {
                    ready: false,
                    permission_request: true,
                    user_action_request: false,
                },
                previewBehavior: 'status_only',
            },
            quietHoursOverride: {
                mode: 'disabled',
            },
            desktopOverlay: {
                hoverExpandDelay: 'slow',


                quickReplyPhrases: ['Ship', 'Explain', 'Retry', 'More', 'Stop', 'Thanks', 'Ignored'],
            },
            liveActivities: {
                registerRemoteUpdateTargets: false,
                allowBackgroundWakeFallback: true,
                privacyMode: 'status_only',
                showFreshnessDiagnostics: true,
                remoteUpdateModeOverride: 'local_only',
            },
            terminalSmartSuppression: {
                enabled: false,
            },
        });
    });

    it('backfills attention device overrides from legacy local notification and surface settings', () => {
        const parsed = localSettingsParse({
            localNotificationsEnabled: false,
            localNotificationsShowReady: false,
            localNotificationsShowReadyMessageText: false,
            localNotificationsShowRequestMessageText: false,
            localNotificationsShowPendingPermissionRequests: true,
            localNotificationsShowPendingUserActionRequests: false,
            localNotificationsForegroundBehavior: 'silent',
            activityBadgesEnabled: false,
            activityBadgeShowUnread: false,
            activityBadgeShowPendingPermissionRequests: true,
            activityBadgeShowPendingUserActionRequests: false,
            activityBadgeShowQueuedUserInput: false,

            liveActivitiesShowPreviewText: false,
            liveActivitiesAllowActionButtons: false,
            widgetsEnabled: false,
            widgetsShowPreviewText: false,
            activitySurfacePrivacyMode: 'include_preview',
        });

        expect(parsed.attentionDeviceOverridesV1).toMatchObject({
            foregroundBehavior: 'silent',
            localNotifications: {
                enabled: false,
                events: {
                    ready: false,
                    permission_request: true,
                    user_action_request: false,
                },
                previewBehavior: 'status_only',
                requestPreviewBehavior: 'status_only',
            },
            badge: {
                enabled: false,
                includeUnread: false,
                includePendingPermissionRequests: true,
                includePendingUserActionRequests: false,
                includeQueuedUserInput: false,
            },
            desktopOverlay: {

            },
            liveActivities: {
                privacyMode: 'status_only',
            },
            widgets: {
                enabled: false,
                privacyMode: 'status_only',
            },
        });
    });

    it('syncs canonical activity surface aliases when applying local settings', () => {
        const applied = applyLocalSettings(localSettingsDefaults, {
            iosLiveActivitiesEnabled: false,
            homeScreenWidgetsMode: 'running',
            homeScreenWidgetsShowPreviewText: false,
            homeScreenWidgetsShowMachinePath: false,

        });

        expect(applied.liveActivitiesEnabled).toBe(false);
        expect(applied.iosLiveActivitiesEnabled).toBe(false);
        expect(applied.widgetsPresetMode).toBe('running');
        expect(applied.homeScreenWidgetsMode).toBe('running');
        expect(applied.widgetsShowPreviewText).toBe(false);
        expect(applied.homeScreenWidgetsShowPreviewText).toBe(false);
        expect(applied.widgetsShowMachinePath).toBe(false);
        expect(applied.homeScreenWidgetsShowMachinePath).toBe(false);
    });

    it('keeps attention device overrides in sync when applying legacy local setting deltas', () => {
        const applied = applyLocalSettings(localSettingsDefaults, {
            localNotificationsEnabled: false,
            localNotificationsShowReady: false,
            localNotificationsForegroundBehavior: 'off',

        });

        expect(applied.attentionDeviceOverridesV1).toMatchObject({
            foregroundBehavior: 'off',
            localNotifications: {
                enabled: false,
                events: {
                    ready: false,
                },
            },
            desktopOverlay: {

            },
        });
    });

    it('preserves attention device override identity for unrelated local setting deltas', () => {
        const current = localSettingsParse({
            attentionDeviceOverridesV1: {
                ...localSettingsDefaults.attentionDeviceOverridesV1,
                localNotifications: {
                    ...localSettingsDefaults.attentionDeviceOverridesV1.localNotifications,
                    enabled: false,
                },
            },
        });

        const applied = applyLocalSettings(current, { uiFontScale: 1.1 });

        expect(applied.uiFontScale).toBeCloseTo(1.1, 5);
        expect(applied.attentionDeviceOverridesV1).toBe(current.attentionDeviceOverridesV1);
    });

    it('preserves activity surface alias choices for unrelated local setting deltas', () => {
        const current = localSettingsParse({
            liveActivitiesEnabled: false,
            widgetsEnabled: false,
            widgetsPresetMode: 'running',
            widgetsShowPreviewText: false,
            widgetsShowMachinePath: false,
        });

        const applied = applyLocalSettings(current, { uiFontScale: 1.1 });

        expect(applied.uiFontScale).toBeCloseTo(1.1, 5);
        expect(applied.liveActivitiesEnabled).toBe(false);
        expect(applied.iosLiveActivitiesEnabled).toBe(false);
        expect(applied.widgetsEnabled).toBe(false);
        expect(applied.iosWidgetsEnabled).toBe(false);
        expect(applied.widgetsPresetMode).toBe('running');
        expect(applied.homeScreenWidgetsMode).toBe('running');
        expect(applied.widgetsShowPreviewText).toBe(false);
        expect(applied.homeScreenWidgetsShowPreviewText).toBe(false);
        expect(applied.widgetsShowMachinePath).toBe(false);
        expect(applied.homeScreenWidgetsShowMachinePath).toBe(false);
    });

    it.each(['editorFocusModeEnabled', 'uiSurfaceExecutableApprovalsV1'])(
        'drops the retired local setting %s while parsing and applying settings', (key) => {
        const parsed = localSettingsParse({ [key]: true });
        expect(parsed).not.toHaveProperty(key);

        const staleDelta: Record<string, unknown> = { [key]: true };
        const applied = applyLocalSettings(localSettingsDefaults, staleDelta);
        expect(applied).not.toHaveProperty(key);
    });
});


describe('Notch U4 stored preference contraction', () => {
    const retired = {
        desktopOverlayShowWhenRunning: false, desktopOverlayShowWhenAttentionRequired: false,
        desktopOverlayShowWhenReady: false, desktopOverlayExpandedBehavior: 'bad',
        desktopOverlayInteractiveCollapsed: 'bad', desktopOverlayClickAction: 'bad',
        desktopOverlayDensity: 'bad', desktopOverlayCompactStyle: 'bad', desktopOverlayShowSessionCount: 'bad',
        desktopOverlayAutoHideEnabled: 'bad', desktopOverlayAutoHideDelayMs: 'bad', desktopOverlayShowPreviewText: true,
        desktopPetOverlayVisibilityModeOverride: 'alwaysWhenEnabled', desktopPetOverlayOffset: { x: 9, y: 4 },
    };
    it('strips retired values without resetting deliberate canonical and unrelated preferences', () => {
        const input = { ...retired, desktopOverlayVisibilityMode: 'active_sessions', themePreference: 'dark',
            petsEnabledOverride: 'disabled', desktopPetOverlayEnabledOverride: 'enabled' };
        for (const parsed of [localSettingsParse(input), applyLocalSettings(localSettingsParse(input), retired)]) {
            expect(parsed).toMatchObject({ desktopOverlayVisibilityMode: 'active_sessions', themePreference: 'dark',
                petsEnabledOverride: 'disabled', desktopPetOverlayEnabledOverride: 'enabled' });
            for (const key of Object.keys(retired)) expect(parsed).not.toHaveProperty(key);
            expect(localSettingsParse(parsed)).toEqual(parsed);
        }
        expect(localSettingsParse(retired).desktopOverlayVisibilityMode).toBe('attention_only');
    });
    it('strips only retired nested overrides and retains all quick replies and unrelated branches', () => {
        const phrases = [' One ', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
        const parsed = localSettingsParse({ themePreference: 'dark', attentionDeviceOverridesV1: {
            desktopOverlay: { compactCollapsedMode: 'bad', physicalNotchMode: 'bad', autoDismissDelayMs: 'bad',
                collapsedCarouselEnabled: 'bad', hoverExpandDelay: 'slow', quickReplyPhrases: phrases },
            widgets: { enabled: false },
        } });
        expect(parsed.themePreference).toBe('dark');
        expect(parsed.attentionDeviceOverridesV1).toMatchObject({ desktopOverlay: {
            hoverExpandDelay: 'slow', quickReplyPhrases: phrases.map(value => value.trim()) },
            widgets: { enabled: false } });
        for (const key of ['compactCollapsedMode', 'physicalNotchMode', 'autoDismissDelayMs', 'collapsedCarouselEnabled'])
            expect(parsed.attentionDeviceOverridesV1.desktopOverlay).not.toHaveProperty(key);
    });
});
