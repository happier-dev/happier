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
        })).toEqual({ ok: true, credentials: guest });
        expect(reads).toBe(0);
    });

    it('refuses a guest without retained custody and preserves the installed owner identity', async () => {
        const credentials = credentialsFor('custodian');
        let reads = 0;
        const readCredentials = async () => { reads++; return credentials; };
        // A guest's personal call carries no custody of its own: Services here run as the owner.
        expect(await resolveLocalServiceActionCredentials({ credentials, actorAccountId: 'guest',
            requester: null, readCredentials })).toEqual({ ok: false, errorCode: 'custodian_only' });
        expect(reads).toBe(0);
        expect(await resolveLocalServiceActionCredentials({ credentials, actorAccountId: 'custodian',
            requester: null, readCredentials })).toEqual({ ok: true, credentials });
        // Custody that does not match its actor, or an owner whose stored sign-in changed, is a credential fault.
        expect(await resolveLocalServiceActionCredentials({ credentials, actorAccountId: 'guest',
            requester: { credentials: credentialsFor('another') }, readCredentials }))
            .toEqual({ ok: false, errorCode: 'requester_credentials_unavailable' });
        expect(await resolveLocalServiceActionCredentials({ credentials, actorAccountId: 'custodian',
            requester: null, readCredentials: async () => credentialsFor('custodian-replaced') }))
            .toEqual({ ok: false, errorCode: 'requester_credentials_unavailable' });
    });
});
