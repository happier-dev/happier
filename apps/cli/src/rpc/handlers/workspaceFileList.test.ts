import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonWorkspaceFileListResponseSchema, DaemonWorkspaceFileSearchResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { createFilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { logger } from '@/ui/logger';
import { registerSessionHandlers } from './registerSessionHandlers';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';

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
    it('retains more than 5000 paths and a corpus above the old tunnel-frame limit', async () => {
        const paths = Array.from({ length: 6000 }, (_, index) => `src/${String(index).padStart(5, '0')}-${'component'.repeat(8)}.ts`);
        runRipgrepMock.mockResolvedValue({ exitCode: 0, stdout: `${paths.join('\n')}\n`, stderr: '' });
        const result = DaemonWorkspaceFileListResponseSchema.parse(await createHandler()({ rootPath: '/repo' }));
        expect(result).toEqual({ ok: true, paths, truncated: false });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(300 * 1024);
    });
    it('preserves filesystem admission cause through registered workspace readers without running native search', async () => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'workspace-reasons', encryptionMode: 'plain' });
        const registration = registerSessionHandlers(rpc, '/workspace', { filesystemEffectAdmission: createFilesystemEffectAdmission() });
        try {
            for (const [method, schema, codeField] of [
                [RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, DaemonWorkspaceFileListResponseSchema, 'errorCode'],
                [RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, DaemonWorkspaceFileSearchResponseSchema, 'code'],
            ] as const) {
                const response = schema.parse(await rpc.handleRequest({ method: `workspace-reasons:${method}`,
                    params: { rootPath: '/workspace', query: 'needle' } }));
                expect(response).toMatchObject({ ok: false, [codeField]: 'filesystem_identity_custody_unavailable',
                    details: { reason: 'requester_identity_unavailable' } });
            }
            expect(runRipgrepMock).not.toHaveBeenCalled();
        } finally { await registration.dispose(); }
    });
    let fixtureRoot: string | undefined;
    let deniedDirectory: string | undefined;
    beforeEach(() => runRipgrepMock.mockReset());
    afterEach(async () => {
        vi.unstubAllGlobals();
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

    it.skipIf(process.platform === 'win32')('retains sparse native output while an ignore-file read stalls traversal', async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'workspace-file-list-'));
        await writeFile(join(fixtureRoot, 'needle.txt'), 'fixture');
        const slow = join(fixtureRoot, 'needle-slow');
        await mkdir(slow);
        // A pipe at the native ignore-file boundary makes traversal stay pending
        // after its readable sibling, without mocking internal search logic.
        await promisify(execFile)('mkfifo', [join(slow, '.ignore')]);
        const { run } = await vi.importActual<typeof import('@/integrations/ripgrep/index')>('@/integrations/ripgrep/index');
        const native = await run(['--files', '--line-buffered', '--threads', '1', join(fixtureRoot, 'needle.txt'), slow], {
            deadlineAtMs: Date.now() + 1_000,
        });
        expect(native.stdout).toContain(join(fixtureRoot, 'needle.txt'));
        runRipgrepMock.mockImplementation(run);
        // Assert the consumed filename operation, not a particular native output
        // mode: a framing correction can fix the owner without changing
        // upstream --null buffering. Registration and strict consumer stay real.
        const machine = await createInstalledFilesystemMachineFixture();
        try {
            const response = await machine.invoke(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST,
                { rootPath: fixtureRoot, query: 'needle', budgetMs: 1_000 });
            expect(DaemonWorkspaceFileListResponseSchema.parse(response)).toEqual({
                ok: true, paths: ['needle.txt'], truncated: true,
            });
        } finally {
            await machine.machine.shutdown();
        }
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

            const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
            const machine = await createInstalledFilesystemMachineFixture();
            try {
                const readableResponse = await machine.invoke(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST,
                    { rootPath: fixtureRoot, query: 'needle' });
                expect(DaemonWorkspaceFileListResponseSchema.parse(readableResponse)).toEqual({
                    ok: true, paths: ['needle.txt'], truncated: true,
                });
                const response = await machine.invoke(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST,
                    { rootPath: fixtureRoot, query: 'absent' });
                expect(DaemonWorkspaceFileListResponseSchema.parse(response)).toEqual({
                    ok: true, paths: [], truncated: true,
                });
                expect(diagnostics.mock.calls).toContainEqual(['[WORKSPACE FILE LIST] Traversal incomplete', {
                    exitCode: 2, osErrorCodes: [13],
                }]);
                expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(fixtureRoot);
            } finally {
                await machine.machine.shutdown();
                diagnostics.mockRestore();
            }
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
        runRipgrepMock.mockResolvedValue({ exitCode: 0, stdout: 'src/a.ts\n', stderr: '' });

        await expect(handler(
            { rootPath: '/repo', query: 'a', includeHidden: true, limit: 50 },
            { signal: controller.signal },
        )).resolves.toEqual({ ok: true, paths: ['src/a.ts'], truncated: false });
        expect(runRipgrepMock).toHaveBeenCalledWith(
            [
                '--no-config',
                '--files',
                '--hidden',
                '--line-buffered',
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

    it.each([false, true])('returns only complete paths even when stdoutTruncated is %s', async (stdoutTruncated) => {
        const handler = createHandler();
        runRipgrepMock.mockResolvedValue({
            exitCode: 0,
            stdout: 'first.ts\nsecond-incomplete',
            stderr: '',
            stdoutTruncated,
        });

        await expect(handler({ rootPath: '/repo' })).resolves.toEqual({
            ok: true,
            paths: ['first.ts'],
            truncated: true,
        });
    });

    it.each(['win32', 'linux'])('handles CRLF framing on %s without stripping a POSIX filename character', async (platform) => {
        vi.stubGlobal('process', { ...process, platform });
        runRipgrepMock.mockResolvedValue({ exitCode: 0, stdout: 'src/a.ts\r\n', stderr: '' });

        await expect(createHandler()({ rootPath: '/repo' })).resolves.toEqual({
            ok: true, paths: [platform === 'win32' ? 'src/a.ts' : 'src/a.ts\r'], truncated: false,
        });
    });
});
