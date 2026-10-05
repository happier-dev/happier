import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

type CredentialMutationEvent = Readonly<{
    kind: 'credentials_set' | 'credentials_removed';
    serverId: string;
    serverUrl: string;
}>;

const harness = vi.hoisted(() => ({
    tokenByServerId: new Map<string, string>(),
    unreadableServerIds: new Set<string>(),
    profiles: new Map<string, { id: string; serverUrl: string }>(),
    listeners: new Set<(event: CredentialMutationEvent) => void>(),
    profilesGeneration: 1,
    credentialReadGate: null as Promise<void> | null,
}));
const captureExceptionIfEnabled = vi.hoisted(() => vi.fn());
const filenameTransport = vi.hoisted(() => ({ list: vi.fn(), directory: vi.fn() }));
// The applied network connection is an environment boundary; both lifetime owners stay real.
vi.mock('@/sync/runtime/orchestration/connectionManager', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    getAppliedActiveServerSnapshot: () => ({ serverId: 'home-a', serverUrl: 'https://home-a.example.test', generation: 1 }),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
vi.mock('@/sync/ops/machineWorkspaceFileList', () => ({ machineWorkspaceFileList: filenameTransport.list }));
vi.mock('@/sync/ops/machineFileBrowser', () => ({ machineFilesystemListDirectory: filenameTransport.directory }));

vi.mock('@/utils/system/sentry', async (importOriginal) => ({
    ...(await (importOriginal as () => Promise<typeof import('@/utils/system/sentry')>)()),
    captureExceptionIfEnabled,
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => harness.profilesGeneration,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await (importOriginal as () => Promise<typeof import('@/sync/domains/server/serverProfiles')>)();
    return {
        ...actual,
        areServerProfileIdentifiersEquivalent: (left: string, right: string) => left === right,
        getServerProfileById: (serverId: string) => harness.profiles.get(serverId) ?? null,
        resolveServerProfileScopeIdForIdentifier: (serverId: unknown) => String(serverId ?? '').trim(),
    };
});

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async (
                _serverUrl: string,
                options: { serverId?: string | null; storageReadFailure?: 'absent' | 'surface' },
            ) => {
                await harness.credentialReadGate;
                // Mirrors the real owner (proven in serverCredentialAccountScope.test.ts):
                // an unreadable store throws only for a reader that asked to see it.
                if (harness.unreadableServerIds.has(options.serverId ?? '')) {
                    if (options.storageReadFailure === 'surface') throw new Error('secure_storage_unavailable');
                    return null;
                }
                const token = harness.tokenByServerId.get(options.serverId ?? '');
                return token ? {
                    token: token === 'malformed'
                        ? token
                        : `header.${Buffer.from(JSON.stringify({ sub: token })).toString('base64')}.signature`,
                } : null;
            },
        },
        subscribeHomeCredentialMutations: () => () => undefined,
    });
});
vi.mock('@/sync/runtime/orchestration/homeAccountChange', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/homeAccountChange')>(),
    subscribeHomeCredentialChange: (listener: (event: CredentialMutationEvent) => void) => {
        harness.listeners.add(listener);
        return () => harness.listeners.delete(listener);
    },
}));


function emitCredentialMutation(event: CredentialMutationEvent): void {
    act(() => {
        for (const listener of [...harness.listeners]) listener(event);
    });
}

function saveProfile(serverId: string): void {
    harness.profiles.set(serverId, { id: serverId, serverUrl: `https://${serverId}.example.test` });
}

afterEach(() => {
    harness.tokenByServerId.clear();
    harness.unreadableServerIds.clear();
    harness.profiles.clear();
    harness.listeners.clear();
    harness.profilesGeneration = 1;
    harness.credentialReadGate = null;
    standardCleanup();
    storage.setState(storage.getInitialState(), true);
    filenameTransport.list.mockReset();
    filenameTransport.directory.mockReset();
});

