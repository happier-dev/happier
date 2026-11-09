import { describe, expect, it } from 'vitest';

import { resolveAppearanceDefaults } from './appearanceDefaults';

describe('Appearance reset', () => {
    it('restores the separate New backdrop preference without changing New presentation', () => {
        const { account } = resolveAppearanceDefaults();
        expect(account.newSessionBackdropStrengthV1).toBe('soft');
        expect(account).not.toHaveProperty('newSessionPresentationModeV1');
    });

    it('restores the Bots default face style with the other Appearance defaults', () => {
        expect(resolveAppearanceDefaults().account.botFaceStyle).toBe('dither');
        expect(resolveAppearanceDefaults().account.botMotion).toBe('lively');
    });
});
