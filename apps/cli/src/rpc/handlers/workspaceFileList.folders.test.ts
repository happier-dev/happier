import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonWorkspaceFileListResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';

// The filesystem is the boundary: count directory reads, keep every read real.
const fsReads = vi.hoisted(() => ({ readdir: 0 }));
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return { ...actual, readdir: ((...args: Parameters<typeof actual.readdir>) => {
        fsReads.readdir += 1;
        return actual.readdir(...args);
    }) as typeof actual.readdir };
});

import { registerWorkspaceFileListHandler } from './workspaceFileList';

function createHandler(): RpcHandler {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
    registerWorkspaceFileListHandler(registrar, '/daemon');
    return handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST)!;
}

/**
 * Folder pickers search folder names. A file walk can never return an empty folder, and on a large
 * home it spends the whole budget before it reaches a shallow match (QA-BREADTH Q11).
 */
describe('workspace file list: folder results', () => {
    let root: string | undefined;
    afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

    async function seed(): Promise<string> {
        root = await mkdtemp(join(tmpdir(), 'workspace-folder-list-'));
        await mkdir(join(root, 'p03-join2'));
        // A large, deep tree beside the match: 40 folders × 3 levels, one deep same-named folder.
        for (let index = 0; index < 40; index += 1) await mkdir(join(root, `big-${index}`, 'a', 'b'), { recursive: true });
        await mkdir(join(root, 'big-7', 'a', 'b', 'p03-join2-deep'));
        await writeFile(join(root, 'big-7', 'a', 'file-p03-join2.txt'), 'x');
        for (const excluded of ['node_modules', '.git']) await mkdir(join(root, excluded, 'p03-join2'), { recursive: true });
        return root;
    }

    it('finds an empty shallow folder by name and stops at the shallowest matching level', async () => {
        const rootPath = await seed();
        fsReads.readdir = 0;
        const response = DaemonWorkspaceFileListResponseSchema.parse(await createHandler()({
            rootPath, query: 'p03-join2', resultType: 'folder', includeHidden: true,
        }));
        expect(response).toEqual({ ok: true, paths: ['p03-join2/'], truncated: true });
        // One read of the root found the match; the 160 folders below were never listed.
        expect(fsReads.readdir).toBe(1);
    });

    it('lists only direct children within maxDepth, case-insensitively, without claiming more', async () => {
        const rootPath = await seed();
        fsReads.readdir = 0;
        const response = DaemonWorkspaceFileListResponseSchema.parse(await createHandler()({
            rootPath, query: 'BIG-1', resultType: 'folder', maxDepth: 1,
        }));
        expect(response.ok && [...response.paths].sort()).toEqual(
            ['big-1/', ...Array.from({ length: 10 }, (_, index) => `big-1${index}/`)].sort());
        expect(response).toMatchObject({ truncated: false });
        expect(fsReads.readdir).toBe(1);
    });

    it('reaches a deep folder when no shallower folder matches', async () => {
        const rootPath = await seed();
        const response = DaemonWorkspaceFileListResponseSchema.parse(await createHandler()({
            rootPath, query: 'join2-deep', resultType: 'folder',
        }));
        // Its own children are still unread, so deeper matches stay possible.
        expect(response).toEqual({ ok: true, paths: ['big-7/a/b/p03-join2-deep/'], truncated: true });
    });

    it('reports a missing root as root_not_found', async () => {
        const response = await createHandler()({ rootPath: join(tmpdir(), 'workspace-folder-list-missing-0'), query: 'x', resultType: 'folder' });
        expect(response).toEqual({ ok: false, errorCode: 'root_not_found' });
    });
});
