import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import type { ScmLogEntry, ScmLogListRequest } from '@happier-dev/plugin-sdk/scm';
import type { BackendRuntimeContext as ScmBackendContext } from '@happier-dev/plugin-sdk/scm/backend';

import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import { gitLogList } from './readOperations.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[], env?: Record<string, string>): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd, env });
    return stdout.trim();
}

let repoRoot: string;
let headSha: string;
const cleanups: Array<() => Promise<void>> = [];

async function commitFile(input: {
    fileName: string;
    message: string;
    authorName: string;
    authorEmail: string;
    dateIso: string;
}): Promise<string> {
    await writeFile(join(repoRoot, input.fileName), `${input.fileName}\n`, 'utf8');
    await runGit(repoRoot, ['add', input.fileName]);
    const env = {
        GIT_AUTHOR_NAME: input.authorName,
        GIT_AUTHOR_EMAIL: input.authorEmail,
        GIT_AUTHOR_DATE: input.dateIso,
        GIT_COMMITTER_NAME: input.authorName,
        GIT_COMMITTER_EMAIL: input.authorEmail,
        GIT_COMMITTER_DATE: input.dateIso,
    };
    await runGit(repoRoot, ['commit', '-m', input.message], env);
    return await runGit(repoRoot, ['rev-parse', 'HEAD']);
}

function buildContext(): ScmBackendContext {
    return {
        cwd: repoRoot,
        projectKey: `test:${repoRoot}`,
        detection: {
            isRepo: true,
            rootPath: repoRoot,
            mode: '.git',
        },
    };
}

function shas(entries: readonly ScmLogEntry[]): string[] {
    return entries.map((entry) => entry.sha);
}

/**
 * The backend runner resolves the `git` executable through the plugin runtime services; the
 * testkit injects the host's real git for tests, exactly like `repository.test.ts`.
 */
async function logQuery(input: {
    context: ReturnType<typeof buildContext>;
    request: ScmLogListRequest;
}) {
    return runWithRealGitScmRuntime(() => gitLogList(input as Parameters<typeof gitLogList>[0]));
}

