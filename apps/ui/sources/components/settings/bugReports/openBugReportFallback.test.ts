import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('openBugReportFallbackIssueUrl', () => {
    const originalOs = Platform.OS;

    beforeEach(() => {
        Platform.OS = originalOs;
    });

    it('opens the fallback issue URL when openUrl succeeds', async () => {
        const { openBugReportFallbackIssueUrl } = await import('./openBugReportFallback');
        const canOpenUrl = vi.fn(async () => false);
        const openUrl = vi.fn(async () => {});
        const showAlert = vi.fn(async () => {});

        const opened = await openBugReportFallbackIssueUrl('https://github.com/happier-dev/happier/issues/new', {
            canOpenUrl,
            openUrl,
            showAlert,
        });

        expect(opened).toBe(true);
        expect(openUrl).toHaveBeenCalledTimes(1);
        expect(showAlert).not.toHaveBeenCalled();
        expect(canOpenUrl).not.toHaveBeenCalled();
    });

    it('shows an alert and returns false when openUrl throws', async () => {
        const { openBugReportFallbackIssueUrl } = await import('./openBugReportFallback');
        const canOpenUrl = vi.fn(async () => true);
        const openUrl = vi.fn(async () => {
            throw new Error('open failed');
        });
        const showAlert = vi.fn(async () => {});

        const opened = await openBugReportFallbackIssueUrl('https://github.com/happier-dev/happier/issues/new', {
            canOpenUrl,
            openUrl,
            showAlert,
        });

        expect(opened).toBe(false);
        expect(openUrl).toHaveBeenCalledTimes(1);
        expect(showAlert).toHaveBeenCalledTimes(1);
        expect(canOpenUrl).not.toHaveBeenCalled();
    });

    it('rejects non-http(s) URLs', async () => {
        const { openBugReportFallbackIssueUrl } = await import('./openBugReportFallback');
        const canOpenUrl = vi.fn(async () => true);
        const openUrl = vi.fn(async () => {});
        const showAlert = vi.fn(async () => {});

        const opened = await openBugReportFallbackIssueUrl('javascript:alert(1)', {
            canOpenUrl,
            openUrl,
            showAlert,
        });

        expect(opened).toBe(false);
        expect(canOpenUrl).not.toHaveBeenCalled();
        expect(openUrl).not.toHaveBeenCalled();
        expect(showAlert).toHaveBeenCalledTimes(1);
    });

    it('uses the default Modal.alert dependency on web without throwing', async () => {
        Platform.OS = 'web';

        const { Modal } = await import('@/modal');
        const { openBugReportFallbackIssueUrl } = await import('./openBugReportFallback');

        let modalType: string | null = null;
        Modal.setFunctions((config) => {
            modalType = config.type;
            return 'alert-1';
        }, () => {}, () => {});

        const canOpenUrl = vi.fn(async () => false);
        const openUrl = vi.fn(async () => {
            throw new Error('open failed');
        });

        await expect(
            openBugReportFallbackIssueUrl('https://github.com/happier-dev/happier/issues/new', {
                canOpenUrl,
                openUrl,
            }),
        ).resolves.toBe(false);

        expect(modalType).toBe('alert');
        expect(canOpenUrl).not.toHaveBeenCalled();
    });
});

describe('openBugReportIssueUrlSilently', () => {
    it('attempts to open the URL but does not throw when openUrl fails', async () => {
        const { openBugReportIssueUrlSilently } = await import('./openBugReportFallback');

        const openUrl = vi.fn(async () => {
            throw new Error('open failed');
        });

        await expect(
            openBugReportIssueUrlSilently('https://github.com/happier-dev/happier/issues/36', { openUrl }),
        ).resolves.toBeUndefined();

        expect(openUrl).toHaveBeenCalledTimes(1);
    });
});
