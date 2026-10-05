import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/rpc';
import { DaemonWorkspaceFileSearchResponseSchema, WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol';
import { registerWorkspaceFileSearchHandler } from './workspaceFileSearch';

describe('workspace file content search through the registered daemon owner', () => {
    let root: string;
    let handler: RpcHandler;
    let lifetime: AbortController;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-file-content-'));
        lifetime = new AbortController();
        const handlers = new Map<string, RpcHandler>();
        const registrar: RpcHandlerRegistrar = { registerHandler: (method, next) => { handlers.set(method, next); } };
        registerWorkspaceFileSearchHandler(registrar, root);
        const registered = handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)!;
        handler = (request, context) => registered(request, { signal: lifetime.signal, ...context });
    });
    afterEach(async () => { lifetime.abort(); await rm(root, { recursive: true, force: true }); });

    it('finds literal metacharacters by default, case insensitively, with UTF-16 positions and CRLF context', async () => {
        await writeFile(join(root, 'a.txt'), 'before\r\né😀 A.B A.B\r\nafter\r\n');
        const result = await handler({ rootPath: root, query: 'a.b', contextLines: 2 });
        expect(result).toEqual({ ok: true, coverage: 'complete', hasMore: false, files: [{ path: 'a.txt', matches: [
            { line: 2, column16: 5, length16: 3, text: 'é😀 A.B A.B', before: ['before'], after: ['after'] },
            { line: 2, column16: 9, length16: 3, text: 'é😀 A.B A.B', before: ['before'], after: ['after'] },
        ] }] });
        expect(DaemonWorkspaceFileSearchResponseSchema.safeParse(result).success).toBe(true);
    });

    it('supports regex and case-sensitive queries, keeps exclusions and reports invalid regex distinctly', async () => {
        await writeFile(join(root, 'a.txt'), 'abc A.B\n');
        await mkdir(join(root, 'node_modules'));
        await writeFile(join(root, 'node_modules', 'ignored.txt'), 'abc\n');
        expect(await handler({ rootPath: root, query: 'a.c', regex: true, matchCase: true, contextLines: 0 }))
            .toMatchObject({ ok: true, coverage: 'complete', files: [{ path: 'a.txt', matches: [{ text: 'abc A.B', column16: 1 }] }] });
        expect(await handler({ rootPath: root, query: '[' })).toMatchObject({ ok: true, files: [] });
        expect(await handler({ rootPath: root, query: '[', regex: true })).toMatchObject({ ok: false, code: 'invalid_pattern' });
    });

    it('returns one bounded partial page at a complete file boundary, omitting oversized files whole', async () => {
        const content = `${'needle '.repeat(3000)}\n`;
        await mkdir(join(root, 'a'));
        await writeFile(join(root, 'a.txt'), content);
        await writeFile(join(root, 'a', 'file.txt'), content);
        // Each file has one hit record with many submatches, too large alone. It is omitted whole.
        await writeFile(join(root, 'c.txt'), 'needle\n');
        const result = DaemonWorkspaceFileSearchResponseSchema.parse(await handler({ rootPath: root, query: 'needle' }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES);
        expect(result.coverage).toBe('partial');
        expect(result.files.map((file) => file.path)).toEqual(['c.txt']);
        expect(result.hasMore).toBe(false);

        await writeFile(join(root, 'a.txt'), `${'needle\n'.repeat(1700)}`);
        await writeFile(join(root, 'a', 'file.txt'), `${'needle\n'.repeat(1700)}`);
        const first = DaemonWorkspaceFileSearchResponseSchema.parse(await handler({ rootPath: root, query: 'needle', contextLines: 0 }));
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.hasMore).toBe(true);
        expect(first.coverage).toBe('partial');
        const includedLargeFiles = first.files.filter((file) => file.path !== 'c.txt');
        expect(includedLargeFiles).toHaveLength(1);
        expect(['a.txt', 'a/file.txt']).toContain(includedLargeFiles[0].path);
        expect(includedLargeFiles[0].matches).toHaveLength(1700);
        expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES);
    });

    it('skips non-UTF-8 lines with partial coverage and never converts a byte bag to text', async () => {
        await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff, ...Buffer.from(' needle\n')]));
        await writeFile(join(root, 'text.txt'), 'needle\n');
        expect(await handler({ rootPath: root, query: 'needle' })).toMatchObject({
            ok: true, coverage: 'partial', files: [{ path: 'text.txt' }], hasMore: false,
        });
    });

    it('reports partial coverage when a binary file stops at its native binary offset', async () => {
        await writeFile(join(root, 'binary.bin'), Buffer.from('needle\0opaque\n'));
        expect(await handler({ rootPath: root, query: 'needle' })).toMatchObject({ ok: true, coverage: 'partial', hasMore: false });
    });

    it('skips byte-oriented regex hits that have no valid UTF-16 character range', async () => {
        await writeFile(join(root, 'unicode.txt'), 'é needle\n');
        expect(await handler({ rootPath: root, query: '(?-u:\\xA9)', regex: true }))
            .toEqual({ ok: true, files: [], coverage: 'partial', hasMore: false });
    });

    it('enforces root policy, rejects caller argv, and propagates cancellation', async () => {
        const restricted = new Map<string, RpcHandler>();
        registerWorkspaceFileSearchHandler({ registerHandler: (method, next) => { restricted.set(method, next); } }, root,
            { accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
        const invoke = restricted.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)!;
        expect(await invoke({ rootPath: '/not-allowed', query: 'needle' })).toMatchObject({ ok: false, code: 'root_not_allowed' });
        expect(await handler({ rootPath: root, query: 'needle', args: ['--files'] })).toMatchObject({ ok: false, code: 'ripgrep_failed' });
        const controller = new AbortController();
        controller.abort();
        await expect(handler({ rootPath: root, query: 'needle' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        // Workspace operations are Machine-owned, not Session transcript authority.
        expect(resolveSocketRpcSessionAuthorization(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)).toBeNull();
    });
});
