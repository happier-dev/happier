import { describe, expect, it } from 'vitest';

import { resolveDesktopActivityOverlayCompanionPolicy } from './resolveDesktopActivityOverlayCompanionPolicy';

describe('resolveDesktopActivityOverlayCompanionPolicy', () => {
    it('falls back to the built-in companion when account pet metadata has not loaded yet', () => {
        let policy: ReturnType<typeof resolveDesktopActivityOverlayCompanionPolicy> | null = null;

        expect(() => {
            policy = resolveDesktopActivityOverlayCompanionPolicy({
                companionDecision: { state: 'enabled' },
                syncDecision: { state: 'enabled' },
                accountSettings: {
                    petsEnabled: true,
                    petsSelectedPetRef: { kind: 'accountPet', accountPetId: 'account-pet-1' },
                    petsDesktopOverlayDefaultEnabled: true,
                },
                localSettings: {
                    petsEnabledOverride: 'inherit',
                    petsSelectedPetOverride: { kind: 'inherit' },
                },
                accountPetsById: undefined,
            });
        }).not.toThrow();

        expect(policy).toEqual(expect.objectContaining({
            enabled: true,
            visibilityMode: 'alwaysWhenEnabled',
            pet: {
                source: { kind: 'builtIn', petId: 'blink' },
                displayName: 'Blink',
            },
        }));
    });

    it('resolves a selected managed local pet from shared local source metadata', () => {
        const input: Parameters<typeof resolveDesktopActivityOverlayCompanionPolicy>[0] = {
            companionDecision: { state: 'enabled' },
            syncDecision: { state: 'disabled' },
            accountSettings: {
                petsEnabled: true,
                petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' },
                petsDesktopOverlayDefaultEnabled: true,
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: { kind: 'happierManagedLocal', sourceKey: 'managed:blink' },
            },
            accountPetsById: undefined,
            localPetSourcesBySourceKey: {
                'managed:blink': {
                    sourceKey: 'managed:blink',
                    source: {
                        kind: 'happierManagedLocal',
                        packagePath: '/Users/tester/.happy-dev/pets/imports/blink',
                        sourceKey: 'managed:blink',
                    },
                    displayName: 'Blink local',
                    manifest: {
                        id: 'blink-local',
                        displayName: 'Blink local',
                        description: 'Local Blink pet',
                        spritesheetPath: 'spritesheet.webp',
                    },
                    mediaType: 'image/webp',
                    digest: 'sha256:local',
                    sizeBytes: 256,
                    daemonTarget: {
                        serverId: 'server-pets',
                        machineId: 'machine-pets',
                    },
                },
            },
        };

        const policy = resolveDesktopActivityOverlayCompanionPolicy(input);

        expect(policy.pet).toEqual(expect.objectContaining({
            displayName: 'Blink local',
            source: expect.objectContaining({
                kind: 'happierManagedLocal',
                sourceKey: 'managed:blink',
                mediaType: 'image/webp',
                digest: 'sha256:local',
                daemonTarget: {
                    serverId: 'server-pets',
                    machineId: 'machine-pets',
                },
            }),
        }));
    });

    it('upgrades the legacy attention-or-active desktop pet visibility mode to always visible', () => {
        const policy = resolveDesktopActivityOverlayCompanionPolicy({
            companionDecision: { state: 'enabled' },
            syncDecision: { state: 'disabled' },
            accountSettings: {
                petsEnabled: true,
                petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' },
                petsDesktopOverlayDefaultEnabled: true,
                petsDesktopOverlayDefaultVisibilityMode: 'attentionOrActive',
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: { kind: 'inherit' },
                desktopPetOverlayEnabledOverride: 'inherit',
                desktopPetOverlayVisibilityModeOverride: 'inherit',
            },
        });

        expect(policy.visibilityMode).toBe('alwaysWhenEnabled');
    });

    it('honors an explicit local attention-or-active desktop pet visibility override', () => {
        const policy = resolveDesktopActivityOverlayCompanionPolicy({
            companionDecision: { state: 'enabled' },
            syncDecision: { state: 'disabled' },
            accountSettings: {
                petsEnabled: true,
                petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' },
                petsDesktopOverlayDefaultEnabled: true,
                petsDesktopOverlayDefaultVisibilityMode: 'alwaysWhenEnabled',
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: { kind: 'inherit' },
                desktopPetOverlayEnabledOverride: 'inherit',
                desktopPetOverlayVisibilityModeOverride: 'attentionOrActive',
            },
        });

        expect(policy.visibilityMode).toBe('attentionOrActive');
    });
});
