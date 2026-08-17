import { describe, expect, it } from 'vitest';

import { applySettings, settingsParse } from '@/sync/domains/settings/settings';
import {
    mergeCurrentSecretBindingsIntoRawBindings,
    pruneSecretBindings,
    readRetainedSecretBindingsByProfileId,
} from '@/sync/domains/settings/secretBindings';

function createCustomProfile(id: string) {
    return {
        id,
        name: 'Custom',
        environmentVariables: [],
        compatibility: { claude: true, codex: true, gemini: true },
        envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    };
}

function createSavedSecret() {
    return {
        id: 's1',
        name: 'S1',
        kind: 'apiKey',
        encryptedValue: {
            _isSecretValue: true,
            encryptedValue: { t: 'enc-v1', c: 'Zm9v' },
        },
        createdAt: 0,
        updatedAt: 0,
    };
}

describe('pruneSecretBindings', () => {
    it('prunes truly unknown bindings and dangling entries in a recognized current map', () => {
        const base = settingsParse({});

        const settings = {
            ...base,
            profiles: [
                {
                    id: 'custom-1',
                    name: 'Custom',
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true, gemini: true },
                    envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
                    isBuiltIn: false,
                    createdAt: 0,
                    updatedAt: 0,
                    version: '1.0.0',
                },
            ],
            secrets: [
                { id: 's1', name: 'S1', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Zm9v' } }, createdAt: 0, updatedAt: 0 },
            ],
            secretBindingsByProfileId: {
                // Truly unknown profile -> prune.
                'missing-profile': { OPENAI_API_KEY: 's1' },
                // Historical generated profile may be absent from today's catalog.
                gemini: { GEMINI_API_KEY: 's1' },
                // Known profile:
                'custom-1': {
                    // Normalized to uppercase and kept
                    openai_api_key: 's1',
                    // An all-string current carrier remains current when it
                    // also contains an undeclared stale entry.
                    UNDECLARED_SECRET: 'missing-secret',
                },
            },
        };

        const pruned = pruneSecretBindings(settings as any);
        expect(pruned.secretBindingsByProfileId).toEqual({
            gemini: {
                GEMINI_API_KEY: 's1',
            },
            'custom-1': {
                OPENAI_API_KEY: 's1',
            },
        });
    });

    it('normalizes an isolated declared binding key', () => {
        const base = settingsParse({});
        const settings = {
            ...base,
            profiles: [createCustomProfile('custom-1')],
            secrets: [createSavedSecret()],
            secretBindingsByProfileId: {
                'custom-1': {
                    openai_api_key: 's1',
                },
            },
        };

        const pruned = pruneSecretBindings(settings);
        expect(pruned.secretBindingsByProfileId).toEqual({
            'custom-1': {
                OPENAI_API_KEY: 's1',
            },
        });
    });

    it('keeps opaque carriers when a current profile binding is updated', () => {
        const opaqueCarrier = { v: 'future', revision: 2 };
        const merged = mergeCurrentSecretBindingsIntoRawBindings({
            rawBindings: {
                'opaque-profile': opaqueCarrier,
                'current-profile': { OPENAI_API_KEY: 's1' },
            },
            currentBindings: {
                'current-profile': { OPENAI_API_KEY: 's1' },
            },
            nextBindings: {
                // This profile is intentionally absent from the safe runtime
                // view, so an editor must not replace its opaque carrier.
                'opaque-profile': { OPENAI_API_KEY: 's2' },
                'current-profile': { OPENAI_API_KEY: 's2' },
            },
        });

        expect(merged).toEqual({
            'opaque-profile': opaqueCarrier,
            'current-profile': { OPENAI_API_KEY: 's2' },
        });
    });

    it('preserves bindings byte-for-byte when the profile record is malformed', () => {
        const base = settingsParse({});

        const settings = {
            ...base,
            profiles: [
                {
                    id: 'custom-1',
                    name: 'Custom',
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true, gemini: true },
                    envVarRequirements: {},
                    isBuiltIn: false,
                    createdAt: 0,
                    updatedAt: 0,
                    version: '1.0.0',
                },
            ],
            secrets: [{ id: 's1', name: 'S1', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Zm9v' } }, createdAt: 0, updatedAt: 0 }],
            secretBindingsByProfileId: {
                'custom-1': {
                    OPENAI_API_KEY: 's1',
                },
            },
        };

        const pruned = pruneSecretBindings(settings as any);
        expect(pruned.secretBindingsByProfileId).toEqual({
            'custom-1': {
                OPENAI_API_KEY: 's1',
            },
        });
    });

    it('preserves ambiguous object carriers and prunes a recognized dangling binding', () => {
        const base = settingsParse({});
        const emptyCarrier = {};
        const scalarCarrier = 'future-binding-carrier';
        const arrayCarrier = ['future-binding-carrier'];
        const futureCarrier = { v: '2', kind: 'future' };
        const settings = {
            ...base,
            profiles: [
                createCustomProfile('empty-profile'),
                createCustomProfile('scalar-profile'),
                createCustomProfile('array-profile'),
                createCustomProfile('future-profile'),
                createCustomProfile('deleted-secret-profile'),
            ],
            secrets: [createSavedSecret()],
            secretBindingsByProfileId: {
                'empty-profile': emptyCarrier,
                'scalar-profile': scalarCarrier,
                'array-profile': arrayCarrier,
                'future-profile': futureCarrier,
                // The map is positively recognized because its key is a
                // declared secret requirement, but the secret no longer exists.
                'deleted-secret-profile': { OPENAI_API_KEY: 'deleted-secret' },
            },
        };

        const pruned = pruneSecretBindings(settings);
        expect(pruned.secretBindingsByProfileId).toEqual({
            'empty-profile': emptyCarrier,
            'scalar-profile': scalarCarrier,
            'array-profile': arrayCarrier,
            'future-profile': futureCarrier,
        });
    });

    it('preserves ambiguous object carriers across unrelated settings mutations', () => {
        const emptyCarrier = {};
        const scalarCarrier = 'future-binding-carrier';
        const arrayCarrier = ['future-binding-carrier'];
        const futureCarrier = { v: '2', kind: 'future' };
        const parsed = settingsParse({
            profiles: [
                createCustomProfile('empty-profile'),
                createCustomProfile('scalar-profile'),
                createCustomProfile('array-profile'),
                createCustomProfile('future-profile'),
            ],
            secrets: [createSavedSecret()],
            secretBindingsByProfileId: {
                'empty-profile': emptyCarrier,
                'scalar-profile': scalarCarrier,
                'array-profile': arrayCarrier,
                'future-profile': futureCarrier,
            },
        });

        const afterUnrelatedMutation = applySettings(parsed, { useProfiles: true });
        expect(readRetainedSecretBindingsByProfileId(afterUnrelatedMutation)).toEqual({
            'empty-profile': emptyCarrier,
            'scalar-profile': scalarCarrier,
            'array-profile': arrayCarrier,
            'future-profile': futureCarrier,
        });
    });
});
