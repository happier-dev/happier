import { describe, expect, it } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';
import { pruneSecretBindings } from '@/sync/domains/settings/secretBindings';

describe('pruneSecretBindings', () => {
    it('prunes truly unknown bindings and invalid entries for a valid editable legacy profile', () => {
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
                    // Env var not declared as secret requirement -> drop
                    OTHER_SECRET: 's1',
                    // Unknown secret id -> drop
                    OPENAI_API_KEY: 'missing-secret',
                    // Invalid env name -> drop
                    'not valid': 's1',
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
});
