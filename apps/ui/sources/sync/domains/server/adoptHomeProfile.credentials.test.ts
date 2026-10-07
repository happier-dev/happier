import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TokenStorageModule = typeof import('@/auth/storage/tokenStorage');
type SetCredentialsForServerUrl = TokenStorageModule['TokenStorage']['setCredentialsForServerUrl'];
type SetCredentialsForServerUrlWithRollback = TokenStorageModule['TokenStorage']['setCredentialsForServerUrlWithRollback'];
type SetHomeCredentialsWithRollbackUnderMutationAuthority = TokenStorageModule['setHomeCredentialsWithRollbackUnderMutationAuthority'];

const setCredentialsForServerUrlMock = vi.hoisted(() => vi.fn<SetCredentialsForServerUrl>(async () => true));
const setCredentialsForServerUrlWithRollbackMock = vi.hoisted(() => vi.fn<SetHomeCredentialsWithRollbackUnderMutationAuthority>());
const publicSetCredentialsForServerUrlWithRollbackMock = vi.hoisted(() => vi.fn<SetCredentialsForServerUrlWithRollback>());
const getHomeCredentialsUnderMutationAuthorityMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null as { token: string } | null));

// The untouched legacy failure-injection family remains deferred. The deciding
// serialization case below removes this fixture and runs the credential owner.
function installLegacyCredentialFixture(): void {
    vi.doMock('@/auth/storage/tokenStorage', () => ({
        getHomeCredentialsUnderMutationAuthority: (...args: unknown[]) => getHomeCredentialsUnderMutationAuthorityMock(...args),
        removeHomeCredentialsUnderMutationAuthority: vi.fn(async () => true),
        setHomeCredentialsWithRollbackUnderMutationAuthority: (
            ...args: Parameters<SetHomeCredentialsWithRollbackUnderMutationAuthority>
        ) => setCredentialsForServerUrlWithRollbackMock(...args),
        TokenStorage: {
            setCredentialsForServerUrl: (...args: Parameters<SetCredentialsForServerUrl>) => setCredentialsForServerUrlMock(...args),
            setCredentialsForServerUrlWithRollback: (...args: Parameters<SetCredentialsForServerUrlWithRollback>) => publicSetCredentialsForServerUrlWithRollbackMock(...args),
        },
    }));
}

