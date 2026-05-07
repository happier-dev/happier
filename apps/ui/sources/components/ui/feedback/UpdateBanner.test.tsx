import * as React from 'react';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('./AppUpdateStatusTag', async () => {
    const ReactModule = await import('react');
    return {
        AppUpdateStatusTag: () => ReactModule.createElement('AppUpdateStatusTag', {
            testID: 'mock-app-update-status-tag',
        }),
    };
});

const originalPlatformOs = Platform.OS;

describe('UpdateBanner', () => {
    afterEach(() => {
        (Platform as unknown as { OS: typeof originalPlatformOs }).OS = originalPlatformOs;
        standardCleanup();
    });

    it('suppresses legacy content placement on web shells', async () => {
        (Platform as unknown as { OS: typeof originalPlatformOs }).OS = 'web';

        const { UpdateBanner } = await import('./UpdateBanner');
        const screen = await renderScreen(<UpdateBanner />);

        expect(screen.tree.toJSON()).toBeNull();
    });

    it('keeps the compatibility placement on native surfaces', async () => {
        (Platform as unknown as { OS: typeof originalPlatformOs }).OS = 'ios';

        const { UpdateBanner } = await import('./UpdateBanner');
        const screen = await renderScreen(<UpdateBanner />);

        expect(screen.findByProps({ testID: 'mock-app-update-status-tag' })).toBeTruthy();
    });
});
