import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { accountDirectoryCredentialStorage } from './accountDirectoryCredentialStorage';
import {
    createAccountDirectoryClient,
    type HomeLoginAssertionV1,
} from '@/sync/api/accountDirectory/accountDirectoryClient';
import { adoptHomeProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';

export type AccountDirectoryAuthCompletion = Readonly<{
    endpoint: string;
    token: string;
    purpose?: 'account_directory';
    serverIdentityId?: string;
}>;

/**
 * Account Service authentication is intentionally explicit-targeted. These methods never
 * consult or mutate the focused Home runtime; callers decide when/where a discovered Home is
 * adopted.
 */
export const accountDirectoryAuthClient = {
    async storeCredentials(endpoint: string, credentials: AuthCredentials): Promise<boolean> {
        return await accountDirectoryCredentialStorage.set(endpoint, credentials);
    },

    async completeOAuth(completion: AccountDirectoryAuthCompletion): Promise<boolean> {
        if (completion.purpose !== undefined && completion.purpose !== 'account_directory') {
            throw new Error('Invalid Account Service OAuth purpose');
        }
        if (!completion.token.trim()) throw new Error('Invalid Account Service OAuth token');
        return await accountDirectoryCredentialStorage.set(completion.endpoint, { token: completion.token });
    },

    async loginWithToken(endpoint: string, token: string): Promise<boolean> {
        return await this.completeOAuth({ endpoint, token, purpose: 'account_directory' });
    },

    getClient(endpoint: string) {
        return createAccountDirectoryClient(endpoint);
    },

    /** Reconcile directory-discovered Homes through Lane 04's sole adoption owner. */
    async reconcileHomes(endpoint: string): Promise<readonly ServerProfile[]> {
        const response = await createAccountDirectoryClient(endpoint).listHomes();
        const adopted: ServerProfile[] = [];
        for (const home of response.homes) {
            adopted.push(await adoptHomeProfile({
                descriptor: home.connectionDescriptor,
                source: 'account-directory',
                preserveUserLabel: true,
            }));
        }
        return adopted;
    },

    async requestHomeLoginAssertion(
        endpoint: string,
        homeServerIdentityId: string,
        clientBoxPublicKeyBase64: string,
    ): Promise<HomeLoginAssertionV1> {
        const client = createAccountDirectoryClient(endpoint);
        return await client.requestLoginAssertion(homeServerIdentityId, { clientBoxPublicKeyBase64 });
    },

    async logout(endpoint: string): Promise<boolean> {
        return await accountDirectoryCredentialStorage.remove(endpoint);
    },
};

export async function completeAccountDirectoryOAuth(
    completion: AccountDirectoryAuthCompletion,
): Promise<boolean> {
    return await accountDirectoryAuthClient.completeOAuth(completion);
}
