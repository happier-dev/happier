import { describe, expect, it } from 'vitest';

import { resolveDesktopPetOverlayPolicy } from './resolveDesktopPetOverlayPolicy';

describe('resolveDesktopPetOverlayPolicy', () => {
    it('fails closed when the companion feature decision is not enabled', () => {
        const policy = resolveDesktopPetOverlayPolicy({
            companionFeatureState: 'disabled',
            accountSettings: {
                petsEnabled: true,
                petsDesktopOverlayDefaultEnabled: true,
            },
            localSettings: {
                desktopPetOverlayEnabledOverride: 'enabled',
            },
        });

        expect(policy.enabled).toBe(false);
    });

    it('keeps the overlay hidden when pets are disabled by user policy', () => {
        const policy = resolveDesktopPetOverlayPolicy({
            companionFeatureState: 'enabled',
            accountSettings: {
                petsEnabled: false,
                petsDesktopOverlayDefaultEnabled: true,
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                desktopPetOverlayEnabledOverride: 'enabled',
            },
        });

        expect(policy.enabled).toBe(false);
    });

    it('uses local desktop overlay override and placement settings when enabled', () => {
        const policy = resolveDesktopPetOverlayPolicy({
            companionFeatureState: 'enabled',
            accountSettings: {
                petsEnabled: true,
                petsDesktopOverlayDefaultEnabled: false,
                petsDesktopOverlayDefaultVisibilityMode: 'attentionOnly',
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                desktopPetOverlayEnabledOverride: 'enabled',
                desktopPetOverlayVisibilityModeOverride: 'alwaysWhenEnabled',
                desktopPetOverlayAnchor: 'topLeft',
                desktopPetOverlayLocked: true,
            },
        });

        expect(policy).toEqual({
            enabled: true,
            visibilityMode: 'alwaysWhenEnabled',
            alwaysOnTop: true,
            inputLocked: true,
            anchor: 'topLeft',
        });
    });

    it('defaults enabled overlays to visible while the pet is idle', () => {
        const policy = resolveDesktopPetOverlayPolicy({
            companionFeatureState: 'enabled',
            accountSettings: {
                petsEnabled: true,
                petsDesktopOverlayDefaultEnabled: true,
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                desktopPetOverlayEnabledOverride: 'inherit',
                desktopPetOverlayVisibilityModeOverride: 'inherit',
            },
        });

        expect(policy).toEqual(expect.objectContaining({
            enabled: true,
            visibilityMode: 'alwaysWhenEnabled',
        }));
    });

    it('preserves the account attention-or-active default so visibility can follow activity', () => {
        const policy = resolveDesktopPetOverlayPolicy({
            companionFeatureState: 'enabled',
            accountSettings: {
                petsEnabled: true,
                petsDesktopOverlayDefaultEnabled: true,
                petsDesktopOverlayDefaultVisibilityMode: 'attentionOrActive',
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                desktopPetOverlayEnabledOverride: 'inherit',
                desktopPetOverlayVisibilityModeOverride: 'inherit',
            },
        });

        expect(policy.visibilityMode).toBe('attentionOrActive');
    });

    it('honors an explicit local attention-or-active visibility override', () => {
        const policy = resolveDesktopPetOverlayPolicy({
            companionFeatureState: 'enabled',
            accountSettings: {
                petsEnabled: true,
                petsDesktopOverlayDefaultEnabled: true,
                petsDesktopOverlayDefaultVisibilityMode: 'alwaysWhenEnabled',
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                desktopPetOverlayEnabledOverride: 'inherit',
                desktopPetOverlayVisibilityModeOverride: 'attentionOrActive',
            },
        });

        expect(policy.visibilityMode).toBe('attentionOrActive');
    });
});
