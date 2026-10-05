import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    beforeEach(() => runRipgrepMock.mockReset());

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
                '--glob',
                '!**/.git/**',
                '--glob',
                '!**/node_modules/**',
                '--null',
                '--iglob',
                '*a*',
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
