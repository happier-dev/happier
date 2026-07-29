import { describe, expect, it } from 'vitest';

import { buildCustomProviderTemplate, createCustomProviderDraft, updateCustomProviderDraftPreset } from './state';

describe('custom provider authoring state', () => {
    it('builds an OpenAI-compatible probe template through the canonical normalizer', () => {
        const draft = createCustomProviderDraft('openai-responses');
        const template = buildCustomProviderTemplate({
            ...draft,
            name: 'Company gateway',
            baseUrl: 'https://gateway.example.test/v1',
        });

        expect(template.endpointTemplates[0]).toMatchObject({
            protocol: 'openai-responses',
            baseUrl: 'https://gateway.example.test/v1',
        });
        expect(template.catalog).toMatchObject({ source: 'probe' });
        expect(template.credential?.transports[0]?.destination).toEqual({
            kind: 'httpHeader',
            name: 'authorization',
            format: 'bearer',
        });
    });

    it('keeps Anthropic-compatible providers manual-only and uses x-api-key', () => {
        const template = buildCustomProviderTemplate({
            ...createCustomProviderDraft('anthropic'),
            name: 'Anthropic gateway',
            baseUrl: 'https://gateway.example.test/anthropic',
        });

        expect(template.catalog).toEqual({ source: 'manual', manualModelPolicy: 'allowed' });
        expect(template.credential?.transports[0]?.destination).toEqual({
            kind: 'httpHeader',
            name: 'x-api-key',
            format: 'raw',
        });
    });

    it('removes credential materialization when no API key is selected', () => {
        const template = buildCustomProviderTemplate({
            ...createCustomProviderDraft('openai-chat'),
            name: 'Local gateway',
            baseUrl: 'http://127.0.0.1:8080/v1',
            requiresApiKey: false,
        });
        expect(template.credential).toBeUndefined();
    });

    it('resets only protocol-owned defaults when changing preset', () => {
        const original = {
            ...createCustomProviderDraft('openai-chat'),
            name: 'Keep me',
            baseUrl: 'https://gateway.example.test',
        };
        expect(updateCustomProviderDraftPreset(original, 'anthropic')).toMatchObject({
            name: 'Keep me',
            baseUrl: 'https://gateway.example.test',
            protocol: 'anthropic',
            catalog: 'manual',
            credentialStyle: 'x-api-key',
        });
    });

    it('builds a multi-protocol advanced template with public headers and one safe probe per endpoint', () => {
        const draft = createCustomProviderDraft('openai-responses');
        const template = buildCustomProviderTemplate({
            ...draft,
            name: 'Advanced gateway',
            advanced: true,
            endpoints: [
                {
                    protocol: 'openai-responses', enabled: true, baseUrl: 'https://gateway.example/v1',
                    requiresApiKey: true, credentialStyle: 'bearer', credentialHeader: '',
                    publicHeadersText: 'X-Tenant: engineering', probePathsText: '/models\n/fallback-models',
                    probeParser: 'openai-models',
                },
                {
                    protocol: 'anthropic', enabled: true, baseUrl: 'https://gateway.example/anthropic',
                    requiresApiKey: true, credentialStyle: 'x-api-key', credentialHeader: '',
                    publicHeadersText: '', probePathsText: '/model-catalog',
                    probeParser: 'openai-models',
                },
            ],
        });
        expect(template.endpointTemplates).toMatchObject([
            { protocol: 'openai-responses', publicHeaders: { 'x-tenant': 'engineering' } },
            { protocol: 'anthropic' },
        ]);
        expect(template.catalog).toMatchObject({ source: 'probe', probes: [
            { endpointTemplateId: 'openai-responses', path: '/models' },
            { endpointTemplateId: 'openai-responses', path: '/fallback-models' },
            { endpointTemplateId: 'anthropic', path: '/model-catalog' },
        ] });
    });
});
