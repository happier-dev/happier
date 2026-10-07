import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import type { ScmBackendContext } from '../types.js';
import { gitChangeDiscard } from './changeDiscard.js';
import { gitCommitCreate } from './commitOperations.js';
import { gitDiffCommit } from './readOperations.js';
import { createGitBackend } from '../backend.js';

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createWorkspace(initialCommit = true) {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'happier-git-safety-')));
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 'test@example.com']);
    git(cwd, ['config', 'user.name', 'Happier Test']);
    writeFileSync(join(cwd, 'a.txt'), 'base\n');
    if (initialCommit) {
        git(cwd, ['add', 'a.txt']);
        git(cwd, ['commit', '-qm', 'base']);
    }
    const context: ScmBackendContext = {
        cwd, projectKey: 'test', detection: { isRepo: true, rootPath: cwd, mode: '.git' },
    };
    return { cwd, context };
}

// Loaded mac-host measured a completed real-Git case at 15.374s. Allow twice
// that, rounded up to 40s, at the runner boundary; Git command deadlines stay intact.
describe('Git mutation safety', { timeout: 40_000 }, () => {
    it('publishes a prepared plan message beyond the ordinary request limit', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const expectedHeadOid = git(cwd, ['rev-parse', 'HEAD']);
            const expectedRef = git(cwd, ['symbolic-ref', 'HEAD']);
            const expectedIndexTreeOid = git(cwd, ['write-tree']);
            writeFileSync(join(cwd, 'a.txt'), 'accepted\n');
            git(cwd, ['add', 'a.txt']);
            const preparedTreeOid = git(cwd, ['write-tree']);
            git(cwd, ['reset', '-q', 'HEAD']);
            const message = 'm'.repeat(4097);
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: {
                message, expectedHeadOid, expectedRef, expectedIndexTreeOid,
                preparedTreeOid, expectedCandidateTreeOid: preparedTreeOid,
            } }));
            expect(response, JSON.stringify(response)).toMatchObject({ success: true, publication: { state: 'published', actualMessage: message } });
            expect(git(cwd, ['show', '-s', '--format=%B', 'HEAD'])).toBe(message);
            expect(git(cwd, ['rev-parse', 'HEAD^{tree}'])).toBe(preparedTreeOid);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('compares a prepared plan against the actual parent tree despite replacement refs', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const expectedHeadOid = git(cwd, ['rev-parse', 'HEAD']);
            const expectedRef = git(cwd, ['symbolic-ref', 'HEAD']);
            const parentTreeOid = git(cwd, ['write-tree']);
            writeFileSync(join(cwd, 'a.txt'), 'accepted\n');
            git(cwd, ['add', 'a.txt']);
            const preparedTreeOid = git(cwd, ['write-tree']);
            git(cwd, ['reset', '-q', 'HEAD']);
            writeFileSync(join(cwd, 'b.txt'), 'unrelated staged intent\n');
            git(cwd, ['add', 'b.txt']);
            const expectedIndexTreeOid = git(cwd, ['write-tree']);
            const displayCommit = git(cwd, ['commit-tree', preparedTreeOid, '-m', 'replacement display']);
            git(cwd, ['replace', expectedHeadOid, displayCommit]);
            expect(git(cwd, ['rev-parse', `${expectedHeadOid}^{tree}`])).toBe(preparedTreeOid);
            expect(git(cwd, ['--no-replace-objects', 'rev-parse', `${expectedHeadOid}^{tree}`])).toBe(parentTreeOid);
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: {
                message: 'accepted', expectedHeadOid, expectedRef, expectedIndexTreeOid,
                preparedTreeOid, expectedCandidateTreeOid: preparedTreeOid,
            } }));
            expect(response, JSON.stringify(response)).toMatchObject({ success: true, publication: { state: 'published' } });
            expect(git(cwd, ['--no-replace-objects', 'rev-parse', 'HEAD^{tree}'])).toBe(preparedTreeOid);
            expect(git(cwd, ['--no-replace-objects', 'show', '-s', '--format=%P', 'HEAD'])).toBe(expectedHeadOid);
            expect(git(cwd, ['show', ':a.txt'])).toBe('accepted');
            expect(git(cwd, ['show', ':b.txt'])).toBe('unrelated staged intent');
            expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('b.txt');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('does not attribute a timed-out candidate through replacement history', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const head = git(cwd, ['rev-parse', 'HEAD']);
            const index = readFileSync(join(cwd, '.git', 'index'));
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            let candidateOid = '';
            let externalOid = '';
            const response = await runWithGitScmCommandRunner(async (input) => {
                if (input.args[0] === 'update-ref' && input.stdinInteraction) {
                    candidateOid = /^update HEAD ([a-f0-9]+) /m.exec(input.stdin ?? '')?.[1] ?? '';
                    const baseTree = git(cwd, ['rev-parse', `${head}^{tree}`]);
                    externalOid = git(cwd, ['commit-tree', baseTree, '-m', 'external root']);
                    git(cwd, ['update-ref', 'HEAD', externalOid, head]);
                    const replacement = git(cwd, ['commit-tree', baseTree, '-p', candidateOid, '-m', 'replacement history']);
                    git(cwd, ['replace', externalOid, replacement]);
                    // The lost process response supplies no evidence of publication.
                    return { success: false, stdout: '', stderr: 'Publication response lost', exitCode: -1, timedOut: true };
                }
                return runtime.runCommand(input);
            }, () => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(candidateOid).not.toBe('');
            expect(spawnSync('git', ['merge-base', '--is-ancestor', candidateOid, externalOid], { cwd }).status).toBe(0);
            expect(spawnSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', candidateOid, externalOid], { cwd }).status).toBe(1);
            expect(response).toMatchObject({ success: false, errorCode: 'COMMAND_TIMEOUT', publication: { state: 'unknown', candidateOid }, outcome: { kind: 'outcome_unknown' } });
            expect(response.commitSha).toBeUndefined();
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(externalOid);
            expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(index);
            expect(existsSync(join(cwd, '.git', 'index.lock'))).toBe(false);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32').each(['staged', 'scoped', 'amend'] as const)('matches native post-publication hook index reads and staging writes (%s)', async (kind) => {
        const owner = createWorkspace();
        const native = createWorkspace();
        try {
            for (const { cwd } of [owner, native]) {
                writeFileSync(join(cwd, 'b.txt'), 'retained staged intent\n'); git(cwd, ['add', 'b.txt']);
                writeFileSync(join(cwd, 'a.txt'), 'selected\n');
                if (kind === 'staged') git(cwd, ['add', 'a.txt']);
                writeFileSync(join(cwd, '.git', 'hooks', 'post-commit'), '#!/bin/sh\ngit diff --cached --name-only > post-index\nprintf "post staged\\n" > c.txt\ngit add c.txt\n', { mode: 0o755 });
                if (kind === 'amend') writeFileSync(join(cwd, '.git', 'hooks', 'post-rewrite'), '#!/bin/sh\ncat > rewritten-pair\ngit show :c.txt > rewrite-index\nprintf "rewrite staged\\n" > c.txt\ngit add c.txt\n', { mode: 0o755 });
            }
            git(native.cwd, ['commit', '-qm', 'selected', ...(kind === 'amend' ? ['--amend'] : []), ...(kind === 'staged' ? [] : ['--', 'a.txt'])]);
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context: owner.context,
                request: { message: 'selected', ...(kind === 'amend' ? { mode: 'amend' as const } : {}), ...(kind === 'staged' ? {} : { scope: { kind: 'paths' as const, include: ['a.txt'] } }) } }));
            expect(response.success, JSON.stringify(response)).toBe(true);
            expect(readFileSync(join(owner.cwd, 'post-index'), 'utf8')).toBe(readFileSync(join(native.cwd, 'post-index'), 'utf8'));
            expect(git(owner.cwd, ['show', ':c.txt'])).toBe(git(native.cwd, ['show', ':c.txt']));
            expect(git(owner.cwd, ['diff', '--cached', '--name-only'])).toBe(git(native.cwd, ['diff', '--cached', '--name-only']));
            if (kind === 'amend') {
                expect(readFileSync(join(owner.cwd, 'rewrite-index'), 'utf8')).toBe(readFileSync(join(native.cwd, 'rewrite-index'), 'utf8'));
                expect(readFileSync(join(owner.cwd, 'rewritten-pair'), 'utf8').trim().split(' ')[1]).toBe(response.commitSha);
            }
        } finally { for (const { cwd } of [owner, native]) rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32').each(['umask', 'group', 'all', 'world', '0660', '0600'] as const)('matches native sharedRepository=%s index permissions after configuration changes', async (sharing) => {
        const owner = createWorkspace();
        const native = createWorkspace();
        // Restrictive umask distinguishes world-read from group-only sharing.
        const previousUmask = process.umask(sharing === 'all' || sharing === 'world' ? 0o077 : 0o022);
        try {
            for (const { cwd } of [owner, native]) {
                git(cwd, ['config', 'core.sharedRepository', sharing]);
                writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            }
            git(native.cwd, ['commit', '-qm', 'selected', '--', 'a.txt']);
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context: owner.context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response.success, JSON.stringify(response)).toBe(true);
            expect(statSync(join(owner.cwd, '.git', 'index')).mode & 0o777).toBe(statSync(join(native.cwd, '.git', 'index')).mode & 0o777);
            expect(git(owner.cwd, ['status', '--porcelain'])).toBe('');
        } finally {
            process.umask(previousUmask);
            for (const { cwd } of [owner, native]) rmSync(cwd, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32')('retains the landed commit and post-rewrite hook identity when amend staging succeeds but the hook fails', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            writeFileSync(join(cwd, '.git', 'hooks', 'post-rewrite'), '#!/bin/sh\ncat >/dev/null\nprintf "hook staged\\n" > b.txt\ngit add b.txt\nexit 1\n', { mode: 0o755 });
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { mode: 'amend', message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response).toMatchObject({ success: false, errorCode: 'COMMIT_HOOK_FAILED', commitSha: git(cwd, ['rev-parse', 'HEAD']),
                publication: { state: 'published', hookName: 'post-rewrite' }, outcome: { kind: 'effect_applied_with_warning' } });
            expect(git(cwd, ['show', ':b.txt'])).toBe('hook staged');
            expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('b.txt');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32')('reports a real reference-transaction veto as hook failure with unchanged HEAD and index', async () => {
        const owner = createWorkspace();
        const native = createWorkspace();
        try {
            for (const { cwd } of [owner, native]) {
                writeFileSync(join(cwd, 'a.txt'), 'selected\n'); git(cwd, ['add', 'a.txt']);
                writeFileSync(join(cwd, '.git', 'hooks', 'reference-transaction'), '#!/bin/sh\ncat >/dev/null\nif test "$1" = prepared; then echo rejected-reference >&2; exit 1; fi\n', { mode: 0o755 });
            }
            const head = git(owner.cwd, ['rev-parse', 'HEAD']);
            const index = readFileSync(join(owner.cwd, '.git', 'index'));
            const nativeHead = git(native.cwd, ['rev-parse', 'HEAD']);
            expect(spawnSync('git', ['commit', '-qm', 'selected'], { cwd: native.cwd }).status).not.toBe(0);
            expect(git(native.cwd, ['rev-parse', 'HEAD'])).toBe(nativeHead);
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context: owner.context, request: { message: 'selected' } }));
            expect(response).toMatchObject({ success: false, errorCode: 'COMMIT_HOOK_FAILED', outcome: { kind: 'failed', errorCode: 'COMMIT_HOOK_FAILED' }, publication: { state: 'not_published', hookName: 'reference-transaction' } });
            expect(git(owner.cwd, ['rev-parse', 'HEAD'])).toBe(head);
            expect(readFileSync(join(owner.cwd, '.git', 'index'))).toEqual(index);
            expect(existsSync(join(owner.cwd, '.git', 'index.lock'))).toBe(false);
        } finally { for (const { cwd } of [owner, native]) rmSync(cwd, { recursive: true, force: true }); }
    });

    it('keeps deterministic ref lock failures as command failures when HEAD did not change', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const head = git(cwd, ['rev-parse', 'HEAD']);
            const ref = git(cwd, ['symbolic-ref', 'HEAD']);
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            writeFileSync(join(cwd, '.git', `${ref}.lock`), 'other owner\n');
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response).toMatchObject({ success: false, errorCode: 'COMMAND_FAILED', outcome: { kind: 'failed' }, publication: { state: 'not_published' } });
            expect(response.publication?.hookName).toBeUndefined();
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
            expect(readFileSync(join(cwd, '.git', `${ref}.lock`), 'utf8')).toBe('other owner\n');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('refuses a prepared plan whose expected index changed before the native reconciliation lock', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const expectedHeadOid = git(cwd, ['rev-parse', 'HEAD']);
            const expectedRef = git(cwd, ['symbolic-ref', 'HEAD']);
            const expectedIndexTreeOid = git(cwd, ['write-tree']);
            writeFileSync(join(cwd, 'a.txt'), 'selected\n'); git(cwd, ['add', 'a.txt']);
            const preparedTreeOid = git(cwd, ['write-tree']); git(cwd, ['reset', '-q', 'HEAD']);
            const runtime = createRealGitScmBackendRuntimeServices();
            let changedTreeOid = '';
            const response = await runWithGitScmCommandRunner(async (input) => {
                const result = await runtime.runCommand(input);
                if (!changedTreeOid && input.args[0] === 'commit-tree') {
                    writeFileSync(join(cwd, 'b.txt'), 'staged after host validation\n'); git(cwd, ['add', 'b.txt']);
                    changedTreeOid = git(cwd, ['write-tree']);
                }
                return result;
            }, () => gitCommitCreate({ context, request: { message: 'selected', expectedHeadOid, expectedRef, preparedTreeOid, expectedCandidateTreeOid: preparedTreeOid, expectedIndexTreeOid } }));
            expect(changedTreeOid).not.toBe('');
            expect(response).toMatchObject({ success: false, errorCode: 'SCM_SOURCE_CHANGED', outcome: { kind: 'needs_input' }, publication: { state: 'not_published' } });
            expect(response.publication).not.toHaveProperty('indexTreeOid');
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(expectedHeadOid);
            expect(git(cwd, ['write-tree'])).toBe(changedTreeOid);
            const accepted = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'selected', expectedHeadOid, expectedRef, preparedTreeOid, expectedCandidateTreeOid: preparedTreeOid, expectedIndexTreeOid: changedTreeOid } }));
            expect(accepted).toMatchObject({ success: true, publication: { indexReconciliation: 'reconciled', indexTreeOid: git(cwd, ['write-tree']) } });
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
    it('consumes an exact host-prepared tree beyond legacy patch limits and preserves unrelated live staging', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'b.txt'), 'base b\n');
            git(cwd, ['add', 'b.txt']); git(cwd, ['commit', '-qm', 'two files']);
            const expectedHeadOid = git(cwd, ['rev-parse', 'HEAD']);
            const expectedRef = git(cwd, ['symbolic-ref', 'HEAD']);
            writeFileSync(join(cwd, 'a.txt'), 'accepted\n');
            for (let i = 0; i < 257; i += 1) writeFileSync(join(cwd, `selected-${i}.txt`), 'selected\n');
            writeFileSync(join(cwd, 'large.txt'), 'x'.repeat(200_001));
            git(cwd, ['add', '-A']);
            const preparedTreeOid = git(cwd, ['write-tree']);
            git(cwd, ['reset', '-q', 'HEAD']);
            writeFileSync(join(cwd, 'b.txt'), 'unrelated staged\n'); git(cwd, ['add', 'b.txt']);
            writeFileSync(join(cwd, 'c.txt'), 'unrelated pending\n');
            const request = { message: 'host prepared', expectedHeadOid, expectedRef, expectedCandidateTreeOid: preparedTreeOid, preparedTreeOid };
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request }));
            expect(response, JSON.stringify(response)).toMatchObject({ success: true, publication: { state: 'published', expectedHeadOid, expectedRef } });
            expect(git(cwd, ['rev-parse', 'HEAD^{tree}'])).toBe(preparedTreeOid);
            expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('accepted');
            expect(git(cwd, ['show', 'HEAD:b.txt'])).toBe('base b');
            expect(git(cwd, ['show', ':b.txt'])).toBe('unrelated staged');
            expect(git(cwd, ['diff', '--cached'])).toContain('+unrelated staged');
            expect(git(cwd, ['ls-tree', '--name-only', 'HEAD'])).not.toContain('c.txt');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('refuses incomplete, mismatched or invalid host-prepared tree authority before publication', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const expectedHeadOid = git(cwd, ['rev-parse', 'HEAD']);
            const expectedRef = git(cwd, ['symbolic-ref', 'HEAD']);
            const preparedTreeOid = git(cwd, ['rev-parse', 'HEAD^{tree}']);
            writeFileSync(join(cwd, 'a.txt'), 'staged\n'); git(cwd, ['add', 'a.txt']);
            const staged = readFileSync(join(cwd, '.git', 'index'));
            const request = { message: 'host prepared', expectedHeadOid, expectedRef, expectedCandidateTreeOid: preparedTreeOid, preparedTreeOid };
            for (const invalid of [
                { ...request, expectedCandidateTreeOid: undefined },
                { ...request, expectedHeadOid: undefined },
                { ...request, expectedRef: undefined },
                { ...request, expectedCandidateTreeOid: 'a'.repeat(40) },
                { ...request, preparedTreeOid: '--bad', expectedCandidateTreeOid: '--bad' },
                { ...request, scope: { kind: 'all-pending' as const } },
            ]) {
                const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: invalid }));
                expect(response, JSON.stringify(invalid)).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
                expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(expectedHeadOid);
                expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(staged);
            }
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
    it('refuses a safe-plan candidate tree mismatch before running hooks', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const expectedHeadOid = git(cwd, ['rev-parse', 'HEAD']);
            const expectedRef = git(cwd, ['symbolic-ref', 'HEAD']);
            const expectedCandidateTreeOid = git(cwd, ['rev-parse', 'HEAD^{tree}']);
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            writeFileSync(join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho ran > hook-ran\n', { mode: 0o755 });
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: {
                message: 'exact candidate', scope: { kind: 'paths', include: ['a.txt'] },
                ...{ expectedHeadOid, expectedRef, expectedCandidateTreeOid },
            } }));
            expect(response).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST', publication: { state: 'not_published' } });
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(expectedHeadOid);
            expect(existsSync(join(cwd, 'hook-ran'))).toBe(false);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32')('commits precisely an explicitly accepted hook tree and pauses on renewed expansion', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const expectedHeadOid = git(cwd, ['rev-parse', 'HEAD']);
            const expectedRef = git(cwd, ['symbolic-ref', 'HEAD']);
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            git(cwd, ['add', 'a.txt']);
            const expectedCandidateTreeOid = git(cwd, ['write-tree']);
            git(cwd, ['reset', '-q', 'HEAD', '--', 'a.txt']);
            const hook = join(cwd, '.git', 'hooks', 'pre-commit');
            const acceptedHook = '#!/bin/sh\nprintf "selected\\nhook\\n" > a.txt\necho hook > b.txt\ngit add a.txt b.txt\n';
            writeFileSync(hook, acceptedHook, { mode: 0o755 });
            const request = { message: 'accepted hook', preparedTreeOid: expectedCandidateTreeOid, expectedHeadOid, expectedRef, expectedCandidateTreeOid };
            const initial = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request }));
            expect(initial).toMatchObject({ success: false, errorCode: 'COMMIT_HOOK_CONTENT_CHANGED', hookContentChanges: { beforeTreeOid: expectedCandidateTreeOid } });
            const acceptedHookTreeOid = initial.hookContentChanges!.afterTreeOid;
            // Inspection stays bound to the paused trees even after the real worktree changes again.
            writeFileSync(join(cwd, 'a.txt'), 'later worktree content\n');
            const inspected = await runWithRealGitScmRuntime(() => gitDiffCommit({ context, request: {
                commit: acceptedHookTreeOid, beforeTreeOid: expectedCandidateTreeOid,
            } }));
            expect(inspected).toMatchObject({ success: true, beforeTreeOid: expectedCandidateTreeOid, afterTreeOid: acceptedHookTreeOid });
            expect(inspected.diff).toContain('+hook');
            expect(inspected.diff).toContain('diff --git a/b.txt b/b.txt');
            expect(inspected.diff).not.toContain('later worktree content');
            expect(inspected.files).toEqual(expect.arrayContaining([
                expect.objectContaining({ path: 'a.txt', changeKind: 'modified', unifiedDiff: expect.stringContaining('+hook') }),
                expect.objectContaining({ path: 'b.txt', changeKind: 'added', unifiedDiff: expect.stringContaining('+hook') }),
            ]));
            const movingEndpoint = await runWithRealGitScmRuntime(() => gitDiffCommit({ context, request: {
                commit: 'HEAD', beforeTreeOid: expectedCandidateTreeOid,
            } }));
            expect(movingEndpoint).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
            const commitNotTree = await runWithRealGitScmRuntime(() => gitDiffCommit({ context, request: {
                commit: expectedHeadOid, beforeTreeOid: expectedCandidateTreeOid,
            } }));
            expect(commitNotTree).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
            writeFileSync(hook, acceptedHook + 'echo renewed > c.txt\ngit add c.txt\n', { mode: 0o755 });
            const expanded = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { ...request, ...{ acceptedHookTreeOid } } }));
            expect(expanded).toMatchObject({ success: false, errorCode: 'COMMIT_HOOK_CONTENT_CHANGED', publication: { state: 'not_published' }, hookContentChanges: { beforeTreeOid: acceptedHookTreeOid } });
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(expectedHeadOid);
            const renewedInspection = await runWithRealGitScmRuntime(() => gitDiffCommit({ context, request: {
                commit: expanded.hookContentChanges!.afterTreeOid, beforeTreeOid: acceptedHookTreeOid,
            } }));
            expect(renewedInspection.diff).toContain('diff --git a/c.txt b/c.txt');
            expect(renewedInspection.diff).not.toContain('diff --git a/b.txt b/b.txt');
            writeFileSync(hook, acceptedHook, { mode: 0o755 });
            const included = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { ...request, ...{ acceptedHookTreeOid } } }));
            expect(included, JSON.stringify(included)).toMatchObject({ success: true, publication: { state: 'published' } });
            expect(git(cwd, ['rev-parse', 'HEAD^{tree}'])).toBe(acceptedHookTreeOid);
            expect(git(cwd, ['show', 'HEAD:b.txt'])).toBe('hook');
            expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('selected\nhook');
            expect(git(cwd, ['ls-tree', '--name-only', 'HEAD'])).not.toContain('c.txt');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('pairs exact hook tree diff evidence with literal unusual filenames', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const beforeTreeOid = git(cwd, ['rev-parse', 'HEAD^{tree}']);
            const path = 'hook added\tcafé.txt';
            writeFileSync(join(cwd, path), 'literal hook evidence\n');
            git(cwd, ['add', '--', path]);
            const afterTreeOid = git(cwd, ['write-tree']);
            const inspected = await runWithRealGitScmRuntime(() => gitDiffCommit({ context, request: {
                commit: afterTreeOid, beforeTreeOid,
            } }));
            expect(inspected).toMatchObject({ success: true, beforeTreeOid, afterTreeOid,
                files: [{ path, changeKind: 'added', unifiedDiff: expect.stringContaining('+literal hook evidence') }] });
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('resolves only a known candidate in its verified target chain and preserves uncertainty after divergence', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const expectedHeadOid = git(cwd, ['rev-parse', 'HEAD']);
            const expectedRef = git(cwd, ['symbolic-ref', 'HEAD']);
            const candidateTreeOid = git(cwd, ['rev-parse', 'HEAD^{tree}']);
            const candidateOid = git(cwd, ['commit-tree', candidateTreeOid, '-p', expectedHeadOid, '-m', 'known candidate']);
            const backend = createGitBackend();
            expect(backend.commitResolveOutcome).toBeTypeOf('function');
            const request = { candidateOid, expectedHeadOid, expectedRef };
            const unresolved = await runWithRealGitScmRuntime(() => backend.commitResolveOutcome!({ context, request }));
            expect(unresolved).toMatchObject({ success: true, candidateTreeOid, publication: { state: 'not_published', candidateOid, actualMessage: 'known candidate' } });
            git(cwd, ['update-ref', expectedRef, candidateOid, expectedHeadOid]);
            writeFileSync(join(cwd, 'a.txt'), 'later actor\n'); git(cwd, ['add', 'a.txt']); git(cwd, ['commit', '-qm', 'later actor']);
            const published = await runWithRealGitScmRuntime(() => backend.commitResolveOutcome!({ context, request }));
            expect(published).toMatchObject({ success: true, candidateTreeOid, publication: { state: 'published', candidateOid, actualMessage: 'known candidate', indexReconciliation: 'pending' } });
            const otherCandidate = git(cwd, ['commit-tree', candidateTreeOid, '-p', expectedHeadOid, '-m', 'not in chain']);
            const unknown = await runWithRealGitScmRuntime(() => backend.commitResolveOutcome!({ context, request: { ...request, candidateOid: otherCandidate } }));
            expect(unknown).toMatchObject({ success: true, publication: { state: 'unknown' } });
            const wrongParent = await runWithRealGitScmRuntime(() => backend.commitResolveOutcome!({ context, request: { ...request, expectedHeadOid: candidateOid } }));
            expect(wrongParent).toMatchObject({ success: false, publication: { state: 'unknown' } });
            const runtime = createRealGitScmBackendRuntimeServices();
            const failedRead = await runWithGitScmCommandRunner((input) => input.args.includes('rev-parse')
                ? Promise.resolve({ success: false, stdout: '', stderr: 'observation timed out', exitCode: -1, timedOut: true })
                : runtime.runCommand(input), () => backend.commitResolveOutcome!({ context, request }));
            expect(failedRead).toMatchObject({ success: false, errorCode: 'COMMAND_TIMEOUT', publication: { state: 'unknown', candidateOid } });
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
    it('does not mistake a reversible deletion for a staged superset', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n');
            git(cwd, ['add', 'a.txt']); git(cwd, ['commit', '-qm', 'two lines']);
            writeFileSync(join(cwd, 'a.txt'), 'one\nSTAGED\n'); git(cwd, ['add', 'a.txt']);
            const head = git(cwd, ['rev-parse', 'HEAD']);
            const staged = readFileSync(join(cwd, '.git', 'index'));
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: {
                message: 'selected deletion', patches: [{ path: 'a.txt', patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1 @@\n one\n-two\n' }],
            } }));
            expect(response).toMatchObject({ success: false, errorCode: 'COMMIT_STAGING_CONFLICT', publication: { state: 'not_published' } });
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
            expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(staged);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('preserves an adjacent staged superset while committing only its accepted prefix', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'base\nline-one\nline-two\n');
            git(cwd, ['add', 'a.txt']);
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: {
                message: 'selected prefix', patches: [{ path: 'a.txt', patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n base\n+line-one\n' }],
            } }));
            expect(response.success, JSON.stringify(response)).toBe(true);
            expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('base\nline-one');
            expect(git(cwd, ['show', ':a.txt'])).toBe('base\nline-one\nline-two');
            expect(git(cwd, ['diff', '--cached'])).toContain('+line-two');
            expect(git(cwd, ['diff', '--cached'])).not.toContain('+line-one');
            expect(response.publication).toMatchObject({ indexReconciliation: 'reconciled', indexTreeOid: git(cwd, ['write-tree']) });
            expect(response.publication?.indexTreeOid).not.toBe(git(cwd, ['rev-parse', 'HEAD^{tree}']));
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32')('runs configured executable hooks on old Git with private-index, message and rewrite semantics', async () => {
        const { cwd, context } = createWorkspace();
        const inheritedConfig = process.env.GIT_CONFIG_PARAMETERS;
        try {
            process.env.GIT_CONFIG_PARAMETERS = "'test.inherited=kept'";
            const hooks = join(cwd, 'custom hooks');
            mkdirSync(hooks);
            git(cwd, ['config', 'core.hooksPath', 'custom hooks']);
            writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\ntest "$(git show :a.txt)" = selected || exit 1\ntest "$GIT_EDITOR" = : || exit 1\ntest -n "$GIT_AUTHOR_NAME" || exit 1\ntest "$(git config --get test.inherited)" = kept || exit 1\ntest -z "$(git config --get alias.happier-commit-hook)" || exit 1\npwd > hook-cwd\necho pre >> hook-order\n', { mode: 0o755 });
            writeFileSync(join(hooks, 'prepare-commit-msg'), '#!/bin/sh\ntest "$2" = message || exit 1\necho prepare >> hook-order\n', { mode: 0o755 });
            writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho rewritten > "$1"\necho message >> hook-order\n', { mode: 0o755 });
            writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\necho post >> hook-order\n', { mode: 0o755 });
            writeFileSync(join(hooks, 'post-rewrite'), '#!/bin/sh\ntest "$1" = amend || exit 1\ncat > hook-rewrite\necho rewrite >> hook-order\n', { mode: 0o755 });
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            const backend = createGitBackend();
            let versionProbes = 0;
            await runWithGitScmCommandRunner(async (input) => {
                if (input.args[0] === '--version') { versionProbes += 1; return { success: true, stdout: 'git version 2.35.8\n', stderr: '', exitCode: 0 }; }
                if (input.args[0] === 'hook') return { success: false, stdout: '', stderr: "git: 'hook' is not a git command", exitCode: 1 };
                return runtime.runCommand(input);
            }, async () => {
                const first = await backend.commitCreate({ context, request: { message: 'original', scope: { kind: 'paths', include: ['a.txt'] } } });
                expect(first, JSON.stringify(first)).toMatchObject({ success: true, publication: { state: 'published', actualMessage: 'rewritten' } });
                const previous = git(cwd, ['rev-parse', 'HEAD']);
                // Like Git, ignore a hook without an executable bit.
                chmodSync(join(hooks, 'commit-msg'), 0o644);
                const second = await backend.commitCreate({ context, request: { message: 'amended', mode: 'amend' } });
                expect(second).toMatchObject({ success: true, publication: { actualMessage: 'amended' } });
                expect(readFileSync(join(cwd, 'hook-rewrite'), 'utf8')).toBe(`${previous} ${second.commitSha}\n`);
            });
            expect(readFileSync(join(cwd, 'hook-order'), 'utf8')).toBe('pre\nprepare\nmessage\npost\npre\nprepare\npost\nrewrite\n');
            expect(readFileSync(join(cwd, 'hook-cwd'), 'utf8').trim()).toBe(cwd);
            expect(versionProbes).toBe(1);
            expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('selected');
        } finally {
            if (inheritedConfig === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
            else process.env.GIT_CONFIG_PARAMETERS = inheritedConfig;
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    // Git for Windows has no supported pre-2.36 hook-execution path.
    it.each(process.platform === 'win32' ? ['2.39.5'] : ['2.35.8', '2.39.5'])('fails closed only when Git %s requires staged-intent merging', async (version) => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\n');
            git(cwd, ['add', 'a.txt']); git(cwd, ['commit', '-qm', 'three lines']);
            writeFileSync(join(cwd, 'a.txt'), 'STAGED\ntwo\nthree\n'); git(cwd, ['add', 'a.txt']);
            writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nSELECTED\n');
            const head = git(cwd, ['rev-parse', 'HEAD']);
            const staged = readFileSync(join(cwd, '.git', 'index'));
            const runtime = createRealGitScmBackendRuntimeServices();
            const response = await runWithGitScmCommandRunner(async (input) => {
                if (input.args[0] === '--version') return { success: true, stdout: `git version ${version}\n`, stderr: '', exitCode: 0 };
                // A modern executable behind the fake version makes accidental use observable.
                return runtime.runCommand(input);
            }, () => createGitBackend().commitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response).toMatchObject({ success: false, errorCode: 'COMMIT_STAGING_CONFLICT', publication: { state: 'not_published' } });
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
            expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(staged);
            expect(existsSync(join(cwd, '.git', 'index.lock'))).toBe(false);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32').each(['reject', 'expand', 'timeout'] as const)('preserves publication truth for an old-Git hook that will %s', async (behavior) => {
        const { cwd, context } = createWorkspace();
        try {
            const hook = behavior === 'timeout' ? 'post-commit' : 'pre-commit';
            const hookPath = join(cwd, '.git', 'hooks', hook);
            writeFileSync(hookPath, `#!/bin/sh\n${behavior === 'reject' ? 'exit 1' : behavior === 'expand' ? 'git add b.txt' : 'sleep 1'}\n`, { mode: 0o755 });
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            writeFileSync(join(cwd, 'b.txt'), 'unselected\n');
            const head = git(cwd, ['rev-parse', 'HEAD']);
            const runtime = createRealGitScmBackendRuntimeServices();
            const response = await runWithGitScmCommandRunner(async (input) => {
                if (input.args[0] === '--version') return { success: true, stdout: 'git version 2.35.8\n', stderr: '', exitCode: 0 };
                if (input.args[0] === 'hook') return { success: false, stdout: '', stderr: "git: 'hook' is not a git command", exitCode: 1 };
                return runtime.runCommand(behavior === 'timeout' && input.args.includes(hookPath) ? { ...input, timeoutMs: 50 } : input);
            }, () => createGitBackend().commitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response.success).toBe(false);
            expect(response.errorCode).toBe(behavior === 'reject' ? 'COMMIT_HOOK_FAILED' : behavior === 'expand' ? 'COMMIT_HOOK_CONTENT_CHANGED' : 'COMMAND_TIMEOUT');
            expect(response.publication?.state).toBe(behavior === 'timeout' ? 'published' : 'not_published');
            if (behavior === 'timeout') {
                expect(response.commitSha).toBe(git(cwd, ['rev-parse', 'HEAD']));
                expect(response.outcome?.kind).toBe('effect_applied_with_warning');
                expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('selected');
            } else expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
            expect(git(cwd, ['diff', '--cached'])).toBe('');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('reports captured not-published authority when a selected patch is rejected', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const headOid = git(cwd, ['rev-parse', 'HEAD']);
            const ref = git(cwd, ['symbolic-ref', 'HEAD']);
            const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-not the captured body\n+selected\n';
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'must not land', patches: [{ path: 'a.txt', patch }] } }));
            expect(response.success).toBe(false);
            expect(response.publication).toEqual({ state: 'not_published', expectedHeadOid: headOid, expectedRef: ref, indexReconciliation: 'not_required' });
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(headOid);
            expect(git(cwd, ['diff', '--cached'])).toBe('');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('refuses an overlapping staged-only change created after candidate preparation', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const head = git(cwd, ['rev-parse', 'HEAD']);
            const runtime = createRealGitScmBackendRuntimeServices();
            let injected = false;
            const response = await runWithGitScmCommandRunner(async (input) => {
                const result = await runtime.runCommand(input);
                if (!injected && input.args[0] === 'add' && input.env?.GIT_INDEX_FILE) {
                    injected = true;
                    writeFileSync(join(cwd, 'a.txt'), 'other actor staged only\n');
                    writeFileSync(join(cwd, 'b.txt'), 'unrelated\n');
                    git(cwd, ['add', 'a.txt', 'b.txt']);
                    writeFileSync(join(cwd, 'a.txt'), 'selected\n');
                }
                return result;
            }, () => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(injected).toBe(true);
            expect(response.success).toBe(false);
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
            expect(git(cwd, ['show', ':a.txt'])).toBe('other actor staged only');
            expect(git(cwd, ['show', ':b.txt'])).toBe('unrelated');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('preserves disjoint staged differences on the selected path without creating a reversal', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\n');
            git(cwd, ['add', 'a.txt']); git(cwd, ['commit', '-qm', 'three lines']);
            writeFileSync(join(cwd, 'a.txt'), 'STAGED\ntwo\nthree\n');
            git(cwd, ['add', 'a.txt']);
            writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nSELECTED\n');
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({
                context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } },
            }));
            expect(response.success).toBe(true);
            expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('one\ntwo\nSELECTED');
            expect(git(cwd, ['show', ':a.txt'])).toBe('STAGED\ntwo\nSELECTED');
            const staged = git(cwd, ['diff', '--cached']);
            expect(staged).toContain('+STAGED'); expect(staged).not.toContain('-SELECTED');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('reports the verified reconciled index tree rather than a raced post-publication live tree', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'b.txt'), 'unrelated staged\n'); git(cwd, ['add', 'b.txt']);
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            let installedTreeOid = '';
            const response = await runWithGitScmCommandRunner(async (input) => {
                const result = await runtime.runCommand(input);
                if (input.args[0] === 'hook' && input.args.includes('post-commit')) {
                    installedTreeOid = git(cwd, ['write-tree']);
                    writeFileSync(join(cwd, 'b.txt'), 'staged by later actor\n'); git(cwd, ['add', 'b.txt']);
                }
                return result;
            }, () => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response).toMatchObject({ success: true, publication: { state: 'published', indexReconciliation: 'reconciled', indexTreeOid: installedTreeOid } });
            expect(installedTreeOid).not.toBe('');
            expect(installedTreeOid).not.toBe(git(cwd, ['rev-parse', 'HEAD^{tree}']));
            expect(installedTreeOid).not.toBe(git(cwd, ['write-tree']));
            expect(git(cwd, ['show', `${installedTreeOid}:b.txt`])).toBe('unrelated staged');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('does not attach a seeded tree to a concurrently advanced parent', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            let otherHead = '';
            const response = await runWithGitScmCommandRunner(async (input) => {
                const result = await runtime.runCommand(input);
                if (!otherHead && input.args[0] === 'add' && input.env?.GIT_INDEX_FILE) {
                    writeFileSync(join(cwd, 'b.txt'), 'other actor committed\n');
                    git(cwd, ['add', 'b.txt']); git(cwd, ['commit', '-qm', 'other']);
                    otherHead = git(cwd, ['rev-parse', 'HEAD']);
                }
                return result;
            }, () => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(otherHead).not.toBe(''); expect(response.success).toBe(false);
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(otherHead);
            expect(git(cwd, ['show', 'HEAD:b.txt'])).toBe('other actor committed');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32').each(['pre-commit', 'prepare-commit-msg', 'commit-msg'])('pauses before publication if %s expands candidate content', async (hook) => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'selected\n'); writeFileSync(join(cwd, 'b.txt'), 'hook content\n');
            const head = git(cwd, ['rev-parse', 'HEAD']);
            writeFileSync(join(cwd, '.git', 'hooks', hook), '#!/bin/sh\ngit add b.txt\n', { mode: 0o755 });
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response.success).toBe(false);
            expect(response.errorCode).toBe('COMMIT_HOOK_CONTENT_CHANGED');
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
            expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32')('reports its known landed commit on a real post-commit timeout even after another commit advances HEAD', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const postHook = join(cwd, '.git', 'hooks', 'post-commit');
            writeFileSync(postHook, '#!/bin/sh\nsleep 1\n', { mode: 0o755 });
            const runtime = createRealGitScmBackendRuntimeServices();
            let publishedOid = '';
            const response = await runWithGitScmCommandRunner(async (input) => {
                if (input.args[0] === 'hook' && input.args.includes('post-commit')) {
                    const result = await runtime.runCommand({ ...input, timeoutMs: 50 });
                    expect(result.timedOut).toBe(true);
                    publishedOid = git(cwd, ['rev-parse', 'HEAD']);
                    unlinkSync(postHook);
                    writeFileSync(join(cwd, 'b.txt'), 'later actor\n');
                    git(cwd, ['add', 'b.txt']);
                    git(cwd, ['commit', '-qm', 'later actor']);
                    return result;
                }
                return runtime.runCommand(input);
            }, () => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response.success).toBe(false);
            expect(publishedOid).not.toBe('');
            expect(response.commitSha).toBe(publishedOid);
            expect(response.commitSha).not.toBe(git(cwd, ['rev-parse', 'HEAD']));
            expect(git(cwd, ['rev-parse', 'HEAD^'])).toBe(publishedOid);
            expect(git(cwd, ['show', `${publishedOid}:a.txt`])).toBe('selected');
            expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('holds the native index lock at the final reconciliation boundary', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\n');
            git(cwd, ['add', 'a.txt']); git(cwd, ['commit', '-qm', 'three lines']);
            writeFileSync(join(cwd, 'a.txt'), 'STAGED\ntwo\nthree\n'); git(cwd, ['add', 'a.txt']);
            writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nSELECTED\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            let contenderStatus: number | null | undefined;
            const response = await runWithGitScmCommandRunner(async (input) => {
                const result = await runtime.runCommand(input);
                if (input.args.includes('merge-tree')) {
                    writeFileSync(join(cwd, 'b.txt'), 'stage contender\n');
                    contenderStatus = spawnSync('git', ['add', 'b.txt'], { cwd, encoding: 'utf8' }).status;
                }
                return result;
            }, () => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(contenderStatus).not.toBeUndefined(); expect(contenderStatus).not.toBe(0);
            expect(response.success, JSON.stringify(response)).toBe(true);
            expect(git(cwd, ['show', ':a.txt'])).toBe('STAGED\ntwo\nSELECTED');
            expect(git(cwd, ['status', '--porcelain'])).toContain('?? b.txt');
            expect(existsSync(join(cwd, '.git', 'index.lock'))).toBe(false);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.each(['advance', 'switch'] as const)('refuses a HEAD %s at final publication even with equal branch OIDs', async (kind) => {
        const { cwd, context } = createWorkspace();
        try {
            const old = git(cwd, ['rev-parse', 'HEAD']);
            const branch = git(cwd, ['symbolic-ref', 'HEAD']);
            git(cwd, ['branch', 'other']);
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            let changed = '';
            const response = await runWithGitScmCommandRunner(async (input) => {
                if (input.args[0] === 'update-ref' && !changed) {
                    if (kind === 'switch') { git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/other']); changed = old; }
                    else {
                        const tree = git(cwd, ['rev-parse', `${old}^{tree}`]);
                        changed = git(cwd, ['commit-tree', tree, '-p', old, '-m', 'another actor']);
                        git(cwd, ['update-ref', 'HEAD', changed, old]);
                    }
                }
                return runtime.runCommand(input);
            }, () => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(changed).not.toBe(''); expect(response.success).toBe(false);
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(changed);
            expect(git(cwd, ['rev-parse', branch])).toBe(kind === 'advance' ? changed : old);
            expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('base');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.each(['detached', 'linked'] as const)('commits through the actual %s worktree boundaries', async (kind) => {
        const { cwd, context } = createWorkspace();
        try {
            let targetCwd = cwd;
            if (kind === 'detached') git(cwd, ['checkout', '--detach', '-q']);
            else { targetCwd = join(cwd, 'linked'); git(cwd, ['worktree', 'add', '-qb', 'linked', targetCwd]); }
            writeFileSync(join(targetCwd, 'a.txt'), 'selected\n');
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context: { ...context, cwd: targetCwd }, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response.success, JSON.stringify(response)).toBe(true);
            expect(response.commitSha).toBe(git(targetCwd, ['rev-parse', 'HEAD']));
            expect(git(targetCwd, ['status', '--porcelain'])).toBe('');
            if (kind === 'linked') expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('base');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32')('honors native hook discovery, message rewrites, identity and ref hooks', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const hooks = join(cwd, 'custom-hooks'); mkdirSync(hooks); git(cwd, ['config', 'core.hooksPath', hooks]);
            writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\ntest "$GIT_EDITOR" = : || exit 1\ngit symbolic-ref -q HEAD > hook-branch\necho pre >> hooks-seen\n', { mode: 0o755 });
            writeFileSync(join(hooks, 'prepare-commit-msg'), '#!/bin/sh\ntest "$2" = message || exit 1\necho prepare >> hooks-seen\n', { mode: 0o755 });
            writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho rewritten > "$1"\necho message >> hooks-seen\n', { mode: 0o755 });
            writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\necho post >> hooks-seen\n', { mode: 0o755 });
            writeFileSync(join(hooks, 'reference-transaction'), '#!/bin/sh\necho "ref-$1" >> hooks-seen\ncat >/dev/null\n', { mode: 0o755 });
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'original', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response.success, JSON.stringify(response)).toBe(true);
            expect(git(cwd, ['show', '-s', '--format=%B'])).toBe('rewritten');
            expect(response.publication?.actualMessage).toBe('rewritten');
            expect(readFileSync(join(cwd, 'hook-branch'), 'utf8').trim()).toBe(git(cwd, ['symbolic-ref', 'HEAD']));
            expect(readFileSync(join(cwd, 'hooks-seen'), 'utf8').trim().split('\n')).toEqual(['pre', 'prepare', 'message', 'ref-prepared', 'ref-committed', 'post']);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('fails configured signing before publishing any ref or index change', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const head = git(cwd, ['rev-parse', 'HEAD']); const index = readFileSync(join(cwd, '.git', 'index'));
            git(cwd, ['config', 'commit.gpgSign', 'true']);
            git(cwd, ['config', 'gpg.program', join(cwd, 'nonexistent-signer')]);
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'signed', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response.success).toBe(false); expect(response.errorCode).toBe('COMMIT_SIGNING_FAILED');
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(head); expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(index);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32')('names the hook that stopped or expanded a commit, and says when a landed commit was signed', async () => {
        for (const behavior of ['reject', 'expand'] as const) {
            const { cwd, context } = createWorkspace();
            try {
                writeFileSync(join(cwd, '.git', 'hooks', 'commit-msg'), `#!/bin/sh\n${behavior === 'reject' ? 'echo "lint failed" >&2; exit 1' : 'git add b.txt'}\n`, { mode: 0o755 });
                writeFileSync(join(cwd, 'a.txt'), 'selected\n');
                writeFileSync(join(cwd, 'b.txt'), 'unselected\n');
                const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
                expect(response).toMatchObject({ success: false, publication: { state: 'not_published', hookName: 'commit-msg' } });
            } finally { rmSync(cwd, { recursive: true, force: true }); }
        }
        const { cwd, context } = createWorkspace();
        try {
            const signer = join(cwd, 'fake-signer');
            writeFileSync(signer, '#!/bin/sh\ncat >/dev/null\nprintf "\\n[GNUPG:] SIG_CREATED D 1 8 00 0 FAKE\\n" >&2\nprintf -- "-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n"\n', { mode: 0o755 });
            writeFileSync(join(cwd, 'a.txt'), 'unsigned\n');
            const unsigned = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'unsigned', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(unsigned.success, JSON.stringify(unsigned)).toBe(true);
            expect(unsigned.publication).toMatchObject({ state: 'published', signed: false, committedAtMs: Number(git(cwd, ['show', '-s', '--format=%ct', 'HEAD'])) * 1000 });
            expect(unsigned.publication?.hookName).toBeUndefined();
            git(cwd, ['config', 'commit.gpgSign', 'true']);
            git(cwd, ['config', 'gpg.program', signer]);
            writeFileSync(join(cwd, 'a.txt'), 'signed\n');
            const signed = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'signed', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(signed.success, JSON.stringify(signed)).toBe(true);
            expect(signed.publication).toMatchObject({ state: 'published', signed: true });
            expect(git(cwd, ['cat-file', 'commit', 'HEAD'])).toContain('gpgsig');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform === 'win32')('preserves amend author and runs the normal post-rewrite hook', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const original = git(cwd, ['rev-parse', 'HEAD']);
            git(cwd, ['config', 'user.name', 'Different Committer']);
            writeFileSync(join(cwd, '.git', 'hooks', 'post-rewrite'), '#!/bin/sh\ntest "$1" = amend || exit 1\ncat > rewritten-pair\n', { mode: 0o755 });
            writeFileSync(join(cwd, 'a.txt'), 'amended\n'); git(cwd, ['add', 'a.txt']);
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { mode: 'amend', message: 'amended', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response.success, JSON.stringify(response)).toBe(true);
            expect(git(cwd, ['show', '-s', '--format=%an'])).toBe('Happier Test');
            expect(git(cwd, ['show', '-s', '--format=%cn'])).toBe('Different Committer');
            expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('amended');
            expect(readFileSync(join(cwd, 'rewritten-pair'), 'utf8').trim()).toBe(`${original} ${response.commitSha}`);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('retains both merge parents and completes normal merge state for an ordinary staged commit', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const initial = git(cwd, ['rev-parse', 'HEAD']);
            const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD']);
            git(cwd, ['checkout', '-qb', 'side']);
            writeFileSync(join(cwd, 'b.txt'), 'side\n'); git(cwd, ['add', 'b.txt']); git(cwd, ['commit', '-qm', 'side']);
            const side = git(cwd, ['rev-parse', 'HEAD']);
            git(cwd, ['checkout', '-q', branch]);
            writeFileSync(join(cwd, 'a.txt'), 'main\n'); git(cwd, ['add', 'a.txt']); git(cwd, ['commit', '-qm', 'main']);
            const main = git(cwd, ['rev-parse', 'HEAD']);
            expect(main).not.toBe(initial);
            git(cwd, ['merge', '--no-commit', 'side']);
            expect(readFileSync(join(cwd, '.git', 'MERGE_MODE'), 'utf8')).toBe('');
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'merge' } }));
            expect(response.success, JSON.stringify(response)).toBe(true);
            expect(git(cwd, ['show', '-s', '--format=%P'])).toBe(`${main} ${side}`);
            expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);
            expect(existsSync(join(cwd, '.git', 'MERGE_MODE'))).toBe(false);
            expect(git(cwd, ['status', '--porcelain'])).toBe('');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
    it.skipIf(process.platform === 'win32').each([false, true])('synchronizes Git-derived colon filenames (nested=%s)', async (nested) => {
        const { cwd, context } = createWorkspace();
        try {
            const commandCwd = nested ? join(cwd, 'sub') : cwd;
            if (nested) mkdirSync(commandCwd);
            writeFileSync(join(commandCwd, ':(literal)new.txt'), 'new\n');
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({
                context: { ...context, cwd: commandCwd },
                request: { message: 'colon file', scope: { kind: 'all-pending' } },
            }));
            expect(response.success).toBe(true);
            expect(git(cwd, ['status', '--porcelain'])).toBe('');
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('discards only the requested bracket filename', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'literal[1].txt'), 'chosen\n');
            writeFileSync(join(cwd, 'literal1.txt'), 'keep\n');
            const response = await runWithRealGitScmRuntime(() => gitChangeDiscard({
                context, request: { entries: [{ path: 'literal[1].txt', kind: 'untracked' }] },
            }));
            expect(response.success).toBe(true);
            expect(existsSync(join(cwd, 'literal[1].txt'))).toBe(false);
            expect(readFileSync(join(cwd, 'literal1.txt'), 'utf8')).toBe('keep\n');
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it.each(['paths', 'all-pending'] as const)('synchronizes the live index after a %s root commit', async (kind) => {
        const { cwd, context } = createWorkspace(false);
        try {
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({
                context, request: { message: 'root', scope: kind === 'paths' ? { kind, include: ['a.txt'] } : { kind } },
            }));
            expect(response.success).toBe(true);
            expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('base');
            expect(git(cwd, ['status', '--porcelain'])).toBe('');
            expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('');
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('preserves same-path and unrelated staging when the preservation inspection fails', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'staged\n');
            writeFileSync(join(cwd, 'b.txt'), 'unrelated\n');
            git(cwd, ['add', 'a.txt', 'b.txt']);
            writeFileSync(join(cwd, 'a.txt'), 'pending\n');
            const head = git(cwd, ['rev-parse', 'HEAD']);
            const index = readFileSync(join(cwd, '.git', 'index'));
            const runtime = createRealGitScmBackendRuntimeServices();
            let injected = false;
            // Inject only at the Git process boundary; every other command uses real Git.
            const response = await runWithGitScmCommandRunner((input) => {
                if (input.args[0] === 'write-tree' && existsSync(join(cwd, '.git', 'index.lock'))) {
                    injected = true;
                    return Promise.resolve({ success: false, stdout: '', stderr: 'inspection failed', exitCode: 128 });
                }
                return runtime.runCommand(input);
            }, () => gitCommitCreate({
                context,
                request: { message: 'must not commit', scope: { kind: 'paths', include: ['a.txt'] } },
            }));
            expect(injected).toBe(true);
            expect(response.success).toBe(false);
            expect(response.error).toContain('inspection failed');
            expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
            expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(index);
            expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('pending\n');
            expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('unrelated\n');
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('retains the exact published object when the native index replacement fails', async () => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            let publishedOid = '';
            const response = await runWithGitScmCommandRunner(async (input) => {
                const result = await runtime.runCommand(input);
                if (input.args[0] === 'update-ref' && input.stdinInteraction && result.success) {
                    publishedOid = git(cwd, ['rev-parse', 'HEAD']);
                    // A real filesystem failure after publication, not a mocked internal reconciler.
                    unlinkSync(join(cwd, '.git', 'index'));
                    mkdirSync(join(cwd, '.git', 'index'));
                }
                return result;
            }, () => gitCommitCreate({ context, request: { message: 'selected', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(publishedOid).not.toBe('');
            expect(response.success).toBe(false);
            expect(response.commitSha).toBe(publishedOid);
            expect(response.publication).toMatchObject({ state: 'published', candidateOid: publishedOid, indexReconciliation: 'failed' });
            expect(response.publication).not.toHaveProperty('indexTreeOid');
            expect(response.outcome).toMatchObject({ kind: 'effect_applied_with_warning', effect: { kind: 'commit', commitSha: publishedOid } });
            expect(git(cwd, ['show', `${publishedOid}:a.txt`])).toBe('selected');
            expect(existsSync(join(cwd, '.git', 'index.lock'))).toBe(false);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('matches native non-editor commit message cleanup and signoff', async () => {
        const native = createWorkspace();
        const managed = createWorkspace();
        try {
            const message = 'subject  \n\n; remove this comment\nbody  \n\n';
            for (const workspace of [native, managed]) {
                git(workspace.cwd, ['config', 'commit.cleanup', 'strip']);
                git(workspace.cwd, ['config', 'core.commentChar', ';']);
                writeFileSync(join(workspace.cwd, 'a.txt'), 'selected\n');
            }
            git(native.cwd, ['add', 'a.txt']);
            git(native.cwd, ['commit', '--signoff', '-m', message.trim()]);
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({
                context: managed.context, request: { message, signOff: true, scope: { kind: 'paths', include: ['a.txt'] } },
            }));
            expect(response.success).toBe(true);
            expect(git(managed.cwd, ['show', '-s', '--format=%B', response.commitSha!])).toBe(git(native.cwd, ['show', '-s', '--format=%B', 'HEAD']));
            expect(response.publication?.actualMessage).toBe(git(native.cwd, ['show', '-s', '--format=%B', 'HEAD']));
            expect(git(managed.cwd, ['rev-parse', `${response.commitSha}^{tree}`])).toBe(git(native.cwd, ['rev-parse', 'HEAD^{tree}']));
            expect(git(managed.cwd, ['show', '-s', '--format=%an <%ae>%n%cn <%ce>', response.commitSha!])).toBe(git(native.cwd, ['show', '-s', '--format=%an <%ae>%n%cn <%ce>', 'HEAD']));
        } finally { for (const workspace of [native, managed]) rmSync(workspace.cwd, { recursive: true, force: true }); }
    });

    it.skipIf(spawnSync('ssh-keygen', ['-V'], { encoding: 'utf8' }).error?.message.includes('ENOENT') === true)('creates a verifiable commit using the configured native SSH signer', async () => {
        const { cwd, context } = createWorkspace();
        try {
            const key = join(cwd, '.git', 'test-signing-key');
            execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
            const allowedSigners = join(cwd, '.git', 'allowed-signers');
            writeFileSync(allowedSigners, `test@example.com ${readFileSync(`${key}.pub`, 'utf8')}`);
            git(cwd, ['config', 'gpg.format', 'ssh']);
            git(cwd, ['config', 'user.signingkey', key]);
            git(cwd, ['config', 'gpg.ssh.allowedSignersFile', allowedSigners]);
            git(cwd, ['config', 'commit.gpgsign', 'true']);
            writeFileSync(join(cwd, 'a.txt'), 'signed selection\n');
            const response = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'signed', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(response.success).toBe(true);
            expect(response.commitSha).toBe(git(cwd, ['rev-parse', 'HEAD']));
            expect(spawnSync('git', ['verify-commit', response.commitSha!], { cwd, encoding: 'utf8' }).status).toBe(0);
            expect(git(cwd, ['show', `${response.commitSha}:a.txt`])).toBe('signed selection');
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it.each(['untracked', 'added', 'locked'] as const)('reports actual discard outcome for %s files', async (kind) => {
        const { cwd, context } = createWorkspace();
        try {
            writeFileSync(join(cwd, 'new.txt'), 'new\n');
            if (kind !== 'untracked') git(cwd, ['add', 'new.txt']);
            const index = readFileSync(join(cwd, '.git', 'index'));
            if (kind === 'locked') writeFileSync(join(cwd, '.git', 'index.lock'), '');
            const response = await runWithRealGitScmRuntime(() => gitChangeDiscard({
                context,
                request: { entries: [{ path: 'new.txt', kind: kind === 'untracked' ? 'untracked' : 'added' }] },
            }));
            expect(response.success).toBe(kind !== 'locked');
            expect(existsSync(join(cwd, 'new.txt'))).toBe(kind === 'locked');
            if (kind === 'locked') expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(index);
            else expect(git(cwd, ['status', '--porcelain'])).toBe('');
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
