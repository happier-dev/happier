import { describe, expect, it } from 'vitest';
import {
    NATIVE_AUTH_EMAIL_LOGIN_PATH_V1,
    NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1,
    NativeEmailPasswordLoginResponseV1Schema,
    NativeEmailPasswordPreloginResponseV1Schema,
} from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import {
    PASSWORD_ENVELOPE_KDF_SALT_BYTES_V1,
    PASSWORD_ENVELOPE_WRITER_PROFILE_V1,
    encodePasswordCredentialFieldV1,
} from '@happier-dev/protocol/auth/accountPasswordCredential';
import { ACCOUNT_MODE_DOWNGRADE_UNVERIFIED, AccountModeDowngradeUnverifiedError } from '@happier-dev/sync-client';

import { TokenStorage, withAccountE2eeCustody } from '@/auth/storage/tokenStorage';
import { describeEmailPasswordFailure } from '@/components/account/auth/emailPassword/emailPasswordFormModel';
import { countTransportRequests } from '@/dev/testkit';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { encodeBase64 } from '@/encryption/base64';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { loginEmailPassword } from './loginEmailPassword';

const target = {
    endpointUrl: 'https://password-home.example.test',
    canonicalServerUrl: 'https://password-home.example.test',
    addressAnchorUrl: 'https://password-home.example.test',
    serverId: 'local-password-home',
    serverIdentityId: 'srv_password_home',
};
const input = { target, email: 'person@example.test', password: 'a valid test password' };
const storedKeys = {
    token: 'stored-test-token',
    secret: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(4)),
};

function offerPlainPasswordSignIn() {
    const requests = countTransportRequests(async (url: RequestInfo | URL) => {
        const path = new URL(String(url)).pathname;
        if (path === NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1) {
            return Response.json(NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'plain_password' }));
        }
        if (path === NATIVE_AUTH_EMAIL_LOGIN_PATH_V1) {
            return Response.json(NativeEmailPasswordLoginResponseV1Schema.parse({ token: 'plain-test-token' }));
        }
        throw new Error(`Unexpected auth route: ${path}`);
    }, (url) => new URL(String(url)).pathname);
    setRuntimeFetch(requests.request);
    return requests;
}

async function expectRefusalBeforeLogin(credentialTarget?: 'account_directory') {
    const requests = offerPlainPasswordSignIn();
    const outcome = await loginEmailPassword({ ...input, credentialTarget }).catch((error: unknown) => error);
    expect.soft(requests.read()).toEqual({ [NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1]: 1 });
    expect(outcome).toBeInstanceOf(AccountModeDowngradeUnverifiedError);
    expect(outcome).toMatchObject({ code: ACCOUNT_MODE_DOWNGRADE_UNVERIFIED });
    expect(describeEmailPasswordFailure(outcome)).toEqual({
        field: 'form',
        messageKey: 'machineDetailPage.recovery.enrollmentRequired',
    });
}

describe('plain password prelogin custody', () => {
    it.each([
        { kind: 'Home', credentialTarget: undefined },
        { kind: 'Account Directory', credentialTarget: 'account_directory' as const },
    ])('does not POST a password for $kind sign-in while the target Home pins active keys', async ({ credentialTarget }) => {
        expect(await TokenStorage.setCredentialsForServerUrl(target.endpointUrl, { serverId: target.serverIdentityId }, storedKeys)).toBe(true);
        await expectRefusalBeforeLogin(credentialTarget);
    });

    it('does not POST a password while the target Account Service has its own active content key', async () => {
        const encryption = await createEncryptionFromAuthCredentials(storedKeys);
        expect(await TokenStorage.accountDirectoryAuthCredentials.set(
            { endpoint: target.endpointUrl, serverIdentityId: target.serverIdentityId },
            { token: 'directory-test-token' },
            {
                retainedContentKey: {
                    publicKey: encodeBase64(encryption.contentDataKey, 'base64'),
                    machineKey: encodeBase64(encryption.getContentPrivateKey(), 'base64'),
                },
            },
        )).toBe(true);
        await expectRefusalBeforeLogin('account_directory');
    });

    it('allows plain sign-in with historical keys for the target Home', async () => {
        expect(await TokenStorage.setCredentialsForServerUrl(
            target.endpointUrl,
            { serverId: target.serverIdentityId },
            withAccountE2eeCustody(storedKeys, 'historical'),
        )).toBe(true);
        offerPlainPasswordSignIn();
        await expect(loginEmailPassword(input)).resolves.toEqual({ token: 'plain-test-token' });
    });

    it('allows first sign-in when only a different Home has active keys', async () => {
        expect(await TokenStorage.setCredentialsForServerUrl(
            'https://other-home.example.test',
            { serverId: 'srv_other_home' },
            storedKeys,
        )).toBe(true);
        offerPlainPasswordSignIn();
        await expect(loginEmailPassword(input)).resolves.toEqual({ token: 'plain-test-token' });
    });

    it('routes encrypted prelogin with active keys to password derivation', async () => {
        expect(await TokenStorage.setCredentialsForServerUrl(
            target.endpointUrl,
            { serverId: target.serverIdentityId },
            storedKeys,
        )).toBe(true);
        const requests = countTransportRequests(async (url: RequestInfo | URL, init?: RequestInit) => {
            expect(new URL(String(url)).pathname).toBe(NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1);
            expect(JSON.parse(String(init?.body))).not.toHaveProperty('password');
            return Response.json(NativeEmailPasswordPreloginResponseV1Schema.parse({
                v: 1,
                kind: 'e2ee_password_unlock',
                kdf: {
                    ...PASSWORD_ENVELOPE_WRITER_PROFILE_V1,
                    salt: encodePasswordCredentialFieldV1(new Uint8Array(PASSWORD_ENVELOPE_KDF_SALT_BYTES_V1)),
                },
            }));
        }, (url) => new URL(String(url)).pathname);
        setRuntimeFetch(requests.request);
        // The Node test host has no browser Worker. Reaching its KDF boundary proves the branch.
        await expect(loginEmailPassword(input)).rejects.toThrow('password_kdf_unavailable');
        expect(requests.read()).toEqual({ [NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1]: 1 });
    });
});
