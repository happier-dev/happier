import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import {
    installLocalStorageMock,
    installWebLockManagerMock,
    type WebLockManagerMockHandle,
} from '@/auth/storage/tokenStorage.web.testHelpers';

// Real TokenStorage + real serverProfiles storage: no credential-owner mocks. The web
// platform mocks below only stand in for genuine device boundaries (secure store/OS).
installTokenStorageWebPlatformMocks();

const HOME_B_DESCRIPTOR = {
    v: 1 as const,
    homeServerIdentityId: 'srv_home_b',
    canonicalServerUrl: 'https://home-b.test',
    revision: 1,
    endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
};

type ServerProfilesModule = typeof import('@/sync/domains/server/serverProfiles');
type LocalStorageMock = ReturnType<typeof installLocalStorageMock>;

/** The browser storage boundary refuses every write that carries this credential. */
function failCredentialWrites(localStorageMock: LocalStorageMock, token: string): void {
    localStorageMock.setItemMock.mockImplementation((key: string, value: string) => {
        if (value.includes(token)) throw new Error('storage write unavailable');
        localStorageMock.store.set(key, value);
    });
}

/** Records the storage key that received this credential once the write lands. */
function observeCredentialWrite(localStorageMock: LocalStorageMock, token: string): { key: string | null } {
    const write = { key: null as string | null };
    localStorageMock.setItemMock.mockImplementation((key: string, value: string) => {
        localStorageMock.store.set(key, value);
        if (write.key === null && value.includes(token)) write.key = key;
    });
    return write;
}

/** Starts another claim on `serverUrl` the moment the credential lands, while adoption still holds the Home authority. */
function startCompetingClaimOnCredentialWrite(
    localStorageMock: LocalStorageMock,
    profiles: ServerProfilesModule,
    token: string,
    serverUrl: string,
): { started: Promise<unknown> | null } {
    const competitor = { started: null as Promise<unknown> | null };
    localStorageMock.setItemMock.mockImplementation((key: string, value: string) => {
        localStorageMock.store.set(key, value);
        if (competitor.started || !value.includes(token)) return;
        competitor.started = (async () => {
            const profile = await profiles.upsertServerProfile({ serverUrl, source: 'manual' });
            return await profiles.setServerProfileIdentityForUrl(profile.serverUrl, 'srv_competing_home');
        })();
    });
    return competitor;
}

async function seedFocusedHomeA(profiles: ServerProfilesModule) {
    const focused = await profiles.upsertServerProfile({ serverUrl: 'https://home-a.test', source: 'manual' });
    await profiles.setActiveServerId(focused.id);
    await profiles.saveHomeViewState({
        version: 1,
        activeTargetKind: 'server',
        activeTargetId: focused.id,
        groups: [{ id: 'g', name: 'Homes', serverIds: [focused.id] }],
    });
    return { focus: profiles.getActiveServerSnapshot(), view: profiles.loadHomeViewState() };
}

function expectFocusAndGroupsUnchanged(
    profiles: ServerProfilesModule,
    before: Awaited<ReturnType<typeof seedFocusedHomeA>>,
): void {
    expect(profiles.getActiveServerSnapshot()).toMatchObject({
        serverId: before.focus.serverId,
        serverUrl: before.focus.serverUrl,
    });
    expect(profiles.loadHomeViewState()).toEqual(before.view);
}

