import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as scmRuntime from '../../runtime';
import { gitDiffFile } from './operations/readOperations';
import type { ScmBackendContext } from '../../types';
import { getGitSnapshot, getGitWorktreesEnrichment } from './repository';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function makeTempDir(prefix: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), prefix));
}

async function initRepoWithCommit(prefix: string): Promise<string> {
    const repoRoot = await makeTempDir(prefix);
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await runGit(repoRoot, ['config', 'user.name', 'Happier Test']);
    await runGit(repoRoot, ['branch', '-M', 'main']);
    await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
    await runGit(repoRoot, ['add', 'README.md']);
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function buildContext(repoRoot: string): ScmBackendContext {
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

describe('getGitSnapshot — worktree status enrichment wiring', () => {
    const cleanups: Array<() => Promise<void>> = [];

    beforeEach(() => {
        cleanups.length = 0;
    });

    afterEach(async () => {
        await Promise.all(cleanups.map((c) => c().catch(() => undefined)));
    });

    it.each(['included', 'pending'] as const)('marks tracked statistics incomplete when %s numstat fails', async (area) => {
        const repoRoot = await initRepoWithCommit('git-snap-failed-stats-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'other.txt'), 'original\n');
        await runGit(repoRoot, ['add', 'other.txt']);
        await runGit(repoRoot, ['commit', '-m', 'add other']);
        await writeFile(join(repoRoot, 'README.md'), 'staged\n');
        await runGit(repoRoot, ['add', 'README.md']);
        await writeFile(join(repoRoot, 'README.md'), 'pending\n');
        await writeFile(join(repoRoot, 'new.txt'), 'new\n');
        await writeFile(join(repoRoot, 'other.txt'), 'other\n');
        if (area === 'pending') await runGit(repoRoot, ['add', 'other.txt']);
        const originalCommand = scmRuntime.runScmCommand;
        const command = vi.spyOn(scmRuntime, 'runScmCommand').mockImplementation((input) => {
            if (input.args.includes('--numstat') && input.args.includes('--cached') === (area === 'included')) {
                return Promise.resolve({ success: false, stdout: '', stderr: 'diff failed', exitCode: 1 });
            }
            return originalCommand(input);
        });
        try {
            const response = await getGitSnapshot({ context: buildContext(repoRoot) });
            expect(response.success).toBe(true);
            expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'README.md')?.stats.isComplete).toBe(false);
            expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'new.txt')?.stats.isComplete).toBeUndefined();
            expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'other.txt')?.stats.isComplete).toBeUndefined();
            expect.soft(response.snapshot?.totals.isComplete).toBe(false);
        } finally {
            command.mockRestore();
        }
    });

    it('counts untracked text lines without inventing a trailing line or classifying skipped text as binary', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-untracked-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'one.txt'), 'hello\n');
        await writeFile(join(repoRoot, 'large.txt'), 'x'.repeat(5_000_001));
        const response = await getGitSnapshot({ context: buildContext(repoRoot) });
        expect(response.success).toBe(true);
        expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'one.txt')?.stats.pendingAdded).toBe(1);
        expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'large.txt')?.stats.isBinary).toBe(false);
        expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'large.txt')?.stats).toMatchObject({ isComplete: false });
        expect.soft(response.snapshot?.totals).toMatchObject({ isComplete: false });
    });

    it("'all' mode (default) uses porcelain untracked paths without a second repository enumeration", async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enumeration-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'new.txt'), 'hello');
        const command = vi.spyOn(scmRuntime, 'runScmCommand');
        try {
            const response = await getGitSnapshot({ context: buildContext(repoRoot) });
            expect(response.snapshot?.entries.find((entry) => entry.path === 'new.txt')?.stats.pendingAdded).toBe(1);
            expect(command.mock.calls.filter(([input]) => input.args[0] === 'ls-files')).toHaveLength(0);

            // Explicit 'all' keeps the same single-enumeration contract.
            const explicitAll = await getGitSnapshot({
                context: buildContext(repoRoot),
                request: { untrackedFiles: 'all' },
            });
            expect(explicitAll.snapshot?.totals).toMatchObject({ untrackedFiles: 1 });
            expect(command.mock.calls.filter(([input]) => input.args[0] === 'ls-files')).toHaveLength(0);
        } finally {
            command.mockRestore();
        }
    });

    it("'normal' mode collapses a fully-untracked directory into one entry with truthful file totals", async () => {
        const repoRoot = await initRepoWithCommit('git-snap-normal-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await mkdir(join(repoRoot, 'D'), { recursive: true });
        await writeFile(join(repoRoot, 'D', 'one.txt'), '1\n');
        await writeFile(join(repoRoot, 'D', 'two.txt'), '2\n');
        await writeFile(join(repoRoot, 'D', 'three.txt'), '3\n');
        const command = vi.spyOn(scmRuntime, 'runScmCommand');
        try {
            const response = await getGitSnapshot({
                context: buildContext(repoRoot),
                request: { untrackedFiles: 'normal' },
            });
            expect(response.success).toBe(true);
            const snapshot = response.snapshot!;
            const dirEntries = snapshot.entries.filter((entry) => entry.isDirectory === true);
            expect(dirEntries).toHaveLength(1);
            expect(dirEntries[0]).toMatchObject({
                path: 'D/',
                kind: 'untracked',
                isDirectory: true,
                untrackedFileCount: 3,
            });
            // Per-file rows for a collapsed directory are never shipped in the snapshot.
            expect(snapshot.entries.some((entry) => entry.path === 'D/one.txt')).toBe(false);
            expect(snapshot.entries.some((entry) => entry.path === 'D/two.txt')).toBe(false);
            expect(snapshot.entries.some((entry) => entry.path === 'D/three.txt')).toBe(false);
            // T2: totals keep file semantics — 3 untracked FILES, 3 changed files.
            expect(snapshot.totals).toMatchObject({ untrackedFiles: 3, changedFiles: 3 });
            // Exactly one additional bounded enumeration command in 'normal' mode.
            expect(command.mock.calls.filter(([input]) => input.args[0] === 'ls-files')).toHaveLength(1);
        } finally {
            command.mockRestore();
        }
    });

    it("'normal' mode keeps loose untracked files as individual file entries", async () => {
        const repoRoot = await initRepoWithCommit('git-snap-normal-loose-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await mkdir(join(repoRoot, 'D'), { recursive: true });
        await writeFile(join(repoRoot, 'D', 'one.txt'), '1\n');
        await writeFile(join(repoRoot, 'loose.txt'), 'loose\n');
        const response = await getGitSnapshot({
            context: buildContext(repoRoot),
            request: { untrackedFiles: 'normal' },
        });
        expect(response.success).toBe(true);
        const entries = response.snapshot!.entries;
        const loose = entries.find((entry) => entry.path === 'loose.txt');
        expect(loose).toMatchObject({ kind: 'untracked' });
        expect(loose?.isDirectory).toBeUndefined();
        expect(loose?.untrackedFileCount).toBeUndefined();
        expect(response.snapshot!.totals).toMatchObject({ untrackedFiles: 2, changedFiles: 2 });
    });

    it("'normal' mode degrades honestly when the untracked count enumeration fails", async () => {
        const repoRoot = await initRepoWithCommit('git-snap-normal-degraded-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await mkdir(join(repoRoot, 'D'), { recursive: true });
        await writeFile(join(repoRoot, 'D', 'one.txt'), '1\n');
        await writeFile(join(repoRoot, 'D', 'two.txt'), '2\n');
        await writeFile(join(repoRoot, 'D', 'three.txt'), '3\n');
        const originalCommand = scmRuntime.runScmCommand;
        const command = vi.spyOn(scmRuntime, 'runScmCommand').mockImplementation((input) => {
            if (input.args[0] === 'ls-files') {
                return Promise.resolve({ success: false, stdout: '', stderr: 'ls-files failed', exitCode: 1 });
            }
            return originalCommand(input);
        });
        try {
            const response = await getGitSnapshot({
                context: buildContext(repoRoot),
                request: { untrackedFiles: 'normal' },
            });
            expect(response.success).toBe(true);
            const snapshot = response.snapshot!;
            const dirEntry = snapshot.entries.find((entry) => entry.isDirectory === true);
            expect(dirEntry?.path).toBe('D/');
            // Degraded: directory rows lack the count, totals fall back to
            // entry-derived counts, and the incompleteness is observable.
            expect(dirEntry?.untrackedFileCount).toBeUndefined();
            expect(snapshot.totals).toMatchObject({ untrackedFiles: 1, changedFiles: 1, isComplete: false });
        } finally {
            command.mockRestore();
        }
    });

    it('keeps included-only diffs empty for untracked files and reads both areas in an unborn repository', async () => {
        const repoRoot = await makeTempDir('git-diff-unborn-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await runGit(repoRoot, ['init']);
        await writeFile(join(repoRoot, 'new.txt'), 'hello\n');
        const context = buildContext(repoRoot);
        expect.soft(await gitDiffFile({ context, request: { path: 'new.txt', area: 'included' } })).toEqual({ success: true, diff: '' });
        expect.soft(await gitDiffFile({ context, request: { path: 'new.txt', area: 'both' } })).toMatchObject({ success: true, diff: expect.stringContaining('+hello') });
        await runGit(repoRoot, ['add', 'new.txt']);
        await writeFile(join(repoRoot, 'new.txt'), 'latest\n');
        expect.soft(await gitDiffFile({ context, request: { path: 'new.txt', area: 'both' } })).toMatchObject({ success: true, diff: expect.stringContaining('+latest') });
    });

    it.each(['file\tname.txt', 'file\nname.txt', 'café.txt', 'literal[1].txt'])('reads actual untracked filenames %j', async (path) => {
        if (process.platform === 'win32' && /[\t\n]/.test(path)) return;
        const repoRoot = await initRepoWithCommit('git-diff-literal-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, path), 'hello\n');
        expect(await gitDiffFile({ context: buildContext(repoRoot), request: { path, area: 'pending' } })).toMatchObject({ success: true, diff: expect.stringContaining('+hello') });
    });

    it('omits per-worktree changeCount and lastActivityAt when includeWorktreeStatus is not set', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-flag-off-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        const response = await getGitSnapshot({ context: buildContext(repoRoot) });

        expect(response.success).toBe(true);
        const worktrees = response.snapshot?.repo.worktrees ?? [];
        expect(worktrees.length).toBeGreaterThan(0);
        for (const worktree of worktrees) {
            expect(worktree.changeCount).toBeUndefined();
            expect(worktree.lastActivityAt).toBeUndefined();
        }
    });

    it('populates per-worktree changeCount and lastActivityAt when includeWorktreeStatus is true', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-flag-on-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        // Add an unstaged change so changeCount > 0 is observable.
        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');

        const response = await getGitSnapshot({
            context: buildContext(repoRoot),
            request: { includeWorktreeStatus: true },
        });

        expect(response.success).toBe(true);
        const worktrees = response.snapshot?.repo.worktrees ?? [];
        expect(worktrees.length).toBeGreaterThan(0);
        const main = worktrees.find((w) => w.path === repoRoot) ?? worktrees[0]!;
        expect(typeof main.changeCount).toBe('number');
        expect(main.changeCount).toBeGreaterThanOrEqual(1);
        expect(typeof main.lastActivityAt).toBe('number');
        expect(main.lastActivityAt).toBeGreaterThan(0);
    });

    it('omits per-worktree changeCount and lastActivityAt when includeWorktreeStatus is explicitly false', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-flag-explicit-false-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        const response = await getGitSnapshot({
            context: buildContext(repoRoot),
            request: { includeWorktreeStatus: false },
        });

        expect(response.success).toBe(true);
        const worktrees = response.snapshot?.repo.worktrees ?? [];
        for (const worktree of worktrees) {
            expect(worktree.changeCount).toBeUndefined();
            expect(worktree.lastActivityAt).toBeUndefined();
        }
    });
});

