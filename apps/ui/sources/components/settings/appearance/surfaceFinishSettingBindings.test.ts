import { describe, expect, it } from 'vitest';
import { APPEARANCE_SETTINGS } from './appearanceSettings';
import { localSettingsDefaults, applyLocalSettings, localSettingsParse } from '@/sync/domains/settings/localSettings';
import { THEME_SURFACE_FINISH_ROLES, resolveThemeStyleScales, themeStyleSelectionFromSurfaceFinish } from '@/theme/themeStyleScales';

describe('Appearance surface finish settings owner', () => {
    it('reads prior settings as soft and retains valid role preferences when a neighboring saved value is unknown', () => {
        expect(localSettingsParse({}).uiSurfaceFinish).toBe('soft');
        const saved = localSettingsParse({ uiSurfaceFinish: 'glossy', uiSurfaceFinishOverrides: { card: 'flat', composer: 'glossy', floating: 'soft', future: 'flat' } });
        expect(saved.uiSurfaceFinish).toBe('soft');
        expect(saved.uiSurfaceFinishOverrides).toEqual({ card: 'flat', composer: undefined, floating: 'soft' });
        expect(resolveThemeStyleScales(themeStyleSelectionFromSurfaceFinish(saved)).parts.composer.finish).toBe('soft');
    });
    it('declares each choice and applies overrides or inheritance while preserving neighboring roles', async () => {
        const global = APPEARANCE_SETTINGS.settings.surfaceFinish.storage;
        expect(global).toMatchObject({ scope: 'local', key: 'uiSurfaceFinish', allowedValues: ['flat', 'soft'] });
        const declarations = [
            APPEARANCE_SETTINGS.settings.surfaceFinishCard,
            APPEARANCE_SETTINGS.settings.surfaceFinishFloating,
            APPEARANCE_SETTINGS.settings.surfaceFinishComposer,
            APPEARANCE_SETTINGS.settings.surfaceFinishPrimaryButton,
            APPEARANCE_SETTINGS.settings.surfaceFinishSecondaryButton,
        ];
        let local = applyLocalSettings(localSettingsDefaults, { uiSurfaceFinish: 'flat' });
        const write = (delta: Parameters<typeof applyLocalSettings>[1]) => { local = applyLocalSettings(local, delta); };
        for (const declaration of declarations) {
            const binding = declaration.storage;
            if (!binding || binding.scope !== 'local' || !('kind' in binding) || binding.kind !== 'localOwner') throw new Error('Missing finish owner binding');
            expect(binding.allowedValues).toEqual(['auto', 'flat', 'soft']);
            expect(binding.read(local)).toBe('auto');
            expect(binding.parse('glossy')).toEqual({ success: false });
            await binding.commit(local, 'soft', write);
            expect(binding.read(local)).toBe('soft');
        }
        for (const role of THEME_SURFACE_FINISH_ROLES) expect(resolveThemeStyleScales(themeStyleSelectionFromSurfaceFinish(local)).parts[role].finish).toBe('soft');
        const card = declarations[0].storage;
        if (!card || card.scope !== 'local' || !('kind' in card) || card.kind !== 'localOwner') throw new Error('Missing card binding');
        await card.commit(local, 'auto', write);
        expect(local.uiSurfaceFinishOverrides.card).toBeUndefined();
        expect(local.uiSurfaceFinishOverrides.floating).toBe('soft');
        expect(resolveThemeStyleScales(themeStyleSelectionFromSurfaceFinish(local)).parts.card.finish).toBe('flat');
    });
});