describe('adoptHomeProfileWithCredentials', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    beforeEach(() => {
        installLegacyCredentialFixture();
    });

    afterEach(() => {
        setCredentialsForServerUrlMock.mockReset();
        setCredentialsForServerUrlMock.mockResolvedValue(true);
        setCredentialsForServerUrlWithRollbackMock.mockReset();
        publicSetCredentialsForServerUrlWithRollbackMock.mockReset();
        getHomeCredentialsUnderMutationAuthorityMock.mockReset();
        getHomeCredentialsUnderMutationAuthorityMock.mockResolvedValue(null);
        vi.doUnmock('react-native');
        vi.unstubAllGlobals();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        vi.resetModules();
    });

    it('leaves an established profile unchanged when the replacement credential cannot be stored before a canonical URL move', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `canonical_url_write_failure_${Date.now()}_${Math.random()}`;
        const profiles = await import('./serverProfiles');
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
        setCredentialsForServerUrlWithRollbackMock.mockResolvedValueOnce(null);
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');

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
    });

    it('serializes a competing profile claim until a same-identity credential and URL move commits', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `canonical_url_adoption_rollback_${Date.now()}_${Math.random()}`;
        vi.doUnmock('@/auth/storage/tokenStorage');
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock();
        });
        vi.resetModules();
        const credentialBytes = new Map<string, string>();
        let onCredentialWrite: (() => void) | null = null;
        const localStorage = {
            getItem: (key: string) => credentialBytes.get(key) ?? null,
            setItem: (key: string, value: string) => {
                credentialBytes.set(key, value);
                if (value === JSON.stringify({ token: 'new-home-token' })) onCredentialWrite?.();
            },
            removeItem: (key: string) => void credentialBytes.delete(key),
        };
        vi.stubGlobal('window', {
            location: { origin: 'https://adoption-ui.test' }, localStorage,
            addEventListener: () => undefined, removeEventListener: () => undefined,
        });
        vi.stubGlobal('localStorage', localStorage);
        vi.stubGlobal('document', {});
        const lockTails = new Map<string, Promise<void>>();
        vi.stubGlobal('navigator', {
            locks: {
                request: <T>(name: string, callback: () => T | PromiseLike<T>): Promise<T> => {
                    const previous = lockTails.get(name) ?? Promise.resolve();
                    const result = previous.then(callback);
                    lockTails.set(name, result.then(() => undefined, () => undefined));
                    return result;
                },
            },
        });
        const profiles = await import('./serverProfiles');
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
        let competitor: Promise<unknown> | null = null;
        onCredentialWrite = () => {
            onCredentialWrite = null;
            competitor = (async () => {
                const profile = await profiles.upsertServerProfile({
                    serverUrl: 'https://moving-home-new.test',
                    source: 'manual',
                });
                return await profiles.setServerProfileIdentityForUrl(profile.serverUrl, 'srv_competing_home');
            })();
        };
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');

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

        await expect(competitor!).resolves.toBeNull();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.getCredentialsForServerUrl('https://moving-home-new.test', {
            serverId: 'srv_moving_home',
        })).resolves.toEqual({ token: 'new-home-token' });
        expect(profiles.getServerProfileById(established.id)).toMatchObject({
            canonicalServerUrl: 'https://moving-home-new.test',
            serverIdentityId: 'srv_moving_home',
        });
    });

    it.each([
        ['the previous credential', { token: 'previous-home-b-token' }],
        ['an empty target', null],
    ])('keeps the new credential when a competing profile claim waits for atomic adoption from %s', async (_label, priorCredential) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_rollback_${Date.now()}_${Math.random()}`;
        const profiles = await import('./serverProfiles');
        const focused = await profiles.upsertServerProfile({ serverUrl: 'https://home-a.test', source: 'manual' });
        await profiles.setActiveServerId(focused.id);
        await profiles.saveHomeViewState({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: focused.id,
            groups: [{ id: 'g', name: 'Homes', serverIds: [focused.id] }],
        });
        const focusBefore = profiles.getActiveServerSnapshot();
        const viewBefore = profiles.loadHomeViewState();
        let storedCredential = priorCredential;
        const rollback = vi.fn(async () => {
            storedCredential = priorCredential;
            return true;
        });
        let competitor: Promise<unknown> | null = null;
        setCredentialsForServerUrlWithRollbackMock.mockImplementationOnce(async (
            _authority,
            _serverUrl: string,
            _options: unknown,
            credentials: typeof priorCredential,
        ) => {
            storedCredential = credentials;
            competitor = (async () => {
                const profile = await profiles.upsertServerProfile({
                    serverUrl: 'https://home-b.test',
                    source: 'manual',
                });
                return await profiles.setServerProfileIdentityForUrl(profile.serverUrl, 'srv_competing_home');
            })();
            return {
                serverUrl: 'https://home-b.test',
                serverId: 'srv_home_b',
                rollback,
            };
        });
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');

        await expect(adoptHomeProfileWithCredentials({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
            },
            source: 'qr',
            credentials: { token: 'new-home-b-token' },
        })).resolves.toMatchObject({ serverIdentityId: 'srv_home_b' });

        expect(rollback).not.toHaveBeenCalled();
        expect(storedCredential).toEqual({ token: 'new-home-b-token' });
        await expect(competitor!).resolves.toBeNull();
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: focusBefore.serverId,
            serverUrl: focusBefore.serverUrl,
        });
        expect(profiles.loadHomeViewState()).toEqual(viewBefore);
    });

    it('reports a partial commit with both errors when credential rollback rejects', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_rollback_failure_${Date.now()}_${Math.random()}`;
        const profiles = await import('./serverProfiles');
        const rollback = vi.fn(async () => {
            throw new Error('credential rollback failed');
        });
        setCredentialsForServerUrlWithRollbackMock.mockImplementationOnce(async (authority) => {
            await profiles.adoptHomeProfileUnderMutationAuthority({
                descriptor: {
                    v: 1,
                    homeServerIdentityId: 'srv_competing_home',
                    canonicalServerUrl: 'https://home-b.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
                },
                source: 'manual',
            }, authority);
            return {
                serverUrl: 'https://home-b.test',
                serverId: 'srv_home_b',
                rollback,
            };
        });
        const {
            adoptHomeProfileWithCredentials,
            HomeProfileAdoptionPartialCommitError,
        } = await import('./adoptHomeProfile');

        const result = adoptHomeProfileWithCredentials({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
            },
            source: 'qr',
            credentials: { token: 'new-home-b-token' },
        });
        await expect(result).rejects.toBeInstanceOf(HomeProfileAdoptionPartialCommitError);
        await expect(result).rejects.toMatchObject({
            code: 'home_profile_adoption_partial_commit',
            canonicalServerUrl: 'https://home-b.test',
            serverIdentityId: 'srv_home_b',
            adoptionError: expect.objectContaining({ message: 'Home identity conflicts with URL' }),
            rollbackOutcome: {
                kind: 'failed',
                error: expect.objectContaining({ message: 'credential rollback failed' }),
            },
        });
        expect(rollback).toHaveBeenCalledOnce();
    });

    it('reports a partial commit when rollback cannot apply after credential ownership changes', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_rollback_not_applied_${Date.now()}_${Math.random()}`;
        const profiles = await import('./serverProfiles');
        const focused = await profiles.upsertServerProfile({ serverUrl: 'https://home-a.test', source: 'manual' });
        await profiles.setActiveServerId(focused.id);
        await profiles.saveHomeViewState({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: focused.id,
            groups: [{ id: 'g', name: 'Homes', serverIds: [focused.id] }],
        });
        const focusBefore = profiles.getActiveServerSnapshot();
        const viewBefore = profiles.loadHomeViewState();
        let storedCredential = { token: 'attempted-home-b-token' };
        const concurrentWinner = { token: 'concurrent-winner-token' };
        const rollback = vi.fn(async () => {
            if (storedCredential !== concurrentWinner) storedCredential = { token: 'unexpected-rollback' };
            return false;
        });
        setCredentialsForServerUrlWithRollbackMock.mockImplementationOnce(async (authority) => {
            await profiles.adoptHomeProfileUnderMutationAuthority({
                descriptor: {
                    v: 1,
                    homeServerIdentityId: 'srv_competing_home',
                    canonicalServerUrl: 'https://home-b.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
                },
                source: 'manual',
            }, authority);
            storedCredential = concurrentWinner;
            return {
                serverUrl: 'https://home-b.test',
                serverId: 'srv_home_b',
                rollback,
            };
        });
        const {
            adoptHomeProfileWithCredentials,
            HomeProfileAdoptionPartialCommitError,
        } = await import('./adoptHomeProfile');

        const result = adoptHomeProfileWithCredentials({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
            },
            source: 'qr',
            credentials: { token: 'new-home-b-token' },
        });
        await expect(result).rejects.toBeInstanceOf(HomeProfileAdoptionPartialCommitError);
        await expect(result).rejects.toMatchObject({
            code: 'home_profile_adoption_partial_commit',
            canonicalServerUrl: 'https://home-b.test',
            serverIdentityId: 'srv_home_b',
            adoptionError: expect.objectContaining({ message: 'Home identity conflicts with URL' }),
            rollbackOutcome: { kind: 'not_applied', reason: 'ownership_changed' },
        });
        expect(rollback).toHaveBeenCalledOnce();
        expect(storedCredential).toBe(concurrentWinner);
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: focusBefore.serverId,
            serverUrl: focusBefore.serverUrl,
        });
        expect(profiles.loadHomeViewState()).toEqual(viewBefore);
    });

    it('writes credentials under the canonical preflight target, then adopts without changing focus or groups', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_${Date.now()}_${Math.random()}`;
        const profiles = await import('./serverProfiles');
        const focused = await profiles.upsertServerProfile({ serverUrl: 'https://home-a.test', source: 'manual' });
        await profiles.setActiveServerId(focused.id);
        const activeBefore = profiles.getActiveServerSnapshot();
        await profiles.saveHomeViewState({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: focused.id,
            groups: [{ id: 'g', name: 'Homes', serverIds: [focused.id] }],
        });
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        const rollback = vi.fn(async () => true);
        setCredentialsForServerUrlWithRollbackMock.mockImplementationOnce(async () => {
            expect(profiles.listServerProfiles()).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ serverIdentityId: 'srv_home_b' }),
            ]));
            return {
                serverUrl: 'https://home-b.test',
                serverId: 'srv_home_b',
                rollback,
            };
        });

        const adopted = await adoptHomeProfileWithCredentials({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
            },
            source: 'qr',
            preserveUserLabel: true,
            suggestedName: 'Home B',
            credentials: { token: 'home-b-token' },
        });

        expect(adopted.serverIdentityId).toBe('srv_home_b');
        expect(adopted.name).toBe('Home B');
        expect(setCredentialsForServerUrlWithRollbackMock).toHaveBeenCalledWith(
            expect.any(Object),
            adopted.canonicalServerUrl ?? adopted.serverUrl,
            { serverId: adopted.serverIdentityId },
            { token: 'home-b-token' },
        );
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(rollback).not.toHaveBeenCalled();
        expect(profiles.loadHomeViewState()).toMatchObject({
            activeTargetId: focused.id,
            groups: [{ id: 'g', serverIds: [focused.id] }],
        });
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: activeBefore.serverId,
            serverUrl: activeBefore.serverUrl,
        });
    });

    it('leaves profile, focus, and groups unchanged when the credential write fails', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_write_failure_${Date.now()}_${Math.random()}`;
        const profiles = await import('./serverProfiles');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        setCredentialsForServerUrlWithRollbackMock.mockResolvedValueOnce(null);

        await expect(adoptHomeProfileWithCredentials({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
            },
            source: 'qr',
            preserveUserLabel: true,
            credentials: { token: 'home-b-token' },
        })).rejects.toThrow('Unable to store Home credentials');

        expect(profiles.listServerProfiles()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_home_b' }),
        ]));
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('does not write credentials when adoption rejects an identity conflict', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_conflict_${Date.now()}_${Math.random()}`;
        const profiles = await import('./serverProfiles');
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
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');

        await expect(adoptHomeProfileWithCredentials({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_conflicting',
                canonicalServerUrl: 'https://home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
            },
            source: 'account-directory',
            credentials: { token: 'must-not-store' },
        })).rejects.toThrow('Home identity conflicts with URL');
        expect(setCredentialsForServerUrlWithRollbackMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('rolls back an exact credential write when the owning enrollment attempt is cancelled before profile adoption', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_cancelled_${Date.now()}_${Math.random()}`;
        const profiles = await import('./serverProfiles');
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');
        let cancelled = false;
        const rollback = vi.fn(async () => true);
        setCredentialsForServerUrlWithRollbackMock.mockImplementationOnce(async () => {
            cancelled = true;
            return {
                serverUrl: 'https://home-b.test',
                serverId: 'srv_home_b',
                rollback,
            };
        });

        await expect(adoptHomeProfileWithCredentials({
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
            },
            source: 'account-directory',
            credentials: { token: 'must-roll-back' },
            shouldCancel: () => cancelled,
        })).rejects.toThrow('Home credential adoption cancelled');

        expect(rollback).toHaveBeenCalledOnce();
        expect(profiles.listServerProfiles()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_home_b' }),
        ]));
    });

    it('uses a nonempty Directory hint for a new profile and preserves an existing user label', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_suggested_name_${Date.now()}_${Math.random()}`;
        const profiles = await import('./serverProfiles');
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

    it('does not write an orphan credential when strict adoption rejects the descriptor', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `adopt_credentials_invalid_${Date.now()}_${Math.random()}`;
        const { adoptHomeProfileWithCredentials } = await import('./adoptHomeProfile');

        await expect(adoptHomeProfileWithCredentials({
            descriptor: {
                serverUrl: 'https://unbound-home.test',
            },
            source: 'qr',
            preserveUserLabel: true,
            credentials: { token: 'must-not-store' },
        })).rejects.toThrow();
        expect(setCredentialsForServerUrlWithRollbackMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });
});
