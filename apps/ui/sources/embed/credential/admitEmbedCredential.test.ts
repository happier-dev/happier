import { describe, expect, it } from 'vitest';
import { ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import type { ServerFetch } from '@/sync/http/client';
import { admitEmbedCredential } from './admitEmbedCredential';

const self = {
    accountId: 'account', accountEncryptionMode: 'plain',
    credentialId: '00000000-0000-4000-8000-000000000001', parentTokenId: null, expiresAt: null,
    grant: { v: 1, actions: null, targets: null, approve: false,
        origins: ['https://parent.example', 'https://outer.example'], models: null, permissionModes: null, create: null },
    embedConfig: null,
};

describe('embed credential admission', () => {
    it('admits only self-confirmed origins and retains persisted Account mode', async () => {
        const paths: string[] = [];
        const request: ServerFetch = async (path) => {
            paths.push(String(path));
            return String(path) === ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1
                ? new Response(JSON.stringify(self), { status: 200 })
                : new Response(null, { status: 404 });
        };
        const admitted = await admitEmbedCredential({ request, parentOrigin: 'https://parent.example', ancestorOrigins: ['https://outer.example'] });
        expect(admitted.accountEncryptionMode).toBe('plain');
        expect(paths).toEqual([ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1]);
    });
    it('rejects an ungranted ancestor before any other authenticated request', async () => {
        const request: ServerFetch = async () => new Response(JSON.stringify(self));
        await expect(admitEmbedCredential({ request, parentOrigin: 'https://parent.example', ancestorOrigins: ['https://evil.example'] })).rejects.toThrow('origin_not_allowed');
    });
    it('does not accept origin prefixes, null origins, or malformed self authority', async () => {
        const request: ServerFetch = async () => new Response(JSON.stringify(self));
        await expect(admitEmbedCredential({ request, parentOrigin: 'https://parent.example.evil', ancestorOrigins: [] })).rejects.toThrow('origin_not_allowed');
        await expect(admitEmbedCredential({ request, parentOrigin: 'null', ancestorOrigins: [] })).rejects.toThrow('origin_not_allowed');
        await expect(admitEmbedCredential({ request: async () => new Response(JSON.stringify({ ...self, grant: { ...self.grant, send: true } })), parentOrigin: 'https://parent.example', ancestorOrigins: [] })).rejects.toThrow('credential_rejected');
    });
});
