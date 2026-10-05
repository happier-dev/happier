import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRipgrepMock = vi.fn();
const machineFilesystemListDirectoryMock = vi.fn();
let activeAccountLifetime: ReturnType<typeof createAccountLifetimeFixture> | null = null;

function createAccountLifetimeFixture(accountId: string) {
    let current = true;
    const retirementCallbacks = new Set<() => void>();
    return {
        scope: { serverId: 'server-a', accountId },
        isCurrent: () => current,
        onRetire(callback: () => void) {
            retirementCallbacks.add(callback);
            return { dispose: () => retirementCallbacks.delete(callback) };
        },
        retire() {
            current = false;
            for (const callback of [...retirementCallbacks]) callback();
            retirementCallbacks.clear();
        },
    };
}

vi.mock('@/sync/ops/machineWorkspaceFileList', () => ({
    machineWorkspaceFileList: async (...args: unknown[]) => {
        const response = await machineRipgrepMock(...args) as Readonly<{
            ok?: boolean;
            success?: boolean;
            paths?: string[];
            stdout?: string;
        }>;
        if (typeof response?.ok === 'boolean') return response;
        if (response?.success === true) {
            const requestedLimit = (args[1] as Readonly<{ limit?: number }> | undefined)?.limit;
            const allPaths = String(response.stdout ?? '').split('\n').filter(Boolean);
            return {
                ok: true,
                paths: typeof requestedLimit === 'number' ? allPaths.slice(0, requestedLimit) : allPaths,
                truncated: typeof requestedLimit === 'number' && allPaths.length > requestedLimit,
            };
        }
        return { ok: false, errorCode: 'ripgrep_unavailable' };
    },
}));

vi.mock('@/sync/ops/machineFileBrowser', () => ({
    machineFilesystemListDirectory: (...args: unknown[]) => machineFilesystemListDirectoryMock(...args),
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime,
}));

/**
 * Two workspaces that differ ONLY by the server they are reached through. A machine id is
 * unique only within its server, so `m1:/repo` names two different worktrees here — which is
 * exactly the pair the poisoning defect confused.
 */
const SCOPE_A = { serverId: 'server-a', machineId: 'm1', rootPath: '/repo' } as const;
const SCOPE_B = { serverId: 'server-b', machineId: 'm1', rootPath: '/repo' } as const;

/**
 * THE SIGNATURE GUARD — this one is enforced by the COMPILER, not by a runtime assertion.
 *
 * `searchWorkspaceFiles` takes the workspace as ONE `scope` and derives the cache key from it
 * internally. There is no `workspaceCacheKey` parameter, so a caller physically cannot key by
 * one workspace while routing through another. The literal below does exactly that — a
 * `server-b` key next to a `server-a` scope — and it must NOT typecheck.
 *
 * Mutation proof: restore a `workspaceCacheKey` field on the owner's input type and this line
 * starts compiling, which turns the directive into an unused `@ts-expect-error` and fails
 * `yarn typecheck`. Vitest strips types, so this guard is invisible to `vitest run` by design.
 * The value is referenced and never invoked; nothing here executes.
 */
type SearchWorkspaceFilesInput = Parameters<typeof import('./workspaceFileSearch').searchWorkspaceFiles>[0];
const disagreeingKeyAndScope: SearchWorkspaceFilesInput = {
    scope: SCOPE_A,
    // @ts-expect-error - a cache key cannot be supplied alongside the scope it would contradict.
    workspaceCacheKey: 'server-b:m1:/repo',
    query: 'needle',
};
void disagreeingKeyAndScope;

