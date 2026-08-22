import { describe, expect, it } from 'vitest';

import {
    serializeManagedServiceEndpointReadRequestHeaders,
} from './managedServiceEndpointReadHeaders';

describe('managed service endpoint read request headers', () => {
    it.each([
        'API-Key',
        'X-Auth-Token',
        'X-Goog-Api-Key',
    ])('rejects credential-bearing caller header %s', (name) => {
        expect(() => serializeManagedServiceEndpointReadRequestHeaders({
            [name]: 'caller-secret',
        })).toThrow('cannot supply authentication');
    });

    it('preserves ordinary bounded caller headers', () => {
        const exactMaximumValue = 'x'.repeat(8_192);
        expect(serializeManagedServiceEndpointReadRequestHeaders({
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Request-Context': exactMaximumValue,
        })).toEqual({
            accept: 'application/json',
            'content-type': 'application/json',
            'x-request-context': exactMaximumValue,
        });
    });
});
