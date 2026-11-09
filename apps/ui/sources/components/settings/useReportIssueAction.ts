import { Linking } from 'react-native';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { openExternalUrlOrThrow } from '@/hooks/ui/useOpenExternalUrl';

export function useReportIssueAction(navigateToComposer: () => void) {
    return useHappyAction(async () => {
        recordBugReportUserAction('settings.report_issue_open');
        const overrideUrl = String(process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL ?? '').trim();
        if (overrideUrl.length > 0) {
            if (/^https?:\/\//i.test(overrideUrl)) {
                await openExternalUrlOrThrow(overrideUrl);
                return;
            }
            const supported = await Linking.canOpenURL(overrideUrl);
            if (supported) {
                await Linking.openURL(overrideUrl);
                return;
            }
        }
        navigateToComposer();
    });
}
