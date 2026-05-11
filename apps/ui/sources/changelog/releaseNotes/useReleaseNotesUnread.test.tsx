import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import Constants from 'expo-constants';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import {
    commitRemoteManifest,
    getCurrentReleaseId,
    resetManifestRuntimeCacheForTests,
} from './manifestRuntime';
import {
    clearCachedManifest,
    clearLastSeenReleaseId,
    setLastSeenReleaseId,
} from './storage';
import * as releaseNotesStorage from './storage';
import { useReleaseNotesUnread } from './useReleaseNotesUnread';

const originalEnv = { ...process.env };

const storageWithOptionalAssetIndexCache = releaseNotesStorage as typeof releaseNotesStorage & Readonly<{
    clearCachedAssetIndex?: () => void;
}>;

function makeManifestForCurrentTestVersion(): string {
    const releaseId = getCurrentReleaseId() ?? 'v0.0.0';
    return JSON.stringify({
        schemaVersion: 'v1',
        latestReleaseId: releaseId,
        generatedAt: '2026-05-09T00:00:00.000Z',
        assetBaseUrl: 'https://cdn.example/releases/',
        releases: [{
            releaseId,
            versionLabel: releaseId,
            publishedAt: '2026-05-09T00:00:00.000Z',
            titleKey: 'releaseNotes.v0.title',
            cards: [{
                kind: 'list',
                titleKey: 'releaseNotes.v0.card.title',
                rows: [{ iconId: 'sparkles', titleKey: 'releaseNotes.v0.row.title', bodyKey: 'releaseNotes.v0.row.body' }],
            }],
        }],
    });
}

describe('useReleaseNotesUnread', () => {
    beforeEach(() => {
        (Constants as { expoConfig?: { version?: string } }).expoConfig = { version: '0.0.0' };
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'app.ui.releaseNotes';
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = '';
        clearLastSeenReleaseId();
        clearCachedManifest();
        storageWithOptionalAssetIndexCache.clearCachedAssetIndex?.();
        resetManifestRuntimeCacheForTests();
    });

    afterEach(() => {
        standardCleanup();
        clearLastSeenReleaseId();
        clearCachedManifest();
        storageWithOptionalAssetIndexCache.clearCachedAssetIndex?.();
        resetManifestRuntimeCacheForTests();
        process.env = { ...originalEnv };
    });

    it('updates after the current release is marked seen', async () => {
        const releaseId = getCurrentReleaseId() ?? 'v0.0.0';
        commitRemoteManifest(makeManifestForCurrentTestVersion());

        const hook = await renderHook(() => useReleaseNotesUnread());

        expect(hook.getCurrent().hasUnread).toBe(true);

        await act(async () => {
            setLastSeenReleaseId(releaseId);
        });
        await flushHookEffects();

        expect(hook.getCurrent().hasUnread).toBe(false);
    });

    it('updates after a remote manifest is committed', async () => {
        const hook = await renderHook(() => useReleaseNotesUnread());

        expect(hook.getCurrent().hasUnread).toBe(false);

        await act(async () => {
            commitRemoteManifest(makeManifestForCurrentTestVersion());
        });
        await flushHookEffects();

        expect(hook.getCurrent().hasUnread).toBe(true);
    });

    it('keeps release-note unread status available without an explicit story allow', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = '';
        commitRemoteManifest(makeManifestForCurrentTestVersion());

        const hook = await renderHook(() => useReleaseNotesUnread());

        expect(hook.getCurrent().hasUnread).toBe(true);
    });
});
