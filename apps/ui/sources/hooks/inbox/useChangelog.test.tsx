import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { MMKV } from 'react-native-mmkv';

import { getLatestReleaseId } from '@/changelog';
import { getLegacyChangelogAutoSeenBaseline } from '@/changelog/releaseNotes/storage';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANGELOG_LAST_VIEWED_RELEASE_ID_KEY = 'changelog-last-viewed-release-id';

type ChangelogSnapshot = {
    hasUnread: boolean;
    latestReleaseId: string | null;
};

type ChangelogSnapshotWithAction = ChangelogSnapshot & {
    markAsRead: () => void;
};

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

    it('marks the latest release as read on first install using a release id', async () => {
        const { useChangelog } = await import('./useChangelog');

        let latest: ChangelogSnapshot | null = null;
        let storedReleaseIdDuringRender: string | null = null;
        let storedBaselineDuringRender: string | null = null;

        function Probe() {
            const value = useChangelog();
            latest = {
                hasUnread: value.hasUnread,
                latestReleaseId: value.latestReleaseId,
            };
            const mmkv = new MMKV();
            storedReleaseIdDuringRender = mmkv.getString(CHANGELOG_LAST_VIEWED_RELEASE_ID_KEY) ?? null;
            storedBaselineDuringRender = getLegacyChangelogAutoSeenBaseline();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Probe))).tree;

        expect(latest).not.toBeNull();
        if (latest === null) {
            throw new Error('Expected changelog state to be captured');
        }
        const latestValue: ChangelogSnapshot = latest;
        expect(latestValue.hasUnread).toBe(false);
        expect(latestValue.latestReleaseId).toBe(getLatestReleaseId());
        expect(storedReleaseIdDuringRender).toBeNull();
        expect(storedBaselineDuringRender).toBeNull();
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(new MMKV().getString(CHANGELOG_LAST_VIEWED_RELEASE_ID_KEY)).toBe(getLatestReleaseId());
        expect(getLegacyChangelogAutoSeenBaseline()).toBe(getLatestReleaseId());
    });

    it('reports unread changelog entries when the last viewed release id differs', async () => {
        new MMKV().set(CHANGELOG_LAST_VIEWED_RELEASE_ID_KEY, '0.0.0');

        const { useChangelog } = await import('./useChangelog');

        let latest: ChangelogSnapshotWithAction | null = null;

        function Probe() {
            latest = useChangelog();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Probe))).tree;

        expect(latest).not.toBeNull();
        if (latest === null) {
            throw new Error('Expected changelog state to be captured');
        }
        const latestValue: ChangelogSnapshotWithAction = latest;
        expect(latestValue.hasUnread).toBe(true);
        expect(latestValue.latestReleaseId).toBe(getLatestReleaseId());

        act(() => {
            latestValue.markAsRead();
        });

        expect(new MMKV().getString(CHANGELOG_LAST_VIEWED_RELEASE_ID_KEY)).toBe(getLatestReleaseId());
    });
});
