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
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                desktopPetOverlayEnabledOverride: 'enabled',
                desktopPetOverlayAnchor: 'topLeft',
                desktopPetOverlayLocked: true,
            },
        });

        expect(policy).toEqual({
            enabled: true,
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
            },
        });

        expect(policy).toEqual(expect.objectContaining({
            enabled: true,
        }));
    });

});
