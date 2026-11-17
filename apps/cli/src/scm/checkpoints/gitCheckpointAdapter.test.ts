import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRepositoryCheckpointRefs } from './refs';
import { createGitCheckpointRuntimeServices, gitCheckpointAdapter } from './gitCheckpointAdapter';

// Observe the OS boundary without replacing Git or the real SCM runtime.
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe('gitCheckpointAdapter runtime services', () => {
    it('rejects a mismatched installable key before running the Git command', async () => {
        const services = createGitCheckpointRuntimeServices();
        const result = await services.runCommand({
            installableKey: 'dep.sapling',
            command: 'git',
            cwd: process.cwd(),
            args: ['--version'],
            timeoutMs: 5000,
        });

        expect(result).toEqual({
            success: false,
            stdout: '',
            stderr: "Installable 'dep.sapling' does not authorize SCM command 'git'",
            exitCode: -1,
        });
    });

    it('keeps cached file stats for unchanged captures and captures dirty contents without changing the user index', async () => {
        const spawnImplementation = vi.mocked(spawn).getMockImplementation()!;
        const repoRoot = mkdtempSync(join(tmpdir(), 'happier-checkpoint-index-cost-'));
        const emptyStatCounts: number[] = [];
        try {
            execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
            const oldTime = new Date(Date.now() - 60_000);
            const paths = Array.from({ length: 1000 }, (_, index) => `file-${index}.txt`);
            for (const path of paths) {
                writeFileSync(join(repoRoot, path), 'unchanged\n');
                utimesSync(join(repoRoot, path), oldTime, oldTime);
            }
            execFileSync('git', ['add', '-A'], { cwd: repoRoot });
            execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial'], { cwd: repoRoot });
            const expectedTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, encoding: 'utf8' }).trim();
            const indexPath = join(repoRoot, '.git', 'index');
            const initialIndex = readFileSync(indexPath);
            const context = { cwd: repoRoot, projectKey: repoRoot,
                detection: { isRepo: true, rootPath: repoRoot, mode: '.git' as const } };
            const refs = buildRepositoryCheckpointRefs({ scopeId: `index-cost:${repoRoot}`, messageId: 'message', turnId: 'turn' });
            if (!refs.messageStart || !refs.turnFinal) throw new Error('Missing refs');
            // Observe Git's actual temporary index at the OS boundary before
            // staging. A tree-only index has zero sizes and re-hashes every file.
            vi.mocked(spawn).mockImplementation((...args) => {
                const [, commandArgs, options] = args;
                if (options?.cwd === repoRoot && Array.isArray(commandArgs) && commandArgs.includes('add')) {
                    const entries = execFileSync('git', ['ls-files', '--debug'], {
                        cwd: repoRoot, env: options.env, encoding: 'utf8',
                    });
                    emptyStatCounts.push([...entries.matchAll(/size: 0\s+flags:/g)].length);
                }
                return spawnImplementation(...args);
            });
            const unchanged = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.messageStart });
            expect(unchanged).toMatchObject({ success: true, treeSha: expectedTree });
            expect(emptyStatCounts).toEqual([0]);
            expect(readFileSync(indexPath)).toEqual(initialIndex);

            writeFileSync(join(repoRoot, paths[0]!), 'unstaged\n');
            unlinkSync(join(repoRoot, paths[1]!));
            writeFileSync(join(repoRoot, paths[2]!), 'staged\n');
            execFileSync('git', ['add', '--', paths[2]!], { cwd: repoRoot });
            writeFileSync(join(repoRoot, paths[2]!), 'staged then edited\n');
            writeFileSync(join(repoRoot, 'untracked.txt'), 'untracked\n');
            const dirtyIndex = readFileSync(indexPath);
            const changed = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal });
            expect(changed.success).toBe(true);
            if (!changed.success) throw new Error(changed.error);
            expect(execFileSync('git', ['show', `${changed.commitSha}:${paths[0]}`], { cwd: repoRoot, encoding: 'utf8' })).toBe('unstaged\n');
            expect(execFileSync('git', ['show', `${changed.commitSha}:${paths[2]}`], { cwd: repoRoot, encoding: 'utf8' })).toBe('staged then edited\n');
            expect(execFileSync('git', ['show', `${changed.commitSha}:untracked.txt`], { cwd: repoRoot, encoding: 'utf8' })).toBe('untracked\n');
            expect(execFileSync('git', ['ls-tree', '--name-only', changed.commitSha, '--', paths[1]!], { cwd: repoRoot, encoding: 'utf8' })).toBe('');
            expect(readFileSync(indexPath)).toEqual(dirtyIndex);
        } finally {
            vi.mocked(spawn).mockImplementation(spawnImplementation).mockClear();
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('reads many-file checkpoint comparisons with one Git diff and preserves literal paths, empty or unavailable evidence', async () => {
        const spawnImplementation = vi.mocked(spawn).getMockImplementation()!;
        const repoRoot = mkdtempSync(join(tmpdir(), 'happier-checkpoint-diff-cost-'));
        try {
            execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
            const context = { cwd: repoRoot, projectKey: repoRoot,
                detection: { isRepo: true, rootPath: repoRoot, mode: '.git' as const } };
            const refs = buildRepositoryCheckpointRefs({ scopeId: `cost:${repoRoot}`, messageId: 'message', turnId: 'turn' });
            if (!refs.messageStart || !refs.turnFinal) throw new Error('Missing refs');
            const paths = Array.from({ length: 150 }, (_, index) => `file-${String(index).padStart(3, '0')}.txt`);
            paths[0] = '-literal [1] café.txt';
            // Windows cannot create control characters in working-tree names.
            // Git's raw lineage must preserve every name legal on this host.
            if (process.platform !== 'win32') {
                paths[1] = 'literal\tfile.txt';
                paths[2] = 'literal\nfile.txt';
            }
            paths.forEach((path, index) => writeFileSync(join(repoRoot, path), `before ${index}\n`));
            expect((await gitCheckpointAdapter.capture({ context, checkpointRef: refs.messageStart })).success).toBe(true);
            paths.forEach((path, index) => writeFileSync(join(repoRoot, path), `after ${index}\n`));
            expect((await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal })).success).toBe(true);

            vi.mocked(spawn).mockClear();
            const result = await gitCheckpointAdapter.diff({ context, baseRef: refs.messageStart, finalRef: refs.turnFinal,
                baseRefSource: 'message_start', attributionScope: 'unknown' });
            expect(result.success).toBe(true);
            if (!result.success) throw new Error(result.error);
            const diffs = vi.mocked(spawn).mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === 'diff');
            expect(diffs).toHaveLength(1);
            expect(result.contentConfidence).toBe('exact');
            expect(result.files).toHaveLength(paths.length);
            paths.forEach((path, index) => {
                const file = result.files.find(entry => entry.filePath === path);
                expect(file?.unifiedDiff).toContain(`+after ${index}\n`);
                expect(file?.unifiedDiff).not.toContain(`+after ${(index + 1) % paths.length}\n`);
            });

            vi.mocked(spawn).mockClear();
            const empty = await gitCheckpointAdapter.diff({ context, baseRef: refs.messageStart, finalRef: refs.messageStart,
                baseRefSource: 'message_start', attributionScope: 'unknown' });
            expect(empty).toMatchObject({ success: true, files: [], contentConfidence: 'exact' });
            expect(vi.mocked(spawn).mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === 'diff')).toHaveLength(1);

            // Make only the external patch command fail; inventory still comes
            // from real Git and must remain visible with honest missing evidence.
            vi.mocked(spawn).mockImplementation((...args) => {
                const [command, commandArgs, options] = args;
                if (options?.cwd === repoRoot && Array.isArray(commandArgs)
                    && commandArgs[0] === 'diff' && commandArgs.includes('--patch')) {
                    return spawnImplementation(command, [commandArgs[0], '--happier-invalid-patch-option', ...commandArgs.slice(1)], options);
                }
                return spawnImplementation(...args);
            });
            const unavailable = await gitCheckpointAdapter.diff({ context, baseRef: refs.messageStart, finalRef: refs.turnFinal,
                baseRefSource: 'message_start', attributionScope: 'unknown' });
            expect(unavailable.success).toBe(true);
            if (!unavailable.success) throw new Error(unavailable.error);
            expect(unavailable.contentConfidence).toBe('unavailable');
            expect(unavailable.files).toHaveLength(paths.length);
            expect(unavailable.files.every(file => file.unifiedDiff === undefined && file.confidence === 'best_effort')).toBe(true);
        } finally {
            vi.mocked(spawn).mockImplementation(spawnImplementation).mockClear();
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('retains complete readable checkpoint diffs beyond process output limits', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'happier-checkpoint-large-diff-'));
        try {
        execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        const context = { cwd: repoRoot, projectKey: repoRoot, detection: { isRepo: true, rootPath: repoRoot, mode: '.git' as const } };
        const refs = buildRepositoryCheckpointRefs({ scopeId: `large:${repoRoot}`, messageId: 'message', turnId: 'turn' });
        if (!refs.messageStart || !refs.turnFinal) throw new Error('Missing refs');
        writeFileSync(join(repoRoot, 'large.txt'), 'before\n');
        expect((await gitCheckpointAdapter.capture({ context, checkpointRef: refs.messageStart })).success).toBe(true);
        const content = Array.from({ length: 70000 }, (_, index) => `${index}: ${'content'.repeat(10)}\n`).join('');
        writeFileSync(join(repoRoot, 'large.txt'), content);
        expect((await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal })).success).toBe(true);
        const result = await gitCheckpointAdapter.diff({ context, baseRef: refs.messageStart, finalRef: refs.turnFinal,
            baseRefSource: 'message_start', attributionScope: 'unknown' });
        expect(result.success).toBe(true);
        if (!result.success) throw new Error(result.error);
        expect(result.files[0]?.unifiedDiff).toContain('+69999:');
        expect(result.files[0]?.unifiedDiff?.length).toBeGreaterThan(4 * 1024 * 1024);
        } finally { rmSync(repoRoot, { recursive: true, force: true }); }
    });
});
