import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import {
    HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
    consumeProviderBindingLaunchHandoffFromEnvironments,
    serializeProviderBindingLaunchHandoffForEnv,
} from './handoff';

describe('provider-binding launch materialization handoff', () => {
    const materialization = {
        v: 1 as const,
        kind: 'engineConfig' as const,
        engineConfig: { model_provider: { name: 'gateway' } },
    };
    const sessionBindingMetadata = {
        v: 1 as const,
        connectionId: ProviderConnectionIdSchema.parse('pc_work'),
        contributionKey: 'plugin.openrouter/openrouter',
        connectionRevision: 3,
        protocol: 'openai-responses' as const,
        materialization: 'engineConfig' as const,
        adapterBindingKey: 'openrouter',
        compatibilityFingerprint: 'compatibility-v1',
        bindingSecurityFingerprint: 'security-v1',
        runtimeBindingBasis: {
            v: 1 as const,
            deployment: { kind: 'external' as const },
            agentTargetKey: 'backend:codex',
            connectionId: ProviderConnectionIdSchema.parse('pc_work'),
            contributionKey: 'plugin.openrouter/openrouter',
            endpoint: {
                endpointTemplateId: 'responses',
                normalizedUrl: 'https://provider.example/v1',
                protocol: 'openai-responses' as const,
                publicHeaders: { 'x-provider': 'openrouter' },
            },
            runtimeCredentialTransport: {
                id: 'runtime-bearer',
                protocols: ['openai-responses' as const],
                uses: ['runtime' as const],
                destination: {
                    kind: 'httpHeader' as const,
                    name: 'authorization',
                    format: 'bearer' as const,
                },
            },
            prepared: {
                v: 1 as const,
                materialization: 'engineConfig' as const,
                adapterBindingKey: 'openrouter',
            },
            adapterVersion: 1,
            credentialAuthorization: {
                connectionSecurityFingerprint: 'connection-security-v1',
                grantFingerprint: 'grant-v1',
                selectedSecretBindingId: 'binding-v1',
                selectedSecretRecordFingerprint: 'record-v1',
            },
            agentSupport: {
                acceptsProtocols: ['openai-responses' as const],
                required: { streaming: true as const },
                credentialSupport: {
                    supportsNoAuth: false,
                    apiKeyTransports: [{
                        protocol: 'openai-responses' as const,
                        destination: {
                            kind: 'httpHeader' as const,
                            names: ['authorization'],
                            formats: ['bearer' as const],
                        },
                    }],
                },
                authIsolation: {
                    suppressConnectedServiceIds: [],
                    ownedEnvKeys: ['OPENAI_API_KEY'],
                },
                materialization: 'engineConfig' as const,
                applyPolicy: 'live' as const,
                supportsFreeformModelIds: true,
            },
        },
        displaySnapshot: {
            providerName: 'OpenRouter',
            connectionName: 'Work',
            connectionRole: 'named' as const,
            connectionDisplayNameMode: 'custom' as const,
        },
    };

    it.each([
        ['raw materialization', materialization],
        ['metadata-less envelope', { v: 1 as const, materialization }],
    ])('consumes and refuses %s', (_label, value) => {
        const env: NodeJS.ProcessEnv = {
            KEEP: 'yes',
            [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
                Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'),
        };

        expect(() => consumeProviderBindingLaunchHandoffFromEnvironments([env])).toThrow(
            /provider binding launch materialization/i,
        );
        expect(env).toEqual({ KEEP: 'yes' });
    });

    it('carries the non-secret session binding snapshot in the same one-shot handoff', () => {
        const env: NodeJS.ProcessEnv = {
            [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
                serializeProviderBindingLaunchHandoffForEnv(
                    materialization,
                    sessionBindingMetadata,
                ),
        };

        expect(consumeProviderBindingLaunchHandoffFromEnvironments([env])).toEqual({
            v: 1,
            materialization,
            sessionBindingMetadata,
        });
        expect(env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]).toBeUndefined();
    });

    it('removes malformed handoff data before refusing it', () => {
        const env: NodeJS.ProcessEnv = {
            [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]: 'not-base64url!',
        };
        expect(() => consumeProviderBindingLaunchHandoffFromEnvironments([env])).toThrow(/provider binding launch materialization/i);
        expect(env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]).toBeUndefined();
    });

    it('returns undefined when no handoff exists and rejects secret-bearing/unknown fields', () => {
        expect(consumeProviderBindingLaunchHandoffFromEnvironments([{ KEEP: 'yes' }, {}])).toBeUndefined();
        expect(() => serializeProviderBindingLaunchHandoffForEnv(
            materialization,
            undefined as never,
        )).toThrow();
        expect(() => serializeProviderBindingLaunchHandoffForEnv({
            v: 1,
            kind: 'configFile',
            rootPath: '/session/provider',
            relativePaths: ['config.json'],
            credential: 'secret',
        } as never, sessionBindingMetadata)).toThrow();
    });

    it.each([
        ['valid scoped plus valid ambient', 'valid', 'other-valid'],
        ['malformed scoped plus valid ambient', 'malformed', 'valid'],
        ['valid scoped plus malformed ambient', 'valid', 'malformed'],
        ['duplicate equal carriers', 'valid', 'valid'],
    ] as const)('removes every carrier before refusing %s', (_label, scopedKind, ambientKind) => {
        const valid = serializeProviderBindingLaunchHandoffForEnv(
            materialization,
            sessionBindingMetadata,
        );
        const otherValid = serializeProviderBindingLaunchHandoffForEnv(materialization, {
            ...sessionBindingMetadata,
            connectionId: ProviderConnectionIdSchema.parse('pc_other'),
        });
        const encoded = (kind: typeof scopedKind | typeof ambientKind): string => (
            kind === 'valid' ? valid : kind === 'other-valid' ? otherValid : 'not-base64url!'
        );
        const scoped: NodeJS.ProcessEnv = {
            [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]: encoded(scopedKind),
        };
        const ambient: NodeJS.ProcessEnv = {
            [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]: encoded(ambientKind),
        };

        expect(() => consumeProviderBindingLaunchHandoffFromEnvironments([scoped, ambient])).toThrow(
            /provider binding launch materialization/i,
        );
        expect(scoped).not.toHaveProperty(HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY);
        expect(ambient).not.toHaveProperty(HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY);
    });
});
