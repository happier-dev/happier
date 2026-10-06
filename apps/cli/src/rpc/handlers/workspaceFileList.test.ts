import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const runRipgrepMock = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/ripgrep/index', () => ({
    run: (...args: unknown[]) => runRipgrepMock(...args),
}));

import { registerWorkspaceFileListHandler } from './workspaceFileList';

function createHandler(): RpcHandler {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
    registerWorkspaceFileListHandler(registrar, '/daemon');
    const handler = handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST);
    if (!handler) throw new Error('workspace file-list handler was not registered');
    return handler;
}

describe('registerWorkspaceFileListHandler', () => {
    let fixtureRoot: string | undefined;
    let deniedDirectory: string | undefined;
    beforeEach(() => runRipgrepMock.mockReset());
    afterEach(async () => {
        if (deniedDirectory) await chmod(deniedDirectory, 0o700);
        if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
        deniedDirectory = undefined;
        fixtureRoot = undefined;
    });

    it('finds files beneath a matching directory with the real ripgrep path', async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'workspace-file-list-'));
        await mkdir(join(fixtureRoot, 'search-fixture'));
        await writeFile(join(fixtureRoot, 'search-fixture', 'target.txt'), 'fixture');
        for (const excluded of ['node_modules', '.git']) {
            await mkdir(join(fixtureRoot, excluded, 'search-fixture'), { recursive: true });
            await writeFile(join(fixtureRoot, excluded, 'search-fixture', 'target.txt'), 'fixture');
        }
        const { run } = await vi.importActual<typeof import('@/integrations/ripgrep/index')>('@/integrations/ripgrep/index');
        runRipgrepMock.mockImplementation(run);

        await expect(createHandler()({ rootPath: fixtureRoot, query: 'search-fixture' })).resolves.toEqual({
            ok: true, paths: ['search-fixture/target.txt'], truncated: false,
        });
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'retains readable real-ripgrep matches when a sibling directory denies traversal', async () => {
            fixtureRoot = await mkdtemp(join(tmpdir(), 'workspace-file-list-'));
            await writeFile(join(fixtureRoot, 'needle.txt'), 'fixture');
            deniedDirectory = join(fixtureRoot, 'denied');
            await mkdir(deniedDirectory);
            await writeFile(join(deniedDirectory, 'hidden.txt'), 'fixture');
            await chmod(deniedDirectory, 0);
            const { run } = await vi.importActual<typeof import('@/integrations/ripgrep/index')>('@/integrations/ripgrep/index');
            const observed = await run(['--files', '--null', '--iglob', '*needle*'], { cwd: fixtureRoot });
            expect(observed.exitCode).toBe(2);
            expect(observed.stderr).toMatch(/Permission denied/);
            expect(observed.stdout).toBe('needle.txt\0');
            runRipgrepMock.mockImplementation(run);

            await expect(createHandler()({ rootPath: fixtureRoot, query: 'needle' })).resolves.toEqual({
                ok: true, paths: ['needle.txt'], truncated: true,
            });
            await expect(createHandler()({ rootPath: fixtureRoot, query: 'absent' })).resolves.toEqual({
                ok: false, errorCode: 'ripgrep_failed', exitCode: 2,
            });
        },
    );

    it('rejects raw argv and cwd instead of forwarding caller-controlled process options or paths', async () => {
        const handler = createHandler();

        await expect(handler({ rootPath: '/repo', args: ['--files', '/etc'] })).resolves.toMatchObject({
            ok: false,
            errorCode: 'invalid_request',
        });
        await expect(handler({ rootPath: '/repo', cwd: '/etc' })).resolves.toMatchObject({
            ok: false,
            errorCode: 'invalid_request',
        });
        expect(runRipgrepMock).not.toHaveBeenCalled();
    });

    it('builds the file-search argv at the daemon and forwards cancellation', async () => {
        const handler = createHandler();
        const controller = new AbortController();
        runRipgrepMock.mockResolvedValue({ exitCode: 0, stdout: 'src/a.ts\0', stderr: '' });

        await expect(handler(
            { rootPath: '/repo', query: 'a', includeHidden: true, limit: 50 },
            { signal: controller.signal },
        )).resolves.toEqual({ ok: true, paths: ['src/a.ts'], truncated: false });
        expect(runRipgrepMock).toHaveBeenCalledWith(
            [
                '--no-config',
                '--files',
                '--hidden',
                '--null',
                '--iglob',
                '*a*',
                '--iglob',
                '**/*a*/**',
                '--iglob',
                '!**/.git/**',
                '--iglob',
                '!**/node_modules/**',
            ],
            expect.objectContaining({
                cwd: '/repo',
                signal: controller.signal,
                maxStdoutBytes: expect.any(Number),
                maxStderrBytes: expect.any(Number),
                terminateOnStdoutLimit: true,
            }),
        );
    });

    it('reports a nonzero ripgrep exit as failure', async () => {
        const handler = createHandler();
        runRipgrepMock.mockResolvedValue({ exitCode: 2, stdout: '', stderr: 'sensitive detail' });

        await expect(handler({ rootPath: '/repo' })).resolves.toEqual({
            ok: false,
            errorCode: 'ripgrep_failed',
            exitCode: 2,
        });
    });

    it('reports unavailable native ripgrep without treating the missing tool as an empty corpus', async () => {
        runRipgrepMock.mockResolvedValue({ exitCode: 127, stdout: '', stderr: '' });
        await expect(createHandler()({ rootPath: '/repo' })).resolves.toEqual({ ok: false, errorCode: 'ripgrep_unavailable' });
    });

    it('treats ripgrep no-results exit 1 as a successful empty workspace result', async () => {
        const handler = createHandler();
        runRipgrepMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

        await expect(handler({ rootPath: '/repo', query: 'absent' })).resolves.toEqual({
            ok: true,
            paths: [],
            truncated: false,
        });
    });

    it('returns bounded complete paths and explicit truncation', async () => {
        const handler = createHandler();
        runRipgrepMock.mockResolvedValue({
            exitCode: 0,
            stdout: 'first.ts\0second-incomplete',
            stderr: '',
            stdoutTruncated: true,
        });

        await expect(handler({ rootPath: '/repo' })).resolves.toEqual({
            ok: true,
            paths: ['first.ts'],
            truncated: true,
        });
    });
});
