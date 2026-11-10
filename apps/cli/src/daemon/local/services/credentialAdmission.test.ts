import { describe, expect, it } from 'vitest';
import type { StoredCredentials } from '@/persistence';
import { resolveLocalServiceActionCredentials } from './credentialAdmission';

const credentialsFor = (accountId: string): StoredCredentials => ({
    token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    encryption: null,
});

describe('receiving Services Action credentials', () => {
    it('uses retained guest custody without reading the custodian store', async () => {
        const credentials = credentialsFor('custodian');
        const guest = credentialsFor('guest');
        let reads = 0;
        expect(await resolveLocalServiceActionCredentials({ credentials, actorAccountId: 'guest',
            requester: { credentials: guest }, readCredentials: async () => { reads++; return credentials; },
        })).toBe(guest);
        expect(reads).toBe(0);
    });

    it('refuses a guest without retained custody and preserves the installed owner identity', async () => {
        const credentials = credentialsFor('custodian');
        const readCredentials = async () => credentials;
        expect(await resolveLocalServiceActionCredentials({ credentials, actorAccountId: 'guest',
            requester: null, readCredentials })).toBeNull();
        expect(await resolveLocalServiceActionCredentials({ credentials, actorAccountId: 'custodian',
            requester: null, readCredentials })).toBe(credentials);
        expect(await resolveLocalServiceActionCredentials({ credentials, actorAccountId: 'guest',
            requester: { credentials: credentialsFor('another') }, readCredentials })).toBeNull();
    });
});
