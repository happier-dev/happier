import { getConnectedAccountDescriptor } from '@happier-dev/protocol';

export const BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID = 'bitbucket' as const;
export const BITBUCKET_BASIC_AUTH_CREDENTIAL_KIND = 'bitbucket_basic_auth' as const;
export const BITBUCKET_BASIC_AUTH_MATERIALIZATION_KIND = 'scm_hosting_basic_auth' as const;
export const BITBUCKET_CLOUD_HOST = 'bitbucket.org' as const;

export function getBitbucketConnectedAccountDescriptor() {
    const descriptor = getConnectedAccountDescriptor(BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID);
    if (!descriptor) {
        throw new Error('Bitbucket connected-account descriptor is not registered');
    }
    return descriptor;
}
