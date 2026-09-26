import { Linking } from 'react-native';

import { Modal, type AlertButton } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

type OpenBugReportFallbackDependencies = {
    canOpenUrl: (url: string) => Promise<boolean>;
    openUrl: (url: string) => Promise<void>;
    showAlert: (title: string, message: string, buttons?: AlertButton[]) => Promise<void> | void;
    copyUrl: (url: string) => Promise<boolean>;
};

type OpenBugReportIssueUrlSilentDependencies = {
    openUrl: (url: string) => Promise<void>;
};

export async function openBugReportFallbackIssueUrl(
    issueUrl: string,
    deps: Partial<OpenBugReportFallbackDependencies> = {},
): Promise<boolean> {
    const openUrl = deps.openUrl ?? Linking.openURL;
    const showAlert = deps.showAlert ?? ((title: string, message: string, buttons?: AlertButton[]) => Modal.alertAsync(title, message, buttons));
    const copyUrl = deps.copyUrl ?? setClipboardStringSafe;

    const normalizedUrl = String(issueUrl ?? '').trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
        await showAlert('Cannot open issue link', `Please open this URL manually:\n\n${normalizedUrl || '(missing url)'}`);
        return false;
    }

    try {
        await openUrl(normalizedUrl);
        return true;
    } catch {
        await showAlert(
            'Cannot open issue link',
            `Please open this URL manually:\n\n${normalizedUrl}`,
            [{
                text: t('common.copy'),
                onPress: () => {
                    void copyUrl(normalizedUrl);
                },
            }],
        );
        return false;
    }
}

export async function openBugReportIssueUrlSilently(
    issueUrl: string,
    deps: Partial<OpenBugReportIssueUrlSilentDependencies> = {},
): Promise<void> {
    const openUrl = deps.openUrl ?? Linking.openURL;

    const normalizedUrl = String(issueUrl ?? '').trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) return;

    try {
        await openUrl(normalizedUrl);
    } catch {
        // best-effort only
    }
}
