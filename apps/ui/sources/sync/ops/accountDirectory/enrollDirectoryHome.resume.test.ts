import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from '@/encryption/libsodium.lib';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from './accountDirectoryTestFixtures';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { completeAccountServicePostAuth } from './completeAccountServicePostAuth';
import { cancelPendingDirectoryHomeEnrollment, enrollDirectoryHome, getPendingDirectoryHomeEnrollment, resumePendingDirectoryHomeEnrollment } from './enrollDirectoryHome';
import { refreshAccountHomeDirectory } from './refreshAccountHomeDirectory';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { encodeBase64 } from '@/encryption/base64';

/** Non-secret binding to the Account credential that created the continuation. */
const TEST_CREDENTIAL_TOKEN_DIGEST = 'sha256:test-account-credential';


installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (options: { endpointUrl: string }) => (path: string, init?: RequestInit) => boundary.request(options.endpointUrl, path, init),
    serverFetch: (path: string, init?: RequestInit) => boundary.request('ambient', path, init),
}));

describe('exact Directory approval continuation', () => {
    const previousStorageScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let storageScopeSequence = 0;
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;
    let restore: () => void;
    let restoreLocks: () => void;
    beforeAll(async () => { await sodium.ready; });
    beforeEach(() => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `directory_enrollment_resume_${storageScopeSequence++}`;
        restore = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        fixture = createDirectoryHttpFixture();
        boundary.request.mockImplementation(fixture.request);
    });
    afterEach(async () => {
        await cancelPendingDirectoryHomeEnrollment();
        restoreLocks();
        restore();
        if (previousStorageScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousStorageScope;
    });

    async function input() {
        const { service } = fixture;
        expect(await TokenStorage.accountDirectoryAuthCredentials.set(
            { endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { token: 'directory-token' },
        )).toBe(true);
        return {
            service,
            session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
            credentialTokenDigest: TEST_CREDENTIAL_TOKEN_DIGEST,
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId },
        };
    }

    it('shares approval resume, commits the exact Home, and never repeats service authentication or assertion minting', async () => {
        const attempt = await input();
        expect(await completeAccountServicePostAuth(attempt)).toMatchObject({ kind: 'approval_required', homeServerIdentityId: fixture.home.homeServerIdentityId });
        fixture.state.approval = 'approved';
        const results = await Promise.all([resumePendingDirectoryHomeEnrollment(), resumePendingDirectoryHomeEnrollment()]);
        expect(results).toEqual([
            { kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId },
            { kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId },
        ]);
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
        expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId })).toEqual({ token: fixture.token });
        expect(fixture.state.calls.filter(({ path }) => path.includes('/login-assertion'))).toHaveLength(1);
        expect(fixture.state.calls.filter(({ path }) => path === '/v1/auth/home-login')).toHaveLength(2);
        expect(fixture.state.calls.filter(({ path }) => path === '/v1/account-directory/homes')).toHaveLength(1);
        expect(fixture.state.calls.some(({ endpoint }) => endpoint === 'ambient')).toBe(false);
    });

    it('retains missing E2EE material after approval without another service login', async () => {
        const attempt = await input();
        await completeAccountServicePostAuth(attempt);
        fixture.state.approval = 'approved';
        fixture.state.mode = 'e2ee';
        expect(await resumePendingDirectoryHomeEnrollment()).toEqual({
            kind: 'home_material_required', homeServerIdentityId: fixture.home.homeServerIdentityId,
            homeAccountId: 'account-home', intent: attempt.intent, reason: 'missing_material',
        });
        expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId })).toEqual({ token: fixture.token });
    });

    it('stops rejected approval rather than automatically creating a replacement', async () => {
        await completeAccountServicePostAuth(await input());
        fixture.state.approval = 'rejected';
        expect(await resumePendingDirectoryHomeEnrollment()).toMatchObject({
            kind: 'failure', stage: 'enroll', code: { source: 'home', code: 'rejected' }, recovery: 'stop',
        });
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
        expect(await resumePendingDirectoryHomeEnrollment()).toBeNull();
    });

    it('keeps a published approval continuation alive after its initiating surface unmounts', async () => {
        const controller = new AbortController();
        await completeAccountServicePostAuth({ ...await input(), signal: controller.signal });
        expect(getPendingDirectoryHomeEnrollment()?.input.signal).toBeUndefined();
        controller.abort();
        fixture.state.approval = 'approved';
        expect(await resumePendingDirectoryHomeEnrollment()).toEqual({
            kind: 'home_enrolled',
            homeServerIdentityId: fixture.home.homeServerIdentityId,
        });
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
        expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId })).toEqual({ token: fixture.token });
    });

    it('retains a retryable Home observation after the initiating surface unmounts before the observation settles', async () => {
        const controller = new AbortController();
        let homeFeatureRequestCount = 0;
        let releaseObservation!: () => void;
        const observationGate = new Promise<void>((resolve) => {
            releaseObservation = resolve;
        });
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            if (endpoint === fixture.home.canonicalServerUrl && path === '/v1/features') {
                homeFeatureRequestCount += 1;
                if (homeFeatureRequestCount === 1) {
                    await observationGate;
                    return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
                        status: 503,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
            }
            return await fixture.request(endpoint, path, init);
        });

        const attempt = { ...await input(), signal: controller.signal };
        const complete = async () => ({ kind: 'account_connected' as const });
        const result = enrollDirectoryHome(attempt, {
            home: fixture.home,
            shouldCancel: () => controller.signal.aborted,
            complete,
            completeRetained: complete,
        });
        await vi.waitFor(() => expect(homeFeatureRequestCount).toBe(1));
        controller.abort();
        releaseObservation();

        await expect(result).resolves.toMatchObject({
            kind: 'transport_unavailable',
            reason: 'home_observation_unavailable',
        });
        expect(getPendingDirectoryHomeEnrollment()).toMatchObject({
            kind: 'transport_unavailable',
            reason: 'home_observation_unavailable',
            homeServerIdentityId: fixture.home.homeServerIdentityId,
        });
        expect(getPendingDirectoryHomeEnrollment()?.input.signal).toBeUndefined();

        boundary.request.mockImplementation(fixture.request);
        fixture.state.approval = 'approved';
        await expect(resumePendingDirectoryHomeEnrollment()).resolves.toEqual({ kind: 'account_connected' });
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
        expect(await TokenStorage.getCredentialsForServerUrl(
            fixture.home.canonicalServerUrl,
            { serverId: fixture.home.homeServerIdentityId },
        )).toEqual({ token: fixture.token });
        expect(fixture.state.calls.filter(({ path }) => path.includes('/login-assertion'))).toHaveLength(1);
    });

    it('does not publish a retryable continuation after explicit cancellation during Home observation', async () => {
        const attempt = await input();
        let homeFeatureRequestCount = 0;
        let releaseObservation!: () => void;
        const observationGate = new Promise<void>((resolve) => {
            releaseObservation = resolve;
        });
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            if (endpoint === fixture.home.canonicalServerUrl && path === '/v1/features') {
                homeFeatureRequestCount += 1;
                if (homeFeatureRequestCount === 1) {
                    await observationGate;
                    return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
                        status: 503,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
            }
            return await fixture.request(endpoint, path, init);
        });

        const complete = async () => ({ kind: 'account_connected' as const });
        const result = enrollDirectoryHome(attempt, {
            home: fixture.home,
            shouldCancel: () => false,
            complete,
            completeRetained: complete,
        });
        await vi.waitFor(() => expect(homeFeatureRequestCount).toBe(1));
        await cancelPendingDirectoryHomeEnrollment();
        releaseObservation();

        await expect(result).resolves.toEqual({ kind: 'cancelled' });
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
        expect(await TokenStorage.getCredentialsForServerUrl(
            fixture.home.canonicalServerUrl,
            { serverId: fixture.home.homeServerIdentityId },
        )).toBeNull();
    });

    it('does not let an older delayed enrollment replace the newer retained continuation', async () => {
        const olderAttempt = await input();
        const newerAttempt = await input();
        let homeObservationCount = 0;
        let releaseFirstObservation!: () => void;
        const firstObservationGate = new Promise<void>((resolve) => {
            releaseFirstObservation = resolve;
        });
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            if (endpoint === fixture.home.canonicalServerUrl && path === '/v1/features') {
                homeObservationCount += 1;
                if (homeObservationCount === 1) {
                    await firstObservationGate;
                    return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
                        status: 503,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
            }
            return await fixture.request(endpoint, path, init);
        });

        const complete = async () => ({ kind: 'account_connected' as const });
        const older = enrollDirectoryHome(olderAttempt, {
            home: fixture.home,
            shouldCancel: () => false,
            complete,
            completeRetained: complete,
        });
        await vi.waitFor(() => expect(homeObservationCount).toBe(1));
        const newer = enrollDirectoryHome(newerAttempt, {
            home: fixture.home,
            shouldCancel: () => false,
            complete,
            completeRetained: complete,
        });
        releaseFirstObservation();

        const [olderResult, newerResult] = await Promise.all([older, newer]);
        expect(olderResult).toEqual({ kind: 'cancelled' });
        expect(newerResult).toMatchObject({
            kind: 'approval_required',
            homeServerIdentityId: fixture.home.homeServerIdentityId,
        });
        const newerPending = getPendingDirectoryHomeEnrollment();
        expect(newerPending).toMatchObject({ kind: 'approval_required' });
        expect(getPendingDirectoryHomeEnrollment()).toBe(newerPending);

        fixture.state.approval = 'approved';
        await expect(resumePendingDirectoryHomeEnrollment()).resolves.toEqual({ kind: 'account_connected' });
        expect(await TokenStorage.getCredentialsForServerUrl(
            fixture.home.canonicalServerUrl,
            { serverId: fixture.home.homeServerIdentityId },
        )).toEqual({ token: fixture.token });
    });

    it('explicit cancellation still withdraws a pending requester before credential commit', async () => {
        await completeAccountServicePostAuth(await input());
        expect(getPendingDirectoryHomeEnrollment()).not.toBeNull();
        await cancelPendingDirectoryHomeEnrollment();
        fixture.state.approval = 'approved';
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
        expect(await resumePendingDirectoryHomeEnrollment()).toBeNull();
        expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId })).toBeNull();
    });

    it('read-only remount hydration never enrolls a Home from credential presence', async () => {
        const attempt = await input();
        expect((await refreshAccountHomeDirectory(attempt.session)).status).toBe('ready');
        expect(fixture.state.calls.map(({ path }) => path)).toEqual(['/v1/account-directory/homes']);
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
    });

    it('never reuses another Account credential merely because it belongs to the same Home profile', async () => {
        await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
        const existing = {
            token: `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'other-account' })), 'base64')}.signature`,
            secret: encodeBase64(new Uint8Array(32).fill(8), 'base64url'),
        };
        expect(await TokenStorage.setCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId }, existing)).toBe(true);
        fixture.state.approval = 'approved';
        expect(await completeAccountServicePostAuth(await input())).toMatchObject({ kind: 'failure', stage: 'enroll', recovery: 'use_home_auth' });
        expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId })).toEqual(existing);
        expect(fixture.state.calls.some(({ path }) => path === '/v1/account/encryption')).toBe(false);
    });
});
