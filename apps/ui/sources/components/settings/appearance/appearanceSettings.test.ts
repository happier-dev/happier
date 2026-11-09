import { describe, expect, it } from 'vitest';
import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { APPEARANCE_GLASS_SETTINGS } from './appearanceSettings';

describe('New backdrop native availability', () => {
    it.each(['ios', 'android'] as const)('exposes its declared setting to %s search and Actions', os => {
        expect(settingRendersOnHost(APPEARANCE_GLASS_SETTINGS.settings.newSessionBackdropStrength, { os, desktop: false })).toBe(true);
    });
});
