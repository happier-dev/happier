import { act } from 'react-test-renderer';
import * as SecureStore from 'expo-secure-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerProfileById, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';

// Real TokenStorage, Home profiles and credential-change fan-out over the
// device secure-store boundary. Only the machine file transport is faked.
const filenameTransport = vi.hoisted(() => ({ list: vi.fn(), directory: vi.fn() }));
vi.mock('@/sync/ops/machineWorkspaceFileList', () => ({ machineWorkspaceFileList: filenameTransport.list }));
vi.mock('@/sync/ops/machineFileBrowser', () => ({ machineFilesystemListDirectory: filenameTransport.directory }));

const HOME_IDS = ['home-a', 'home-b', 'home-moved'] as const;

beforeEach(async () => {
    await seedPersistedHomeProfilesForTests({ activeServerId: 'home-a', profiles: [
        ...['home-a', 'home-b'].map(id => ({ id, name: id, serverUrl: `https://${id}.example.test`,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1 })),
        // Stored under an older address of the same Home, so re-saving its canonical
        // address changes only the credential lookup target.
        { id: 'home-moved', name: 'home-moved', serverUrl: 'https://home-moved-old.example.test',
            canonicalServerUrl: 'https://home-moved.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
    ] });
});

afterEach(async () => {
    standardCleanup();
    for (const serverId of HOME_IDS) {
        const serverUrl = getServerProfileById(serverId)?.serverUrl;
        if (serverUrl) await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId });
    }
    storage.setState(storage.getInitialState(), true);
    filenameTransport.list.mockReset();
    filenameTransport.directory.mockReset();
});

function credentials(accountId: string) {
    return { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
}

async function signIn(serverId: string, accountId: string): Promise<void> {
    const serverUrl = getServerProfileById(serverId)!.serverUrl;
    expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, credentials(accountId))).toBe(true);
}

async function signOut(serverId: string): Promise<void> {
    await act(async () => {
        await TokenStorage.removeCredentialsForServerUrl(getServerProfileById(serverId)!.serverUrl, { serverId });
    });
}

