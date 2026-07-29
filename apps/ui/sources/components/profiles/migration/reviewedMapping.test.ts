import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from '@happier-dev/protocol';

import {
    buildLegacyProfileMigrationDraft,
    buildLegacyProfileReviewedMapping,
} from './reviewedMapping';

describe('legacy profile reviewed migration mapping', () => {
    it('prefills routing, credential, and model facts while leaving launch-only env out of the provider mapping', () => {
        const profile = AIBackendProfileSchema.parse({
            id: 'legacy-gateway',
            name: 'Company gateway',
            environmentVariables: [
                { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.test' },
                { name: 'ANTHROPIC_MODEL', value: 'company-model' },
                { name: 'SAFE_LAUNCH_FLAG', value: '1' },
            ],
            envVarRequirements: [{ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', required: true }],
        });

        const draft = buildLegacyProfileMigrationDraft({
            profile,
            secretBindings: { ANTHROPIC_AUTH_TOKEN: 'saved-secret-a' },
        });

        expect(draft).toMatchObject({
            name: 'Company gateway',
            protocol: 'anthropic',
            baseUrl: 'https://gateway.example.test',
            credentialEnvVarName: 'ANTHROPIC_AUTH_TOKEN',
            credentialStyle: 'bearer',
            manualModelsText: 'company-model',
            routingEnvironmentVariableNames: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
        });
        expect(draft.routingEnvironmentVariableNames).not.toContain('SAFE_LAUNCH_FLAG');

        const mapping = buildLegacyProfileReviewedMapping({
            draft,
            connectionId: 'pc_migrated',
            now: 42,
        });
        expect(mapping.connection).toMatchObject({
            id: 'pc_migrated', role: 'named', displayName: 'Company gateway',
            source: {
                kind: 'custom',
                template: {
                    endpointTemplates: [{ protocol: 'anthropic' }],
                    credential: {
                        transports: [{ destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }],
                    },
                },
            },
        });
        expect(mapping.credentialMoves).toEqual([
            { legacyEnvVarName: 'ANTHROPIC_AUTH_TOKEN', credentialSlotId: 'apiKey', credentialStyle: 'bearer' },
        ]);
        expect(mapping.manualModelIds).toEqual(['company-model']);
    });

    it('requires an explicit endpoint before previewing an ambiguous candidate', () => {
        const profile = AIBackendProfileSchema.parse({ id: 'legacy', name: 'Legacy', environmentVariables: [] });
        const draft = buildLegacyProfileMigrationDraft({ profile, secretBindings: {} });
        expect(() => buildLegacyProfileReviewedMapping({ draft, connectionId: 'pc_migrated', now: 1 }))
            .toThrow();
    });

    it('requires an explicit credential choice when multiple bound requirements exist regardless of candidate order', () => {
        const create = (names: readonly string[]) => AIBackendProfileSchema.parse({
            id: 'legacy-multi',
            name: 'Legacy multi',
            environmentVariables: [{ name: 'OPENAI_BASE_URL', value: 'https://gateway.example.test' }],
            envVarRequirements: names.map((name) => ({ name, kind: 'secret' as const, required: true })),
        });
        const secretBindings = {
            OPENAI_API_KEY: 'saved-openai',
            COMPANY_GATEWAY_TOKEN: 'saved-company',
        };
        const first = buildLegacyProfileMigrationDraft({
            profile: create(['OPENAI_API_KEY', 'COMPANY_GATEWAY_TOKEN']),
            secretBindings,
        });
        const second = buildLegacyProfileMigrationDraft({
            profile: create(['COMPANY_GATEWAY_TOKEN', 'OPENAI_API_KEY']),
            secretBindings,
        });

        expect(first.credentialCandidateEnvVarNames).toEqual(['COMPANY_GATEWAY_TOKEN', 'OPENAI_API_KEY']);
        expect(second.credentialCandidateEnvVarNames).toEqual(first.credentialCandidateEnvVarNames);
        expect(first.credentialEnvVarName).toBeNull();
        expect(first.credentialStyle).toBeNull();
        expect(first.credentialSelectionReviewed).toBe(false);
        expect(() => buildLegacyProfileReviewedMapping({ draft: first, connectionId: 'pc_multi', now: 1 }))
            .toThrow('credential');

        const mapping = buildLegacyProfileReviewedMapping({
            draft: {
                ...first,
                credentialEnvVarName: 'OPENAI_API_KEY',
                credentialStyle: 'bearer',
                credentialSelectionReviewed: true,
            },
            connectionId: 'pc_multi',
            now: 1,
        });
        expect(mapping.credentialMoves).toEqual([
            { legacyEnvVarName: 'OPENAI_API_KEY', credentialSlotId: 'apiKey', credentialStyle: 'bearer' },
        ]);

        const noCredential = buildLegacyProfileReviewedMapping({
            draft: {
                ...first,
                credentialEnvVarName: null,
                credentialStyle: null,
                credentialSelectionReviewed: true,
            },
            connectionId: 'pc_no_auth',
            now: 1,
        });
        expect(noCredential.credentialMoves).toEqual([]);
        expect(noCredential.connection.source.kind === 'custom'
            ? noCredential.connection.source.template.credential
            : 'unexpected').toBeUndefined();
    });

    it('orders migration evidence canonically without host locale authority', () => {
        const create = (names: readonly string[]) => AIBackendProfileSchema.parse({
            id: 'legacy-canonical-order',
            name: 'Legacy canonical order',
            environmentVariables: [{ name: 'OPENAI_BASE_URL', value: 'https://gateway.example.test' }],
            envVarRequirements: names.map((name) => ({ name, kind: 'secret' as const, required: true })),
        });
        const secretBindings = {
            Z_TOKEN: 'saved-z',
            _TOKEN: 'saved-underscore',
        };
        const originalLocaleCompare = String.prototype.localeCompare;
        String.prototype.localeCompare = () => {
            throw new Error('localeCompare must not participate in Provider migration evidence');
        };
        try {
            const forward = buildLegacyProfileMigrationDraft({
                profile: create(['_TOKEN', 'Z_TOKEN']),
                secretBindings,
            });
            const reversed = buildLegacyProfileMigrationDraft({
                profile: create(['Z_TOKEN', '_TOKEN']),
                secretBindings,
            });
            expect(forward.credentialCandidateEnvVarNames).toEqual(['Z_TOKEN', '_TOKEN']);
            expect(reversed.credentialCandidateEnvVarNames).toEqual(
                forward.credentialCandidateEnvVarNames,
            );
        } finally {
            String.prototype.localeCompare = originalLocaleCompare;
        }
    });

    it('preserves known API-key transport semantics and requires an explicit style for unknown names', () => {
        const create = (name: string) => AIBackendProfileSchema.parse({
            id: `legacy-${name}`,
            name: 'Legacy credential',
            environmentVariables: [{ name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.test' }],
            envVarRequirements: [{ name, kind: 'secret' as const, required: true }],
        });

        const apiKey = buildLegacyProfileMigrationDraft({
            profile: create('ANTHROPIC_API_KEY'),
            secretBindings: { ANTHROPIC_API_KEY: 'saved-api-key' },
        });
        expect(apiKey.credentialStyle).toBe('x-api-key');

        const unknown = buildLegacyProfileMigrationDraft({
            profile: create('COMPANY_GATEWAY_TOKEN'),
            secretBindings: { COMPANY_GATEWAY_TOKEN: 'saved-company' },
        });
        expect(unknown).toMatchObject({
            credentialEnvVarName: 'COMPANY_GATEWAY_TOKEN',
            credentialStyle: null,
        });
        expect(() => buildLegacyProfileReviewedMapping({
            draft: unknown,
            connectionId: 'pc_unknown',
            now: 1,
        })).toThrow('credential format');
    });

    it('exact-deduplicates valid manual model ids and rejects any invalid reviewed line', () => {
        const profile = AIBackendProfileSchema.parse({
            id: 'legacy-models',
            name: 'Legacy models',
            environmentVariables: [{ name: 'OPENAI_BASE_URL', value: 'https://gateway.example.test' }],
        });
        const draft = buildLegacyProfileMigrationDraft({ profile, secretBindings: {} });

        expect(buildLegacyProfileReviewedMapping({
            draft: { ...draft, manualModelsText: 'model-a\nmodel-a\nModel-A' },
            connectionId: 'pc_models',
            now: 1,
        }).manualModelIds).toEqual(['model-a', 'Model-A']);
        expect(() => buildLegacyProfileReviewedMapping({
            draft: { ...draft, manualModelsText: 'model-a\nbad model' },
            connectionId: 'pc_models',
            now: 1,
        })).toThrow('manual model');
    });
});