describe('workspaceFileSearch', () => {
    beforeEach(() => {
        vi.resetModules();
        machineRipgrepMock.mockReset();
        machineFilesystemListDirectoryMock.mockReset();
        machineFilesystemListDirectoryMock.mockResolvedValue({ ok: false });
        activeAccountLifetime = null;
    });

    it('ranks exact basenames and stems before prefixes and fuzzy matches before applying the limit', async () => {
        machineRipgrepMock.mockResolvedValue({ success: true, stdout: [
            'src/normalizeSecretStringPromptInput.ts',
            'src/promptInputHelper.ts',
            'src/promptInput.test.ts',
            'packages/a/promptInput.ts',
            'packages/b/promptInput.ts',
            'promptInput/child.ts',
        ].join('\n') });
        const { searchWorkspaceFiles } = await import('./workspaceFileSearch');
        const results = await searchWorkspaceFiles({ scope: SCOPE_A, query: 'PROMPTINPUT', limit: 4 });
        expect(results.map((file) => file.fullPath)).toEqual([
            'promptInput/', 'packages/a/promptInput.ts', 'packages/b/promptInput.ts', 'src/promptInput.test.ts',
        ]);
        expect((await searchWorkspaceFiles({ scope: SCOPE_A, query: 'promptInput.ts', limit: 2 })).map((file) => file.fullPath))
            .toEqual(['packages/a/promptInput.ts', 'packages/b/promptInput.ts']);
        expect((await searchWorkspaceFiles({ scope: SCOPE_A, query: 'packages/b/promptInput.ts', limit: 1 }))[0]?.fullPath)
            .toBe('packages/b/promptInput.ts');
    });

    it('does not reuse the same server, machine, and root cache across Account lifetimes', async () => {
        activeAccountLifetime = createAccountLifetimeFixture('account-a');
        machineRipgrepMock.mockResolvedValueOnce({ success: true, stdout: 'src/account-a.ts\n' });

        const mod = await import('./workspaceFileSearch');
        await expect(mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 50 }))
            .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ fullPath: 'src/account-a.ts' })]));

        activeAccountLifetime.retire();
        activeAccountLifetime = createAccountLifetimeFixture('account-b');
        machineRipgrepMock.mockResolvedValueOnce({ success: true, stdout: 'src/account-b.ts\n' });

        const accountBFiles = await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 50 });
        expect(accountBFiles).toEqual(expect.arrayContaining([expect.objectContaining({ fullPath: 'src/account-b.ts' })]));
        expect(accountBFiles).not.toEqual(expect.arrayContaining([expect.objectContaining({ fullPath: 'src/account-a.ts' })]));
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);
    });

    it('rejects late index publication from a retired Account lifetime', async () => {
        activeAccountLifetime = createAccountLifetimeFixture('account-a');
        let releaseAccountA!: (value: { success: boolean; stdout: string }) => void;
        machineRipgrepMock.mockImplementationOnce(() => new Promise((resolve) => {
            releaseAccountA = resolve;
        }));

        const mod = await import('./workspaceFileSearch');
        const pendingAccountA = mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 50 });
        await vi.waitFor(() => expect(machineRipgrepMock).toHaveBeenCalledTimes(1));

        activeAccountLifetime.retire();
        activeAccountLifetime = createAccountLifetimeFixture('account-b');
        releaseAccountA({ success: true, stdout: 'src/stale-account-a.ts\n' });

        await expect(pendingAccountA).rejects.toMatchObject({ code: 'WORKSPACE_FILE_SEARCH_UNAVAILABLE' });

        machineRipgrepMock.mockResolvedValueOnce({ success: true, stdout: 'src/current-account-b.ts\n' });
        const accountBFiles = await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 50 });
        expect(accountBFiles.map((entry) => entry.fullPath)).toContain('src/current-account-b.ts');
        expect(accountBFiles.map((entry) => entry.fullPath)).not.toContain('src/stale-account-a.ts');
    });

    it('binds an inactive selected workspace search to its exact supplied credential lifetime', async () => {
        activeAccountLifetime = createAccountLifetimeFixture('account-a');
        const inactiveAccountB = createAccountLifetimeFixture('account-b');
        machineRipgrepMock.mockResolvedValueOnce({ success: true, stdout: 'src/account-b.ts\n' });

        const mod = await import('./workspaceFileSearch');
        const accountBFiles = await mod.searchWorkspaceFiles({
            scope: SCOPE_B,
            query: '',
            limit: 50,
            accountLifetime: inactiveAccountB,
        });
        expect(accountBFiles.map((entry) => entry.fullPath)).toContain('src/account-b.ts');

        inactiveAccountB.retire();
        await expect(mod.searchWorkspaceFiles({
            scope: SCOPE_B,
            query: '',
            limit: 50,
            accountLifetime: inactiveAccountB,
        })).rejects.toMatchObject({ code: 'WORKSPACE_FILE_SEARCH_UNAVAILABLE' });
    });

    it('keeps simultaneously valid Account lifetime caches isolated', async () => {
        const accountA = createAccountLifetimeFixture('account-a');
        const accountB = createAccountLifetimeFixture('account-b');
        let releaseAccountA!: (value: { success: boolean; stdout: string }) => void;
        machineRipgrepMock
            .mockImplementationOnce(() => new Promise((resolve) => {
                releaseAccountA = resolve;
            }))
            .mockResolvedValueOnce({ success: true, stdout: 'src/account-b.ts\n' });

        const mod = await import('./workspaceFileSearch');
        const pendingAccountA = mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: '',
            limit: 50,
            accountLifetime: accountA,
        });
        await vi.waitFor(() => expect(machineRipgrepMock).toHaveBeenCalledTimes(1));

        await expect(mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: '',
            limit: 50,
            accountLifetime: accountB,
        })).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ fullPath: 'src/account-b.ts' }),
        ]));

        releaseAccountA({ success: true, stdout: 'src/account-a.ts\n' });
        await expect(pendingAccountA).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ fullPath: 'src/account-a.ts' }),
        ]));

        await expect(mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: '',
            limit: 50,
            accountLifetime: accountB,
        })).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ fullPath: 'src/account-b.ts' }),
        ]));
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);
    });

    it('retires only the affected Account lifetime cache partition', async () => {
        const accountA = createAccountLifetimeFixture('account-a');
        const accountB = createAccountLifetimeFixture('account-b');
        machineRipgrepMock
            .mockResolvedValueOnce({ success: true, stdout: 'src/account-a.ts\n' })
            .mockResolvedValueOnce({ success: true, stdout: 'src/account-b.ts\n' });

        const mod = await import('./workspaceFileSearch');
        await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', accountLifetime: accountA });
        await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', accountLifetime: accountB });

        accountA.retire();
        await expect(mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: '',
            accountLifetime: accountA,
        })).rejects.toMatchObject({ code: 'WORKSPACE_FILE_SEARCH_UNAVAILABLE' });
        await expect(mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: '',
            accountLifetime: accountB,
        })).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ fullPath: 'src/account-b.ts' }),
        ]));
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);
    });

    it('clears one workspace from every valid Account lifetime partition', async () => {
        const accountA = createAccountLifetimeFixture('account-a');
        const accountB = createAccountLifetimeFixture('account-b');
        machineRipgrepMock
            .mockResolvedValueOnce({ success: true, stdout: 'src/account-a-before.ts\n' })
            .mockResolvedValueOnce({ success: true, stdout: 'src/account-b-before.ts\n' })
            .mockResolvedValueOnce({ success: true, stdout: 'src/account-a-after.ts\n' })
            .mockResolvedValueOnce({ success: true, stdout: 'src/account-b-after.ts\n' });

        const mod = await import('./workspaceFileSearch');
        await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', accountLifetime: accountA });
        await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', accountLifetime: accountB });

        mod.workspaceFileSearchCache.clearCache(SCOPE_A);

        await expect(mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: '',
            accountLifetime: accountA,
        })).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ fullPath: 'src/account-a-after.ts' }),
        ]));
        await expect(mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: '',
            accountLifetime: accountB,
        })).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ fullPath: 'src/account-b-after.ts' }),
        ]));
        expect(machineRipgrepMock).toHaveBeenCalledTimes(4);
    });

    it('throws a typed unavailable error only when ripgrep and directory traversal both fail', async () => {
        machineRipgrepMock.mockResolvedValue({ success: false, stdout: '', stderr: 'missing', exitCode: 127 });
        machineFilesystemListDirectoryMock.mockResolvedValue({ ok: false });

        const mod = await import('./workspaceFileSearch');
        await expect(mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 50 }))
            .rejects.toMatchObject({ code: 'WORKSPACE_FILE_SEARCH_UNAVAILABLE' });
    });

    it('returns a successful empty result when directory traversal answers with an empty workspace', async () => {
        machineRipgrepMock.mockResolvedValue({ success: false, stdout: '', stderr: 'missing', exitCode: 127 });
        machineFilesystemListDirectoryMock.mockResolvedValue({ ok: true, entries: [] });

        const mod = await import('./workspaceFileSearch');
        await expect(mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 50 })).resolves.toEqual([]);
        await expect(mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 50 })).resolves.toEqual([]);
        expect(machineRipgrepMock).toHaveBeenCalledTimes(1);
        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledTimes(1);
    });

    it('returns a successful empty result from ripgrep without consulting traversal', async () => {
        machineRipgrepMock.mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });

        const mod = await import('./workspaceFileSearch');
        await expect(mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 50 })).resolves.toEqual([]);
        await expect(mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 50 })).resolves.toEqual([]);
        expect(machineRipgrepMock).toHaveBeenCalledTimes(1);
        expect(machineFilesystemListDirectoryMock).not.toHaveBeenCalled();
    });

    it('preserves a successful directory fallback when ripgrep is unavailable', async () => {
        activeAccountLifetime = createAccountLifetimeFixture('account-a');
        machineRipgrepMock.mockResolvedValue({ success: false, stdout: '', stderr: 'missing', exitCode: 127 });
        machineFilesystemListDirectoryMock.mockResolvedValueOnce({
            ok: true,
            entries: [{ name: 'README.md', type: 'file' }],
        });

        const mod = await import('./workspaceFileSearch');
        await expect(mod.searchWorkspaceFiles({ scope: SCOPE_A, query: 'readme', limit: 50 }))
            .resolves.toEqual([expect.objectContaining({ fullPath: 'README.md', fileType: 'file' })]);
        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledWith(
            'm1',
            { path: '/repo', includeFiles: true },
            { serverId: 'server-a', accountId: 'account-a' },
        );
    });

    it('applies the requested result type before the row limit without removing folders from the shared corpus', async () => {
        machineRipgrepMock.mockResolvedValue({
            success: true,
            stdout: 'alpha/one.ts\nalpha/two.ts\nalpha/three.ts\n',
            stderr: '',
            exitCode: 0,
        });

        const mod = await import('./workspaceFileSearch');
        const filesOnly = await mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: 'alpha',
            limit: 2,
            resultType: 'file',
        });
        expect(filesOnly).toHaveLength(2);
        expect(filesOnly.every((entry) => entry.fileType === 'file')).toBe(true);

        const sharedCorpus = await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: '', limit: 20 });
        expect(sharedCorpus.some((entry) => entry.fileType === 'folder')).toBe(true);
    });

    it('indexes hidden paths consistently in the initial ripgrep and directory fallback corpora', async () => {
        machineRipgrepMock.mockResolvedValueOnce({ success: true, stdout: '.github/workflows/ci.yml\n' });

        const mod = await import('./workspaceFileSearch');
        await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: 'ci', limit: 20 });
        expect(machineRipgrepMock).toHaveBeenCalledWith(
            'm1',
            { rootPath: '/repo', includeHidden: true, limit: 5000 },
            expect.objectContaining({ serverId: 'server-a' }),
        );

        machineRipgrepMock.mockResolvedValueOnce({ success: false, stdout: '', stderr: 'missing', exitCode: 127 });
        machineFilesystemListDirectoryMock
            .mockResolvedValueOnce({
                ok: true,
                entries: [
                    { name: '.git', type: 'directory' },
                    { name: '.github', type: 'directory' },
                ],
            })
            .mockResolvedValueOnce({ ok: true, entries: [{ name: 'ci.yml', type: 'file' }] });
        const hiddenFallback = await mod.searchWorkspaceFiles({
            scope: { ...SCOPE_A, rootPath: '/fallback' },
            query: 'ci',
            limit: 20,
            resultType: 'file',
        });
        expect(hiddenFallback).toEqual([expect.objectContaining({ fullPath: '.github/ci.yml' })]);
        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledTimes(2);
    });

    /**
     * The index is filed under the scope it was READ through. Two scopes differing only by
     * `serverId` name two different worktrees, so they must build two indexes and neither may
     * be served the other's files.
     *
     * The glob fallback is deliberately starved (empty stdout) so it cannot mask a shared
     * index: without that, B's miss on A's index silently falls through to a per-keystroke
     * glob that returns B's files anyway, and the test passes under the very regression it
     * exists to catch. Asserted two independent ways — the INDEX-BUILD calls (`--files`
     * without `--iglob`) must be one per server, and B must not see A's file.
     */
    it('indexes files via ripgrep and caches per workspace scope, keeping two servers apart', async () => {
        machineRipgrepMock.mockImplementation((
            _machineId: string,
            input: Readonly<{ query?: string }>,
            options: Readonly<{ serverId?: string | null }> | undefined,
        ) => Promise.resolve({
            success: true,
            stdout: input.query
                ? ''
                : options?.serverId === 'server-b' ? 'src/beta.ts\n' : 'src/alpha.ts\nREADME.md\n',
            stderr: '',
            exitCode: 0,
        }));

        const mod = await import('./workspaceFileSearch');
        const indexBuildServerIds = () => machineRipgrepMock.mock.calls
            .filter((call) => !(call[1] as Readonly<{ query?: string }>).query)
            .map((call) => (call[2] as Readonly<{ serverId?: string | null }> | undefined)?.serverId);

        const resA1 = await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: 'alpha', limit: 50 });
        expect(resA1.some((r) => r.fullPath === 'src/alpha.ts')).toBe(true);

        const resA2 = await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: 'readme', limit: 50 });
        expect(resA2.some((r) => r.fullPath === 'README.md')).toBe(true);

        // Same workspace should not re-index twice in a row.
        expect(indexBuildServerIds()).toEqual(['server-a']);

        // B asks for a file that exists only in A's worktree. Under a key that ignored
        // `serverId` the two share one index and B would be handed `src/alpha.ts`.
        const resB = await mod.searchWorkspaceFiles({ scope: SCOPE_B, query: 'alpha', limit: 50 });
        expect(resB.some((r) => r.fullPath === 'src/alpha.ts')).toBe(false);
        expect(indexBuildServerIds()).toEqual(['server-a', 'server-b']);

        // ...and B's own file is there, read through B.
        const resBOwn = await mod.searchWorkspaceFiles({ scope: SCOPE_B, query: 'beta', limit: 50 });
        expect(resBOwn.some((r) => r.fullPath === 'src/beta.ts')).toBe(true);
    });

    it('cancels a query-owned index build and never publishes its late files to the shared cache', async () => {
        activeAccountLifetime = createAccountLifetimeFixture('account-a');
        let releaseFirstIndex!: (value: { success: boolean; stdout: string }) => void;
        let callCount = 0;
        machineRipgrepMock.mockImplementation((_machineId: string, input: Readonly<{ query?: string }>) => {
            if (input.query) {
                return Promise.resolve({ success: true, stdout: '' });
            }
            callCount += 1;
            if (callCount === 1) {
                return new Promise<{ success: boolean; stdout: string }>((resolve) => {
                    releaseFirstIndex = resolve;
                });
            }
            return Promise.resolve({ success: true, stdout: 'src/current.ts\n' });
        });

        const mod = await import('./workspaceFileSearch');
        const controller = new AbortController();
        const pending = mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: 'late',
            signal: controller.signal,
        });

        await vi.waitFor(() => expect(machineRipgrepMock).toHaveBeenCalledTimes(1));
        expect(machineRipgrepMock.mock.calls[0]?.[2]).toEqual({
            serverId: 'server-a',
            accountId: 'account-a',
            signal: controller.signal,
        });

        controller.abort();
        releaseFirstIndex({ success: true, stdout: 'src/stale.ts\n' });

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

        const current = await mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: '',
            limit: 50,
        });
        expect(current.some((entry) => entry.fullPath === 'src/current.ts')).toBe(true);
        expect(current.some((entry) => entry.fullPath === 'src/stale.ts')).toBe(false);
        expect(callCount).toBe(2);
    });

    /**
     * The clear path and the fill path must agree on the identity. They no longer pass a key
     * to each other — both derive it from the scope — and this pins that agreement end to end:
     * clearing scope A forces A to re-index while B's index survives untouched.
     */
    it('clears exactly the scope it is given, leaving another server\'s index intact', async () => {
        machineRipgrepMock.mockImplementation((
            _machineId: string,
            _input: Readonly<{ query?: string }>,
            options: Readonly<{ serverId?: string | null }> | undefined,
        ) => Promise.resolve({
            success: true,
            stdout: options?.serverId === 'server-b' ? 'src/only-on-b.ts\n' : 'src/a.ts\n',
            stderr: '',
            exitCode: 0,
        }));

        const mod = await import('./workspaceFileSearch');

        await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: 'a', limit: 50 });
        await mod.searchWorkspaceFiles({ scope: SCOPE_B, query: 'only-on-b', limit: 50 });
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);

        mod.workspaceFileSearchCache.clearCache(SCOPE_A);

        // A lost its index and rebuilds it...
        const afterClearA = await mod.searchWorkspaceFiles({ scope: SCOPE_A, query: 'a', limit: 50 });
        expect(afterClearA.some((r) => r.fullPath === 'src/a.ts')).toBe(true);
        expect(machineRipgrepMock).toHaveBeenCalledTimes(3);

        // ...while B was never touched, so it is still served from cache.
        const afterClearB = await mod.searchWorkspaceFiles({ scope: SCOPE_B, query: 'only-on-b', limit: 50 });
        expect(afterClearB.some((r) => r.fullPath === 'src/only-on-b.ts')).toBe(true);
        expect(machineRipgrepMock).toHaveBeenCalledTimes(3);
    });

    // The targeted glob runs against the whole worktree, so its output is attacker-
    // adjacent in size: a broad query on a large repo can return tens of thousands of
    // paths, every one of which would otherwise be turned into item objects, pushed
    // into the long-lived workspace cache and re-indexed by Fuse. The bound is
    // `Math.max(50, limit * 5)` — a floor so a small limit still discovers enough to
    // rank, and a multiple of the caller's limit so a large limit is still served.
    // Both terms are asserted, because a bare constant would pass a floor-only test.
    it('bounds how many glob-fallback paths it ingests, by both the floor and the limit multiple', async () => {
        const indexStdout = 'src/index.ts\n';
        const globStdout = Array.from({ length: 400 }, (_, i) => `pkg/zeta-${String(i).padStart(3, '0')}.ts`).join('\n') + '\n';

        machineRipgrepMock.mockImplementation((_machineId: string, input: Readonly<{ query?: string }>) => {
            const isGlob = Boolean(input.query);
            return Promise.resolve({
                success: true,
                stdout: isGlob ? globStdout : indexStdout,
                stderr: '',
                exitCode: 0,
            });
        });

        const mod = await import('./workspaceFileSearch');

        // Reads back the whole cache: an empty query short-circuits to `cache.files`
        // without issuing another ripgrep call.
        const countIngestedZetaFiles = async (rootPath: string): Promise<number> => {
            const all = await mod.searchWorkspaceFiles({
                scope: { serverId: 'server-a', machineId: 'm1', rootPath },
                query: '',
                limit: 1000,
            });
            return all.filter((entry) => entry.fileType === 'file' && entry.fileName.startsWith('zeta-')).length;
        };

        // limit 4 → max(50, 20) = 50: the floor decides.
        const floorResults = await mod.searchWorkspaceFiles({
            scope: { serverId: 'server-a', machineId: 'm1', rootPath: '/repo-floor' },
            query: 'zeta',
            limit: 4,
        });
        // The fallback must actually have run, or the bound below proves nothing.
        expect(machineRipgrepMock.mock.calls.some((call) => Boolean((call[1] as Readonly<{ query?: string }>).query))).toBe(true);
        expect(floorResults.length).toBe(4);
        expect(await countIngestedZetaFiles('/repo-floor')).toBe(50);

        // limit 20 → max(50, 100) = 100: the caller's limit decides.
        await mod.searchWorkspaceFiles({
            scope: { serverId: 'server-a', machineId: 'm1', rootPath: '/repo-multiple' },
            query: 'zeta',
            limit: 20,
        });
        expect(await countIngestedZetaFiles('/repo-multiple')).toBe(100);
    });

    // The glob fallback is a per-keystroke worktree scan. Merging what it found back
    // into the cache is only half the fix: unless the Fuse index is rebuilt over the
    // grown file list, the next identical query still misses the index and pays for
    // another scan. The observable contract is therefore "no second RPC", not "the
    // file is in the array".
    it('re-indexes glob-discovered files so an identical repeat query is served without another scan', async () => {
        // Deliberately unlimited: a regression must fail on the call-count assertion
        // below, not by running out of queued mock responses.
        machineRipgrepMock.mockImplementation((_machineId: string, input: Readonly<{ query?: string }>) => Promise.resolve({
            success: true,
            stdout: input.query
                ? '.github/workflows/publish-github-release.yml\n'
                : 'src/index.ts\n',
            stderr: '',
            exitCode: 0,
        }));

        const mod = await import('./workspaceFileSearch');

        const search = () => mod.searchWorkspaceFiles({
            scope: { serverId: 'server-a', machineId: 'm1', rootPath: '/repo-reindex' },
            query: 'publish-github-release',
            limit: 50,
        });

        const first = await search();
        expect(first.some((r) => r.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);
        // One index build + one targeted glob.
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);

        const second = await search();
        expect(second.some((r) => r.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);
        // Served from the rebuilt index — a third call would mean the merge did not
        // reach Fuse. (No third mock response is queued, so a regression also surfaces
        // as a miss rather than a silent pass.)
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);
    });

    it('queries the complete workspace when a truncated cache has only a weak local match', async () => {
        machineRipgrepMock
            .mockResolvedValueOnce({
                ok: true,
                paths: ['src/needle-ish.ts'],
                truncated: true,
            })
            .mockResolvedValueOnce({
                ok: true,
                paths: ['packages/exact-needle.ts'],
                truncated: false,
            });

        const mod = await import('./workspaceFileSearch');
        const page = await mod.searchWorkspaceFiles({
            scope: SCOPE_A,
            query: 'needle',
            limit: 20,
            resultType: 'file',
            includeCoverage: true,
        });

        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);
        expect(machineRipgrepMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ query: 'needle' }));
        expect(page.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ fullPath: 'packages/exact-needle.ts' }),
        ]));
        expect(page.corpusTruncated).toBe(true);
        expect(page.hasMore).toBe(true);
    });

    it('retains targeted-query truncation so repeated queries do not report complete coverage', async () => {
        machineRipgrepMock
            .mockResolvedValueOnce({
                ok: true,
                paths: ['src/index.ts'],
                truncated: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                paths: ['packages/exact-needle.ts'],
                truncated: true,
            });

        const mod = await import('./workspaceFileSearch');
        const input = {
            scope: SCOPE_A,
            query: 'needle',
            limit: 20,
            resultType: 'file' as const,
            includeCoverage: true as const,
        };

        const first = await mod.searchWorkspaceFiles(input);
        expect(first.corpusTruncated).toBe(true);
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);

        const second = await mod.searchWorkspaceFiles(input);
        expect(second.corpusTruncated).toBe(true);
        // The retained truncation forces the existing bounded query path to run
        // again; a false-complete cache would stop at the Fuse result here.
        expect(machineRipgrepMock).toHaveBeenCalledTimes(3);
    });

    it('reports page overflow independently of a complete filename corpus', async () => {
        machineRipgrepMock.mockResolvedValue({ ok: true, paths: ['src/needle.ts', 'src/needle.test.ts'], truncated: false });
        const { searchWorkspaceFiles } = await import('./workspaceFileSearch');
        const page = await searchWorkspaceFiles({ scope: SCOPE_A, query: 'needle', resultType: 'file', limit: 1, includeCoverage: true });
        expect(page.items).toHaveLength(1);
        expect(page.corpusTruncated).toBe(false);
        expect(page.hasMore).toBe(true);
    });

    it('queries globs directly without warming or contaminating the workspace fuzzy corpus', async () => {
        machineRipgrepMock
            .mockResolvedValueOnce({ ok: true, paths: ['nested/needle.ts'], truncated: true })
            .mockResolvedValueOnce({ ok: true, paths: ['current.ts'], truncated: false });
        const { searchWorkspaceFiles } = await import('./workspaceFileSearch');
        const controller = new AbortController();
        const page = await searchWorkspaceFiles({ scope: SCOPE_A, mode: 'glob', query: '*.ts', includeHidden: false,
            signal: controller.signal, includeCoverage: true });
        expect(machineRipgrepMock).toHaveBeenCalledTimes(1);
        expect(machineRipgrepMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ query: '*.ts', includeHidden: false }));
        expect(machineRipgrepMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ serverId: 'server-a', signal: controller.signal }));
        expect(page.items.map((item) => item.fullPath)).toEqual(['nested/needle.ts', 'nested/']);
        expect(page.corpusTruncated).toBe(true);
        expect(page.hasMore).toBe(true);
        const fuzzy = await searchWorkspaceFiles({ scope: SCOPE_A, query: '', resultType: 'file' });
        expect(fuzzy.map((item) => item.fullPath)).toEqual(['current.ts']);
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);
    });

    /**
     * A workspace is addressed by `{ serverId, machineId, rootPath }` — all three, because a
     * machine id is only unique within the server that reaches it. `serverId` already keys the
     * cache and already routes the directory fallback, so dropping it on the *ripgrep* path is
     * silent: the entries look right and land under the right key, but they were read through
     * whichever server `machineRpcWithServerScope` falls back to when handed no scope.
     *
     * That is reachable from the new-session composer, whose whole point is declaring a spawn
     * server that is deliberately NOT the active one. Both ripgrep calls are asserted, because
     * the index build and the per-keystroke glob are separate call sites and fixing one would
     * leave the other addressing the wrong server.
     */
    it('routes both ripgrep calls through the server the workspace is addressed to', async () => {
        machineRipgrepMock.mockImplementation((_machineId: string, input: Readonly<{ query?: string }>) => Promise.resolve({
            success: true,
            stdout: input.query ? 'pkg/needle-file.ts\n' : 'src/index.ts\n',
            stderr: '',
            exitCode: 0,
        }));

        const mod = await import('./workspaceFileSearch');

        const results = await mod.searchWorkspaceFiles({
            scope: SCOPE_B,
            query: 'needle-file',
            limit: 50,
        });
        expect(results.some((r) => r.fullPath === 'pkg/needle-file.ts')).toBe(true);

        // One index build plus one targeted glob, so both call sites are covered here.
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);
        for (const call of machineRipgrepMock.mock.calls) {
            const [machineId, input, options] = call as [
                string,
                Readonly<{ rootPath: string }>,
                Readonly<{ serverId?: string | null }> | undefined,
            ];
            expect(machineId).toBe('m1');
            expect(input.rootPath).toBe('/repo');
            expect(options?.serverId).toBe('server-b');
        }
    });
});
