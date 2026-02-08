import { describe, expect, it } from 'vitest';

import { getDesktopUpdateBannerModel } from './desktopUpdateBannerModel';

function fakeT(key: string) {
    const map: Record<string, string> = {
        'common.error': 'Error',
        'common.retry': 'Retry',
        'common.loading': 'Loading...',
        'updateBanner.updateAvailable': 'Update available',
        'updateBanner.pressToApply': 'Press to apply the update',
    };
    return map[key] ?? key;
}

describe('getDesktopUpdateBannerModel', () => {
    it('builds available copy with version and update action', () => {
        const model = getDesktopUpdateBannerModel({
            status: 'available',
            availableVersion: '1.2.3',
            error: null,
            t: fakeT,
        });

        expect(model.message).toBe('Update available: v1.2.3');
        expect(model.actionLabel).toBe('Press to apply the update');
        expect(model.actionDisabled).toBe(false);
    });

    it('builds retry action for error state', () => {
        const model = getDesktopUpdateBannerModel({
            status: 'error',
            availableVersion: null,
            error: 'network timeout',
            t: fakeT,
        });

        expect(model.message).toBe('Error');
        expect(model.actionLabel).toBe('Retry');
        expect(model.actionDisabled).toBe(false);
    });

    it('marks install action as disabled while installing', () => {
        const model = getDesktopUpdateBannerModel({
            status: 'installing',
            availableVersion: null,
            error: null,
            t: fakeT,
        });

        expect(model.actionLabel).toBe('Loading...');
        expect(model.actionDisabled).toBe(true);
    });
});
