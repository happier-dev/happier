import tweetnacl from 'tweetnacl';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { AccountDirectoryMeResponseV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { createHomeCredentialDestinationDigestV1, type AccountDirectoryHomeEntryV1 as WireAccountDirectoryHomeEntryV1 } from '@happier-dev/protocol/auth/accountDirectory';
import type { OpenedAccountDirectoryHomeEntryV1 as AccountDirectoryHomeEntryV1 } from '@happier-dev/protocol/auth/openedAccountDirectoryHome';
import type { AuthEntryProjectionV1 } from '@happier-dev/protocol/auth/entry';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { sealSavedSecretResourceRecipientEnvelopeV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';

/** Project the fixture's client-opened Home model at the Account Directory wire boundary. */
export function toAccountDirectoryHomeWire(home: AccountDirectoryHomeEntryV1): WireAccountDirectoryHomeEntryV1 {
    return {
        ...home,
        label: { content: { t: 'plain', v: home.label }, recipientEnvelope: null },
    };
}

export function createDirectoryHttpFixture(options: Readonly<{
    sameServiceHome?: boolean;
    /** Match a real key login's retained E2EE custody without changing the Home Account mode. */
    directoryRecoverySecret?: Uint8Array;
}> = {}) {
    const directoryContentPublicKey = options.directoryRecoverySecret
        ? tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(options.directoryRecoverySecret)).publicKey
        : null;
    const homeRecoverySecret = new Uint8Array(32).fill(7);
    const directoryToken = createAccountTokenForTests('account-directory');
    const endpoint = 'https://directory.test';
    const identity = 'srv_directory';
    const home: AccountDirectoryHomeEntryV1 = {
        v: 1, homeServerIdentityId: options.sameServiceHome ? identity : 'srv_home_b',
        canonicalServerUrl: options.sameServiceHome ? endpoint : 'https://home-b.test',
        label: 'Home B', preferred: true, createdAtMs: 1, updatedAtMs: 1,
        connectionDescriptor: { v: 1,
            homeServerIdentityId: options.sameServiceHome ? identity : 'srv_home_b',
            canonicalServerUrl: options.sameServiceHome ? endpoint : 'https://home-b.test',
            revision: 1, endpoints: [{ kind: 'https', url: options.sameServiceHome ? endpoint : 'https://home-b.test' }] },
    };
    const capability = { version: 1 as const, homeDirectory: true, homeEnrollment: true,
        homeLoginAssertion: { keyId: 'a'.repeat(64), publicKeyBase64Url: 'A'.repeat(43) } };
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: identity }, accountDirectory: capability,
        server: { canonicalServerUrl: endpoint },
        auth: { keyChallenge: { v2: true } },
    } });
    const service = { endpointUrl: endpoint, serverIdentityId: identity, canonicalServerUrl: endpoint,
        capability, snapshot: { status: 'ready' as const, features } };
    const state = {
        homes: [home], preferredHomeServerIdentityId: home.homeServerIdentityId as string | null,
        approval: 'required' as 'required' | 'approved' | 'rejected' | 'expired',
        mode: 'plain' as 'plain' | 'e2ee',
        directoryStatus: 200, loginAssertionStatus: 200, exchangeStatus: 200, exchangeError: 'invalid_request',
        me: {
            v: 1 as const, accountId: 'account-directory', encryptionMode: 'plain' as const,
            displayName: 'Ada Lovelace' as string | null, avatar: null as string | null,
            linkedAuthenticationMethods: [{ providerId: 'github', login: 'ada' as string | null }],
        } as AccountDirectoryMeResponseV1,
        calls: [] as Array<{ endpoint: string; path: string; init?: RequestInit }>,
    };
    const directoryMode = () => directoryContentPublicKey ? 'e2ee' : state.mode;
    const directoryHomeWire = (entry: AccountDirectoryHomeEntryV1): WireAccountDirectoryHomeEntryV1 => {
        if (!directoryContentPublicKey) return toAccountDirectoryHomeWire(entry);
        const dataKey = tweetnacl.randomBytes(32);
        return { ...entry, label: projectPrivateLabelForRecipientV1({
            recipientAccountId: state.me.accountId,
            stored: sealPrivateLabelV1({
                mode: 'e2ee', binding: { entity: 'account_directory_home', field: 'label', id: entry.homeServerIdentityId },
                value: entry.label, dataKey, randomBytes: tweetnacl.randomBytes,
                recipients: [{ accountId: state.me.accountId, envelope: sealSavedSecretResourceRecipientEnvelopeV1({
                    resourceDataKey: dataKey, recipientContentPublicKey: directoryContentPublicKey, randomBytes: tweetnacl.randomBytes,
                }) }],
            }),
        }) };
    };
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: options.sameServiceHome ? 'account-directory' : 'account-home' })), 'base64')}.signature`;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    const request = async (requestEndpoint: string, path: string, init?: RequestInit): Promise<Response> => {
        state.calls.push({ endpoint: requestEndpoint, path, init });
        const currentHome = state.homes.find((entry) => entry.homeServerIdentityId === home.homeServerIdentityId) ?? home;
        if (path === '/v1/features') return json(requestEndpoint === endpoint ? {
            ...features,
            ...(options.sameServiceHome ? { homeConnectionDescriptor: currentHome.connectionDescriptor } : {}),
        } : {
            ...createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: currentHome.homeServerIdentityId } } }),
            homeConnectionDescriptor: currentHome.connectionDescriptor,
        });
        if (path === '/v1/auth/entry') return json({
            v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
            actions: [{ kind: 'authenticate', methodId: 'key_challenge', action: 'login', mode: 'keyed',
                origin: 'home', presentation: { displayName: 'Account key' } }],
        } satisfies AuthEntryProjectionV1);
        if (path === '/v1/account-directory/private-labels/recipient-census') return json({
            contentEncryptionMode: directoryMode(), recipients: directoryContentPublicKey ? [{
                account: { kind: 'account', accountId: state.me.accountId, name: state.me.displayName,
                    firstName: null, lastName: null, username: null, avatarUrl: state.me.avatar },
                readiness: { status: 'available', contentPublicKey: encodeBase64(directoryContentPublicKey, 'base64'),
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(directoryContentPublicKey) },
                envelopeStatus: 'missing',
            }] : [],
        });
        if (path === '/v1/account-directory/homes') return json(
            state.directoryStatus === 200 ? { v: 1, homes: state.homes.map(directoryHomeWire), preferredHomeServerIdentityId: state.preferredHomeServerIdentityId }
                : { error: 'invalid_token' }, state.directoryStatus);
        if (path === '/v1/account-directory/me') return json(
            state.directoryStatus === 200 ? { ...state.me, encryptionMode: directoryMode() } : { error: 'invalid_token' }, state.directoryStatus);
        if (path.includes('/login-assertion')) {
            if (state.loginAssertionStatus !== 200) {
                return json({ error: 'invalid_token' }, state.loginAssertionStatus);
            }
            const body = JSON.parse(String(init?.body));
            return json({ v: 1, purpose: 'happier.home-login', issuerServerIdentityId: identity,
                issuerSubjectId: 'account-directory', audienceHomeServerIdentityId: currentHome.homeServerIdentityId,
                credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(currentHome.connectionDescriptor),
                clientBoxPublicKeyBase64: body.clientBoxPublicKeyBase64,
                issuedAtMs: Date.now(), expiresAtMs: Date.now() + 180_000,
                keyId: capability.homeLoginAssertion.keyId, signatureBase64Url: 'A'.repeat(86) });
        }
        if (path === '/v1/auth/home-login') {
            if (state.approval === 'required') return json({ v: 1, outcome: 'approval_required',
                homeServerIdentityId: home.homeServerIdentityId, approvalId: 'approval-b', deviceLabel: null, expiresAtMs: Date.now() + 180_000 });
            if (state.approval !== 'approved') return json({ error: state.approval === 'expired' ? 'approval_expired' : 'approval_rejected' }, 403);
            const body = JSON.parse(String(init?.body));
            return json({ v: 1, homeServerIdentityId: currentHome.homeServerIdentityId,
                sealedHomeTokenBase64Url: encodeBase64(encryptBox(new TextEncoder().encode(JSON.stringify({ token })),
                    decodeBase64(body.assertion.clientBoxPublicKeyBase64, 'base64')), 'base64url'),
                issuedAtMs: Date.now(), expiresAtMs: Date.now() + 180_000 });
        }
        if (path === '/v1/features/authenticated') return json({
            ...createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: currentHome.homeServerIdentityId } } }),
            homeConnectionDescriptor: currentHome.connectionDescriptor,
        });
        if (path === '/v1/account/encryption') return json({ mode: state.mode, updatedAt: 0 });
        if (path === '/v1/account/profile') return json(AccountProfileSchema.parse({
            id: requestEndpoint === endpoint ? 'account-directory' : 'account-home',
        }));
        if (path === '/v1/account/encryption/currentness') return json(state.mode === 'plain'
            ? createPlainAccountEncryptionCurrentnessFixture()
            : AccountEncryptionCurrentnessResponseSchema.parse({ mode: state.mode, version: 1, signingKeyFingerprint: null,
                contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(homeRecoverySecret)).publicKey),
                updatedAt: 0, recipientEnvelopeReadiness: { status: 'available' } }));
        if (path.includes('/finalize')) return state.exchangeStatus === 200
            ? json({ token: directoryToken }) : json({ error: state.exchangeError }, state.exchangeStatus);
        throw new Error(`Unexpected HTTP fixture request: ${requestEndpoint}${path}`);
    };
    return { service, home, state, token, directoryToken, request, homeRecoverySecret };
}
