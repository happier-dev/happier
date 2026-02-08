import { describe, expect, it } from 'vitest';

describe('desktop updates state', () => {
    it('shows banner when update exists and not dismissed', async () => {
        const { shouldShowDesktopUpdateBanner } = await import('./state');
        expect(shouldShowDesktopUpdateBanner({ availableVersion: '1.2.3', dismissedVersion: null })).toBe(true);
    });

    it('hides banner when no update exists', async () => {
        const { shouldShowDesktopUpdateBanner } = await import('./state');
        expect(shouldShowDesktopUpdateBanner({ availableVersion: null, dismissedVersion: null })).toBe(false);
    });

    it('hides banner when dismissed version matches available version', async () => {
        const { shouldShowDesktopUpdateBanner } = await import('./state');
        expect(shouldShowDesktopUpdateBanner({ availableVersion: '1.2.3', dismissedVersion: '1.2.3' })).toBe(false);
    });

    it('shows banner when dismissed version differs from available version', async () => {
        const { shouldShowDesktopUpdateBanner } = await import('./state');
        expect(shouldShowDesktopUpdateBanner({ availableVersion: '1.2.3', dismissedVersion: '1.2.2' })).toBe(true);
    });
});