describe('useServerCredentialAccountScopeResolutions', () => {
    it.each(['account-b', 'account-a'])('binds addressed filename search and cancellation to Home B with Account %s', async (accountB) => {
        saveProfile('home-a');
        saveProfile('home-b');
        harness.tokenByServerId.set('home-a', 'account-a');
        harness.tokenByServerId.set('home-b', accountB);
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
        harness.tokenByServerId.delete('home-a');
        emitCredentialMutation({ kind: 'credentials_removed', serverId: 'home-a', serverUrl: 'https://home-a.example.test' });
        expect(hook.getCurrent().items).toHaveLength(1);
        await hook.rerender('second');
        await vi.waitFor(() => expect(filenameTransport.list).toHaveBeenCalledTimes(2));
        const signal: AbortSignal = filenameTransport.list.mock.calls[1]?.[2].signal;
        harness.tokenByServerId.delete('home-b');
        emitCredentialMutation({ kind: 'credentials_removed', serverId: 'home-b', serverUrl: 'https://home-b.example.test' });
        expect(signal.aborted).toBe(true);
        await vi.waitFor(() => {
            expect(hook.getCurrent().items).toHaveLength(0);
            expect(hook.getCurrent().coverage).toBe('unavailable');
            expect(hook.getCurrent().isSearching).toBe(false);
        });
        expect(filenameTransport.list).toHaveBeenCalledTimes(2);
    });
    it('binds each Home to the Account held by that Home own credential', async () => {
        saveProfile('home-a');
        saveProfile('home-b');
        harness.tokenByServerId.set('home-a', 'account-a');
        harness.tokenByServerId.set('home-b', 'account-b');
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

    it('reports a saved Home with no credential as signed out', async () => {
        saveProfile('home-a');

        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a']));

        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({ kind: 'signed_out' });
        });
    });

    it('treats a malformed credential as signed out, never as a bound Account', async () => {
        saveProfile('home-a');
        harness.tokenByServerId.set('home-a', 'malformed');

        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a']));

        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({ kind: 'signed_out' });
        });
    });

    it('keeps a secure-storage read failure distinct from a confirmed sign-out', async () => {
        captureExceptionIfEnabled.mockClear();
        saveProfile('home-a');
        harness.unreadableServerIds.add('home-a');

        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a']));

        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({ kind: 'unavailable' });
        });
        expect(captureExceptionIfEnabled).toHaveBeenCalledWith(expect.any(Error), {
            tags: { operation: 'resolve_server_credential_account_scope' },
            extra: { serverId: 'home-a' },
        });
    });

    it('re-reads an unreadable Home on request so its surfaces can settle once storage recovers', async () => {
        saveProfile('home-a');
        saveProfile('home-b');
        harness.unreadableServerIds.add('home-a');
        harness.tokenByServerId.set('home-b', 'account-b');

        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const { retryServerCredentialAccountScope } = await import('./serverCredentialAccountScope');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a', 'home-b']));

        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({ kind: 'unavailable' });
            expect(hook.getCurrent().get('home-b')?.kind).toBe('bound');
        });
        const settledSibling = hook.getCurrent().get('home-b');

        harness.unreadableServerIds.delete('home-a');
        harness.tokenByServerId.set('home-a', 'account-a');
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
    });

    it('rebinds one Home when its credential changes and leaves its siblings alone', async () => {
        saveProfile('home-a');
        saveProfile('home-b');
        harness.tokenByServerId.set('home-a', 'account-a');
        harness.tokenByServerId.set('home-b', 'account-b');

        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a', 'home-b']));
        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({
                kind: 'bound',
                scope: { serverId: 'home-a', accountId: 'account-a' },
            });
        });

        harness.tokenByServerId.set('home-a', 'account-a2');
        emitCredentialMutation({
            kind: 'credentials_set',
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
        });

        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({
                kind: 'bound',
                scope: { serverId: 'home-a', accountId: 'account-a2' },
            });
        });
        expect(hook.getCurrent().get('home-b')).toEqual({
            kind: 'bound',
            scope: { serverId: 'home-b', accountId: 'account-b' },
        });
    });

    it('retains a settled Account projection while an unchanged Home profile is revalidated', async () => {
        saveProfile('home-a');
        harness.tokenByServerId.set('home-a', 'account-a');

        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a']));
        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({
                kind: 'bound',
                scope: { serverId: 'home-a', accountId: 'account-a' },
            });
        });

        let releaseCredentialRead: (() => void) | undefined;
        harness.credentialReadGate = new Promise<void>((resolve) => {
            releaseCredentialRead = resolve;
        });
        harness.profilesGeneration += 1;
        await hook.rerender();

        expect(hook.getCurrent().get('home-a')).toEqual({
            kind: 'bound',
            scope: { serverId: 'home-a', accountId: 'account-a' },
        });

        await act(async () => {
            releaseCredentialRead?.();
            harness.credentialReadGate = null;
        });
        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({
                kind: 'bound',
                scope: { serverId: 'home-a', accountId: 'account-a' },
            });
        });
    });

    it('does not expose a retired binding while retaining its settled revalidation projection', async () => {
        saveProfile('home-a');
        harness.tokenByServerId.set('home-a', 'account-a');

        const {
            useServerCredentialAccountScopeBindings,
            useServerCredentialAccountScopeResolutions,
        } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => ({
            bindings: useServerCredentialAccountScopeBindings(['home-a']),
            resolutions: useServerCredentialAccountScopeResolutions(['home-a']),
        }));
        await vi.waitFor(() => {
            expect(hook.getCurrent().bindings.has('home-a')).toBe(true);
            expect(hook.getCurrent().resolutions.get('home-a')?.kind).toBe('bound');
        });

        let releaseCredentialRead: (() => void) | undefined;
        harness.credentialReadGate = new Promise<void>((resolve) => {
            releaseCredentialRead = resolve;
        });
        harness.profilesGeneration += 1;
        await hook.rerender();

        expect(hook.getCurrent().bindings.has('home-a')).toBe(false);
        expect(hook.getCurrent().resolutions.get('home-a')).toEqual({
            kind: 'bound',
            scope: { serverId: 'home-a', accountId: 'account-a' },
        });

        await act(async () => {
            releaseCredentialRead?.();
            harness.credentialReadGate = null;
        });
    });

    it('stops claiming an Account once that Home credential is removed', async () => {
        saveProfile('home-a');
        harness.tokenByServerId.set('home-a', 'account-a');

        const { useServerCredentialAccountScopeResolutions } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopeResolutions(['home-a']));
        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')?.kind).toBe('bound');
        });

        harness.tokenByServerId.delete('home-a');
        emitCredentialMutation({
            kind: 'credentials_removed',
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
        });

        await vi.waitFor(() => {
            expect(hook.getCurrent().get('home-a')).toEqual({ kind: 'signed_out' });
        });
    });
});

describe('useServerCredentialAccountScopeResolution', () => {
    it('resolves the one requested Home without the caller assembling a set', async () => {
        saveProfile('home-a');
        harness.tokenByServerId.set('home-a', 'account-a');

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
