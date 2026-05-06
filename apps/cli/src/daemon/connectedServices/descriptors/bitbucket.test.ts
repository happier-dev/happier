import { describe, expect, it } from 'vitest';

import {
    BITBUCKET_BASIC_AUTH_CREDENTIAL_KIND,
    BITBUCKET_BASIC_AUTH_MATERIALIZATION_KIND,
    BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
    getBitbucketConnectedAccountDescriptor,
} from './bitbucket';

describe('Bitbucket connected-account descriptor', () => {
    it('projects Cloud API-token credentials into SCM hosting basic auth', () => {
        const descriptor = getBitbucketConnectedAccountDescriptor();

        expect(descriptor.id).toBe(BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID);
        expect(descriptor.oauth).toBeUndefined();
        expect(descriptor.tokenSetup).toMatchObject({
            tokenKind: 'api-token',
            credentialPayloadKind: BITBUCKET_BASIC_AUTH_CREDENTIAL_KIND,
            identity: {
                kind: 'email_or_username',
            },
        });
        expect(descriptor.materialization.materializationKinds).toContain(BITBUCKET_BASIC_AUTH_MATERIALIZATION_KIND);
    });
});
