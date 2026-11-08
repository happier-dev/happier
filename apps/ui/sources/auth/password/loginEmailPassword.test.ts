import { afterEach, describe, expect, it, vi } from 'vitest';

import { loginEmailPassword, type EmailPasswordLoginTarget } from './loginEmailPassword';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createPasswordEnvelopeAadV1, encodePasswordCredentialFieldV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { deriveKey } from '@/encryption/deriveKey';
import { sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

const runtimeFetch = vi.hoisted(() => vi.fn());
// The network is the boundary; request transport and protocol parsing stay real.
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch ,
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));

const target: EmailPasswordLoginTarget = {
    endpointUrl: 'https://password-home.example.test',
    canonicalServerUrl: 'https://password-home.example.test',
    addressAnchorUrl: 'https://password-home.example.test',
    serverId: 'password-home',
    serverIdentityId: 'srv_password_home',
};
const password = '  exact e\u0301 password \ud83d\udd11  ';
function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => { runtimeFetch.mockReset(); vi.unstubAllGlobals(); });

describe('native password login', () => {
    it('unlocks the exact recovery secret and authenticates only the expected Account without sending password text', async () => {
        const root = new Uint8Array(32).fill(9);
        const secret = new Uint8Array(32).fill(4);
        const wrapKey = await deriveKey(root, 'Happier Password Envelope', ['v1', 'wrap']);
        const authKey = await deriveKey(root, 'Happier Password Envelope', ['v1', 'auth']);
        const kdf = {
            algorithm: 'argon2id13', salt: encodePasswordCredentialFieldV1(new Uint8Array(16)),
            opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32,
        } as const;
        const header = {
            v: 1, accountSigningPublicKey: encodePasswordCredentialFieldV1(deriveAccountSigningPublicKey(secret)), kdf,
            cipher: { algorithm: 'aes256gcm', nonce: encodePasswordCredentialFieldV1(new Uint8Array(12)) },
        } as const;
        const ciphertext = await sealAes256GcmBytes({ key: wrapKey, nonce: new Uint8Array(12), aad: createPasswordEnvelopeAadV1(header), plaintext: secret });
        const envelope = { ...header, cipher: { ...header.cipher, ciphertext: encodePasswordCredentialFieldV1(ciphertext) } };
        const issuedChallenge = {
            challengeId: 'password-login-challenge', nonce: 'password-login-nonce',
            issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
            audience: { origin: target.canonicalServerUrl, serverIdentityId: target.serverIdentityId },
        } as const;
        // The worker is a browser boundary; local key separation, AES and Key Challenge stay real.
        vi.stubGlobal('Worker', class {
            onmessage: ((event: { data: unknown }) => void) | null = null;
            onerror = null;
            onmessageerror = null;
            postMessage(input: { password: Uint8Array }) {
                expect(input.password).toEqual(new TextEncoder().encode(password));
                queueMicrotask(() => this.onmessage?.({ data: { ok: true, key: root.slice() } }));
            }
            terminate() {}
        });
        runtimeFetch.mockImplementation(async (url: string, init: RequestInit) => {
            const body = init.body ? JSON.parse(String(init.body)) : null;
            if (body) expect(body).not.toHaveProperty('password');
            expect(new Headers(init.headers).has('Authorization')).toBe(false);
            if (url.endsWith('/prelogin')) return json({ v: 1, kind: 'e2ee_password_unlock', kdf });
            if (url.endsWith('/unlock')) {
                expect(body).toEqual({ v: 1, email: 'person@example.test', authKey: encodePasswordCredentialFieldV1(authKey) });
                return json({ envelope, expectedAccountId: 'encrypted-account', challenge: issuedChallenge });
            }
            if (url.endsWith('/v1/features')) return json(createRootLayoutFeaturesResponse({
                capabilities: {
                    serverIdentity: { serverIdentityId: target.serverIdentityId },
                    auth: { keyChallenge: { v2: true } },
                    accountStoredContentCompatibility: {
                        v: 1,
                        minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        declarationTransport: 'http-header-and-socket-auth-v1',
                    },
                },
            }));
            expect(url).toBe(`${target.endpointUrl}/v1/auth`);
            expect(body).toMatchObject({ expectedAccountId: 'encrypted-account', challengeId: 'password-login-challenge' });
            return json({ token: 'encrypted-token' });
        });
        await expect(loginEmailPassword({ target, email: 'person@example.test', password })).resolves.toEqual({
            token: 'encrypted-token', secret: encodePasswordCredentialFieldV1(secret),
        });
    });

    it('preserves exact password text and returns keyless credentials from the captured Home', async () => {
        runtimeFetch.mockImplementation(async (url: string, init: RequestInit) => {
            expect(url.startsWith(target.endpointUrl)).toBe(true);
            expect(new Headers(init.headers).has('Authorization')).toBe(false);
            if (url.endsWith('/prelogin')) {
                expect(JSON.parse(String(init.body))).toEqual({ v: 1, email: 'person@example.test' });
                return json({ v: 1, kind: 'plain_password' });
            }
            expect(url).toBe(`${target.endpointUrl}/v1/auth/email/login`);
            expect(JSON.parse(String(init.body))).toEqual({ v: 1, email: 'person@example.test', password });
            return json({ token: 'plain-token' });
        });
        await expect(loginEmailPassword({ target, email: 'person@example.test', password })).resolves.toEqual({ token: 'plain-token' });
    });

    it('asks the password route for an Account Directory credential when signing in to an account service', async () => {
        runtimeFetch.mockImplementation(async (url: string, init: RequestInit) => {
            if (url.endsWith('/prelogin')) return json({ v: 1, kind: 'plain_password' });
            expect(url).toBe(`${target.endpointUrl}/v1/auth/email/login`);
            expect(JSON.parse(String(init.body))).toEqual({
                v: 1, email: 'person@example.test', password, credentialTarget: 'account_directory',
            });
            return json({ token: 'directory-token' });
        });
        await expect(loginEmailPassword({
            target, email: 'person@example.test', password, credentialTarget: 'account_directory',
        })).resolves.toEqual({ token: 'directory-token' });
    });

    it('redeems an unlocked E2EE key at the Account Directory Key Challenge for the exact unlocked Account', async () => {
        const root = new Uint8Array(32).fill(9);
        const secret = new Uint8Array(32).fill(4);
        const wrapKey = await deriveKey(root, 'Happier Password Envelope', ['v1', 'wrap']);
        const kdf = {
            algorithm: 'argon2id13', salt: encodePasswordCredentialFieldV1(new Uint8Array(16)),
            opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32,
        } as const;
        const header = {
            v: 1, accountSigningPublicKey: encodePasswordCredentialFieldV1(deriveAccountSigningPublicKey(secret)), kdf,
            cipher: { algorithm: 'aes256gcm', nonce: encodePasswordCredentialFieldV1(new Uint8Array(12)) },
        } as const;
        const ciphertext = await sealAes256GcmBytes({ key: wrapKey, nonce: new Uint8Array(12), aad: createPasswordEnvelopeAadV1(header), plaintext: secret });
        const envelope = { ...header, cipher: { ...header.cipher, ciphertext: encodePasswordCredentialFieldV1(ciphertext) } };
        const challenge = (challengeId: string) => ({
            challengeId, nonce: `${challengeId}-nonce`,
            issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
            audience: { origin: target.canonicalServerUrl, serverIdentityId: target.serverIdentityId },
        });
        vi.stubGlobal('Worker', class {
            onmessage: ((event: { data: unknown }) => void) | null = null;
            onerror = null;
            onmessageerror = null;
            postMessage() { queueMicrotask(() => this.onmessage?.({ data: { ok: true, key: root.slice() } })); }
            terminate() {}
        });
        const redeemed: string[] = [];
        runtimeFetch.mockImplementation(async (url: string, init: RequestInit) => {
            const body = init.body ? JSON.parse(String(init.body)) : null;
            if (url.endsWith('/prelogin')) return json({ v: 1, kind: 'e2ee_password_unlock', kdf });
            if (url.endsWith('/unlock')) {
                return json({ envelope, expectedAccountId: 'encrypted-account', challenge: challenge('home-purpose-challenge') });
            }
            if (url.endsWith('/v1/features')) return json(createRootLayoutFeaturesResponse({
                capabilities: {
                    serverIdentity: { serverIdentityId: target.serverIdentityId },
                    auth: { keyChallenge: { v2: true } },
                    accountStoredContentCompatibility: {
                        v: 1,
                        minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        declarationTransport: 'http-header-and-socket-auth-v1',
                    },
                },
            }));
            if (url === `${target.endpointUrl}/v1/auth/account-directory/challenge`) {
                expect(body).toMatchObject({ expectedAccountId: 'encrypted-account' });
                return json(challenge('directory-challenge'));
            }
            redeemed.push(url);
            expect(url).toBe(`${target.endpointUrl}/v1/auth/account-directory`);
            expect(body).toMatchObject({
                expectedAccountId: 'encrypted-account', challengeId: 'directory-challenge', requireExistingAccount: true,
            });
            return json({ success: true, token: 'directory-token' });
        });
        await expect(loginEmailPassword({
            target, email: 'person@example.test', password, credentialTarget: 'account_directory',
        })).resolves.toEqual({ token: 'directory-token', secret: encodePasswordCredentialFieldV1(secret) });
        expect(redeemed).toEqual([`${target.endpointUrl}/v1/auth/account-directory`]);
    });

    it('does not send a password after its captured form becomes stale during prelogin', async () => {
        let current = true;
        runtimeFetch.mockImplementation(async () => {
            current = false;
            return json({ v: 1, kind: 'plain_password' });
        });
        await expect(loginEmailPassword({ target, email: 'person@example.test', password, isCurrent: () => current }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(runtimeFetch.mock.calls).toHaveLength(1);
    });

    it('rejects malformed prelogin without disclosing password to another route', async () => {
        runtimeFetch.mockResolvedValue(json({ v: 1, kind: 'plain_password', expectedAccountId: 'leaked' }));
        // The strict prelogin schema refuses the unknown field before any password route is chosen.
        await expect(loginEmailPassword({ target, email: 'person@example.test', password })).rejects.toMatchObject({
            issues: expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys', keys: ['expectedAccountId'] })]),
        });
        expect(runtimeFetch.mock.calls).toHaveLength(1);
    });

    it('keeps typed post-factor account disablement without returning credentials', async () => {
        runtimeFetch.mockResolvedValueOnce(json({ v: 1, kind: 'plain_password' }))
            .mockResolvedValueOnce(json({ error: 'account-disabled' }, 403));
        await expect(loginEmailPassword({ target, email: 'person@example.test', password }))
            .rejects.toMatchObject({ code: 'account-disabled', status: 403 });
    });
});
