import { describe, expect, it } from 'vitest';

import { LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions';

describe('LOCAL_SETTING_DEFINITIONS pets', () => {
    it('defaults local pet settings to account inheritance with Codex detection enabled', () => {
        expect(LOCAL_SETTING_DEFINITIONS.petsEnabledOverride.default).toBe('inherit');
        expect(LOCAL_SETTING_DEFINITIONS.petsSelectedPetOverride.default).toEqual({ kind: 'inherit' });
        expect(LOCAL_SETTING_DEFINITIONS.petsCompanionPosition.default).toEqual({
            schemaVersion: 1,
            surface: 'mobile-app-shell',
            normalizedX: 0.82,
            normalizedY: 0.72,
            lastViewport: null,
        });
        expect(LOCAL_SETTING_DEFINITIONS.petsDismissedCompanionTrayItemKeys.default).toEqual([]);
        expect(LOCAL_SETTING_DEFINITIONS.petsCompanionSizeScale.default).toBe(1);
        expect(LOCAL_SETTING_DEFINITIONS.petsDetectCodexPets.default).toBe(true);
        expect(LOCAL_SETTING_DEFINITIONS.desktopPetOverlayEnabledOverride.default).toBe('inherit');
        expect(LOCAL_SETTING_DEFINITIONS.desktopPetOverlayVisibilityModeOverride.default).toBe('inherit');
        expect(LOCAL_SETTING_DEFINITIONS.desktopPetOverlayAnchor.default).toBe('bottomRight');
        expect(LOCAL_SETTING_DEFINITIONS.desktopPetOverlayOffset.default).toEqual({ x: 0, y: 0 });
        expect(LOCAL_SETTING_DEFINITIONS.desktopPetOverlayLocked.default).toBe(false);
    });

    it('allows device-only pet source overrides but rejects account-pet refs locally', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.petsSelectedPetOverride.schema;

        expect(schema.safeParse({ kind: 'inherit' }).success).toBe(true);
        expect(schema.safeParse({ kind: 'detectedCodexHome', sourceKey: 'codex:user:blink' }).success).toBe(true);
        expect(schema.safeParse({ kind: 'happierManagedLocal', sourceKey: 'local:blink' }).success).toBe(true);
        expect(schema.safeParse({ kind: 'accountPet', accountPetId: 'acct_pet_1' }).success).toBe(false);
        expect(schema.safeParse({ kind: 'builtIn', petId: 'blink' }).success).toBe(false);
    });

    it('accepts only versioned normalized app-shell companion positions', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.petsCompanionPosition.schema;

        expect(schema.safeParse({
            schemaVersion: 1,
            surface: 'mobile-app-shell',
            normalizedX: 0,
            normalizedY: 1,
            lastViewport: {
                width: 390,
                height: 844,
                margin: 12,
                keyboardHeight: 300,
                safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
            },
        }).success).toBe(true);
        expect(schema.safeParse({
            schemaVersion: 2,
            surface: 'mobile-app-shell',
            normalizedX: 0.5,
            normalizedY: 0.5,
            lastViewport: null,
        }).success).toBe(false);
        expect(schema.safeParse({
            schemaVersion: 1,
            surface: 'mobile-app-shell',
            normalizedX: 1.2,
            normalizedY: 0.5,
            lastViewport: null,
        }).success).toBe(false);
        expect(schema.safeParse({
            schemaVersion: 1,
            surface: 'desktop-overlay',
            normalizedX: 0.5,
            normalizedY: 0.5,
            lastViewport: null,
        }).success).toBe(false);
    });

    it('stores dismissed companion tray keys as a device-local list', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.petsDismissedCompanionTrayItemKeys.schema;

        expect(schema.safeParse(['waiting:session:1000']).success).toBe(true);
        expect(schema.safeParse([42])).toMatchObject({ success: true, data: [] });
    });

    it('accepts a numeric companion size scale as a local device preference', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.petsCompanionSizeScale.schema;

        expect(schema.safeParse(0.75).success).toBe(true);
        expect(schema.safeParse(1).success).toBe(true);
        expect(schema.safeParse(1.5).success).toBe(true);
        expect(schema.safeParse('large')).toMatchObject({ success: true, data: 1 });
    });
});
