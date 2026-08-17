import { describe, expect, it } from 'vitest';

import { buildAppUpdateStatusModel } from './buildAppUpdateStatusModel';

function fakeT(key: string): string {
    const map: Record<string, string> = {
        'common.retry': 'Retry',
        'common.loading': 'Loading...',
        'common.cancel': 'Cancel',
        'navigation.whatsNew': "What's New",
        'updateBanner.nativeUpdateAvailable': 'Native update available',
        'updateBanner.tapToUpdateAppStore': 'Open the App Store update',
        'updateBanner.tapToUpdatePlayStore': 'Open the Play Store update',
        'updateBanner.updateAvailable': 'Update available',
        'updateBanner.pressToApply': 'Apply update',
        'updateBanner.seeLatest': 'See latest changes',
    };

    return map[key] ?? key;
}

describe('buildAppUpdateStatusModel', () => {
    it('offers a refresh when the same UI origin reports a different deployment', () => {
        const model = buildAppUpdateStatusModel({
            platformOs: 'web',
            nativeUpdateUrl: null,
            webUi: { updateAvailable: true },
            desktop: { status: 'idle', availableVersion: null, error: null },
            ota: { isUpdatePending: false },
            releaseNotes: { hasUnread: false },
            changelog: { hasUnread: false },
            t: fakeT,
        });
        expect(model).toMatchObject({
            visible: true,
            kind: 'web-ui',
            actionLabel: 'Apply update',
        });
    });

    it('prioritizes native store updates over desktop, OTA, release-notes, and changelog states', () => {
        const model = buildAppUpdateStatusModel({
            platformOs: 'ios',
            nativeUpdateUrl: 'https://example.test/store',
            desktop: { status: 'available', availableVersion: '2.0.0', error: null },
            ota: { isUpdatePending: true },
            releaseNotes: { hasUnread: true },
            changelog: { hasUnread: true },
            t: fakeT,
        });

        expect(model.visible).toBe(true);
        if (!model.visible) throw new Error('expected a visible model');
        expect(model.kind).toBe('native-store');
        expect(model.label).toBe('Native update available');
        expect(model.actionLabel).toBe('Open the App Store update');
    });

    it('builds a desktop retry state when the desktop updater errors', () => {
        const model = buildAppUpdateStatusModel({
            platformOs: 'web',
            nativeUpdateUrl: null,
            desktop: { status: 'error', availableVersion: null, error: 'network timeout' },
            ota: { isUpdatePending: false },
            releaseNotes: { hasUnread: false },
            changelog: { hasUnread: false },
            t: fakeT,
        });

        expect(model.visible).toBe(true);
        if (!model.visible) throw new Error('expected a visible model');
        expect(model.kind).toBe('desktop');
        expect(model.actionLabel).toBe('Retry');
        expect(model.dismissLabel).toBe('Cancel');
        expect(model.message).toContain('network timeout');
    });

    it('prefers release-notes over changelog when both are unread', () => {
        const model = buildAppUpdateStatusModel({
            platformOs: 'web',
            nativeUpdateUrl: null,
            desktop: { status: 'idle', availableVersion: null, error: null },
            ota: { isUpdatePending: false },
            releaseNotes: { hasUnread: true },
            changelog: { hasUnread: true },
            t: fakeT,
        });

        expect(model.visible).toBe(true);
        if (!model.visible) throw new Error('expected a visible model');
        expect(model.kind).toBe('release-notes');
        expect(model.actionLabel).toBe('See latest changes');
    });

    it('falls back to changelog when no update actions and no release-notes are unread', () => {
        const model = buildAppUpdateStatusModel({
            platformOs: 'web',
            nativeUpdateUrl: null,
            desktop: { status: 'idle', availableVersion: null, error: null },
            ota: { isUpdatePending: false },
            releaseNotes: { hasUnread: false },
            changelog: { hasUnread: true },
            t: fakeT,
        });

        expect(model.visible).toBe(true);
        if (!model.visible) throw new Error('expected a visible model');
        expect(model.kind).toBe('changelog');
        expect(model.label).toBe("What's New");
        expect(model.actionLabel).toBe('See latest changes');
    });
});
