import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('./AppUpdateStatusItemBanner', async () => {
    const ReactModule = await import('react');
    return {
        AppUpdateStatusItemBanner: () => ReactModule.createElement('AppUpdateStatusItemBanner', {
            testID: 'mock-app-update-status-item-banner',
        }),
    };
});

vi.mock('./AppUpdateStatusTag', async () => {
    const ReactModule = await import('react');
    return {
        AppUpdateStatusTag: () => ReactModule.createElement('AppUpdateStatusTag'),
    };
});

describe('UpdateBanner', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('uses the item-style update banner', async () => {
        const { UpdateBanner } = await import('./UpdateBanner');
        const screen = await renderScreen(<UpdateBanner />);

        expect(screen.findByProps({ testID: 'mock-app-update-status-item-banner' })).toBeTruthy();
    });
});
