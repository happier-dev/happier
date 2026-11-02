import { describe, expect, it } from 'vitest';
import { projectConnectedAccountConfiguredEndpoints } from './configuredOrigins';

type Configuration = NonNullable<Parameters<typeof projectConnectedAccountConfiguredEndpoints>[0]['configuration']>;
const configuration = (semantic: 'connectedAccountOrigin' | 'connectedAccountBase'): Configuration => ({
    scope: 'service', changeBehavior: 'refresh',
    fields: [{ id: 'endpoint', title: 'Endpoint', required: true, secret: false, semantic, schema: { type: 'string', minLength: 1 } }],
});

describe('connected-account endpoint routing projection', () => {
    it('projects descriptor-typed endpoints without turning unrelated configuration into routing data', () => {
        expect(projectConnectedAccountConfiguredEndpoints({ configuration: configuration('connectedAccountOrigin'),
            values: { endpoint: 'https://api.example.test', other: 'https://other.example.test' },
        })).toEqual([{ origin: 'https://api.example.test', base: 'https://api.example.test' }]);
        expect(projectConnectedAccountConfiguredEndpoints({ configuration: undefined, values: {} })).toEqual([]);
    });
    it('projects a fixed endpoint from its declared choice and rejects an unknown choice', () => {
        const fixed: Configuration = { scope: 'service', changeBehavior: 'refresh', fields: [{
            id: 'region', title: 'Region', required: true, secret: false, semantic: 'connectedAccountFixedOrigin',
            schema: { type: 'string', enum: ['us', 'de'] },
            originByValue: { us: 'https://us.example.test', de: 'https://de.example.test' },
        }] };
        expect(projectConnectedAccountConfiguredEndpoints({ configuration: fixed, values: { region: 'de' } }))
            .toEqual([{ origin: 'https://de.example.test', base: 'https://de.example.test' }]);
        expect(() => projectConnectedAccountConfiguredEndpoints({ configuration: fixed, values: { region: 'unknown' } })).toThrow();
    });
    it.each(['https://dev.azure.test/acme', 'https://server.example.test/tfs/DefaultCollection', 'https://192.168.4.7/collection'])
    ('preserves the configured service path, including private endpoints (%s)', base => {
        expect(projectConnectedAccountConfiguredEndpoints({ configuration: configuration('connectedAccountBase'), values: { endpoint: base + '/' } }))
            .toEqual([{ origin: new URL(base).origin, base }]);
    });
    it.each([
        'https://user:secret@dev.azure.test/acme', 'http://dev.azure.test/acme',
        'https://dev.azure.test/acme?project=secret', 'https://dev.azure.test/acme#fragment',
        'https://dev.azure.test/acme/../elsewhere', 'https://DEV.azure.test/acme', 'dev.azure.test/acme',
    ])('rejects malformed configured routing data (%s)', endpoint => {
        expect(() => projectConnectedAccountConfiguredEndpoints({ configuration: configuration('connectedAccountBase'), values: { endpoint } })).toThrow();
    });
});
