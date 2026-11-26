import { describe, expect, it } from 'vitest';

import {
    runWithBackendRuntimeServices,
    type BackendCommandRunInput,
    type BackendCommandRunResult,
    type BackendRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/backend';

import { getGitSnapshot } from './repository.js';
import { readGitBranchOperationState } from './operations/branchOperationState.js';
import type { ScmBackendContext } from './types.js';

type RecordedOp = Readonly<{
    wave: number;
    kind: 'command' | 'fs';
    label: string;
}>;

/**
 * Deterministic sequential RTT wave tracker.
 * Every op dispatched before the current macrotask turn settles shares one wave
 * (modeling concurrent in-flight requests on a multiplexed remote channel).
 * Any op dispatched after awaiting a prior op's result opens a new sequential wave.
 */
function createRttWaveTracker() {
    let waveCount = 0;
    let activeWave: { id: number; waiters: Array<() => void> } | null = null;
    const ops: RecordedOp[] = [];

    function schedule<T>(kind: 'command' | 'fs', label: string, run: () => T | Promise<T>): Promise<T> {
        if (!activeWave) {
            waveCount += 1;
            const wave = { id: waveCount, waiters: [] as Array<() => void> };
            activeWave = wave;
            setImmediate(() => {
                if (activeWave === wave) activeWave = null;
                for (const resume of wave.waiters) resume();
            });
        }
        const wave = activeWave;
        ops.push({ wave: wave.id, kind, label });
        return new Promise<void>((resolve) => {
            wave.waiters.push(resolve);
        }).then(() => run());
    }

    return {
        schedule,
        get waveCount() {
            return waveCount;
        },
        get ops(): readonly RecordedOp[] {
            return ops;
        },
    };
}

function makeEnoent(path: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

function createSyntheticRemoteGitHarness(options: Readonly<{
    repoRoot?: string;
    statusOutput: string;
    upstreamOid?: string;
    includedNumStatOutput?: string;
    pendingNumStatOutput?: string;
    untrackedFiles?: Readonly<Record<string, string>>;
    gitStateFiles?: Readonly<Record<string, string>>;
    gitStateDirs?: readonly string[];
}>) {
    const repoRoot = options.repoRoot ?? '/remote/repo';
    const gitDir = `${repoRoot}/.git`;
    const headOid = 'a'.repeat(40);
    const tracker = createRttWaveTracker();
    const commands: string[][] = [];

    const gitStateDirs = new Set(options.gitStateDirs ?? []);
    const gitStateFiles = options.gitStateFiles ?? {};
    const untrackedFiles = options.untrackedFiles ?? {};

    const repositoryFileSystem: NonNullable<BackendRuntimeServices['repositoryFileSystem']> = {
        stat: (targetPath) => tracker.schedule('fs', `stat:${targetPath}`, () => {
            if (gitStateDirs.has(targetPath)) {
                return { isDirectory: () => true, isFile: () => false, mtimeMs: 1_700_000_000_000 };
            }
            throw makeEnoent(targetPath);
        }),
        lstat: (targetPath) => tracker.schedule('fs', `lstat:${targetPath}`, () => {
            const rel = targetPath.startsWith(`${repoRoot}/`) ? targetPath.slice(repoRoot.length + 1) : null;
            if (rel !== null && Object.prototype.hasOwnProperty.call(untrackedFiles, rel)) {
                const content = untrackedFiles[rel]!;
                return {
                    dev: 1,
                    ino: 100,
                    size: Buffer.byteLength(content, 'utf8'),
                    isFile: () => true,
                    isDirectory: () => false,
                    isSymbolicLink: () => false,
                };
            }
            throw makeEnoent(targetPath);
        }),
        readFile: (targetPath) => tracker.schedule('fs', `readFile:${targetPath}`, () => {
            if (Object.prototype.hasOwnProperty.call(gitStateFiles, targetPath)) {
                return Buffer.from(gitStateFiles[targetPath]!, 'utf8');
            }
            const rel = targetPath.startsWith(`${repoRoot}/`) ? targetPath.slice(repoRoot.length + 1) : null;
            if (rel !== null && Object.prototype.hasOwnProperty.call(untrackedFiles, rel)) {
                return Buffer.from(untrackedFiles[rel]!, 'utf8');
            }
            throw makeEnoent(targetPath);
        }),
        readlink: (targetPath) => tracker.schedule('fs', `readlink:${targetPath}`, () => {
            throw makeEnoent(targetPath);
        }),
        realpath: (targetPath) => tracker.schedule('fs', `realpath:${targetPath}`, () => targetPath),
        writeFile: async () => { throw new Error('unexpected writeFile'); },
        mkdir: async () => { throw new Error('unexpected mkdir'); },
        mkdtemp: async () => { throw new Error('unexpected mkdtemp'); },
        rm: async () => { throw new Error('unexpected rm'); },
        readdir: async () => { throw new Error('unexpected readdir'); },
        rename: async () => { throw new Error('unexpected rename'); },
        rmdir: async () => { throw new Error('unexpected rmdir'); },
        unlink: async () => { throw new Error('unexpected unlink'); },
        writeExclusiveFile: async () => { throw new Error('unexpected writeExclusiveFile'); },
    };

    const runCommand = (input: BackendCommandRunInput): Promise<BackendCommandRunResult> => {
        commands.push([...input.args]);
        return tracker.schedule('command', `git ${input.args.join(' ')}`, (): BackendCommandRunResult => {
            const args = input.args;
            if (args[0] === 'status') {
                return { success: true, stdout: options.statusOutput, stderr: '', exitCode: 0 };
            }
            if (args[0] === 'diff' && args.includes('--cached')) {
                return { success: true, stdout: options.includedNumStatOutput ?? '', stderr: '', exitCode: 0 };
            }
            if (args[0] === 'diff') {
                return { success: true, stdout: options.pendingNumStatOutput ?? '', stderr: '', exitCode: 0 };
            }
            if (args[0] === 'worktree' && args[1] === 'list') {
                return {
                    success: true,
                    stdout: `worktree ${repoRoot}\0HEAD ${headOid}\0branch refs/heads/main\0\0`,
                    stderr: '',
                    exitCode: 0,
                };
            }
            if (args[0] === 'remote' && args[1] === '-v') {
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            }
            if (args[0] === 'for-each-ref') {
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            }
            if (args[0] === 'rev-parse' && args.includes('--git-path')) {
                const resolved: string[] = [];
                for (let i = 0; i < args.length; i += 1) {
                    if (args[i] === '--git-path' && args[i + 1]) {
                        resolved.push(`${gitDir}/${args[i + 1]}`);
                    }
                }
                return { success: true, stdout: `${resolved.join('\n')}\n`, stderr: '', exitCode: 0 };
            }
            if (args[0] === 'rev-parse' && args.includes('HEAD^{commit}')) {
                return { success: true, stdout: `${headOid}\n`, stderr: '', exitCode: 0 };
            }
            if (args[0] === 'symbolic-ref') {
                return { success: true, stdout: 'main\n', stderr: '', exitCode: 0 };
            }
            if (args[0] === 'rev-parse' && args.includes('@{upstream}')) {
                return options.upstreamOid
                    ? { success: true, stdout: 'origin/main\n', stderr: '', exitCode: 0 }
                    : { success: false, stdout: '', stderr: 'fatal: no upstream configured', exitCode: 128 };
            }
            if (args[0] === 'rev-parse' && args.includes('@{upstream}^{commit}')) {
                return options.upstreamOid
                    ? { success: true, stdout: `${options.upstreamOid}\n`, stderr: '', exitCode: 0 }
                    : { success: false, stdout: '', stderr: 'fatal: no upstream', exitCode: 128 };
            }
            if (args[0] === 'rev-list' && args.includes('--left-right')) {
                return options.upstreamOid
                    ? { success: true, stdout: '2\t1\n', stderr: '', exitCode: 0 }
                    : { success: false, stdout: '', stderr: 'fatal: bad revision', exitCode: 128 };
            }
            return { success: false, stdout: '', stderr: `unexpected git command: ${args.join(' ')}`, exitCode: 1 };
        });
    };

    const context: ScmBackendContext = {
        cwd: repoRoot,
        projectKey: `remote:${repoRoot}`,
        detection: { isRepo: true, rootPath: repoRoot, mode: '.git' },
    };

    return {
        context,
        tracker,
        commands,
        run<T>(fn: () => Promise<T>): Promise<T> {
            return runWithBackendRuntimeServices({ runCommand, repositoryFileSystem }, fn);
        },
    };
}

describe('scm.status.snapshot RTT and process cost contract', () => {
    it('completes a clean full snapshot in <= 2 sequential RTT waves with 0 diff --numstat spawns', async () => {
        const harness = createSyntheticRemoteGitHarness({
            statusOutput: `# branch.oid ${'a'.repeat(40)}\0# branch.head main\0`,
        });

        const response = await harness.run(() => getGitSnapshot({
            context: harness.context,
            request: { operationStateVersion: 1 },
        }));

        expect(response.success).toBe(true);
        expect(harness.tracker.waveCount).toBeLessThanOrEqual(2);
        // Zero diff --numstat spawns on a clean working copy/index.
        expect(harness.commands.filter((args) => args[0] === 'diff' && args.includes('--numstat'))).toEqual([]);
        // All 6 operation-state FS probes run in a single concurrent wave.
        const fsWaves = new Set(harness.tracker.ops.filter((op) => op.kind === 'fs').map((op) => op.wave));
        expect(fsWaves.size).toBe(1);
    });

    it('skips staged diff --numstat when only working-tree tracked files changed, in <= 2 RTT waves', async () => {
        const harness = createSyntheticRemoteGitHarness({
            statusOutput: [
                `# branch.oid ${'a'.repeat(40)}`,
                '# branch.head main',
                '1 .M N... 100644 100644 100644 ' + 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' README.md',
                '',
            ].join('\0'),
            pendingNumStatOutput: '3\t1\tREADME.md\0',
        });

        const response = await harness.run(() => getGitSnapshot({
            context: harness.context,
            request: { operationStateVersion: 1 },
        }));

        expect(response).toMatchObject({
            success: true,
            snapshot: {
                entries: [{ path: 'README.md', stats: { pendingAdded: 3, pendingRemoved: 1 } }],
            },
        });
        expect(harness.tracker.waveCount).toBeLessThanOrEqual(2);
        const numstatCommands = harness.commands.filter((args) => args[0] === 'diff' && args.includes('--numstat'));
        expect(numstatCommands).toHaveLength(1);
        expect(numstatCommands[0]).not.toContain('--cached');
    });

    it('completes a dirty snapshot with staged, unstaged, and upstream refs in <= 2 RTT waves', async () => {
        const upstreamOid = 'b'.repeat(40);
        const harness = createSyntheticRemoteGitHarness({
            statusOutput: [
                `# branch.oid ${'a'.repeat(40)}`,
                '# branch.head main',
                '# branch.upstream origin/main',
                '# branch.ab +1 -0',
                '1 MM N... 100644 100644 100644 ' + 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' app.ts',
                '',
            ].join('\0'),
            upstreamOid,
            includedNumStatOutput: '2\t0\tapp.ts\0',
            pendingNumStatOutput: '4\t1\tapp.ts\0',
        });

        const response = await harness.run(() => getGitSnapshot({
            context: harness.context,
            request: { operationStateVersion: 1 },
        }));

        expect(response).toMatchObject({
            success: true,
            snapshot: {
                branch: { upstream: 'origin/main', upstreamOid },
                entries: [{ path: 'app.ts', stats: { includedAdded: 2, pendingAdded: 4, pendingRemoved: 1 } }],
            },
        });
        expect(harness.tracker.waveCount).toBeLessThanOrEqual(2);
        const numstatCommands = harness.commands.filter((args) => args[0] === 'diff' && args.includes('--numstat'));
        expect(numstatCommands).toHaveLength(2);
    });

    it('completes untracked-only snapshots with 0 diff --numstat spawns and O(1) untracked stat waves', async () => {
        const untrackedFiles: Record<string, string> = {};
        const untrackedLines: string[] = [];
        for (let i = 0; i < 6; i += 1) {
            untrackedFiles[`u${i}.txt`] = `line1\nline2\n`;
            untrackedLines.push(`? u${i}.txt`);
        }
        const harness = createSyntheticRemoteGitHarness({
            statusOutput: [
                `# branch.oid ${'a'.repeat(40)}`,
                '# branch.head main',
                ...untrackedLines,
                '',
            ].join('\0'),
            untrackedFiles,
        });

        const response = await harness.run(() => getGitSnapshot({
            context: harness.context,
            request: { operationStateVersion: 1 },
        }));

        expect(response.success).toBe(true);
        expect(response.snapshot?.entries).toHaveLength(6);
        expect(response.snapshot?.totals.pendingAdded).toBe(12);
        expect(harness.commands.filter((args) => args[0] === 'diff' && args.includes('--numstat'))).toEqual([]);
        // Wave 1: git cmds; Wave 2: 6 op-state probes + 6 untracked lstats; Wave 3: 6 untracked readFiles (O(1) not O(6)).
        expect(harness.tracker.waveCount).toBeLessThanOrEqual(3);
    });

    it('collapses detail: "facts" snapshot to 1 RTT wave with zero status/diff/FS probes', async () => {
        const harness = createSyntheticRemoteGitHarness({
            statusOutput: '',
            upstreamOid: 'b'.repeat(40),
        });

        const response = await harness.run(() => getGitSnapshot({
            context: harness.context,
            request: { detail: 'facts' },
        }));

        expect(response).toMatchObject({
            success: true,
            snapshot: {
                detail: 'facts',
                branch: { head: 'main', headOid: 'a'.repeat(40), upstream: 'origin/main', ahead: 2, behind: 1 },
            },
        });
        expect(harness.tracker.waveCount).toBe(1);
        expect(harness.tracker.ops.filter((op) => op.kind === 'fs')).toEqual([]);
        expect(harness.commands.filter((args) => args[0] === 'status' || args[0] === 'diff')).toEqual([]);
    });

    it('parallelizes all 6 branch operation-state probes into 1 FS wave (2 waves total including rev-parse)', async () => {
        const harness = createSyntheticRemoteGitHarness({
            statusOutput: '',
        });

        const state = await harness.run(() => readGitBranchOperationState(harness.context, 'a'.repeat(40)));
        expect(state).toBeNull();
        expect(harness.tracker.waveCount).toBe(2);
        const fsWaves = new Set(harness.tracker.ops.filter((op) => op.kind === 'fs').map((op) => op.wave));
        expect(fsWaves.size).toBe(1);
    });
});
