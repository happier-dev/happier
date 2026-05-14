import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getDeviceLocales: vi.fn(() => [{ languageCode: 'en', languageScriptCode: null }]),
}));

vi.mock('./deviceLocales', () => ({
    getDeviceLocales: mocks.getDeviceLocales,
}));

describe('text/i18n device locale resolution', () => {
    it('caches the resolved device language instead of reading device locales for every translation', async () => {
        const { t, tLoose } = await import('./i18n');

        expect(t('tabs.inbox')).toBe('Inbox');
        expect(tLoose('tabs.settings')).toBe('Settings');
        expect(t('common.error')).toBe('Error');

        expect(mocks.getDeviceLocales).toHaveBeenCalledTimes(1);
    });
});
