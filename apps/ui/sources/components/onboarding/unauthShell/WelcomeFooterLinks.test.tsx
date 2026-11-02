import * as React from 'react';
import { Linking } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

import { WelcomeFooterLinks } from './WelcomeFooterLinks';

const alertSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: alertSpy } }).module;
});

describe('WelcomeFooterLinks', () => {
    afterEach(() => {
        standardCleanup();
        vi.restoreAllMocks();
        alertSpy.mockClear();
    });

    it('shows an OS link-launch failure and lets a later press try again', async () => {
        // Linking is the native OS boundary. Keep the actual link opener and action lifecycle.
        const rejectedLaunch = Promise.reject(new Error('Unable to open URL'));
        void rejectedLaunch.catch(() => {});
        const openUrl = vi.spyOn(Linking, 'openURL')
            .mockReturnValueOnce(rejectedLaunch)
            .mockResolvedValueOnce(undefined);
        const screen = await renderScreen(
            <WelcomeFooterLinks variant="mobile" onOpenRelayCustomFlow={() => {}} />,
        );

        await screen.pressByTestIdAsync('welcome-footer-github-action');

        expect(alertSpy).toHaveBeenCalledWith(
            t('common.error'),
            t('connectedServices.oauthPaste.alerts.failedToOpenUrl'),
            expect.any(Array),
        );

        alertSpy.mockClear();
        await screen.pressByTestIdAsync('welcome-footer-github-action');
        expect(openUrl).toHaveBeenCalledTimes(2);
        expect(openUrl).toHaveBeenLastCalledWith('https://github.com/happier-dev/happier');
        expect(alertSpy).not.toHaveBeenCalled();
    });
});