describe('getGitWorktreesEnrichment — dedicated enrichment-only endpoint', () => {
    const cleanups: Array<() => Promise<void>> = [];

    beforeEach(() => {
        cleanups.length = 0;
    });

    afterEach(async () => {
        await Promise.all(cleanups.map((c) => c().catch(() => undefined)));
    });

    it('returns empty worktrees with success=true when no paths are requested (no per-worktree git work)', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enrich-empty-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        const response = await getGitWorktreesEnrichment({
            context: buildContext(repoRoot),
            request: { worktreePaths: [] },
        });

        expect(response).toEqual({ success: true, worktrees: [] });
    });

    it('returns per-path changeCount + lastActivityAt for an enriched request', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enrich-dirty-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');

        const response = await getGitWorktreesEnrichment({
            context: buildContext(repoRoot),
            request: { worktreePaths: [repoRoot] },
        });

        // FR3-5: server now echoes the CANONICAL path it actually probed (which
        // is what `git worktree list --porcelain` reports). On macOS the tmp
        // dir lives under `/private/var/...` so the response will use that
        // canonical form even though the caller supplied `/var/...`.
        const canonical = await realpath(repoRoot);

        expect(response.success).toBe(true);
        expect(response.worktrees).toHaveLength(1);
        expect(response.worktrees?.[0]?.path).toBe(canonical);
        expect(response.worktrees?.[0]?.changeCount).toBeGreaterThanOrEqual(1);
        expect(typeof response.worktrees?.[0]?.lastActivityAt).toBe('number');
    });

    // ---- F7: server must intersect requested paths with `git worktree list` and silently drop foreign paths ----

    it('F7: silently drops requested paths that are not part of the repo\'s `git worktree list` output', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enrich-pathvalidation-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        // Make sure the legitimate path has work to report.
        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');

        // Use a clearly foreign path that the daemon user could otherwise read.
        // It must NOT appear in the response (and the underlying status reader
        // must NOT have been invoked for it).
        const evilPath = '/etc';

        const response = await getGitWorktreesEnrichment({
            context: buildContext(repoRoot),
            request: { worktreePaths: [repoRoot, evilPath] },
        });

        // FR3-5: the response now echoes the canonical (registered) worktree
        // path matching `git worktree list`, not the caller-supplied form.
        const canonical = await realpath(repoRoot);

        expect(response.success).toBe(true);
        // Only the legitimate worktree path is present in the response.
        const responsePaths = (response.worktrees ?? []).map((w) => w.path);
        expect(responsePaths).toContain(canonical);
        expect(responsePaths).not.toContain(evilPath);
    });

    it('F7: returns empty worktrees with success=true when EVERY requested path is foreign (none belong to the repo)', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enrich-allforeign-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        const response = await getGitWorktreesEnrichment({
            context: buildContext(repoRoot),
            // Two arbitrary paths the daemon could read but that are not registered worktrees.
            request: { worktreePaths: ['/etc', '/tmp'] },
        });

        expect(response.success).toBe(true);
        expect(response.worktrees ?? []).toHaveLength(0);
    });

    // ---- FR3-5: server probes the canonical worktree path, not the caller-supplied path ----

    it('FR3-5: probes the canonical worktree path (from `git worktree list`), not the caller-supplied symlink path', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enrich-fr3-5-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        // Make sure the legitimate worktree has some work to report so enrichment fields are present.
        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');

        // The canonical path is what `git worktree list --porcelain` reports — that's
        // also what `realpath(repoRoot)` returns (macOS reports tmp paths under
        // `/private/var/...`). Build a symlink that resolves to that canonical path.
        const canonical = await realpath(repoRoot);
        const symlinkDir = await mkdtemp(join(tmpdir(), 'git-snap-enrich-fr3-5-link-'));
        cleanups.push(() => rm(symlinkDir, { recursive: true, force: true }));
        const symlinkPath = join(symlinkDir, 'worktree-link');
        await symlink(canonical, symlinkPath, 'dir');

        const response = await getGitWorktreesEnrichment({
            context: buildContext(repoRoot),
            // Caller passes the SYMLINK path. Validation realpaths it to `canonical` and
            // matches against the registered worktree set; the probe must then run
            // against `canonical` (the stable, validated worktree path), NOT the
            // mutable caller-supplied symlink path.
            request: { worktreePaths: [symlinkPath] },
        });

        expect(response.success).toBe(true);
        expect(response.worktrees).toHaveLength(1);
        // The response echoes the path that was actually probed; that must be the
        // canonical worktree path matching `git worktree list`, not the symlink.
        expect(response.worktrees?.[0]?.path).toBe(canonical);
        expect(response.worktrees?.[0]?.path).not.toBe(symlinkPath);
        // Enrichment fields must be populated (proves probing succeeded against the
        // canonical path).
        expect(response.worktrees?.[0]?.changeCount).toBeGreaterThanOrEqual(1);
        expect(typeof response.worktrees?.[0]?.lastActivityAt).toBe('number');
    });

    // ---- FR4-4: worktree paths with embedded newlines must not be truncated ----

    it('FR4-4: returns the full registered worktree path even when it contains a newline character', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enrich-fr4-4-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        // Create a worktree whose registered path contains a newline. Without -z,
        // `git worktree list --porcelain` would split this across two lines and the
        // parser would only see the prefix before the newline. With -z + a NUL-token
        // parser, the full path survives validation.
        const canonicalRoot = await realpath(repoRoot);
        const newlineWorktreeName = 'wt-a\nb';
        const newlineWorktreePath = join(canonicalRoot, newlineWorktreeName);

        await runGit(canonicalRoot, ['worktree', 'add', '-b', 'newline-feature', newlineWorktreePath]);

        const response = await getGitWorktreesEnrichment({
            context: buildContext(canonicalRoot),
            request: { worktreePaths: [newlineWorktreePath] },
        });

        expect(response.success).toBe(true);
        const paths = (response.worktrees ?? []).map((w) => w.path);
        // The full newline-containing path is returned (not the truncated prefix).
        expect(paths).toContain(newlineWorktreePath);
        // The truncated prefix MUST NOT be accepted as a worktree probe.
        expect(paths).not.toContain(join(canonicalRoot, 'wt-a'));
    });

    it('FR4-4: rejects a request for a truncated sibling path that aliases a newline worktree prefix', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enrich-fr4-4-trunc-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        const canonicalRoot = await realpath(repoRoot);

        const newlineWorktreePath = join(canonicalRoot, 'wt-a\nb');
        await runGit(canonicalRoot, ['worktree', 'add', '-b', 'newline-feature-2', newlineWorktreePath]);

        // Create a sibling that mirrors the truncated form an unsafe parser would see.
        // It exists on disk so the daemon user CAN read it — the only thing keeping it
        // out of the response is the intersection check against the canonical registered
        // worktree set, which must use the FULL path including the newline.
        const truncatedSibling = join(canonicalRoot, 'wt-a');
        await execFile('mkdir', ['-p', truncatedSibling]);
        await writeFile(join(truncatedSibling, 'sentinel.txt'), 'sibling\n', 'utf8');

        const response = await getGitWorktreesEnrichment({
            context: buildContext(canonicalRoot),
            request: { worktreePaths: [truncatedSibling] },
        });

        expect(response.success).toBe(true);
        const paths = (response.worktrees ?? []).map((w) => w.path);
        expect(paths).not.toContain(truncatedSibling);
        expect(paths.length).toBe(0);
    });

    it('FR5-D: rejects a request for a trimmed sibling path when the registered worktree ends with a newline', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enrich-fr5-trailing-newline-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        const canonicalRoot = await realpath(repoRoot);

        const trailingNewlineWorktree = join(canonicalRoot, 'wt-trailing-newline\n');
        await runGit(canonicalRoot, ['worktree', 'add', '-b', 'trailing-newline-feature', trailingNewlineWorktree]);

        const trimmedSibling = trailingNewlineWorktree.trimEnd();
        await execFile('mkdir', ['-p', trimmedSibling]);
        await writeFile(join(trimmedSibling, 'sentinel.txt'), 'trimmed sibling\n', 'utf8');

        const response = await getGitWorktreesEnrichment({
            context: buildContext(canonicalRoot),
            request: { worktreePaths: [trimmedSibling] },
        });

        expect(response.success).toBe(true);
        expect(response.worktrees ?? []).toHaveLength(0);
    });
});
