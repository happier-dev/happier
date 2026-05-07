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
    it('prioritizes native store updates over desktop, OTA, and changelog states', () => {
        const model = buildAppUpdateStatusModel({
            platformOs: 'ios',
            nativeUpdateUrl: 'https://example.test/store',
            desktop: {
                status: 'available',
                availableVersion: '2.0.0',
                error: null,
            },
            ota: {
                isUpdatePending: true,
            },
            changelog: {
                hasUnread: true,
            },
            t: fakeT,
        });

        expect(model.visible).toBe(true);
        if (!model.visible) {
            throw new Error('expected a visible model');
        }
        expect(model.kind).toBe('native-store');
        expect(model.label).toBe('Native update available');
        expect(model.actionLabel).toBe('Open the App Store update');
    });

    it('builds a desktop retry state when the desktop updater errors', () => {
        const model = buildAppUpdateStatusModel({
            platformOs: 'web',
            nativeUpdateUrl: null,
            desktop: {
                status: 'error',
                availableVersion: null,
                error: 'network timeout',
            },
            ota: {
                isUpdatePending: false,
            },
            changelog: {
                hasUnread: false,
            },
            t: fakeT,
        });

        expect(model.visible).toBe(true);
        if (!model.visible) {
            throw new Error('expected a visible model');
        }
        expect(model.kind).toBe('desktop');
        expect(model.actionLabel).toBe('Retry');
        expect(model.dismissLabel).toBe('Cancel');
        expect(model.message).toContain('network timeout');
    });

    it('keeps installing desktop updates visible without a dismiss action', () => {
        const model = buildAppUpdateStatusModel({
            platformOs: 'web',
            nativeUpdateUrl: null,
            desktop: {
                status: 'installing',
                availableVersion: '2.0.0',
                error: null,
            },
            ota: {
                isUpdatePending: true,
            },
            changelog: {
                hasUnread: true,
            },
            t: fakeT,
        });

        expect(model.visible).toBe(true);
        if (!model.visible) {
            throw new Error('expected a visible model');
        }
        expect(model.kind).toBe('desktop');
        expect(model.actionDisabled).toBe(true);
        expect(model.dismissLabel).toBeUndefined();
    });

    it('falls back to changelog when no update actions are available', () => {
        const model = buildAppUpdateStatusModel({
            platformOs: 'web',
            nativeUpdateUrl: null,
            desktop: {
                status: 'idle',
                availableVersion: null,
                error: null,
            },
            ota: {
                isUpdatePending: false,
            },
            changelog: {
                hasUnread: true,
            },
            t: fakeT,
        });

        expect(model.visible).toBe(true);
        if (!model.visible) {
            throw new Error('expected a visible model');
        }
        expect(model.kind).toBe('changelog');
        expect(model.label).toBe("What's New");
        expect(model.actionLabel).toBe('See latest changes');
    });
});
