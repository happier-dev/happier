import { describe, expect, it } from 'vitest';

import { localSettingsDefaults, localSettingsParse } from './localSettings';

describe('localSettingsParse', () => {
    it('includes multi-pane and pane tab defaults', () => {
        const parsed = localSettingsParse(null);
        expect(parsed.uiMultiPanePanelsEnabled).toBe(true);
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
        expect(parsed.localNotificationsShowPendingPermissionRequests).toBe(true);
        expect(parsed.localNotificationsShowPendingUserActionRequests).toBe(true);
        expect(parsed.localNotificationsForegroundBehavior).toBe('full');
        expect(typeof (parsed as any).sidebarWidthPx).toBe('number');
        expect(typeof (parsed as any).sidebarWidthBasisPx).toBe('number');
        expect((parsed as any).bottomPaneHeightPx).toBe(320);
        expect((parsed as any).bottomPaneHeightBasisPx).toBe(900);
        expect((parsed as any).embeddedTerminalDockLocation).toBe('bottom');
    });

    it('returns defaults for non-object input', () => {
        expect(localSettingsParse(null)).toEqual(localSettingsDefaults);
        expect(localSettingsParse(undefined)).toEqual(localSettingsDefaults);
        expect(localSettingsParse('nope')).toEqual(localSettingsDefaults);
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

    it('accepts the middle ui item density selection', () => {
        const parsed = localSettingsParse({ uiItemDensity: 'cozy' });
        expect(parsed.uiItemDensity).toBe('cozy');
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
    });
});
