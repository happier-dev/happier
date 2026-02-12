import { describe, expect, it, vi } from 'vitest';

import { openBugReportFallbackIssueUrl } from './openBugReportFallback';

describe('openBugReportFallbackIssueUrl', () => {
    it('opens the fallback issue URL when supported', async () => {
        const canOpenUrl = vi.fn(async () => true);
        const openUrl = vi.fn(async () => {});
        const showAlert = vi.fn(async () => {});

        const opened = await openBugReportFallbackIssueUrl('https://github.com/happier-dev/happier/issues/new', {
            canOpenUrl,
            openUrl,
            showAlert,
        });

        expect(opened).toBe(true);
        expect(canOpenUrl).toHaveBeenCalledTimes(1);
        expect(openUrl).toHaveBeenCalledTimes(1);
        expect(showAlert).not.toHaveBeenCalled();
    });

    it('shows an alert and returns false when URL cannot be opened', async () => {
        const canOpenUrl = vi.fn(async () => false);
        const openUrl = vi.fn(async () => {});
        const showAlert = vi.fn(async () => {});

        const opened = await openBugReportFallbackIssueUrl('https://github.com/happier-dev/happier/issues/new', {
            canOpenUrl,
            openUrl,
            showAlert,
        });

        expect(opened).toBe(false);
        expect(canOpenUrl).toHaveBeenCalledTimes(1);
        expect(openUrl).not.toHaveBeenCalled();
        expect(showAlert).toHaveBeenCalledTimes(1);
    });

    it('returns false and shows alert when openURL throws', async () => {
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
        expect(canOpenUrl).toHaveBeenCalledTimes(1);
        expect(openUrl).toHaveBeenCalledTimes(1);
        expect(showAlert).toHaveBeenCalledTimes(1);
    });

    it('rejects non-http(s) URLs', async () => {
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
});