describe('gitLogList bounded commit query', () => {
    beforeEach(async () => {
        repoRoot = await mkdtemp(join(tmpdir(), 'happier-git-log-query-'));
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await runGit(repoRoot, ['init']);
        await runGit(repoRoot, ['branch', '-M', 'main']);
        // Oldest first so newest-wins ordering is observable.
        await commitFile({
            fileName: 'alpha.txt',
            message: 'fix: login flow validation',
            authorName: 'Ada Lovelace',
            authorEmail: 'ada@example.com',
            dateIso: '2026-01-01T00:00:00Z',
        });
        await commitFile({
            fileName: 'beta.txt',
            message: 'chore: upgrade tooling',
            authorName: 'Grace Hopper',
            authorEmail: 'grace@example.com',
            dateIso: '2026-01-02T00:00:00Z',
        });
        await commitFile({
            fileName: 'gamma.txt',
            message: 'feat: cache layer',
            authorName: 'Ada Lovelace',
            authorEmail: 'ada@example.com',
            dateIso: '2026-01-03T00:00:00Z',
        });
        headSha = await runGit(repoRoot, ['rev-parse', 'HEAD']);
    });

    afterEach(async () => {
        await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => undefined)));
    });

    it('pages the exact pinned range with positive endpoint and exhaustion evidence, excluding later HEAD', async () => {
        const before = await runGit(repoRoot, ['rev-parse', 'HEAD~2']);
        const middle = await runGit(repoRoot, ['rev-parse', 'HEAD~1']);
        const after = headSha;
        await commitFile({ fileName: 'later', message: 'later HEAD [skip ci]', authorName: 'Later',
            authorEmail: 'later@example.com', dateIso: '2026-01-04T00:00:00Z' });
        const revisionRange = { kind: 'revisionRange' as const, baseOid: before, headOid: after };
        const first = await logQuery({ context: buildContext(), request: { cwd: repoRoot, revisionRange, limit: 1 } });
        expect(first.success, first.error).toBe(true);
        expect(shas(first.entries ?? [])).toEqual([after]);
        expect(first.revisionRange).toEqual({ ...revisionRange, historyComplete: true, graphRelation: 'forward', totalCount: 2, nextSkip: 1 });
        const last = await logQuery({ context: buildContext(), request: { cwd: repoRoot, revisionRange, limit: 1, skip: 1 } });
        expect(shas(last.entries ?? [])).toEqual([middle]);
        expect(last.revisionRange).toEqual({ ...revisionRange, historyComplete: true, graphRelation: 'forward', totalCount: 2 });
        const empty = await logQuery({ context: buildContext(), request: { cwd: repoRoot, revisionRange: { ...revisionRange, baseOid: after } } });
        expect(empty.entries).toEqual([]);
        expect(empty.revisionRange).toEqual({ ...revisionRange, baseOid: after, historyComplete: true, graphRelation: 'equal', totalCount: 0 });
    });

    it('never attests complete history for missing endpoints or a shallow range', async () => {
        const before = await runGit(repoRoot, ['rev-parse', 'HEAD~2']);
        const missing = await logQuery({ context: buildContext(), request: { cwd: repoRoot,
            revisionRange: { kind: 'revisionRange', baseOid: 'f'.repeat(40), headOid: headSha } } });
        expect(missing.success).toBe(false);
        expect(missing.revisionRange).toBeUndefined();
        await writeFile(join(repoRoot, '.git', 'shallow'), `${headSha}\n`);
        const shallow = await logQuery({ context: buildContext(), request: { cwd: repoRoot, revisionRange: { kind: 'revisionRange', baseOid: before, headOid: headSha } } });
        expect(shallow.success, shallow.error).toBe(true);
        expect(shallow.revisionRange).toEqual({ kind: 'revisionRange', baseOid: before, headOid: headSha, historyComplete: false });
    });

    it('withholds completeness when the Git boundary truncates or cannot finish a range page', async () => {
        const before = await runGit(repoRoot, ['rev-parse', 'HEAD~2']);
        const services = createRealGitScmBackendRuntimeServices();
        for (const mode of ['truncated', 'outputLimit', 'cancelled'] as const) {
            const controller = new AbortController();
            const response = await runWithGitScmCommandRunner(async input => {
                if (input.args[0] !== 'log') return services.runCommand(input);
                if (mode === 'cancelled') controller.abort();
                return { success: mode === 'truncated', stdout: `${headSha}\0incomplete`, stderr: '', exitCode: mode === 'truncated' ? 0 : -1,
                    ...(mode === 'outputLimit' ? { outputLimitExceeded: true } : {}) };
            }, () => gitLogList({ context: buildContext(), signal: controller.signal,
                request: { cwd: repoRoot, revisionRange: { kind: 'revisionRange', baseOid: before, headOid: headSha } } }));
            expect(response.success).toBe(false);
            expect(response.revisionRange).toBeUndefined();
            expect(response.errorCode).toBe(mode === 'cancelled' ? SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED
                : mode === 'outputLimit' ? SCM_OPERATION_ERROR_CODES.COMMAND_OUTPUT_LIMIT_EXCEEDED : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
        }
    });

    it('reads only upstream commits not reachable from the current branch', async () => {
        await runGit(repoRoot, ['checkout', '-b', 'remote-source']);
        const incomingSha = await commitFile({
            fileName: 'incoming.txt', message: 'remote change', authorName: 'Lin',
            authorEmail: 'lin@example.com', dateIso: '2026-01-04T00:00:00Z',
        });
        await runGit(repoRoot, ['update-ref', 'refs/remotes/origin/main', incomingSha]);
        await runGit(repoRoot, ['checkout', 'main']);
        await runGit(repoRoot, ['config', 'branch.main.remote', 'origin']);
        await runGit(repoRoot, ['config', 'branch.main.merge', 'refs/heads/main']);
        await runGit(repoRoot, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);

        const response = await logQuery({ context: buildContext(), request: { cwd: repoRoot, range: 'incoming' } });
        expect(response.success, response.error).toBe(true);
        expect(response.rangeApplied).toBe(true);
        expect(shas(response.entries ?? [])).toEqual([incomingSha]);
    });

    it('matches subject, body, and author case-insensitively and reports queryApplied', async () => {
        const bySubject = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: 'LOGIN FLOW', limit: 10 },
        });
        expect(bySubject.success).toBe(true);
        expect(bySubject.queryApplied).toBe(true);
        expect(shas(bySubject.entries ?? [])).toEqual([(await runGit(repoRoot, ['rev-parse', 'HEAD~2']))]);

        const byAuthorName = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: 'grace hopper', limit: 10 },
        });
        expect(byAuthorName.queryApplied).toBe(true);
        expect(shas(byAuthorName.entries ?? [])).toEqual([
            await runGit(repoRoot, ['rev-parse', 'HEAD~1']),
        ]);

        const byAuthorEmail = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: 'ada@example.com', limit: 10 },
        });
        expect(byAuthorEmail.queryApplied).toBe(true);
        expect((byAuthorEmail.entries ?? []).length).toBe(2);
    });

    it('matches commit body text', async () => {
        await runGit(repoRoot, ['commit', '--amend', '-m', 'feat: cache layer\n\nCacheInvalidationNotes: sweep entries'], {
            GIT_AUTHOR_NAME: 'Ada Lovelace',
            GIT_AUTHOR_EMAIL: 'ada@example.com',
            GIT_AUTHOR_DATE: '2026-01-03T00:00:00Z',
            GIT_COMMITTER_NAME: 'Ada Lovelace',
            GIT_COMMITTER_EMAIL: 'ada@example.com',
            GIT_COMMITTER_DATE: '2026-01-03T00:00:00Z',
        });
        headSha = await runGit(repoRoot, ['rev-parse', 'HEAD']);

        const byBody = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: 'CacheInvalidationNotes', limit: 10 },
        });
        expect(byBody.success).toBe(true);
        expect(byBody.queryApplied).toBe(true);
        expect(shas(byBody.entries ?? [])).toEqual([headSha]);
    });

    it('treats author queries as literal text rather than regular expressions', async () => {
        const punctuationAuthor = await commitFile({
            fileName: 'punctuation.txt',
            message: 'chore: punctuation author',
            authorName: 'Ada [Core].',
            authorEmail: 'ada+core@example.com',
            dateIso: '2026-01-04T00:00:00Z',
        });

        const regexMeta = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: '.*', limit: 10 },
        });
        expect(shas(regexMeta.entries ?? [])).toEqual([]);

        const bracket = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: '[Core].', limit: 10 },
        });
        expect(shas(bracket.entries ?? [])).toEqual([punctuationAuthor]);
    });

    it('matches an abbreviated SHA prefix', async () => {
        const prefix = headSha.slice(0, 8);
        const bySha = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: prefix, limit: 10 },
        });
        expect(bySha.success).toBe(true);
        expect(bySha.queryApplied).toBe(true);
        expect(shas(bySha.entries ?? [])).toEqual([headSha]);
    });

    it('returns typed empty success for an unknown SHA-like revision', async () => {
        const bySha = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: 'deadbeefdeadbeef', limit: 10 },
        });
        expect(bySha.success).toBe(true);
        expect(bySha.queryApplied).toBe(true);
        expect(bySha.entries).toEqual([]);
    });

    it('does not return full or abbreviated SHA matches outside HEAD ancestry', async () => {
        await runGit(repoRoot, ['checkout', '-b', 'off-branch', 'HEAD~1']);
        const offBranchSha = await commitFile({
            fileName: 'off-branch.txt',
            message: 'feat: off-branch only',
            authorName: 'Linus Torvalds',
            authorEmail: 'linus@example.com',
            dateIso: '2026-01-04T00:00:00Z',
        });
        await runGit(repoRoot, ['checkout', 'main']);

        for (const query of [offBranchSha, offBranchSha.slice(0, 8)]) {
            const result = await logQuery({
                context: buildContext(),
                request: { cwd: repoRoot, query, limit: 10 },
            });
            expect(result.success).toBe(true);
            expect(result.queryApplied).toBe(true);
            expect(result.entries).toEqual([]);
        }
    });

    it('merges overlapping match arms, dedupes, and orders newest first', async () => {
        // Make the newest commit match BOTH arms for one query: its body names the author,
        // so the message arm and the author arm each return it and the merge must keep it
        // exactly once while the author arm contributes the older commit too.
        await runGit(repoRoot, ['commit', '--amend', '-m', 'feat: cache layer\n\nReviewed-by: Ada Lovelace'], {
            GIT_AUTHOR_NAME: 'Ada Lovelace',
            GIT_AUTHOR_EMAIL: 'ada@example.com',
            GIT_AUTHOR_DATE: '2026-01-03T00:00:00Z',
            GIT_COMMITTER_NAME: 'Ada Lovelace',
            GIT_COMMITTER_EMAIL: 'ada@example.com',
            GIT_COMMITTER_DATE: '2026-01-03T00:00:00Z',
        });
        headSha = await runGit(repoRoot, ['rev-parse', 'HEAD']);

        const merged = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: 'ada lovelace', limit: 10 },
        });
        const mergedShas = shas(merged.entries ?? []);
        expect(mergedShas).toEqual([
            headSha,
            await runGit(repoRoot, ['rev-parse', 'HEAD~2']),
        ]);
        expect(new Set(mergedShas).size).toBe(mergedShas.length);
        const timestamps = (merged.entries ?? []).map((entry) => entry.timestamp);
        expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
    });

    it('honors limit and skip over the merged matches', async () => {
        const adaCommits = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: 'ada@example.com', limit: 10 },
        });
        const all = shas(adaCommits.entries ?? []);
        expect(all.length).toBe(2);

        const page = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: 'ada@example.com', limit: 1, skip: 1 },
        });
        expect(shas(page.entries ?? [])).toEqual([all[1]]);
    });

    it('keeps the legacy recent-page behavior (no query echo) when no query is sent', async () => {
        const legacy = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, limit: 2 },
        });
        expect(legacy.success).toBe(true);
        expect(legacy.queryApplied).toBeUndefined();
        expect((legacy.entries ?? []).length).toBe(2);
        expect((legacy.entries ?? [])[0]?.sha).toBe(headSha);
        // `--pretty=format:` separator newlines must never leak into commit identity —
        // this pins the parser fix for entries after the first, which the legacy recent
        // page also serves.
        expect((legacy.entries ?? [])[1]?.sha).toBe(await runGit(repoRoot, ['rev-parse', 'HEAD~1']));
    });

    it('keeps failing with the canonical command-failure code when the repository cannot be read', async () => {
        await rm(join(repoRoot, '.git'), { recursive: true, force: true });
        const failed = await logQuery({
            context: buildContext(),
            request: { cwd: repoRoot, query: 'anything', limit: 10 },
        });
        expect(failed.success).toBe(false);
        expect(failed.errorCode).toBe(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
    });
});
