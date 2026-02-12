import { Linking } from 'react-native';

import { Modal } from '@/modal';

type OpenBugReportFallbackDependencies = {
    canOpenUrl: (url: string) => Promise<boolean>;
    openUrl: (url: string) => Promise<void>;
    showAlert: (title: string, message: string) => Promise<void> | void;
};

export async function openBugReportFallbackIssueUrl(
    issueUrl: string,
    deps: Partial<OpenBugReportFallbackDependencies> = {},
): Promise<boolean> {
    const canOpenUrl = deps.canOpenUrl ?? Linking.canOpenURL;
    const openUrl = deps.openUrl ?? Linking.openURL;
    const showAlert = deps.showAlert ?? Modal.alert;

    const normalizedUrl = String(issueUrl ?? '').trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
        await showAlert('Cannot open issue link', `Please open this URL manually:\n\n${normalizedUrl || '(missing url)'}`);
        return false;
    }

    try {
        const supported = await canOpenUrl(normalizedUrl);
        if (!supported) {
            await showAlert('Cannot open issue link', `Please open this URL manually:\n\n${normalizedUrl}`);
            return false;
        }

        await openUrl(normalizedUrl);
        return true;
    } catch {
        await showAlert('Cannot open issue link', `Please open this URL manually:\n\n${normalizedUrl}`);
        return false;
    }
}
