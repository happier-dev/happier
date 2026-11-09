import { describe, expect, it, vi } from 'vitest';

import {
    clearCachedMachineFileBrowserEntries,
    clearCachedMachineFileBrowserRoots,
    getCachedMachineFileBrowserEntries,
    getCachedMachineFileBrowserRoots,
    listMachineFileBrowserDirectoryEntries,
    listMachineFileBrowserRoots,
    warmMachineFileBrowserDirectoryCache,
} from './machineFileBrowser';

vi.mock('@/sync/ops/machineFileBrowser', () => ({
    machineFilesystemListRoots: vi.fn(),
    machineFilesystemListDirectory: vi.fn(),
}));

describe('machineFileBrowser domain', () => {
    it('sorts and caches roots and directory entries', async () => {
        const ops = await import('@/sync/ops/machineFileBrowser');
        (ops.machineFilesystemListRoots as any).mockReset();
        (ops.machineFilesystemListDirectory as any).mockReset();
        clearCachedMachineFileBrowserEntries({ machineId: 'machine-1' });
        clearCachedMachineFileBrowserRoots({ machineId: 'machine-1' });
        (ops.machineFilesystemListRoots as any).mockResolvedValueOnce({
            ok: true,
            roots: [{ id: '/', label: '/', path: '/' }],
        });
        (ops.machineFilesystemListDirectory as any).mockResolvedValueOnce({
            ok: true,
            path: '/Users/leeroy',
            entries: [
                { name: 'b.txt', path: '/Users/leeroy/b.txt', type: 'file' },
                { name: 'A', path: '/Users/leeroy/A', type: 'directory' },
            ],
            truncated: false,
        });

        const roots = await listMachineFileBrowserRoots({ machineId: 'machine-1', serverId: 'server-1' });
        const directory = await listMachineFileBrowserDirectoryEntries({
            machineId: 'machine-1',
            directoryPath: '/Users/leeroy',
            includeFiles: true,
            serverId: 'server-1',
        });

        expect(roots).toEqual({
            ok: true,
            roots: [{ id: '/', label: '/', path: '/' }],
        });
        expect(directory.ok).toBe(true);
        if (directory.ok) {
            expect(directory.entries.map((entry) => `${entry.type}:${entry.name}`)).toEqual([
                'directory:A',
                'file:b.txt',
            ]);
        }
        expect(getCachedMachineFileBrowserRoots({ machineId: 'machine-1', serverId: 'server-1' })).toEqual([{ id: '/', label: '/', path: '/' }]);
        expect(getCachedMachineFileBrowserEntries({ machineId: 'machine-1', serverId: 'server-1', directoryPath: '/Users/leeroy' })).not.toBeNull();
    });

    it('dedupes in-flight warm requests and clears machine-scoped caches independently', async () => {
        const ops = await import('@/sync/ops/machineFileBrowser');
        (ops.machineFilesystemListDirectory as any).mockReset();
        clearCachedMachineFileBrowserEntries({ machineId: 'machine-1' });
        clearCachedMachineFileBrowserRoots({ machineId: 'machine-1' });
        let resolveDirectory!: (value: unknown) => void;
        (ops.machineFilesystemListDirectory as any).mockReturnValueOnce(new Promise((resolve) => {
            resolveDirectory = resolve;
        }));

        const first = warmMachineFileBrowserDirectoryCache({
            machineId: 'machine-1',
            directoryPath: '/Users/leeroy',
            includeFiles: false,
        });
        const second = warmMachineFileBrowserDirectoryCache({
            machineId: 'machine-1',
            directoryPath: '/Users/leeroy',
            includeFiles: false,
        });

        expect(ops.machineFilesystemListDirectory).toHaveBeenCalledTimes(1);

        resolveDirectory({
            ok: true,
            path: '/Users/leeroy',
            entries: [{ name: 'Documents', path: '/Users/leeroy/Documents', type: 'directory' }],
            truncated: false,
        });

        await first;
        await second;

        clearCachedMachineFileBrowserEntries({ machineId: 'machine-1' });
        clearCachedMachineFileBrowserRoots({ machineId: 'machine-1' });

        expect(getCachedMachineFileBrowserEntries({ machineId: 'machine-1', directoryPath: '/Users/leeroy' })).toBeNull();
        expect(getCachedMachineFileBrowserRoots({ machineId: 'machine-1' })).toBeNull();
    });

    it('keeps machine browse caches isolated by server scope and preserves truncation in warm cache', async () => {
        const ops = await import('@/sync/ops/machineFileBrowser');
        (ops.machineFilesystemListDirectory as any).mockReset();
        clearCachedMachineFileBrowserEntries({ machineId: 'machine-1' });

        (ops.machineFilesystemListDirectory as any)
            .mockResolvedValueOnce({
                ok: true,
                path: '/Users/leeroy',
                entries: [{ name: 'Documents', path: '/Users/leeroy/Documents', type: 'directory' }],
                truncated: true,
            })
            .mockResolvedValueOnce({
                ok: true,
                path: '/Users/leeroy',
                entries: [{ name: 'Downloads', path: '/Users/leeroy/Downloads', type: 'directory' }],
                truncated: false,
            });

        const serverOne = await listMachineFileBrowserDirectoryEntries({
            machineId: 'machine-1',
            serverId: 'server-1',
            directoryPath: '/Users/leeroy',
            includeFiles: false,
        });
        const serverTwo = await listMachineFileBrowserDirectoryEntries({
            machineId: 'machine-1',
            serverId: 'server-2',
            directoryPath: '/Users/leeroy',
            includeFiles: false,
        });

        const warmedServerOne = await warmMachineFileBrowserDirectoryCache({
            machineId: 'machine-1',
            serverId: 'server-1',
            directoryPath: '/Users/leeroy',
            includeFiles: false,
        });

        expect(serverOne).toEqual({
            ok: true,
            entries: [{ name: 'Documents', path: '/Users/leeroy/Documents', type: 'directory' }],
            truncated: true,
        });
        expect(serverTwo).toEqual({
            ok: true,
            entries: [{ name: 'Downloads', path: '/Users/leeroy/Downloads', type: 'directory' }],
            truncated: false,
        });
        expect(warmedServerOne).toEqual(serverOne);
        expect(ops.machineFilesystemListDirectory).toHaveBeenCalledTimes(2);
    });
});