describe('adoptHomeProfileWithCredentials (real storage integration)', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let restoreLocalStorage: (() => void) | null = null;
    let webLocks: WebLockManagerMockHandle | null = null;

    beforeEach(() => {
        webLocks = installWebLockManagerMock();
    });

    afterEach(() => {
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        webLocks?.restore();
        webLocks = null;
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        vi.resetModules();
    });

    it('publishes a usable Home after credential-first adoption to an already-started projection', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_usable_home_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const projection = await import('@/sync/domains/scope/usableHomeServerIds');
        const seen: Array<readonly string[] | null> = [];
        const unsubscribe = projection.subscribeUsableHomeServerIds(() => {
            seen.push(projection.readUsableHomeServerIds());
        });
        try {
            await vi.waitFor(() => expect(projection.readUsableHomeServerIds()).toEqual([]));
            const payload = Buffer.from(JSON.stringify({ sub: 'home-b-account' })).toString('base64url');
            await adoptHomeProfileWithCredentials({
                descriptor: HOME_B_DESCRIPTOR,
                source: 'qr',
                credentials: { token: `header.${payload}.signature` },
            });

            await vi.waitFor(() => expect(projection.readUsableHomeServerIds()).toEqual(['srv_home_b']));
            expect(seen).toContainEqual(['srv_home_b']);
        } finally {
            unsubscribe();
        }
    });

    it('preflights Home B, writes B credentials before adoption, adopts without focus change, and reads B by stable identity while Home A stays byte-identical', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_real_storage_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');

        // Focused Home A with its own typed data-key credential and visible group.
        const homeACreated = await profiles.upsertServerProfile({ serverUrl: 'https://home-a.test', source: 'manual' });
        const homeA = (await profiles.setServerProfileIdentityForUrl(homeACreated.serverUrl, 'srv_home_a')) ?? homeACreated;
        await profiles.setActiveServerId(homeA.id);
        await profiles.saveHomeViewState({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: homeA.id,
            groups: [{ id: 'homes', name: 'Homes', serverIds: [homeA.id] }],
        });
        const homeACredentials = {
            token: 'home-a-token',
            encryption: { machineKey: 'home-a-machine-key', publicKey: 'home-a-public-key' },
        } as const;
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://home-a.test',
            { serverId: 'srv_home_a' },
            homeACredentials,
        )).resolves.toBe(true);

        const focusBefore = profiles.getActiveServerSnapshot();
        const groupsBefore = profiles.loadHomeViewState();
        const homeARawEntries = [...localStorageMock.store.entries()]
            .filter(([, value]) => value.includes('"home-a-token"'));
        expect(homeARawEntries.length).toBeGreaterThanOrEqual(1);

        // Read-only preflight resolves the exact explicit target before any write.
        expect(profiles.preflightHomeProfileAdoption({
            descriptor: HOME_B_DESCRIPTOR,
            source: 'qr',
            preserveUserLabel: true,
        })).toEqual({
            canonicalServerUrl: 'https://home-b.test',
            serverIdentityId: 'srv_home_b',
            credentialWrite: 'required',
        });
        expect(profiles.listServerProfiles()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_home_b' }),
        ]));

        const adopted = await adoptHomeProfileWithCredentials({
            descriptor: HOME_B_DESCRIPTOR,
            source: 'qr',
            preserveUserLabel: true,
            suggestedName: 'Home B',
            credentials: { token: 'home-b-token' },
        });

        expect(adopted.serverIdentityId).toBe('srv_home_b');
        expect(adopted.name).toBe('Home B');
        expect(adopted.canonicalServerUrl ?? adopted.serverUrl).toBe('https://home-b.test');

        // The pre-profile credential write lands under the URL-hash scope; reading by
        // stable identity must migrate it, and the second read must be served by the
        // adopted identity scope alone.
        const readB = { serverId: 'srv_home_b' } as const;
        await expect(TokenStorage.getCredentialsForServerUrl('https://home-b.test', readB))
            .resolves.toEqual({ token: 'home-b-token' });
        await expect(TokenStorage.getCredentialsForServerUrl('https://home-b.test', readB))
            .resolves.toEqual({ token: 'home-b-token' });

        // Focus, groups, and Home A's stored credential bytes are untouched.
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: focusBefore.serverId,
            serverUrl: focusBefore.serverUrl,
        });
        expect(profiles.loadHomeViewState()).toEqual(groupsBefore);
        await expect(TokenStorage.getCredentialsForServerUrl('https://home-a.test', { serverId: 'srv_home_a' }))
            .resolves.toEqual(homeACredentials);
        for (const [key, value] of homeARawEntries) {
            expect(localStorageMock.store.get(key)).toBe(value);
        }
    });

    it('preserves an established Home credential when selected Directory data remains advisory', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_advisory_established_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const established = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_established_home',
                canonicalServerUrl: 'https://established-home.test',
                revision: 3,
                endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }],
            },
        });
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://established-home.test',
            { serverId: 'srv_established_home' },
            { token: 'established-home-token' },
        )).resolves.toBe(true);

        expect(profiles.preflightHomeProfileAdoption({
            source: 'account-directory',
            descriptorAuthority: 'advisory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_established_home',
                canonicalServerUrl: 'https://directory-route.test',
                revision: 999,
                endpoints: [{ kind: 'https', url: 'https://directory-route.test' }],
            },
        })).toEqual({
            canonicalServerUrl: 'https://established-home.test',
            serverIdentityId: 'srv_established_home',
            credentialWrite: 'preserveExisting',
        });

        const adopted = await adoptHomeProfileWithCredentials({
            source: 'account-directory',
            descriptorAuthority: 'advisory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_established_home',
                canonicalServerUrl: 'https://directory-route.test',
                revision: 999,
                endpoints: [{ kind: 'https', url: 'https://directory-route.test' }],
            },
            credentials: { token: 'newly-issued-token' },
        });

        expect(adopted).toEqual(established);
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://established-home.test',
            { serverId: 'srv_established_home' },
        )).resolves.toEqual({ token: 'established-home-token' });
        for (const [, value] of localStorageMock.store.entries()) {
            expect(value).not.toContain('newly-issued-token');
        }
    });


    it('rejects credentials for an advisory-only placeholder until a current Home observation establishes routing', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_advisory_placeholder_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const placeholder = await profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptorAuthority: 'advisory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_coupled_storage_home',
                canonicalServerUrl: 'https://directory-route.test',
                revision: 50,
                endpoints: [{ kind: 'https', url: 'https://directory-route.test' }],
            },
        });

        expect(profiles.preflightHomeProfileAdoption({
            source: 'account-directory',
            descriptorAuthority: 'advisory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_coupled_storage_home',
                canonicalServerUrl: 'https://directory-route.test',
                revision: 50,
                endpoints: [{ kind: 'https', url: 'https://directory-route.test' }],
            },
        })).toEqual({
            canonicalServerUrl: 'https://directory-route.test',
            serverIdentityId: 'srv_coupled_storage_home',
            credentialWrite: 'requiresCurrentObservation',
        });

        await expect(adoptHomeProfileWithCredentials({
            source: 'account-directory',
            descriptorAuthority: 'advisory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_coupled_storage_home',
                canonicalServerUrl: 'https://directory-route.test',
                revision: 50,
                endpoints: [{ kind: 'https', url: 'https://directory-route.test' }],
            },
            credentials: { token: 'advisory-home-token' },
        })).rejects.toMatchObject({
            code: 'home_profile_adoption_requires_current_observation',
            canonicalServerUrl: 'https://directory-route.test',
            serverIdentityId: 'srv_coupled_storage_home',
        });

        const retained = profiles.getServerProfileById(placeholder.id);
        expect(retained?.id).toBe(placeholder.id);
        expect(retained?.descriptorProvenance).toBe('advisory-only');
        expect(retained?.canonicalServerUrl ?? retained?.serverUrl).toBe('https://directory-route.test');
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://directory-route.test',
            { serverId: 'srv_coupled_storage_home' },
        )).resolves.toBeNull();
        for (const [, value] of localStorageMock.store.entries()) {
            expect(value).not.toContain('advisory-home-token');
        }
    });

    it('writes a credential only after the advisory profile receives exact Home observation authority', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_assertion_bound_advisory_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const {
            adoptHomeProfileWithCredentials,
        } = await import('./adoptHomeProfile');
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_assertion_bound_home',
            canonicalServerUrl: 'https://canonical.assertion-bound.test',
            revision: 7,
            endpoints: [{ kind: 'https' as const, url: 'https://ingress.assertion-bound.test' }],
        };
        await profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptorAuthority: 'advisory',
            descriptor,
        });

        const adopted = await adoptHomeProfileWithCredentials({
            source: 'account-directory',
            descriptorAuthority: 'current_connection_observation',
            descriptor,
            credentials: { token: 'assertion-bound-token' },
        });

        expect(adopted.descriptorProvenance).not.toBe('advisory-only');
        await expect(TokenStorage.getCredentialsForServerUrl(
            descriptor.canonicalServerUrl,
            { serverId: descriptor.homeServerIdentityId },
        )).resolves.toEqual({ token: 'assertion-bound-token' });

    });

    it('reads a pre-adoption loopback credential through the adopted stable identity', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_loopback_storage_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_loopback_home',
            canonicalServerUrl: 'http://127.0.0.1:43123',
            revision: 1,
            endpoints: [{ kind: 'https' as const, url: 'http://127.0.0.1:43123' }],
        };

        const adopted = await adoptHomeProfileWithCredentials({
            descriptor,
            source: 'qr',
            credentials: { token: 'loopback-home-token' },
        });

        await expect(TokenStorage.getCredentialsForServerUrl(
            adopted.canonicalServerUrl ?? adopted.serverUrl,
            { serverId: 'srv_loopback_home' },
        )).resolves.toEqual({ token: 'loopback-home-token' });
    });

    it.each([false, true])('moves the canonical URL and credential slot while preserving unrelated Homes with retained alias=%s', async (retainedAlias) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `canonical_url_migration_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');

        const other = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_unrelated_home',
                canonicalServerUrl: 'https://unrelated-home.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://unrelated-home.test' }],
            },
        });
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://unrelated-home.test',
            { serverId: 'srv_unrelated_home' },
            { token: 'unrelated-home-token' },
        )).resolves.toBe(true);

        const moving = await profiles.adoptHomeProfile({
            source: retainedAlias ? 'manual' : 'qr',
            suggestedName: 'Workshop Home',
            descriptor: retainedAlias ? {
                serverUrl: 'https://moving-home-old.test',
                canonicalServerUrl: 'https://moving-home-old.test',
                homeServerIdentityId: 'srv_moving_home',
            } : {
                v: 1,
                homeServerIdentityId: 'srv_moving_home',
                canonicalServerUrl: 'https://moving-home-old.test',
                revision: 3,
                endpoints: [{ kind: 'https', url: 'https://moving-home-old.test' }],
            },
        });
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://moving-home-old.test',
            { serverId: 'srv_moving_home' },
            { token: 'moving-home-token' },
        )).resolves.toBe(true);
        const retainedUrl = 'https://moving-home-retained.test';
        if (retainedAlias) {
            await profiles.adoptHomeProfile({
                source: 'manual',
                descriptor: { serverUrl: retainedUrl, homeServerIdentityId: 'srv_moving_home' },
            });
            expect(profiles.getServerProfileById(moving.id)).toMatchObject({
                serverUrl: retainedUrl,
                canonicalServerUrl: 'https://moving-home-old.test',
            });
        }
        await profiles.setActiveServerId(other.id);
        await profiles.saveHomeViewState({
            version: 1,
            activeTargetKind: 'group',
            activeTargetId: 'homes',
            groups: [{ id: 'homes', name: 'Homes', serverIds: [other.id, moving.id] }],
        });
        const focusBefore = profiles.getActiveServerSnapshot();
        const groupsBefore = profiles.loadHomeViewState();
        const otherBefore = profiles.getServerProfileById(other.id);

        const migrated = await adoptHomeProfileWithCredentials({
            source: 'qr',
            preserveUserLabel: true,
            credentials: { token: 'moving-home-new-token' },
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_moving_home',
                canonicalServerUrl: 'https://moving-home-new.test',
                revision: 4,
                endpoints: [{ kind: 'https', url: 'https://moving-home-new.test' }],
            },
        });

        expect(migrated.id).toBe(moving.id);
        expect(migrated.name).toBe('Workshop Home');
        expect(migrated.serverIdentityId).toBe('srv_moving_home');
        expect(migrated.canonicalServerUrl ?? migrated.serverUrl)
            .toBe('https://moving-home-new.test');

        // The exact bearer follows the identity to its destination and is no longer
        // addressable through the obsolete URL.
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://moving-home-new.test',
            { serverId: 'srv_moving_home' },
        )).resolves.toEqual({ token: 'moving-home-new-token' });
        await expect(TokenStorage.getCredentialsForServerUrl('https://moving-home-old.test'))
            .resolves.toBeNull();

        if (retainedAlias) {
            await expect(TokenStorage.getCredentialsForServerUrl(retainedUrl, { serverId: 'srv_moving_home' }))
                .resolves.toBeNull();
        }

        // Pointers, groups and the unrelated Home are untouched.
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: focusBefore.serverId,
            serverUrl: focusBefore.serverUrl,
        });
        expect(profiles.loadHomeViewState()).toEqual(groupsBefore);
        expect(profiles.getServerProfileById(other.id)).toEqual(otherBefore);
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://unrelated-home.test',
            { serverId: 'srv_unrelated_home' },
        )).resolves.toEqual({ token: 'unrelated-home-token' });
    });

    it('reports a truthful partial commit when the obsolete credential slot cannot be cleaned up', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `canonical_url_partial_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');

        const moving = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_partial_home',
                canonicalServerUrl: 'https://partial-old.test',
                revision: 2,
                endpoints: [{ kind: 'https', url: 'https://partial-old.test' }],
            },
        });
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://partial-old.test',
            { serverId: 'srv_partial_home' },
            { token: 'partial-home-token' },
        )).resolves.toBe(true);

        localStorageMock.removeItemMock.mockImplementation(() => {
            throw new Error('storage removal unavailable');
        });

        await expect(adoptHomeProfileWithCredentials({
            source: 'qr',
            preserveUserLabel: true,
            credentials: { token: 'partial-home-new-token' },
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_partial_home',
                canonicalServerUrl: 'https://partial-new.test',
                revision: 3,
                endpoints: [{ kind: 'https', url: 'https://partial-new.test' }],
            },
        })).rejects.toMatchObject({
            code: 'home_profile_canonical_url_migration_partial_commit',
            stage: 'obsolete_credential_cleanup',
            serverIdentityId: 'srv_partial_home',
            fromCanonicalServerUrl: 'https://partial-old.test',
            toCanonicalServerUrl: 'https://partial-new.test',
        });

        // The destination is already committed; the caller is told so rather than
        // being handed a clean failure that hides the retained obsolete slot.
        expect(profiles.getServerProfileById(moving.id)?.canonicalServerUrl)
            .toBe('https://partial-new.test');
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://partial-new.test',
            { serverId: 'srv_partial_home' },
        )).resolves.toEqual({ token: 'partial-home-new-token' });
    });

    it('moves an identity-scoped credential without a conflicting destination rewrite', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `canonical_url_destination_failure_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');

        const moving = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_destination_failure_home',
                canonicalServerUrl: 'https://destination-failure-old.test',
                revision: 2,
                endpoints: [{ kind: 'https', url: 'https://destination-failure-old.test' }],
            },
        });
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://destination-failure-old.test',
            { serverId: 'srv_destination_failure_home' },
            { token: 'destination-failure-token' },
        )).resolves.toBe(true);
        const seededKeys = [...localStorageMock.store.entries()]
            .filter(([, value]) => value.includes('destination-failure-token'))
            .map(([key]) => key);
        expect(seededKeys).toHaveLength(1);
        const writesBefore = localStorageMock.setItemMock.mock.calls.length;

        await expect(adoptHomeProfileWithCredentials({
            source: 'qr',
            preserveUserLabel: true,
            credentials: { token: 'destination-failure-token' },
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_destination_failure_home',
                canonicalServerUrl: 'https://destination-failure-new.test',
                revision: 3,
                endpoints: [{ kind: 'https', url: 'https://destination-failure-new.test' }],
            },
        })).resolves.toMatchObject({
            canonicalServerUrl: 'https://destination-failure-new.test',
            serverIdentityId: 'srv_destination_failure_home',
        });

        expect(profiles.getServerProfileById(moving.id)?.canonicalServerUrl)
            .toBe('https://destination-failure-new.test');
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://destination-failure-new.test',
            { serverId: 'srv_destination_failure_home' },
        )).resolves.toEqual({ token: 'destination-failure-token' });
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://destination-failure-old.test',
        )).resolves.toBeNull();
        // The credential is rewritten only in its identity-scoped slot; no destination URL slot is written.
        expect(localStorageMock.setItemMock.mock.calls.slice(writesBefore)
            .filter(([, value]) => value.includes('destination-failure-token'))
            .map(([key]) => key)).toEqual(seededKeys);
    });

    it('holds one browser-wide Home authority across reassignment snapshot and obsolete credential cleanup', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `canonical_url_cross_tab_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { digest } = await import('@/platform/digest');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { readStorageScopeFromEnv, scopedStorageId } = await import('@/utils/system/storageScope');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const oldUrl = 'https://cross-tab-old.test';
        const newUrl = 'https://cross-tab-new.test';
        const oldUrlHash = encodeBase64(
            await digest('SHA-256', new TextEncoder().encode(oldUrl)),
            'base64url',
        );
        const oldUrlCredentialKey = scopedStorageId(
            `auth_credentials__srv_${oldUrlHash}`,
            readStorageScopeFromEnv(),
        );

        await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_cross_tab_home',
                canonicalServerUrl: oldUrl,
                revision: 1,
                endpoints: [{ kind: 'https', url: oldUrl }],
            },
        });
        await expect(TokenStorage.setCredentialsForServerUrl(
            oldUrl,
            { serverId: 'srv_cross_tab_home' },
            { token: 'cross-tab-old-token' },
        )).resolves.toBe(true);

        let cleanupRemovalCount = 0;
        let competingAdoption: Promise<unknown> | null = null;
        let competingAdoptionCompleted = false;
        localStorageMock.removeItemMock.mockImplementation((key: string) => {
            localStorageMock.store.delete(key);
            if (key !== oldUrlCredentialKey) return;
            cleanupRemovalCount += 1;
            // The first removal belongs to destination credential write alias
            // cleanup. The later URL-only removal is the obsolete-slot sweep
            // after the profile reassignment snapshot.
            if (cleanupRemovalCount !== 2) return;
            expect(webLocks?.isHeld()).toBe(true);
            competingAdoption = profiles.adoptHomeProfile({
                source: 'qr',
                descriptor: {
                    v: 1,
                    homeServerIdentityId: 'srv_competing_home',
                    canonicalServerUrl: oldUrl,
                    revision: 1,
                    endpoints: [{ kind: 'https', url: oldUrl }],
                },
            }).then((profile) => {
                competingAdoptionCompleted = true;
                return profile;
            });
        });

        const migrated = await adoptHomeProfileWithCredentials({
            source: 'qr',
            credentials: { token: 'cross-tab-new-token' },
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_cross_tab_home',
                canonicalServerUrl: newUrl,
                revision: 2,
                endpoints: [{ kind: 'https', url: newUrl }],
            },
        });

        expect(migrated.serverIdentityId).toBe('srv_cross_tab_home');
        expect(competingAdoption).not.toBeNull();
        expect(competingAdoptionCompleted).toBe(false);
        await expect(competingAdoption!).resolves.toMatchObject({
            serverIdentityId: 'srv_competing_home',
            canonicalServerUrl: oldUrl,
        });
        await expect(TokenStorage.getCredentialsForServerUrl(
            newUrl,
            { serverId: 'srv_cross_tab_home' },
        )).resolves.toEqual({ token: 'cross-tab-new-token' });
        await expect(TokenStorage.getCredentialsForServerUrl(
            oldUrl,
            { serverId: 'srv_competing_home' },
        )).resolves.toBeNull();
    });

    it('does not expose Home A credentials through a conflicting Home B identity observed at the same URL', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `identity_conflict_storage_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const serverUrl = 'https://shared-home.test';

        await profiles.upsertServerProfile({ serverUrl, source: 'manual' });
        expect((await profiles.setServerProfileIdentityForUrl(serverUrl, 'srv_home_a'))?.serverIdentityId)
            .toBe('srv_home_a');
        await expect(TokenStorage.setCredentialsForServerUrl(
            serverUrl,
            { serverId: 'srv_home_a' },
            { token: 'home-a-token' },
        )).resolves.toBe(true);

        expect(await profiles.setServerProfileIdentityForUrl(serverUrl, 'srv_home_b')).toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl(
            serverUrl,
            { serverId: 'srv_home_b' },
        )).resolves.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl(
            serverUrl,
            { serverId: 'srv_home_a' },
        )).resolves.toEqual({ token: 'home-a-token' });
    });

    it('does not expose an established Home credential when an unrelated URL advertises its identity', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `public_identity_collision_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const homeA = await profiles.upsertServerProfile({ serverUrl: 'https://home-a.test', source: 'manual' });
        const unrelated = await profiles.upsertServerProfile({ serverUrl: 'https://unrelated.test', source: 'manual' });
        expect(await profiles.setServerProfileIdentityForUrl(homeA.serverUrl, 'srv_home_a')).not.toBeNull();
        await expect(TokenStorage.setCredentialsForServerUrl(
            homeA.serverUrl,
            { serverId: 'srv_home_a' },
            { token: 'home-a-token' },
        )).resolves.toBe(true);

        expect(await profiles.setServerProfileIdentityForUrl(unrelated.serverUrl, 'srv_home_a')).toBeNull();
        expect(profiles.getServerProfileById(unrelated.id)).not.toHaveProperty('serverIdentityId');
        await expect(TokenStorage.getCredentialsForServerUrl(
            unrelated.serverUrl,
            { serverId: unrelated.id },
        )).resolves.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl(
            homeA.serverUrl,
            { serverId: 'srv_home_a' },
        )).resolves.toEqual({ token: 'home-a-token' });
    });

    it('leaves an established profile unchanged when the replacement credential cannot be stored before a canonical URL move', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `canonical_url_write_failure_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const established = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_moving_home',
                canonicalServerUrl: 'https://moving-home-old.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://moving-home-old.test' }],
            },
        });
        failCredentialWrites(localStorageMock, 'new-home-token');

        await expect(adoptHomeProfileWithCredentials({
            source: 'qr',
            credentials: { token: 'new-home-token' },
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_moving_home',
                canonicalServerUrl: 'https://moving-home-new.test',
                revision: 2,
                endpoints: [{ kind: 'https', url: 'https://moving-home-new.test' }],
            },
        })).rejects.toThrow('Unable to store Home credentials');

        expect(profiles.getServerProfileById(established.id)).toEqual(established);
        await expect(TokenStorage.getCredentialsForServerUrl('https://moving-home-old.test', { serverId: 'srv_moving_home' }))
            .resolves.toBeNull();
    });

    it('leaves profiles, focus, and groups unchanged when the credential write fails', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_write_failure_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const before = await seedFocusedHomeA(profiles);
        failCredentialWrites(localStorageMock, 'home-b-token');

        await expect(adoptHomeProfileWithCredentials({
            descriptor: HOME_B_DESCRIPTOR,
            source: 'qr',
            preserveUserLabel: true,
            credentials: { token: 'home-b-token' },
        })).rejects.toThrow('Unable to store Home credentials');

        expect(profiles.listServerProfiles()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_home_b' }),
        ]));
        expectFocusAndGroupsUnchanged(profiles, before);
    });

    it.each([
        ['an identity that conflicts with the saved Home at that URL', {
            v: 1 as const,
            homeServerIdentityId: 'srv_conflicting',
            canonicalServerUrl: 'https://home-b.test',
            revision: 1,
            endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
        }],
        ['a descriptor without a stable identity', { serverUrl: 'https://unbound-home.test' }],
    ])('stores no credential bytes when strict adoption rejects %s', async (_label, descriptor) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_rejected_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        await profiles.adoptHomeProfile({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_existing',
                canonicalServerUrl: 'https://home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
            },
            source: 'account-directory',
        });

        await expect(adoptHomeProfileWithCredentials({
            descriptor,
            source: 'qr',
            preserveUserLabel: true,
            credentials: { token: 'must-not-store' },
        })).rejects.toThrow();
        expect(localStorageMock.setItemMock.mock.calls.filter(([, value]) => value.includes('must-not-store'))).toEqual([]);
    });

    it('rolls back the exact credential write when the owning enrollment attempt is cancelled before profile adoption', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_cancelled_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const write = observeCredentialWrite(localStorageMock, 'must-roll-back');

        await expect(adoptHomeProfileWithCredentials({
            descriptor: HOME_B_DESCRIPTOR,
            source: 'account-directory',
            credentials: { token: 'must-roll-back' },
            shouldCancel: () => write.key !== null,
        })).rejects.toThrow('Home credential adoption cancelled');

        expect(write.key).not.toBeNull();
        expect(localStorageMock.store.has(write.key!)).toBe(false);
        for (const [, value] of localStorageMock.store.entries()) expect(value).not.toContain('must-roll-back');
        expect(profiles.listServerProfiles()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_home_b' }),
        ]));
        await expect(TokenStorage.getCredentialsForServerUrl('https://home-b.test', { serverId: 'srv_home_b' }))
            .resolves.toBeNull();
    });

    it('rolls back the exact credential write when Home profile persistence fails after it lands', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_profile_write_failure_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const { MMKV } = await import('react-native-mmkv');
        const write = observeCredentialWrite(localStorageMock, 'must-roll-back');
        const writeNativeValue = MMKV.prototype.set;
        // The device store refuses the Home profile write once the credential has landed.
        const profileWrite = vi.spyOn(MMKV.prototype, 'set').mockImplementation(function (this: InstanceType<typeof MMKV>, key, value) {
            if (write.key !== null && key === 'server-state-v1') throw new Error('profile storage unavailable');
            writeNativeValue.call(this, key, value);
        });

        try {
            await expect(adoptHomeProfileWithCredentials({
                descriptor: HOME_B_DESCRIPTOR,
                source: 'qr',
                credentials: { token: 'must-roll-back' },
            })).rejects.toMatchObject({ name: 'ServerProfilesPersistenceError' });
        } finally {
            profileWrite.mockRestore();
        }

        expect(write.key).not.toBeNull();
        expect(localStorageMock.store.has(write.key!)).toBe(false);
        for (const [, value] of localStorageMock.store.entries()) expect(value).not.toContain('must-roll-back');
        expect(profiles.listServerProfiles()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_home_b' }),
        ]));
        await expect(TokenStorage.getCredentialsForServerUrl('https://home-b.test', { serverId: 'srv_home_b' }))
            .resolves.toBeNull();
    });

    it('reports a partial commit with both errors when credential rollback cannot remove the write', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_rollback_failure_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { adoptHomeProfileWithCredentials, HomeProfileAdoptionPartialCommitError } = await import('./adoptHomeProfile');
        const write = observeCredentialWrite(localStorageMock, 'new-home-b-token');
        localStorageMock.removeItemMock.mockImplementation((key: string) => {
            if (key === write.key) throw new Error('storage removal unavailable');
            localStorageMock.store.delete(key);
        });

        const result = adoptHomeProfileWithCredentials({
            descriptor: HOME_B_DESCRIPTOR,
            source: 'qr',
            credentials: { token: 'new-home-b-token' },
            shouldCancel: () => write.key !== null,
        });
        await expect(result).rejects.toBeInstanceOf(HomeProfileAdoptionPartialCommitError);
        await expect(result).rejects.toMatchObject({
            code: 'home_profile_adoption_partial_commit',
            canonicalServerUrl: 'https://home-b.test',
            serverIdentityId: 'srv_home_b',
            adoptionError: expect.objectContaining({ message: 'Home credential adoption cancelled' }),
            rollbackOutcome: {
                kind: 'failed',
                error: expect.objectContaining({ message: 'storage removal unavailable' }),
            },
        });
        // Truthful partial state: the profile was not adopted and the stored credential remains.
        expect(profiles.listServerProfiles()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_home_b' }),
        ]));
        expect(localStorageMock.store.get(write.key!)).toContain('new-home-b-token');
    });

    it('reports a partial commit and keeps the concurrent winner when rollback finds the slot rewritten', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_rollback_not_applied_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { adoptHomeProfileWithCredentials, HomeProfileAdoptionPartialCommitError } = await import('./adoptHomeProfile');
        const before = await seedFocusedHomeA(profiles);
        const write = observeCredentialWrite(localStorageMock, 'new-home-b-token');
        const concurrentWinner = JSON.stringify({ token: 'concurrent-winner-token' });

        const result = adoptHomeProfileWithCredentials({
            descriptor: HOME_B_DESCRIPTOR,
            source: 'qr',
            credentials: { token: 'new-home-b-token' },
            shouldCancel: () => {
                if (write.key === null) return false;
                // Another tab rewrites the same credential slot at the browser storage boundary.
                localStorageMock.store.set(write.key, concurrentWinner);
                return true;
            },
        });
        await expect(result).rejects.toBeInstanceOf(HomeProfileAdoptionPartialCommitError);
        await expect(result).rejects.toMatchObject({
            code: 'home_profile_adoption_partial_commit',
            canonicalServerUrl: 'https://home-b.test',
            serverIdentityId: 'srv_home_b',
            adoptionError: expect.objectContaining({ message: 'Home credential adoption cancelled' }),
            rollbackOutcome: { kind: 'not_applied', reason: 'ownership_changed' },
        });
        expect(localStorageMock.store.get(write.key!)).toBe(concurrentWinner);
        expectFocusAndGroupsUnchanged(profiles, before);
    });

    it('serializes a competing profile claim until a same-identity credential and URL move commits', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `canonical_url_adoption_rollback_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const established = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_moving_home',
                canonicalServerUrl: 'https://moving-home-old.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://moving-home-old.test' }],
            },
        });
        const competitor = startCompetingClaimOnCredentialWrite(localStorageMock, profiles, 'new-home-token', 'https://moving-home-new.test');

        await expect(adoptHomeProfileWithCredentials({
            source: 'qr',
            credentials: { token: 'new-home-token' },
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_moving_home',
                canonicalServerUrl: 'https://moving-home-new.test',
                revision: 2,
                endpoints: [{ kind: 'https', url: 'https://moving-home-new.test' }],
            },
        })).resolves.toMatchObject({
            canonicalServerUrl: 'https://moving-home-new.test',
            serverIdentityId: 'srv_moving_home',
        });

        expect(competitor.started).not.toBeNull();
        await expect(competitor.started!).resolves.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl('https://moving-home-new.test', {
            serverId: 'srv_moving_home',
        })).resolves.toEqual({ token: 'new-home-token' });
        expect(profiles.getServerProfileById(established.id)).toMatchObject({
            canonicalServerUrl: 'https://moving-home-new.test',
            serverIdentityId: 'srv_moving_home',
        });
    });

    it('keeps the new credential when a competing profile claim waits for atomic adoption of a new Home', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_competing_claim_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const before = await seedFocusedHomeA(profiles);
        const competitor = startCompetingClaimOnCredentialWrite(localStorageMock, profiles, 'new-home-b-token', 'https://home-b.test');

        await expect(adoptHomeProfileWithCredentials({
            descriptor: HOME_B_DESCRIPTOR,
            source: 'qr',
            credentials: { token: 'new-home-b-token' },
        })).resolves.toMatchObject({ serverIdentityId: 'srv_home_b' });

        expect(competitor.started).not.toBeNull();
        await expect(competitor.started!).resolves.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl('https://home-b.test', { serverId: 'srv_home_b' }))
            .resolves.toEqual({ token: 'new-home-b-token' });
        expectFocusAndGroupsUnchanged(profiles, before);
    });

    it('uses a nonempty Directory hint for a new profile and preserves an existing user label', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_suggested_name_${Date.now()}_${Math.random()}`;
        const localStorageMock = installLocalStorageMock();
        restoreLocalStorage = localStorageMock.restore;

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const created = await profiles.adoptHomeProfile({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_directory_home',
                canonicalServerUrl: 'https://directory-home.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://directory-home.test' }],
            },
            source: 'account-directory',
            preserveUserLabel: true,
            suggestedName: '  Directory Home  ',
        });
        expect(created.name).toBe('Directory Home');

        await profiles.adoptHomeProfile({
            descriptor: { serverUrl: created.serverUrl },
            source: 'manual',
            suggestedName: 'My Home',
            preserveUserLabel: false,
        });
        const preserved = await profiles.adoptHomeProfile({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_directory_home',
                canonicalServerUrl: 'https://directory-home.test',
                revision: 2,
                endpoints: [{ kind: 'https', url: 'https://directory-home.test' }],
            },
            source: 'account-directory',
            preserveUserLabel: true,
            suggestedName: '   ',
        });
        expect(preserved.name).toBe('My Home');
    });
});
