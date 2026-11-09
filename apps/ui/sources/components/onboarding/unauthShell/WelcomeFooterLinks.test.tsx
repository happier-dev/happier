import * as React from 'react';
import { Linking } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';
import { t } from '@/text';


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

// Initialize the real Action registry once before importing its UI consumer.
await import('@/sync/ops/actions/defaultActionExecutor');

let restoreAuth: () => void;
beforeEach(() => {
    restoreAuth = installSignedOutAuthForTest();
});

describe('WelcomeFooterLinks', () => {
    afterEach(() => {
        standardCleanup();
        restoreAuth();
        vi.restoreAllMocks();
        alertSpy.mockClear();
    });

    it('shows an OS link-launch failure and lets a later press try again', async () => {
        // Exercise real Action admission and URL opening; Linking is the native OS boundary.
        const rejectedLaunch = Promise.reject(new Error('Unable to open URL'));
        void rejectedLaunch.catch(() => {});
        const openUrl = vi.spyOn(Linking, 'openURL')
            .mockReturnValueOnce(rejectedLaunch)
            .mockResolvedValueOnce(undefined);
        const { WelcomeFooterLinks } = await import('./WelcomeFooterLinks');
        const screen = await renderScreen(<WelcomeFooterLinks variant="mobile" />);

        await screen.pressByTestIdAsync('welcome-footer-github-action');

        await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://github.com/happier-dev/happier'));
        await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
            t('common.error'),
            t('connectedServices.oauthPaste.alerts.failedToOpenUrl'),
            expect.any(Array),
        ));

        alertSpy.mockClear();
        await screen.pressByTestIdAsync('welcome-footer-github-action');
        expect(openUrl).toHaveBeenCalledTimes(2);
        expect(openUrl).toHaveBeenLastCalledWith('https://github.com/happier-dev/happier');
        expect(alertSpy).not.toHaveBeenCalled();
    });
});
