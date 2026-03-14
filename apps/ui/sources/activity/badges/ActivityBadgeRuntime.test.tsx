import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

let platformOs: 'web' | 'ios' | 'android' = 'ios';
let isTauriDesktopValue = false;
let sessionsValue: any[] = [];
let friendRequestsValue: Array<{ id: string }> = [];
let localSettingsValue: Record<string, unknown> = {
    activityBadgesEnabled: true,
    activityBadgeShowUnread: true,
    activityBadgeShowPendingPermissionRequests: true,
    activityBadgeShowPendingUserActionRequests: true,
    activityBadgeShowQueuedUserInput: true,
    activityBadgeShowFriendRequestsInboxCount: true,
    activityBadgeShowDesktopNonNumericDot: true,
};
let updateAvailableValue = false;
let changelogUnreadValue = false;

const applyExpoNativeBadgeState = vi.hoisted(() => vi.fn(async () => {}));
const applyTauriBadgeState = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return platformOs;
        },
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllSessions: () => sessionsValue,
    useFriendRequests: () => friendRequestsValue,
    useLocalSettings: () => localSettingsValue,
}));

vi.mock('@/hooks/inbox/useUpdates', () => ({
    useUpdates: () => ({ updateAvailable: updateAvailableValue }),
}));

vi.mock('@/hooks/inbox/useChangelog', () => ({
    useChangelog: () => ({ hasUnread: changelogUnreadValue }),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopValue,
}));

vi.mock('./channels/applyExpoNativeBadgeState', () => ({
    applyExpoNativeBadgeState,
}));

vi.mock('./channels/applyTauriBadgeState', () => ({
    applyTauriBadgeState,
}));

describe('ActivityBadgeRuntime', () => {
    afterEach(() => {
        platformOs = 'ios';
        isTauriDesktopValue = false;
        sessionsValue = [];
        friendRequestsValue = [];
        localSettingsValue = {
            activityBadgesEnabled: true,
            activityBadgeShowUnread: true,
            activityBadgeShowPendingPermissionRequests: true,
            activityBadgeShowPendingUserActionRequests: true,
            activityBadgeShowQueuedUserInput: true,
            activityBadgeShowFriendRequestsInboxCount: true,
            activityBadgeShowDesktopNonNumericDot: true,
        };
        updateAvailableValue = false;
        changelogUnreadValue = false;
        applyExpoNativeBadgeState.mockClear();
        applyTauriBadgeState.mockClear();
    });

    it('applies the native mobile badge count from session and inbox activity', async () => {
        sessionsValue = [
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 0,
                pendingCount: 1,
                metadata: { path: '', host: '' },
            },
        ];
        friendRequestsValue = [{ id: 'friend-1' }, { id: 'friend-2' }];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityBadgeRuntime />);
        });

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 3,
            showNonNumericDot: false,
        });
        expect(applyTauriBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('clears badge channels when badges are disabled on this device', async () => {
        sessionsValue = [
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                metadata: { path: '', host: '' },
            },
        ];
        friendRequestsValue = [{ id: 'friend-1' }];
        localSettingsValue = {
            ...localSettingsValue,
            activityBadgesEnabled: false,
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityBadgeRuntime />);
        });

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('shows the tauri dock dot only for non-numeric inbox attention when enabled', async () => {
        platformOs = 'web';
        isTauriDesktopValue = true;
        updateAvailableValue = true;

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityBadgeRuntime />);
        });

        expect(applyTauriBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: true,
        });
        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });
});
