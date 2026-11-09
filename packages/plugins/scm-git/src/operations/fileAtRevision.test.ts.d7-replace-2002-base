import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScmFileAtRevisionRequest } from '@happier-dev/plugin-sdk/scm';
import { resolveBackendCommandMaxOutputBytes } from '@happier-dev/plugin-sdk/scm/backend';

import { createGitScmBackendRuntimeRegistration } from '../backend.js';
import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let root: string;
const roots: string[] = [];
const expected = (bytes: Buffer) => ({ success: true, contentBase64: bytes.toString('base64'), sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });

async function read(request: Omit<ScmFileAtRevisionRequest, 'cwd'>, cwd = root) {
    const handler = createGitScmBackendRuntimeRegistration().handlers.read?.fileAtRevision;
    expect(handler, 'Git must register a real base-revision byte reader').toBeTypeOf('function');
    if (!handler) throw new Error('Missing base-revision byte reader');
    return runWithRealGitScmRuntime(() => handler({ context: { cwd, projectKey: root,
        detection: { isRepo: true, rootPath: root, mode: '.git' } }, request: { ...request, cwd }, signal: new AbortController().signal }));
}

describe('Git file-at-revision bytes through backend registration and the real process boundary', () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-file-at-revision-'));
        roots.push(root);
        git(root, ['init', '--quiet']);
        git(root, ['config', 'user.name', 'Blob Fixture']);
        git(root, ['config', 'user.email', 'blob@example.test']);
        git(root, ['config', 'core.autocrlf', 'false']);
    });
    afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

    it('distinguishes HEAD, index and working-tree bytes, preserving binary bytes and full SHA256', async () => {
        const path = 'photo.bin';
        const committed = Buffer.from([0, 255, 128, 13, 10, 1]);
        const staged = Buffer.from([0, 254, 129, 10, 2]);
        await writeFile(join(root, path), committed);
        git(root, ['add', '--', path]);
        git(root, ['commit', '--quiet', '-m', 'before']);
        const blobId = git(root, ['rev-parse', 'HEAD:photo.bin']);
        await writeFile(join(root, path), staged);
        git(root, ['add', '--', path]);
        await writeFile(join(root, path), 'working tree differs');
        expect(await read({ path, selector: { side: 'before', area: 'pending' } })).toEqual(expected(staged));
        for (const area of ['included', 'both'] as const) {
            expect(await read({ path, selector: { side: 'before', area } })).toEqual(expected(committed));
        }
        expect(await read({ path, selector: { blobId } })).toEqual(expected(committed));
    });

    it('uses literal repository-root paths, including magic, whitespace and leading dashes', async () => {
        await mkdir(join(root, 'sub'));
        const paths = ['[one].bin', '-dash.bin', 'space .bin', 'sub/nested.bin',
            ...(process.platform === 'win32' ? [] : ['[one]*?.bin', 'colon:name.bin', ':(glob)*', 'line\nbreak.bin'])];
        for (const [index, path] of paths.entries()) {
            await writeFile(join(root, path), Buffer.from([0, 255, index]));
            git(root, ['--literal-pathspecs', 'add', '--', path]);
        }
        git(root, ['commit', '--quiet', '-m', 'literal paths']);
        if (process.platform === 'win32') {
            expect(await read({ path: join('sub', 'nested.bin'), selector: { side: 'before', area: 'included' } })).toEqual(expected(Buffer.from([0, 255, paths.indexOf('sub/nested.bin')])));
        }
        for (const [index, path] of paths.entries()) {
            for (const area of ['pending', 'included'] as const) {
                expect(await read({ path, selector: { side: 'before', area } }, join(root, 'sub'))).toEqual(expected(Buffer.from([0, 255, index])));
            }
        }
    });

    it('returns typed absence for unborn, untracked, staged addition and rename source identities', async () => {
        await writeFile(join(root, 'old.bin'), 'before');
        git(root, ['add', 'old.bin']);
        expect(await read({ path: 'old.bin', selector: { side: 'before', area: 'included' } })).toMatchObject({ success: false, errorCode: 'not_found' });
        expect(await read({ path: 'old.bin', selector: { side: 'before', area: 'pending' } })).toEqual(expected(Buffer.from('before')));
        git(root, ['commit', '--quiet', '-m', 'initial']);
        await rename(join(root, 'old.bin'), join(root, 'new.bin'));
        git(root, ['add', '-A']);
        expect(await read({ path: 'old.bin', selector: { side: 'before', area: 'included' } })).toEqual(expected(Buffer.from('before')));
        expect(await read({ path: 'new.bin', selector: { side: 'before', area: 'included' } })).toMatchObject({ success: false, errorCode: 'not_found' });
        expect(await read({ path: 'new.bin', selector: { side: 'before', area: 'pending' } })).toEqual(expected(Buffer.from('before')));
        await writeFile(join(root, 'untracked.bin'), 'untracked');
        expect(await read({ path: 'untracked.bin', selector: { side: 'before', area: 'pending' } })).toMatchObject({ success: false, errorCode: 'not_found' });
        expect(await read({ path: 'missing.bin', selector: { blobId: 'f'.repeat(40) } })).toMatchObject({ success: false, errorCode: 'blob_unavailable' });
        expect(await read({ path: 'old.bin', selector: { blobId: git(root, ['rev-parse', 'HEAD']) } })).toMatchObject({ success: false, errorCode: 'blob_unavailable' });
    });

    it('honors only the caller admission budget and reads objects beyond the ordinary SCM command cap', async () => {
        const bytes = Buffer.alloc(resolveBackendCommandMaxOutputBytes() + 17, 255);
        await writeFile(join(root, 'large.bin'), bytes);
        git(root, ['add', 'large.bin']);
        const selector = { side: 'before', area: 'pending' } as const;
        expect(await read({ path: 'large.bin', selector, maxBytes: bytes.length - 1 })).toMatchObject({ success: false, errorCode: 'too_large' });
        expect(await read({ path: 'large.bin', selector, maxBytes: bytes.length })).toEqual(expected(bytes));
        expect(await read({ path: 'large.bin', selector })).toEqual(expected(bytes));
        await writeFile(join(root, 'empty.bin'), '');
        git(root, ['add', 'empty.bin']);
        expect(await read({ path: 'empty.bin', selector, maxBytes: 0 })).toEqual(expected(Buffer.alloc(0)));
    });

    it('does not choose a conflict stage or report unavailable HEAD objects as absent files', async () => {
        await writeFile(join(root, 'conflict.bin'), 'before');
        git(root, ['add', 'conflict.bin']);
        git(root, ['commit', '--quiet', '-m', 'initial']);
        const blobId = git(root, ['rev-parse', 'HEAD:conflict.bin']);
        execFileSync('git', ['update-index', '--index-info'], { cwd: root,
            input: `0 ${'0'.repeat(blobId.length)}\tconflict.bin\n100644 ${blobId} 1\tconflict.bin\n100644 ${blobId} 2\tconflict.bin\n` });
        expect(await read({ path: 'conflict.bin', selector: { side: 'before', area: 'pending' } })).toMatchObject({ success: false, errorCode: 'blob_unavailable' });
        await writeFile(join(root, '.git', 'HEAD'), `${'f'.repeat(40)}\n`);
        expect(await read({ path: 'conflict.bin', selector: { side: 'before', area: 'both' } })).toMatchObject({ success: false, errorCode: 'blob_unavailable' });
    });

    it('discards partial bytes when the caller cancels the real streamed process', async () => {
        const bytes = Buffer.alloc(256 * 1024, 255);
        await writeFile(join(root, 'cancel.bin'), bytes);
        git(root, ['add', 'cancel.bin']);
        const handler = createGitScmBackendRuntimeRegistration().handlers.read?.fileAtRevision;
        expect(handler).toBeTypeOf('function');
        if (!handler) return;
        const services = createRealGitScmBackendRuntimeServices();
        const controller = new AbortController();
        let observedBytes = 0;
        const result = await runWithGitScmCommandRunner(input => {
            if (!('stdoutConsumer' in input)) return services.runCommand(input);
            return services.runCommandStreaming!({ ...input, stdoutConsumer(chunk) {
                observedBytes += chunk.byteLength;
                const disposition = input.stdoutConsumer(chunk);
                controller.abort();
                return disposition;
            } });
        }, () => handler({ context: { cwd: root, projectKey: root, detection: { isRepo: true, rootPath: root, mode: '.git' } },
            request: { path: 'cancel.bin', selector: { side: 'before', area: 'pending' } }, signal: controller.signal }));
        expect(observedBytes).toBeGreaterThan(0);
        expect(result).toMatchObject({ success: false, errorCode: 'blob_unavailable' });
        expect(result).not.toHaveProperty('contentBase64');
    });

    it('enforces the host filesystem authority for both path and pinned-object selections', async () => {
        await writeFile(join(root, 'outside.bin'), 'private sibling');
        await mkdir(join(root, 'allowed'));
        git(root, ['add', 'outside.bin']);
        const blobId = git(root, ['rev-parse', ':outside.bin']);
        const handler = createGitScmBackendRuntimeRegistration().handlers.read?.fileAtRevision;
        expect(handler).toBeTypeOf('function');
        if (!handler) return;
        for (const selector of [{ side: 'before', area: 'pending' } as const, { blobId }]) {
            await expect(runWithRealGitScmRuntime(() => handler({
                context: { cwd: join(root, 'allowed'), projectKey: root,
                    detection: { isRepo: true, rootPath: root, mode: '.git' },
                    assertFilesystemPathAuthorized(path) { if (path !== join(root, 'allowed', 'file.bin')) throw new Error('Access denied'); } },
                request: { path: 'outside.bin', selector },
                signal: new AbortController().signal,
            }))).rejects.toThrow('Access denied');
        }
    });

    it('reads immutable blobs in a SHA256-format Git repository', async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-file-at-revision-sha256-'));
        roots.push(root);
        git(root, ['init', '--quiet', '--object-format=sha256']);
        const bytes = Buffer.from([0, 255, 128, 10]);
        await writeFile(join(root, 'object.bin'), bytes);
        git(root, ['add', 'object.bin']);
        const blobId = git(root, ['rev-parse', ':object.bin']);
        expect(blobId).toHaveLength(64);
        expect(await read({ path: 'object.bin', selector: { blobId } })).toEqual(expected(bytes));
    });

    it('requires repository authority for an arbitrary blob even when its claimed path is allowed', async () => {
        await mkdir(join(root, 'allowed'));
        const allowedPath = join(root, 'allowed', 'file.bin');
        const allowedBytes = Buffer.from('permitted file');
        await writeFile(allowedPath, allowedBytes);
        await writeFile(join(root, 'sibling.bin'), 'private sibling');
        git(root, ['add', 'allowed/file.bin', 'sibling.bin']);
        const blobId = git(root, ['rev-parse', ':sibling.bin']);
        const handler = createGitScmBackendRuntimeRegistration().handlers.read?.fileAtRevision;
        expect(handler).toBeTypeOf('function');
        if (!handler) return;
        const context = { cwd: join(root, 'allowed'), projectKey: root,
            detection: { isRepo: true, rootPath: root, mode: '.git' as const },
            assertFilesystemPathAuthorized(path: string) { if (path !== allowedPath) throw new Error('Access denied'); } };
        const signal = new AbortController().signal;
        expect(await runWithRealGitScmRuntime(() => handler({ context, signal,
            request: { path: 'allowed/file.bin', selector: { side: 'before', area: 'pending' } } }))).toEqual(expected(allowedBytes));
        await expect(runWithRealGitScmRuntime(() => handler({ context, signal,
            request: { path: 'allowed/file.bin', selector: { blobId } } }))).rejects.toThrow('Access denied');
    });
});