describe('useServerCredentialAccountScopeResolutions', () => {
    it.each(['signed_out', 'unavailable', 'unknown_home', 'bound'] as const)(
        'does not resolve or publish an unchanged %s Home when a sibling leaves', async (state) => {
            await signIn('home-b', 'account-b');
            if (state === 'bound') await signIn('home-a', 'account-a');
            let locked = state === 'unavailable';
            const originalRead = SecureStore.getItemAsync;
            // Observe the real credential resolver at its device-storage boundary.
            const read = vi.spyOn(SecureStore, 'getItemAsync').mockImplementation(async (key, ...rest) => {
                if (locked && key.includes('auth_credentials') && key.includes('home-a')) {
                    throw new Error('secure storage is locked');
                }
                return originalRead(key, ...rest);
            });
            const subject = state === 'unknown_home' ? 'never-added' : 'home-a';
            try {
                const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
                const hook = await renderHook((ids: string[]) => useServerCredentialAccountScopeResolutions(ids), {
                    initialProps: [subject, 'home-b'],
                });
                expect(hook.getCurrent().get(subject)?.kind).toBe(state);
                const settled = hook.getCurrent().get(subject);
                for (let run = 0; run < 3; run++) {
                    if (run > 0) await hook.rerender([subject, 'home-b']);
                    read.mockClear();
                    const publications: unknown[] = [];
                    const unsubscribe = hook.subscribe(() => { publications.push(hook.getCurrent()); });
                    await hook.rerender([subject]);
                    unsubscribe();
                    expect(hook.getCurrent().get(subject)).toBe(settled);
                    expect(read.mock.calls.filter(([key]) => key.includes('auth_credentials') && key.includes('home-a'))).toHaveLength(0);
                    // One caller render and one publication removing the sibling; no
                    // invalidate/settle publications for the unchanged Home.
                    expect(publications).toHaveLength(2);
                    await hook.rerender([subject]);
                    expect(hook.getCurrent().get(subject)).toBe(settled);
                }
                if (state !== 'unknown_home') {
                    locked = false;
                    await act(async () => { await signIn('home-a', 'account-next'); });
                    expect(hook.getCurrent().get(subject)).toMatchObject({ kind: 'bound', scope: { accountId: 'account-next' } });
                    expect(hook.getCurrent().get(subject)).not.toBe(settled);
                }
                await hook.unmount();
            } finally {
                read.mockRestore();
            }
        },
    );

    it('does not restart an unchanged in-flight Home when a sibling leaves', async () => {
        await signIn('home-b', 'account-b');
        const releaseRead = createDeferred<void>();
        const readStarted = createDeferred<void>();
        const originalRead = SecureStore.getItemAsync;
        const read = vi.spyOn(SecureStore, 'getItemAsync').mockImplementation(async (key, ...rest) => {
            if (key.includes('auth_credentials') && key.includes('home-a')) {
                readStarted.resolve();
                await releaseRead.promise;
            }
            return originalRead(key, ...rest);
        });
        try {
            const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
            const hook = await renderHook((ids: string[]) => useServerCredentialAccountScopeResolutions(ids), {
                initialProps: ['home-a', 'home-b'],
            });
            await readStarted.promise;
            expect(hook.getCurrent().get('home-a')?.kind).toBe('resolving');
            read.mockClear();
            await hook.rerender(['home-a']);
            expect(read.mock.calls.filter(([key]) => key.includes('auth_credentials') && key.includes('home-a'))).toHaveLength(0);
            await act(async () => { releaseRead.resolve(); });
            expect(hook.getCurrent().get('home-a')?.kind).toBe('signed_out');
            await act(async () => { await signIn('home-a', 'account-a'); });
            expect(hook.getCurrent().get('home-a')).toMatchObject({ kind: 'bound', scope: { accountId: 'account-a' } });
            await hook.unmount();
        } finally {
            releaseRead.resolve();
            read.mockRestore();
        }
    });

    it.each(['account-b', 'account-a'])('binds addressed filename search and cancellation to Home B with Account %s', async (accountB) => {
        await signIn('home-a', 'account-a');
        await signIn('home-b', accountB);
        storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' } });
        filenameTransport.list.mockResolvedValueOnce({ ok: true, paths: ['needle.ts'], truncated: false });
        filenameTransport.list.mockImplementationOnce(() => new Promise(() => {}));
        const { useWorkspaceFileQuery } = await import('../workspaces/files/useWorkspaceFileQuery');
        const hook = await renderHook((query: string) => useWorkspaceFileQuery({
            scope: { serverId: 'home-b', machineId: 'machine', rootPath: '/repo' }, query, mode: 'glob',
        }), { initialProps: 'needle' });
        await vi.waitFor(() => expect(hook.getCurrent().items.map((item) => item.fullPath)).toEqual(['needle.ts']));
        expect(filenameTransport.list.mock.calls[0]?.[2]).toMatchObject({ serverId: 'home-b', accountId: accountB });
        // Retiring A must not clear B even when both Homes have the same Account id.
        await signOut('home-a');
        expect(hook.getCurrent().items).toHaveLength(1);
        await hook.rerender('second');
        await vi.waitFor(() => expect(filenameTransport.list).toHaveBeenCalledTimes(2));
        const signal: AbortSignal = filenameTransport.list.mock.calls[1]?.[2].signal;
        await signOut('home-b');
        expect(signal.aborted).toBe(true);
        await vi.waitFor(() => {
            expect(hook.getCurrent().items).toHaveLength(0);
            expect(hook.getCurrent().coverage).toBe('unavailable');
            expect(hook.getCurrent().isSearching).toBe(false);
        });
        expect(filenameTransport.list).toHaveBeenCalledTimes(2);
    });
    it('binds each Home to the Account held by that Home own credential', async () => {
        await signIn('home-a', 'account-a');
        await signIn('home-b', 'account-b');
        const sessionRows = {};
        storage.setState((state) => ({
            ...state,
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId, 'home-a': sessionRows },
            sessionListIndexByServerId: { ...state.sessionListIndexByServerId, 'home-a': [] },
        }));

        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a', 'home-b']));

        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({
                kind: 'bound',
                scope: { serverId: 'home-a', accountId: 'account-a' },
            });
            expect(hook.getCurrent().get('home-b')).toEqual({
                kind: 'bound',
                scope: { serverId: 'home-b', accountId: 'account-b' },
            });
        });
        expect(storage.getState().sessionListRowsByServerId['home-a']).toBe(sessionRows);
    });

    it('reports a Home this device has not saved as unknown rather than signed out', async () => {
        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['never-added']));

        await vi.waitFor(() => {
            expect(hook.getCurrent().get('never-added')).toEqual({ kind: 'unknown_home' });
        });
    });

    it('re-reads an unreadable Home on request so its surfaces can settle once storage recovers', async () => {
        await signIn('home-b', 'account-b');
        // A locked secure store for Home A only; Home B's credential stays readable.
        const readSecureStore = SecureStore.getItemAsync;
        const failedKeys: string[] = [];
        let homeAUnreadable = true;
        const secureStoreRead = vi.spyOn(SecureStore, 'getItemAsync').mockImplementation(async (key, ...rest) => {
            if (homeAUnreadable && key.includes('auth_credentials') && key.includes('home-a')) {
                failedKeys.push(key);
                throw new Error('secure storage is locked');
            }
            return await readSecureStore(key, ...rest);
        });
        try {
            const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
            const { retryServerCredentialAccountScope } = await import('./serverCredentialAccountScope');
            const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a', 'home-b']));

            await vi.waitFor(() => {
                expect(hook.getCurrent().get('home-a')).toEqual({ kind: 'unavailable' });
                expect(hook.getCurrent().get('home-b')?.kind).toBe('bound');
            });
            const settledSibling = hook.getCurrent().get('home-b');

            // The store unlocks holding Home A's credential; no credential mutation is published.
            homeAUnreadable = false;
            await SecureStore.setItemAsync(failedKeys[0]!, JSON.stringify(credentials('account-a')));
            act(() => {
                retryServerCredentialAccountScope('home-a');
            });

            await vi.waitFor(() => {
                expect(hook.getCurrent().get('home-a')).toEqual({
                    kind: 'bound',
                    scope: { serverId: 'home-a', accountId: 'account-a' },
                });
            });
            // A retry re-reads only the Home that was asked about.
            expect(hook.getCurrent().get('home-b')).toBe(settledSibling);
        } finally {
            secureStoreRead.mockRestore();
        }
    });

    it('does not expose a retired binding while retaining its settled revalidation projection', async () => {
        await signIn('home-moved', 'account-moved');

        const {
            useServerCredentialAccountScopeBindings,
            useServerCredentialAccountScopeResolutions,
        } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => ({
            bindings: useServerCredentialAccountScopeBindings(['home-moved']),
            resolutions: useServerCredentialAccountScopeResolutions(['home-moved']),
        }));
        await vi.waitFor(() => {
            expect(hook.getCurrent().bindings.has('home-moved')).toBe(true);
            expect(hook.getCurrent().resolutions.get('home-moved')?.kind).toBe('bound');
        });

        const releaseRead = createDeferred<void>();
        const originalRead = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (...args) => {
            await releaseRead.promise;
            return await originalRead(...args);
        });
        try {
            // Only an actual credential lookup-target change (the Home's URL) retires the binding;
            // a metadata-only publication keeps it.
            await act(async () => {
                await upsertServerProfile({ serverUrl: 'https://home-moved.example.test', replaceEquivalentStoredUrl: true });
            });
            expect(getServerProfileById('home-moved')?.serverUrl).toBe('https://home-moved.example.test');

            expect(hook.getCurrent().bindings.has('home-moved')).toBe(false);
            expect(hook.getCurrent().resolutions.get('home-moved')).toEqual({
                kind: 'bound',
                scope: { serverId: 'home-moved', accountId: 'account-moved' },
            });

            await act(async () => { releaseRead.resolve(); });
            await vi.waitFor(() => expect(hook.getCurrent().bindings.get('home-moved')?.accountId).toBe('account-moved'));
        } finally {
            releaseRead.resolve();
            credentialRead.mockRestore();
        }
    });

    it('stops claiming an Account once that Home credential is removed', async () => {
        await signIn('home-a', 'account-a');

        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a']));
        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')?.kind).toBe('bound');
        });

        await signOut('home-a');

        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({ kind: 'signed_out' });
        });
    });
});

describe('useServerCredentialAccountScopeResolution', () => {
    it('resolves the one requested Home without the caller assembling a set', async () => {
        await signIn('home-a', 'account-a');

        const { useServerCredentialAccountScopeResolution } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolution('home-a'));

        await vi.waitFor(() => {
            expect(hook.getCurrent()).toEqual({
                kind: 'bound',
                scope: { serverId: 'home-a', accountId: 'account-a' },
            });
        });
    });

    it('reports an empty Home id as unknown instead of resolving forever', async () => {
        const { useServerCredentialAccountScopeResolution } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolution('   '));

        await vi.waitFor(() => {
            expect(hook.getCurrent()).toEqual({ kind: 'unknown_home' });
        });
    });
});
