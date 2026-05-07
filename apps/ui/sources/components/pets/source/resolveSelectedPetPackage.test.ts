import { describe, expect, it } from 'vitest';

import { BUILT_IN_PET_IDS, DEFAULT_BUILT_IN_PET_ID } from '../builtIns/builtInPetRegistry';
import { resolveSelectedPetPackage } from './resolveSelectedPetPackage';

const companionEnabled = { state: 'enabled' } as const;
const syncDisabled = { state: 'disabled', blockedBy: 'server', blockerCode: 'server_feature_disabled' } as const;
const syncEnabled = { state: 'enabled' } as const;

describe('resolveSelectedPetPackage', () => {
    it('falls back to Blink without mutating account settings when an account pet is selected but pets sync is unavailable', () => {
        const accountRef = { kind: 'accountPet', accountPetId: 'acct_pet_1' } as const;

        expect(resolveSelectedPetPackage({
            companionDecision: companionEnabled,
            syncDecision: syncDisabled,
            accountSettings: {
                petsEnabled: true,
                petsSelectedPetRef: accountRef,
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: { kind: 'inherit' },
            },
            sources: {
                accountPetsById: new Map(),
                builtInFallbackPetId: 'blink',
                builtInPetIds: ['blink'],
                happierManagedLocalBySourceKey: new Map(),
            },
        })).toEqual({
            enabled: true,
            source: { kind: 'builtIn', petId: 'blink' },
            fallback: {
                reason: 'account_pet_sync_unavailable',
                originalRef: accountRef,
                shouldPersist: false,
            },
        });
    });

    it('uses a local managed-pet override before the account default', () => {
        const localSource = {
            kind: 'happierManagedLocal',
            sourceKey: 'local:blink-copy',
            packagePath: '/local/pets/blink-copy',
        } as const;

        expect(resolveSelectedPetPackage({
            companionDecision: companionEnabled,
            syncDecision: syncEnabled,
            accountSettings: {
                petsEnabled: true,
                petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' },
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: { kind: 'happierManagedLocal', sourceKey: localSource.sourceKey },
            },
            sources: {
                accountPetsById: new Map(),
                builtInFallbackPetId: 'blink',
                builtInPetIds: ['blink'],
                happierManagedLocalBySourceKey: new Map([[localSource.sourceKey, localSource]]),
            },
        })).toEqual({
            enabled: true,
            source: localSource,
            fallback: null,
        });
    });

    it('does not render a stale detected Codex pet override before it is imported locally', () => {
        const detectedSource = {
            kind: 'detectedCodexHome',
            sourceKey: 'detected:blink-copy',
        } as const;

        expect(resolveSelectedPetPackage({
            companionDecision: companionEnabled,
            syncDecision: syncEnabled,
            accountSettings: {
                petsEnabled: true,
                petsSelectedPetRef: { kind: 'builtIn', petId: 'fury' },
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: { kind: 'detectedCodexHome', sourceKey: detectedSource.sourceKey },
            },
            sources: {
                accountPetsById: new Map(),
                builtInFallbackPetId: 'blink',
                builtInPetIds: ['blink', 'fury'],
                happierManagedLocalBySourceKey: new Map(),
            },
        })).toEqual({
            enabled: true,
            source: { kind: 'builtIn', petId: 'blink' },
            fallback: {
                reason: 'unknown_pet_source',
                originalRef: { kind: 'detectedCodexHome', sourceKey: detectedSource.sourceKey },
                shouldPersist: false,
            },
        });
    });

    it('disables rendering when the companion feature decision is denied', () => {
        expect(resolveSelectedPetPackage({
            companionDecision: { state: 'disabled' },
            syncDecision: syncEnabled,
            accountSettings: {
                petsEnabled: true,
                petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' },
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: { kind: 'inherit' },
            },
            sources: {
                accountPetsById: new Map(),
                builtInFallbackPetId: 'blink',
                builtInPetIds: ['blink'],
                happierManagedLocalBySourceKey: new Map(),
            },
        })).toEqual({
            enabled: false,
            source: null,
            fallback: {
                reason: 'companion_feature_disabled',
                shouldPersist: false,
            },
        });
    });

    it('uses the built-in registry to resolve Blink as the default selected source', () => {
        expect(resolveSelectedPetPackage({
            companionDecision: companionEnabled,
            syncDecision: syncDisabled,
            accountSettings: {
                petsEnabled: true,
                petsSelectedPetRef: { kind: 'builtIn', petId: DEFAULT_BUILT_IN_PET_ID },
            },
            localSettings: {
                petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: { kind: 'inherit' },
            },
            sources: {
                accountPetsById: new Map(),
                builtInFallbackPetId: DEFAULT_BUILT_IN_PET_ID,
                builtInPetIds: BUILT_IN_PET_IDS,
                happierManagedLocalBySourceKey: new Map(),
            },
        })).toEqual({
            enabled: true,
            source: { kind: 'builtIn', petId: 'blink' },
            fallback: null,
        });
    });
});
