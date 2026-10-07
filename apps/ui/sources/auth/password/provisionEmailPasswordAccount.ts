import { KeyChallengeV2IssueResponseSchema, canonicalizeKeyChallengeV2AudienceOrigin } from '@happier-dev/protocol/auth/keyChallenge';
import { NATIVE_AUTH_EMAIL_PROVISION_PATH_V1, NativeEmailPasswordProvisionResponseV1Schema, type NativeAccountAdmissionV1, type NativeEmailPasswordProvisionResponseV1 } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { encodePasswordCredentialFieldV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { z } from 'zod';

import { authChallengeV2 } from '@/auth/flows/challenge';
import { confirmAlternateIssuedHomeAddress } from '@/auth/flows/homeAddressTrust';
import type { ResolvedHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { HappyError } from '@/utils/errors/errors';

import { preparePasswordCredentialMaterialV1 } from './preparePasswordCredential';

export type EmailPasswordProvisionTarget = ResolvedHomeAuthenticationTarget & Readonly<{
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
}>;

export type EmailPasswordProvisionInput = Readonly<{
    target: EmailPasswordProvisionTarget;
    email: string;
    password: string;
    /** Exactly the mode the Home's effective `provision` action admits. */
    accountMode: 'plain' | 'e2ee';
    admission: NativeAccountAdmissionV1;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    /** Create the Account for account-service sign-in: the server answers with its Directory credential. */
    credentialTarget?: 'account_directory';
}>;

export type EmailPasswordProvisionResult = Readonly<{
    credentials: AuthCredentials;
    accountId: string;
    teamId: string | null;
    /** Present for E2EE only: the one canonical recovery key to disclose. */
    recoverySecret: Uint8Array | null;
}>;

async function postProvision(request: ServerFetch, body: unknown): Promise<NativeEmailPasswordProvisionResponseV1> {
    const response = await request(NATIVE_AUTH_EMAIL_PROVISION_PATH_V1, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, { includeAuth: false, retry: 'none' });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = z.object({ error: z.string() }).safeParse(payload);
        throw new HappyError('Account creation failed', response.status >= 500 || response.status === 429, {
            kind: response.status >= 500 ? 'server' : 'auth',
            status: response.status,
            ...(parsed.success ? { code: parsed.data.error } : {}),
        });
    }
    return NativeEmailPasswordProvisionResponseV1Schema.parse(payload);
}

/**
 * Create one fresh native email/password Account in the exact requested mode.
 *
 * Everything the Home must verify — mailbox proof, admission bearer, signing
 * proof and content-key binding — is prepared here and committed by the Home's
 * single atomic fresh-Account transaction. A failure creates nothing.
 */
export async function provisionEmailPasswordAccount(
    input: EmailPasswordProvisionInput,
): Promise<EmailPasswordProvisionResult> {
    const assertCurrent = () => {
        if (input.signal?.aborted || input.isCurrent?.() === false) {
            const error = new Error('Account creation cancelled');
            error.name = 'AbortError';
            throw error;
        }
    };
    assertCurrent();
    const endpointRequest = createServerFetchAtEndpoint({
        ...input.target,
        credentials: null,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    const request: ServerFetch = async (path, init, options) => {
        assertCurrent();
        const response = await endpointRequest(path, init, options);
        assertCurrent();
        return response;
    };

    if (input.accountMode === 'plain') {
        const created = await postProvision(request, {
            v: 1,
            email: input.email,
            admission: input.admission,
            account: { mode: 'plain', password: input.password },
            ...(input.credentialTarget ? { credentialTarget: input.credentialTarget } : {}),
        });
        return {
            credentials: { token: created.token },
            accountId: created.accountId,
            teamId: created.teamId,
            recoverySecret: null,
        };
    }

    const secret = await getRandomBytesAsync(32);
    let succeeded = false;
    try {
        const prepared = await preparePasswordCredentialMaterialV1({
            password: input.password,
            secret,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        assertCurrent();
        const issueResponse = await request('/v1/auth/challenge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        }, { includeAuth: false, retry: 'none' });
        if (!issueResponse.ok) {
            throw new HappyError('Account creation failed', issueResponse.status >= 500, {
                kind: 'auth', status: issueResponse.status,
            });
        }
        const challenge = KeyChallengeV2IssueResponseSchema.parse(await issueResponse.json());
        const origin = canonicalizeKeyChallengeV2AudienceOrigin(input.target.addressAnchorUrl);
        if (!origin) throw new HappyError('Account creation failed', false, { kind: 'config' });
        const expectedAudience = { origin, serverIdentityId: input.target.serverIdentityId };
        const acceptAlternateOrigin =
            challenge.audience.origin !== expectedAudience.origin
            && await confirmAlternateIssuedHomeAddress({
                issued: challenge.audience,
                expected: expectedAudience,
            });
        assertCurrent();
        const assertion = authChallengeV2(secret, {
            challenge,
            expectedAudience,
            ...(acceptAlternateOrigin ? { acceptAlternateOrigin: true } : {}),
        });
        const binding = await buildContentKeyBinding(secret);
        assertCurrent();
        const created = await postProvision(request, {
            v: 1,
            email: input.email,
            admission: input.admission,
            account: {
                mode: 'e2ee',
                authKey: prepared.authKey,
                envelope: prepared.envelope,
                proof: {
                    challengeId: challenge.challengeId,
                    publicKey: encodeBase64(assertion.publicKey),
                    signature: encodeBase64(assertion.signature),
                    contentPublicKey: binding.contentPublicKey,
                    contentPublicKeySig: binding.contentPublicKeySig,
                },
            },
            ...(input.credentialTarget ? { credentialTarget: input.credentialTarget } : {}),
        });
        succeeded = true;
        return {
            credentials: { token: created.token, secret: encodePasswordCredentialFieldV1(secret) },
            accountId: created.accountId,
            teamId: created.teamId,
            recoverySecret: secret,
        };
    } finally {
        if (!succeeded) secret.fill(0);
    }
}
