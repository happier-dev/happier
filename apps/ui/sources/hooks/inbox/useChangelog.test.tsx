import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { MMKV } from 'react-native-mmkv';

import { getLatestReleaseId } from '@/changelog';
import { getLegacyChangelogAutoSeenBaseline } from '@/changelog/releaseNotes/storage';
import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANGELOG_LAST_VIEWED_RELEASE_ID_KEY = 'changelog-last-viewed-release-id';

type ChangelogSnapshot = Readonly<{
    hasUnread: boolean;
    latestReleaseId: string | null;
}>;

describe('useChangelog', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        new MMKV().clearAll();
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    });

    afterEach(() => {
        if (tree) {
            act(() => {
                tree?.unmount();
            });
            tree = null;
        }

        if (previousDeny === undefined) {
            delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        } else {
            process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('keeps upgraded users unread, acknowledges across mounted consumers, and stays read after reopening', async () => {
        new MMKV().set('changelog-last-viewed-version', 1);
        const { useChangelog } = await import('./useChangelog');
        const { setLastViewedReleaseId, getLastViewedReleaseId } = await import('@/changelog');
        let latest: ChangelogSnapshot | null = null;
        function Probe() {
            const value = useChangelog();
            latest = { hasUnread: value.hasUnread, latestReleaseId: value.latestReleaseId };
            return React.createElement('View');
        }
        tree = (await renderScreen(React.createElement(Probe))).tree;
        expect(getLastViewedReleaseId()).toBe('1');
        expect(latest).toEqual({ hasUnread: true, latestReleaseId: getLatestReleaseId() });
        act(() => { setLastViewedReleaseId(getLatestReleaseId()!); });
        expect(latest).toEqual({ hasUnread: false, latestReleaseId: getLatestReleaseId() });
        act(() => { tree?.unmount(); });
        tree = (await renderScreen(React.createElement(Probe))).tree;
        expect(latest).toEqual({ hasUnread: false, latestReleaseId: getLatestReleaseId() });
        expect(new MMKV().getNumber('changelog-last-viewed-version')).toBe(1);
    });

    it('records when it auto-marks old changelog entries as read on first install', async () => {
        const { useChangelog } = await import('./useChangelog');
        const latestReleaseId = getLatestReleaseId();
        let latest: ChangelogSnapshot | null = null;

        function Probe() {
            const value = useChangelog();
            latest = {
                hasUnread: value.hasUnread,
                latestReleaseId: value.latestReleaseId,
            };
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Probe))).tree;

        expect(latest).toEqual({ hasUnread: false, latestReleaseId });
        expect(new MMKV().getString(CHANGELOG_LAST_VIEWED_RELEASE_ID_KEY)).toBe(latestReleaseId);
        expect(getLegacyChangelogAutoSeenBaseline()).toBe(latestReleaseId);
    });
});
