import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_DEFINITIONS, accountSettingsParse } from '../../account/settings/accountSettings.js';
import { readPortableAccountSettingBindingV1 } from './accountSettingBindings.js';
import { readBuiltInSettingDeclarationV1, readBuiltInAccountSettingValueV1, parseBuiltInAccountSettingValueV1, buildBuiltInAccountSettingMutationV1 } from './settingsDeclarations.js';
import { glassPresetMaterials, readGlassMaterials, readGlassPreset, readGlassTintedMaterials, resolveGlassIntensitySettingsDelta, resolveGlassPresetSettingsDelta, resolveGlassSurfaceSettingsDelta, resolveGlassSurfaceModeSettingsDelta, resolveGlassTintSettingsDelta } from './glassPreferenceMutations.js';

describe('glass material preferences', () => {
    it('gives backed Elements the composer frost in Auto and Everywhere at any intensity, and a clearer coat in Clear', () => {
        expect(glassPresetMaterials('auto', 'light').card).toEqual({ blur: 'strong', opacity: 0.25 });
        expect(glassPresetMaterials('everywhere', 'regular').card).toEqual({ blur: 'strong', opacity: 0.25 });
        expect(glassPresetMaterials('clear', 'strong').card).toEqual({ blur: 'strong', opacity: 0.15 });
        expect(glassPresetMaterials('solid').card).toEqual({ blur: 'off', opacity: 1 });
    });

    // Owner 2026-11-11 (desktop #25a): no sidebar plate. Under Auto the sidebar column stands on the chrome coat.
    it('gives the Auto sidebar exactly the chrome coat at every blur step (no W3 lift)', () => {
        for (const intensity of ['light', 'regular', 'strong'] as const) {
            const auto = glassPresetMaterials('auto', intensity);
            expect(auto.sidebar).toEqual(auto.chrome);
        }
    });

    it('keeps the selected preset when only Elements changes, and changes no other group', () => {
        const settings = { glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('auto') };
        const delta = resolveGlassSurfaceModeSettingsDelta(settings, 'card', 'solid');
        expect(readGlassPreset({ ...settings, ...delta })).toBe('auto');
        for (const group of ['chrome', 'sidebar', 'content', 'floating'] as const) {
            expect(delta.glassSurfaceMaterials[group]).toEqual(settings.glassSurfaceMaterials[group]);
        }
        expect(readGlassPreset({ ...settings, ...resolveGlassSurfaceSettingsDelta(settings, 'sidebar', { blur: 'off', opacity: 1 }) })).toBe('custom');
    });

    it('preserves solid Elements through preset and intensity switches, updating glass Elements to the preset coat', () => {
        const settings = { glassBlurEnabled: true, glassSurfaceMaterials: { ...glassPresetMaterials('auto'), card: { blur: 'off' as const, opacity: 1 } } };
        for (const preset of ['solid', 'auto', 'everywhere', 'clear'] as const) {
            const changed = { ...settings, ...resolveGlassPresetSettingsDelta(settings, preset) };
            expect(readGlassMaterials(changed).card).toEqual({ blur: 'off', opacity: 1 });
            expect(readGlassPreset(changed)).toBe(preset);
        }
        expect(readGlassMaterials({ ...settings, ...resolveGlassIntensitySettingsDelta(settings, 'strong') }).card).toEqual({ blur: 'off', opacity: 1 });
        const glass = { glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('auto') };
        expect(readGlassMaterials({ ...glass, ...resolveGlassPresetSettingsDelta(glass, 'clear') }).card).toEqual({ blur: 'strong', opacity: 0.15 });
        const solidPreset = { ...glass, ...resolveGlassPresetSettingsDelta(glass, 'solid') };
        expect(readGlassMaterials({ ...solidPreset, ...resolveGlassPresetSettingsDelta(solidPreset, 'auto') }).card).toEqual({ blur: 'strong', opacity: 0.25 });
        const clear = { ...glass, ...resolveGlassPresetSettingsDelta(glass, 'clear') };
        const authoredClear = { ...clear, ...resolveGlassSurfaceSettingsDelta(clear, 'card', { opacity: 0.33 }) };
        const restoredClear = { ...authoredClear, ...resolveGlassSurfaceModeSettingsDelta(authoredClear, 'card', 'glass') };
        expect(readGlassPreset(restoredClear)).toBe('clear');
        expect(readGlassMaterials(restoredClear).card).toEqual({ blur: 'strong', opacity: 0.15 });
    });

    it('defaults the glass tint to 12 and interpolates only named Elements and floating coats', () => {
        const parsed = accountSettingsParse({});
        expect(parsed.glassTintIntensity).toBe(12);
        expect(ACCOUNT_SETTING_DEFINITIONS.glassTintIntensity).toBeDefined();
        const auto = { glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('auto') };
        const coats = (tint: number, settings: Parameters<typeof readGlassTintedMaterials>[0] = auto) =>
            readGlassTintedMaterials({ ...settings, ...resolveGlassTintSettingsDelta(settings, tint) });
        // Subtle is a hair of paint, as thin as the fixed point allows; Medium the earlier faint coat; Strong a frosted one.
        for (const [tint, card, clearCard, floating] of [[0, 0.01, 0.01, 0.01], [12, 0.0676, 0.0436, 0.0124], [50, 0.25, 0.15, 0.02], [100, 0.45, 0.3, 0.25]] as const) {
            expect(coats(tint).card.opacity).toBeCloseTo(card);
            expect(coats(tint, { glassSurfaceMaterials: glassPresetMaterials('clear') }).card.opacity).toBeCloseTo(clearCard);
            expect(coats(tint).floating.opacity).toBeCloseTo(floating);
        }
        // The shell planes and the stored preset table do not move with the tint.
        for (const tint of [0, 12, 50, 73, 100]) {
            const changed = { ...auto, ...resolveGlassTintSettingsDelta(auto, tint) };
            expect(readGlassPreset(changed)).toBe('auto');
            expect(readGlassMaterials(changed)).toEqual(auto.glassSurfaceMaterials);
            for (const group of ['chrome', 'sidebar', 'content'] as const) expect(coats(tint)[group]).toEqual(auto.glassSurfaceMaterials[group]);
        }
        // Solid Elements, the Solid preset and authored (custom) tables keep their exact values.
        const solidCard = { ...auto, glassSurfaceMaterials: { ...auto.glassSurfaceMaterials, card: { blur: 'off' as const, opacity: 1 } } };
        expect(coats(12, solidCard).card).toEqual({ blur: 'off', opacity: 1 });
        const custom = { ...auto, ...resolveGlassSurfaceSettingsDelta(auto, 'card', { opacity: 0.33 }) };
        expect(readGlassPreset(custom)).toBe('custom');
        expect(coats(12, custom)).toEqual(custom.glassSurfaceMaterials);
        const masked = { ...custom, ...resolveGlassPresetSettingsDelta(custom, 'solid') };
        expect(readGlassMaterials(masked).card).toEqual({ blur: 'off', opacity: 1 });
        expect(masked.glassSurfaceMaterials.card.opacity).toBe(0.33);
        const restored = { ...masked, ...resolveGlassPresetSettingsDelta(masked, 'auto') };
        expect(readGlassPreset(restored)).toBe('auto');
        expect(coats(0, restored).card.opacity).toBe(0.01);
        // Equal numbers can carry different intent: an authored Medium value is not the default Glass toggle.
        const authoredDefault = { ...auto, ...resolveGlassSurfaceSettingsDelta(auto, 'card', { opacity: 0.25 }) };
        expect(coats(20, authoredDefault).card.opacity).toBe(0.25);
        expect(readGlassPreset(authoredDefault)).toBe('custom');
        const parsedAuthored = accountSettingsParse(authoredDefault);
        expect(coats(20, parsedAuthored).card.opacity).toBe(0.25);
        const toggled = { ...authoredDefault, ...resolveGlassSurfaceModeSettingsDelta(authoredDefault, 'card', 'glass') };
        expect(readGlassPreset(toggled)).toBe('auto');
        expect(coats(0, toggled).card.opacity).toBe(0.01);
        expect(coats(100, { glassBlurEnabled: false, glassSurfaceMaterials: auto.glassSurfaceMaterials }).floating).toEqual({ blur: 'off', opacity: 1 });
    });

    it('sets the tint through the declared portable owner', () => {
        const settings = accountSettingsParse({});
        const declaration = readBuiltInSettingDeclarationV1('appearance.glassTint');
        expect(declaration).not.toBeNull();
        if (!declaration) throw new Error('Tint declaration unavailable');
        expect(readBuiltInAccountSettingValueV1(declaration, settings)).toBe(12);
        for (const invalid of [-1, 101, 20.5, '35', 'medium', null, NaN, Infinity]) {
            expect(parseBuiltInAccountSettingValueV1(declaration, invalid).success).toBe(false);
            expect(buildBuiltInAccountSettingMutationV1(declaration, settings, invalid)).toBeNull();
        }
        for (const value of [0, 35, 100]) {
            expect(parseBuiltInAccountSettingValueV1(declaration, value)).toEqual({ success: true, value });
            const delta = buildBuiltInAccountSettingMutationV1(declaration, settings, value);
            expect(delta).toEqual({ glassTintIntensity: value });
            expect(accountSettingsParse({ ...settings, ...delta }).glassTintIntensity).toBe(value);
        }
        const binding = readPortableAccountSettingBindingV1({ storage: { owner: 'glassTintStorageBinding' } });
        expect(binding?.mutate(settings, 35)).toEqual({ glassTintIntensity: 35 });
        expect(binding?.mutate(settings, 35.5)).toBeNull();
    });

    it('reads a retained four-group table using its preset card coat without dropping its other choices', () => {
        const { card: _card, ...stored } = glassPresetMaterials('clear', 'strong');
        const settings = accountSettingsParse({ glassBlurEnabled: true, glassBlurIntensity: 'strong', glassSurfaceMaterials: stored });
        expect(readGlassMaterials(settings)).toEqual({ ...stored, card: { blur: 'strong', opacity: 0.15 } });
        expect(readGlassPreset(settings)).toBe('clear');
    });

    it('edits the declared Elements row through the portable owner while retaining the preset', () => {
        const settings = accountSettingsParse({});
        const declaration = readBuiltInSettingDeclarationV1('appearance.glassElements');
        expect(declaration).not.toBeNull();
        if (!declaration) throw new Error('Elements declaration unavailable');
        expect(readBuiltInAccountSettingValueV1(declaration, settings)).toBe('glass');
        expect(parseBuiltInAccountSettingValueV1(declaration, 'solid')).toEqual({ success: true, value: 'solid' });
        const delta = buildBuiltInAccountSettingMutationV1(declaration, settings, 'solid');
        expect(readGlassMaterials({ ...settings, ...delta }).card).toEqual({ blur: 'off', opacity: 1 });
        expect(readGlassPreset({ ...settings, ...delta })).toBe('auto');
        expect(parseBuiltInAccountSettingValueV1(declaration, 'clear').success).toBe(false);
    });

    it('retains the configured Elements choice while Solid masks it and the predecessor switch re-enables Auto', () => {
        const binding = readPortableAccountSettingBindingV1({ storage: { owner: 'glassSurfaceStorageBinding', options: ['card', 'mode'] } });
        const settings = accountSettingsParse(resolveGlassPresetSettingsDelta({}, 'solid'));
        expect(binding?.read(settings)).toBe('glass');
        expect(readGlassMaterials(settings).card).toEqual({ blur: 'off', opacity: 1 });
        expect(readGlassPreset({ ...settings, glassBlurEnabled: true })).toBe('auto');
        const changed = { ...settings, ...binding?.mutate(settings, 'solid') };
        expect(changed.glassBlurEnabled).toBe(false);
        expect(binding?.read(changed)).toBe('solid');
        expect(readGlassPreset(changed)).toBe('solid');
        for (const group of ['chrome', 'sidebar', 'content', 'floating'] as const) {
            expect(changed.glassSurfaceMaterials?.[group]).toEqual(settings.glassSurfaceMaterials?.[group]);
        }
        const chrome = readPortableAccountSettingBindingV1({ storage: { owner: 'glassSurfaceStorageBinding', options: ['chrome', 'mode'] } });
        const changedChrome = { ...settings, ...chrome?.mutate(settings, 'glass') };
        expect(binding?.read(changedChrome)).toBe('glass');
    });

    it('keeps complete custom materials stable and admits retained tables only at the stored boundary', () => {
        const materials = { ...glassPresetMaterials('everywhere'), content: { blur: 'off' as const, opacity: 0.2 } };
        expect(readGlassMaterials({ glassSurfaceMaterials: materials })).toBe(materials);
        const { card: _card, ...retained } = materials;
        expect(ACCOUNT_SETTING_DEFINITIONS.glassSurfaceMaterials.parseStoredValue(retained).success).toBe(true);
        expect(ACCOUNT_SETTING_DEFINITIONS.glassSurfaceMaterials.parseMutationValue(retained).success).toBe(false);
        expect(ACCOUNT_SETTING_DEFINITIONS.glassSurfaceMaterials.parseMutationValue(materials).success).toBe(true);
    });
});
