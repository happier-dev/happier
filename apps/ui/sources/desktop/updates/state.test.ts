import { describe, expect, it } from 'vitest';

describe('desktop updates state', () => {
    it('shows status when update exists and not dismissed', async () => {
        const { shouldShowDesktopUpdateStatus } = await import('./state');
        expect(shouldShowDesktopUpdateStatus({ availableVersion: '1.2.3', dismissedVersion: null })).toBe(true);
    });

    it('hides status when no update exists', async () => {
        const { shouldShowDesktopUpdateStatus } = await import('./state');
        expect(shouldShowDesktopUpdateStatus({ availableVersion: null, dismissedVersion: null })).toBe(false);
    });

    it('hides status when dismissed version matches available version', async () => {
        const { shouldShowDesktopUpdateStatus } = await import('./state');
        expect(shouldShowDesktopUpdateStatus({ availableVersion: '1.2.3', dismissedVersion: '1.2.3' })).toBe(false);
    });

    it('shows status when dismissed version differs from available version', async () => {
        const { shouldShowDesktopUpdateStatus } = await import('./state');
        expect(shouldShowDesktopUpdateStatus({ availableVersion: '1.2.3', dismissedVersion: '1.2.2' })).toBe(true);
    });
});
