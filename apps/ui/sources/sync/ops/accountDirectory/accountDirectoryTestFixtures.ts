import type { AccountDirectoryMeResponseV1 } from '@happier-dev/protocol';
import { createHomeCredentialDestinationDigestV1, type AccountDirectoryHomeEntryV1 } from '@happier-dev/protocol/auth/accountDirectory';
import type { AuthEntryProjectionV1 } from '@happier-dev/protocol/auth/entry';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';

export function createDirectoryHttpFixture(options: Readonly<{ sameServiceHome?: boolean }> = {}) {
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
            v: 1 as const, accountId: 'account-directory', displayName: 'Ada Lovelace' as string | null, avatar: null as string | null,
            linkedAuthenticationMethods: [{ providerId: 'github', login: 'ada' as string | null }],
        } as AccountDirectoryMeResponseV1,
        calls: [] as Array<{ endpoint: string; path: string; init?: RequestInit }>,
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
        if (path === '/v1/account-directory/homes') return json(
            state.directoryStatus === 200 ? { v: 1, homes: state.homes, preferredHomeServerIdentityId: state.preferredHomeServerIdentityId }
                : { error: 'invalid_token' }, state.directoryStatus);
        if (path === '/v1/account-directory/me') return json(
            state.directoryStatus === 200 ? state.me : { error: 'invalid_token' }, state.directoryStatus);
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
        if (path.includes('/finalize')) return state.exchangeStatus === 200
            ? json({ token: 'directory-token' }) : json({ error: state.exchangeError }, state.exchangeStatus);
        throw new Error(`Unexpected HTTP fixture request: ${requestEndpoint}${path}`);
    };
    return { service, home, state, token, request };
}
