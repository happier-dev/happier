import { describe, expect, it } from 'vitest';

import { classifyConnectedAccountTokenEndpointFailure, parseConnectedAccountTokenEndpointFailure } from './tokenEndpointFailure.js';

describe('classifyConnectedAccountTokenEndpointFailure', () => {
    it.each([
        ['invalid_grant', 'invalid_grant'],
        ['refresh_token_reused', 'invalid_grant'],
        ['refresh_token_expired', 'invalid_grant'],
        ['refresh_token_invalidated', 'invalid_grant'],
        ['invalid_client', 'invalid_client'],
        ['unauthorized_client', 'provider_401'],
        ['private-token-value', 'provider_401'],
    ] as const)('retains only an allowlisted OAuth code: %s', (code, kind) => {
        for (const error of [code, { code }]) {
            const result = parseConnectedAccountTokenEndpointFailure({
                status: 401,
                body: new TextEncoder().encode(JSON.stringify({ error,
                    error_description: 'private-description', access_token: 'private-access', refresh_token: 'private-refresh' })),
            });
            expect(result).toEqual({ kind, ...(code === 'private-token-value' ? {} : { providerErrorCode: code }) });
        }
    });

    it.each([
        [400, { error: 'invalid_grant' }, 'invalid_grant'],
        [401, { error: 'invalid_grant' }, 'invalid_grant'],
        [403, { error: 'invalid_client' }, 'invalid_client'],
        [401, { error: 'other_error' }, 'provider_401'],
        [403, {}, 'provider_403'],
        [400, { error: 'other_error', error_description: 'invalid_grant' }, 'unknown'],
        [400, { error: { code: 'invalid_grant' } }, 'invalid_grant'],
        [401, { error: 'refresh_token_reused' }, 'invalid_grant'],
        [401, { error: { code: 'refresh_token_expired' } }, 'invalid_grant'],
        [401, { error: { code: 'refresh_token_invalidated' } }, 'invalid_grant'],
        [400, { error: ['invalid_grant'] }, 'unknown'],
        [400, { access_token: 'invalid_grant', refresh_token: 'invalid_client' }, 'unknown'],
    ] as const)('classifies HTTP %i and %j as %s using only the error code', (status, body, expected) => {
        expect(classifyConnectedAccountTokenEndpointFailure({
            status,
            body: new TextEncoder().encode(JSON.stringify(body)),
        })).toBe(expected);
    });

    it('preserves the HTTP rejection when the error response is not JSON', () => {
        expect(classifyConnectedAccountTokenEndpointFailure({
            status: 401, body: new TextEncoder().encode('invalid_grant'),
        })).toBe('provider_401');
        expect(classifyConnectedAccountTokenEndpointFailure({
            status: 400, body: new Uint8Array(),
        })).toBe('unknown');
    });
});
