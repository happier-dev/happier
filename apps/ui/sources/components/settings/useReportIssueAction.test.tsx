import * as React from 'react';
import { Linking, Pressable } from 'react-native';
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

await import('@/sync/ops/actions/defaultActionExecutor');
const { useReportIssueAction } = await import('./useReportIssueAction');
const navigateToComposer = vi.fn();
function ReportIssueAction() {
    const [, open] = useReportIssueAction(navigateToComposer);
    return <Pressable testID="report-issue" onPress={open} />;
}

let restoreAuth: () => void;
let previousUrl: string | undefined;
beforeEach(() => {
    restoreAuth = installSignedOutAuthForTest();
    previousUrl = process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
});
afterEach(() => {
    standardCleanup();
    restoreAuth();
    if (previousUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
    else process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = previousUrl;
    vi.restoreAllMocks();
    alertSpy.mockClear();
    navigateToComposer.mockClear();
});

describe('Report issue action', () => {
    it('shows an HTTPS override launch failure and allows a later successful press', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = 'https://example.test/report-issue';
        const rejectedLaunch = Promise.reject(new Error('Unable to open URL'));
        void rejectedLaunch.catch(() => {});
        const openUrl = vi.spyOn(Linking, 'openURL')
            .mockReturnValueOnce(rejectedLaunch)
            .mockResolvedValueOnce(undefined);
        const screen = await renderScreen(<ReportIssueAction />);

        await screen.pressByTestIdAsync('report-issue');
        await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://example.test/report-issue'));
        await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
            t('common.error'),
            t('connectedServices.oauthPaste.alerts.failedToOpenUrl'),
            [{ text: t('common.ok'), style: 'cancel' }],
        ));

        alertSpy.mockClear();
        await screen.pressByTestIdAsync('report-issue');
        await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2));
        expect(alertSpy).not.toHaveBeenCalled();
        expect(navigateToComposer).not.toHaveBeenCalled();
    });

    it('keeps the composer fallback for an unsupported custom URL scheme', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = 'support-test://report';
        vi.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
        const openUrl = vi.spyOn(Linking, 'openURL');
        const screen = await renderScreen(<ReportIssueAction />);

        await screen.pressByTestIdAsync('report-issue');
        await vi.waitFor(() => expect(navigateToComposer).toHaveBeenCalledOnce());
        expect(openUrl).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
    });
});
