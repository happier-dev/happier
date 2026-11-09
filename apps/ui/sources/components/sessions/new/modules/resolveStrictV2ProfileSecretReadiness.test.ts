import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';

import { resolveStrictV2ProfileSecretReadiness } from './resolveStrictV2ProfileSecretReadiness';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';

const profile = AIBackendProfileSchema.parse({
    id: 'work',
    name: 'Work',
    envVarRequirements: [{ name: 'ANTHROPIC_API_KEY', required: true, kind: 'secret' }],
});
const personalSecret = {
    id: 'personal-secret',
    name: 'Personal secret',
    kind: 'token' as const,
    encryptedValue: { _isSecretValue: true as const, value: 'sealed-secret' },
    createdAt: 1,
    updatedAt: 1,
};
const resolveReference = (ref: string): SavedSecretReferenceResolution => ({
    ref,
    kind: ref.startsWith('happier:shared-secret:v1:') ? 'shared_resource' : 'personal',
    status: 'ready',
    entry: null,
    secret: personalSecret,
    revision: ref.startsWith('happier:shared-secret:v1:') ? 7 : 1,
    fingerprint: `test:${ref}`,
});

describe('resolveStrictV2ProfileSecretReadiness', () => {
    it('keeps an ordinary Profile with no secret requirements representable by profile id', () => {
        expect(resolveStrictV2ProfileSecretReadiness({
            profile: AIBackendProfileSchema.parse({
                id: 'ordinary',
                name: 'Ordinary',
                environmentVariables: [{ name: 'PROFILE_MODE', value: 'reviewed' }],
            }),
            resolveSavedSecretReference: resolveReference,
        })).toEqual({ ok: true });
    });

    it('accepts a ready persisted binding without opening its value', () => {
        expect(resolveStrictV2ProfileSecretReadiness({
            profile,
            defaultBindings: { ANTHROPIC_API_KEY: personalSecret.id },
            selectedSecretIds: { ANTHROPIC_API_KEY: personalSecret.id },
            machineEnvReadyByName: { ANTHROPIC_API_KEY: false },
            resolveSavedSecretReference: resolveReference,
        })).toEqual({ ok: true });
    });

    it('projects a differing shared Saved Secret selection as an exact one-launch reference', () => {
        const sharedRef = 'happier:shared-secret:v1:shared-resource';
        expect(resolveStrictV2ProfileSecretReadiness({
            profile,
            defaultBindings: { ANTHROPIC_API_KEY: personalSecret.id },
            selectedSecretIds: { ANTHROPIC_API_KEY: sharedRef },
            machineEnvReadyByName: { ANTHROPIC_API_KEY: false },
            resolveSavedSecretReference: resolveReference,
        })).toEqual({
            ok: true,
            secretReferenceOverlay: {
                v: 1,
                bindings: {
                    ANTHROPIC_API_KEY: { ref: sharedRef, revision: 7 },
                },
            },
        });
    });

    it('fails typed when plaintext exists only in the current Session draft', () => {
        expect(resolveStrictV2ProfileSecretReadiness({
            profile,
            sessionOnlyValues: { ANTHROPIC_API_KEY: '   ' },
            machineEnvReadyByName: { ANTHROPIC_API_KEY: false },
            resolveSavedSecretReference: resolveReference,
        })).toEqual({ ok: false, reason: 'session_only_secret_not_representable' });
    });

    it('preserves the existing Machine-environment satisfaction path', () => {
        expect(resolveStrictV2ProfileSecretReadiness({
            profile,
            selectedSecretIds: { ANTHROPIC_API_KEY: '' },
            machineEnvReadyByName: { ANTHROPIC_API_KEY: true },
            resolveSavedSecretReference: resolveReference,
        })).toEqual({ ok: true });
    });
});
