import type { ConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it } from 'vitest';

import { parseHttpHeadersRequestAuthMaterial } from './parseHttpHeadersRequestAuthMaterial';

const request = {
    kind: 'httpHeaders',
    origin: 'https://chatgpt.com',
    headerNames: ['authorization', 'chatgpt-account-id'],
} as const;

describe('parseHttpHeadersRequestAuthMaterial', () => {
    it.each([
        { headerNames: ['x-api-key'], headers: { 'x-api-key': 'fixture-key' } },
        { headerNames: ['authorization'], headers: { authorization: 'Basic Zml4dHVyZTpwYXNz' } },
    ])('preserves complete declared headers and scalar executor facts %#', ({ headerNames, headers }) => {
        const facts = { projectId: 'project-fixture', priority: 2, enabled: true };
        expect(parseHttpHeadersRequestAuthMaterial({ ...request, headerNames }, {
            kind: 'httpHeaders', headers, facts, expiresAt: 123_456,
        })).toEqual({ headers, facts, expiresAt: 123_456 });
    });

    it('preserves the authoritative omission of optional account context', () => {
        expect(parseHttpHeadersRequestAuthMaterial(request, {
            kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-access' },
        })).toEqual({ headers: { authorization: 'Bearer fixture-access' }, facts: {} });
    });

    it('projects credential headers without forwarding declared usage metadata', () => {
        const material = {
            kind: 'httpHeaders',
            usageAccountScope: 'workspace',
            headers: { authorization: 'Bearer fixture-access', 'chatgpt-account-id': 'fixture-account' },
        } satisfies ConnectedAccountMaterialization;

        expect(parseHttpHeadersRequestAuthMaterial(request, material)).toEqual({
            headers: { authorization: 'Bearer fixture-access', 'chatgpt-account-id': 'fixture-account' },
            facts: {},
        });
    });

    it.each([
        { usageAccountScope: 'unsupported' },
        { unrecognizedMetadata: 'workspace' },
    ])('refuses malformed or undeclared metadata %#', (metadata) => {
        expect(() => parseHttpHeadersRequestAuthMaterial(request, {
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer fixture-access' },
            ...metadata,
        })).toThrow(expect.objectContaining({ code: 'request_auth_credential_unavailable',
            diagnostic: { causeCode: 'request_auth_materialization_invalid' } }));
    });
});