describe('machineFileBrowser across an Account change on one Home', () => {
    const home = { serverUrl: 'https://account-change-browser', serverId: 'account-change-browser' };
    const machine = { machineId: 'shared-machine', serverId: home.serverId };
    const directory = { ...machine, directoryPath: '/Users/a', includeFiles: true };
    const listing = (name: string) => ({ ok: true, path: '/Users/a', truncated: false,
        entries: [{ name, path: `/Users/a/${name}`, type: 'file' }] });

    async function signIn(accountId: string) {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const credentials = { token: createAccountTokenForTests(accountId) };
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId }, credentials)).toBe(true);
        return credentials;
    }

    async function readOpsMocks() {
        const ops = await import('@/sync/ops/machineFileBrowser');
        const roots = ops.machineFilesystemListRoots as unknown as ReturnType<typeof vi.fn>;
        const entries = ops.machineFilesystemListDirectory as unknown as ReturnType<typeof vi.fn>;
        roots.mockReset();
        entries.mockReset();
        return { roots, entries };
    }

    it.each(['signed-out', 'switched'] as const)('serves no listing read for the previous Account once the Home has %s', async change => {
        const { roots, entries } = await readOpsMocks();
        await signIn('browser-account-a');
        roots.mockResolvedValueOnce({ ok: true, roots: [{ id: '/', label: 'a-private', path: '/' }] });
        entries.mockResolvedValueOnce(listing('a-private.txt'));
        await listMachineFileBrowserRoots(machine);
        await listMachineFileBrowserDirectoryEntries(directory);
        expect(getCachedMachineFileBrowserEntries(directory)?.[0]?.name).toBe('a-private.txt');

        if (change === 'signed-out') {
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId });
        } else await signIn('browser-account-b');

        expect(getCachedMachineFileBrowserRoots(machine)).toBeNull();
        expect(getCachedMachineFileBrowserEntries(directory)).toBeNull();
    });

    it('neither joins nor retains a read still in flight when the Account changed', async () => {
        const { entries } = await readOpsMocks();
        await signIn('browser-account-a');
        clearCachedMachineFileBrowserEntries(directory);
        let settleHeld = (_value: unknown) => {};
        entries.mockImplementationOnce(() => new Promise(resolve => { settleHeld = resolve; }));
        const held = warmMachineFileBrowserDirectoryCache(directory);
        await vi.waitFor(() => expect(entries).toHaveBeenCalledTimes(1));

        await signIn('browser-account-b');
        entries.mockResolvedValueOnce(listing('b-own.txt'));
        const fresh = await warmMachineFileBrowserDirectoryCache(directory);
        expect(fresh).toMatchObject({ ok: true, entries: [{ name: 'b-own.txt' }] });

        settleHeld(listing('a-private.txt'));
        await held;
        expect(getCachedMachineFileBrowserEntries(directory)?.[0]?.name).toBe('b-own.txt');
    });

    it('lands a read in flight on another Home while this Home\'s Account changes', async () => {
        const { entries } = await readOpsMocks();
        await signIn('browser-account-a');
        const otherDirectory = { ...directory, serverId: 'account-change-browser-other' };
        let settleOther = (_value: unknown) => {};
        entries.mockImplementationOnce(() => new Promise(resolve => { settleOther = resolve; }));
        const other = listMachineFileBrowserDirectoryEntries(otherDirectory);
        await vi.waitFor(() => expect(entries).toHaveBeenCalledTimes(1));

        await signIn('browser-account-b');
        settleOther(listing('other-home.txt'));
        expect(await other).toMatchObject({ ok: true, entries: [{ name: 'other-home.txt' }] });
        expect(getCachedMachineFileBrowserEntries(otherDirectory)?.[0]?.name).toBe('other-home.txt');
    });

    it('keeps listings through a same-Account bearer refresh, even when it is the first credential event this process observes', async () => {
        // A fresh module graph: the Account signed in before anything here subscribed.
        vi.resetModules();
        const browser = await import('./machineFileBrowser');
        const { entries } = await readOpsMocks();
        const original = await signIn('browser-account-refresh');
        entries.mockResolvedValueOnce(listing('kept.txt'));
        await browser.listMachineFileBrowserDirectoryEntries(directory);

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const refreshed = { token: original.token.replace(/\.[^.]*$/, '.refreshed-signature') };
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId }, refreshed)).toBe(true);

        expect(browser.getCachedMachineFileBrowserEntries(directory)?.[0]?.name).toBe('kept.txt');
    });
});
