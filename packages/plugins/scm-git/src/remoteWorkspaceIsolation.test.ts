import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readUntrackedFileStats,
    runWithBackendRuntimeServices,
    type BackendRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/backend';

import { getGitWorktreesEnrichment } from './repository.js';
import { readWorktreeStatusEnrichmentForPaths } from './worktreeStatusEnricher.js';
import { gitBlameFile } from './operations/readOperations.js';
import type { ScmBackendContext } from './types.js';

const PLUGINS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGES_ROOT = resolve(PLUGINS_ROOT, '..');

async function collectProductionTsFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'testkit' || entry.name === '__tests__') {
                continue;
            }
            out.push(...await collectProductionTsFiles(fullPath));
            continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
        if (
            entry.name.endsWith('.test.ts')
            || entry.name.endsWith('.spec.ts')
            || entry.name.endsWith('.test-support.ts')
            || entry.name.endsWith('.testkit.ts')
        ) {
            continue;
        }
        out.push(fullPath);
    }
    return out;
}

function makeVirtualFileSystem(overrides: Partial<NonNullable<BackendRuntimeServices['repositoryFileSystem']>>): NonNullable<BackendRuntimeServices['repositoryFileSystem']> {
    const unexpected = (op: string) => async (...args: unknown[]): Promise<never> => {
        throw new Error(`Unexpected repositoryFileSystem.${op}(${JSON.stringify(args)})`);
    };
    return {
        lstat: unexpected('lstat'),
        realpath: unexpected('realpath'),
        readFile: unexpected('readFile'),
        writeFile: unexpected('writeFile'),
        stat: unexpected('stat'),
        mkdir: unexpected('mkdir'),
        mkdtemp: unexpected('mkdtemp'),
        rm: unexpected('rm'),
        readdir: unexpected('readdir'),
        rename: unexpected('rename'),
        rmdir: unexpected('rmdir'),
        unlink: unexpected('unlink'),
        writeExclusiveFile: unexpected('writeExclusiveFile'),
        ...overrides,
    };
}

function makeEnoent(path: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

describe('SCM remote workspace zero-local-fallback isolation', () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
        await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => undefined)));
    });

    it('bans raw node:fs / fs and local canonicalizePath imports across packages/plugins/scm-* production source', async () => {
        const pluginDirs = (await readdir(PLUGINS_ROOT, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('scm-'))
            .map((entry) => entry.name)
            .sort();

        expect(pluginDirs).toContain('scm-git');
        expect(pluginDirs).toContain('scm-sapling');

        const allowedRawFsFiles = new Set([
            // Single standalone-only fallback gate per SCM plugin; must fail closed when host-bound.
            'scm-git/src/repositoryFileSystem.ts',
            'scm-sapling/src/repositoryFileSystem.ts',
            // Host-local staging directory (`input.artifactDirectory`), never workspace disk.
            'scm-git/src/operations/exportCommit.ts',
        ]);

        const rawFsPattern = /(?:from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)|import\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\))/;
        const localCanonicalizePattern = /\bcanonicalizePath(?:Sync)?\b/;

        const violations: string[] = [];

        for (const pluginDir of pluginDirs) {
            const srcDir = join(PLUGINS_ROOT, pluginDir, 'src');
            let exists = false;
            try {
                exists = (await lstat(srcDir)).isDirectory();
            } catch {
                exists = false;
            }
            if (!exists) continue;

            const files = await collectProductionTsFiles(srcDir);
            for (const file of files) {
                const rel = relative(PLUGINS_ROOT, file).replace(/\\/g, '/');
                const content = await readFile(file, 'utf8');

                if (rawFsPattern.test(content) && !allowedRawFsFiles.has(rel)) {
                    violations.push(`${rel}: forbidden raw node:fs/fs import`);
                }
                if (localCanonicalizePattern.test(content)) {
                    violations.push(`${rel}: forbidden local-disk canonicalizePath import/usage`);
                }
            }
        }

        // Verify the two standalone fallback gates still enforce fail-closed host isolation.
        for (const gateRel of ['scm-git/src/repositoryFileSystem.ts', 'scm-sapling/src/repositoryFileSystem.ts']) {
            const gateContent = await readFile(join(PLUGINS_ROOT, gateRel), 'utf8');
            if (!gateContent.includes('readCurrentBackendRuntimeServices') || !gateContent.includes('BACKEND_UNAVAILABLE')) {
                violations.push(`${gateRel}: standalone gate must fail closed with BACKEND_UNAVAILABLE when host-bound`);
            }
        }

        // Verify plugin-sdk readUntrackedFileStats routes through runtime services and fails closed.
        const untrackedStatsSource = await readFile(
            join(PACKAGES_ROOT, 'plugin-sdk/src/scm/readUntrackedFileStats.ts'),
            'utf8',
        );
        if (!untrackedStatsSource.includes('readCurrentBackendRuntimeServices') || !untrackedStatsSource.includes('BACKEND_UNAVAILABLE')) {
            violations.push('plugin-sdk/src/scm/readUntrackedFileStats.ts: must route via readCurrentBackendRuntimeServices and fail closed');
        }

        expect(violations).toEqual([]);
    });

    it('readUntrackedFileStats reads exclusively from repositoryFileSystem and never falls back to local disk', async () => {
        const localDir = await mkdtemp(join(tmpdir(), 'scm-rws-untracked-local-'));
        cleanups.push(() => rm(localDir, { recursive: true, force: true }));
        // Put a decoy file with 50 lines on local disk at the exact same path.
        await writeFile(join(localDir, 'note.txt'), 'local\n'.repeat(50), 'utf8');

        const lstatSpy = vi.fn(async (targetPath: string) => {
            if (targetPath === join(localDir, 'note.txt')) {
                return { dev: 1, ino: 1, size: 12, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
            }
            if (targetPath === join(localDir, 'link')) {
                return { dev: 1, ino: 2, size: 6, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
            }
            throw makeEnoent(targetPath);
        });
        const readFileSpy = vi.fn(async (targetPath: string) => {
            if (targetPath === join(localDir, 'note.txt')) {
                return Buffer.from('remote1\nremote2\n', 'utf8');
            }
            throw makeEnoent(targetPath);
        });
        const readlinkSpy = vi.fn(async (targetPath: string) => {
            if (targetPath === join(localDir, 'link')) {
                return 'target';
            }
            throw makeEnoent(targetPath);
        });

        const stats = await runWithBackendRuntimeServices({
            runCommand: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }),
            repositoryFileSystem: makeVirtualFileSystem({
                lstat: lstatSpy,
                readFile: readFileSpy,
                readlink: readlinkSpy,
            }),
        }, () => readUntrackedFileStats(localDir, ['note.txt', 'link']));

        expect(stats).toEqual({
            'note.txt': { pendingAdded: 2, isBinary: false },
            link: { pendingAdded: 1, isBinary: false },
        });
        expect(lstatSpy).toHaveBeenCalledTimes(2);
        expect(readFileSpy).toHaveBeenCalledTimes(1);
        expect(readlinkSpy).toHaveBeenCalledTimes(1);

        // When host runtime services omit repositoryFileSystem, fail closed rather than reading local disk.
        await expect(runWithBackendRuntimeServices({
            runCommand: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }),
        }, () => readUntrackedFileStats(localDir, ['note.txt']))).rejects.toMatchObject({
            code: 'BACKEND_UNAVAILABLE',
        });
    });

    it('worktreeStatusEnricher reads lockReason and activity mtimes exclusively via repositoryFileSystem with commandPaths mapping', async () => {
        const remoteRoot = '/remote-virtual-workspace-never-on-disk/repo';
        const guestRoot = '/workspace/repo';
        const commandPaths = {
            toCommandPath: (p: string) => p.replace(remoteRoot, guestRoot),
            fromCommandPath: (p: string) => p.replace(guestRoot, remoteRoot),
        };

        const readFileSpy = vi.fn(async (targetPath: string) => {
            if (targetPath === `${remoteRoot}/.git/locked`) {
                return Buffer.from('remote-lock-reason\n', 'utf8');
            }
            throw makeEnoent(targetPath);
        });
        const statSpy = vi.fn(async (targetPath: string) => {
            if (targetPath === `${remoteRoot}/.git/HEAD`) {
                return { isDirectory: () => false, isFile: () => true, mtimeMs: 1_700_000_123_000 };
            }
            throw makeEnoent(targetPath);
        });

        const entries = await runWithBackendRuntimeServices({
            repositoryFileSystem: makeVirtualFileSystem({
                commandPaths,
                readFile: readFileSpy,
                stat: statSpy,
            }),
            async runCommand(input) {
                const args = input.args.join(' ');
                if (args === 'status --porcelain -z') return { success: true, stdout: ' M a.txt\0', stderr: '', exitCode: 0 };
                if (args === 'ls-files --stage -z') return { success: true, stdout: '', stderr: '', exitCode: 0 };
                if (args === 'rev-parse --verify HEAD') return { success: true, stdout: 'a'.repeat(40) + '\n', stderr: '', exitCode: 0 };
                if (args === 'symbolic-ref --quiet --short HEAD') return { success: true, stdout: 'main\n', stderr: '', exitCode: 0 };
                if (args.includes('--git-dir')) return { success: true, stdout: `${guestRoot}/.git\n`, stderr: '', exitCode: 0 };
                if (args.includes('--git-common-dir')) return { success: true, stdout: `${guestRoot}/.git\n`, stderr: '', exitCode: 0 };
                if (args.includes('--show-toplevel')) return { success: true, stdout: `${guestRoot}\n`, stderr: '', exitCode: 0 };
                if (args.startsWith('reflog')) return { success: true, stdout: '', stderr: '', exitCode: 0 };
                if (args.includes('refs/heads/main')) return { success: true, stdout: '', stderr: '', exitCode: 0 };
                if (args.includes('refs/remotes/*/HEAD')) return { success: true, stdout: '', stderr: '', exitCode: 0 };
                if (args.startsWith('rev-list --count')) return { success: true, stdout: '0\n', stderr: '', exitCode: 0 };
                if (args.startsWith('config --local')) return { success: false, stdout: '', stderr: '', exitCode: 1 };
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        }, () => readWorktreeStatusEnrichmentForPaths({ worktreePaths: [remoteRoot] }));

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            path: remoteRoot,
            changeCount: 1,
            isLocked: true,
            lockReason: 'remote-lock-reason',
            lastActivityAt: 1_700_000_123_000,
        });
        expect(readFileSpy).toHaveBeenCalledWith(`${remoteRoot}/.git/locked`);
        expect(statSpy).toHaveBeenCalledWith(`${remoteRoot}/.git/HEAD`);
    });

    it('getGitWorktreesEnrichment canonicalizes worktree paths via repositoryFileSystem.realpath', async () => {
        const remoteRoot = '/remote-virtual-workspace-never-on-disk/repo';
        const remoteAlias = '/remote-virtual-workspace-never-on-disk/alias';
        const realpathSpy = vi.fn(async (targetPath: string) => {
            if (targetPath === remoteAlias || targetPath === remoteRoot) return remoteRoot;
            throw makeEnoent(targetPath);
        });

        const context: ScmBackendContext = {
            cwd: remoteRoot,
            projectKey: `remote:${remoteRoot}`,
            detection: { isRepo: true, rootPath: remoteRoot, mode: '.git' },
        };

        const response = await runWithBackendRuntimeServices({
            repositoryFileSystem: makeVirtualFileSystem({
                realpath: realpathSpy,
                lstat: async (p) => { throw makeEnoent(p); },
                stat: async (p) => { throw makeEnoent(p); },
                readFile: async (p) => { throw makeEnoent(p); },
            }),
            async runCommand(input) {
                const args = input.args.join(' ');
                if (args === 'worktree list --porcelain -z') {
                    return { success: true, stdout: `worktree ${remoteRoot}\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0\0`, stderr: '', exitCode: 0 };
                }
                if (args === 'status --porcelain -z') return { success: true, stdout: '', stderr: '', exitCode: 0 };
                if (args === 'ls-files --stage -z') return { success: true, stdout: '', stderr: '', exitCode: 0 };
                if (args === 'rev-parse --verify HEAD') return { success: true, stdout: `${'a'.repeat(40)}\n`, stderr: '', exitCode: 0 };
                if (args === 'symbolic-ref --quiet --short HEAD') return { success: true, stdout: 'main\n', stderr: '', exitCode: 0 };
                if (args.includes('--git-dir')) return { success: true, stdout: `${remoteRoot}/.git\n`, stderr: '', exitCode: 0 };
                if (args.includes('--git-common-dir')) return { success: true, stdout: `${remoteRoot}/.git\n`, stderr: '', exitCode: 0 };
                if (args.includes('--show-toplevel')) return { success: true, stdout: `${remoteRoot}\n`, stderr: '', exitCode: 0 };
                return { success: false, stdout: '', stderr: '', exitCode: 1 };
            },
        }, () => getGitWorktreesEnrichment({
            context,
            request: { worktreePaths: [remoteAlias] },
        }));

        expect(response.success).toBe(true);
        expect(response.worktrees).toHaveLength(1);
        expect(response.worktrees?.[0]?.path).toBe(remoteRoot);
        expect(realpathSpy).toHaveBeenCalledWith(remoteAlias);
        expect(realpathSpy).toHaveBeenCalledWith(remoteRoot);
    });

    it('gitBlameFile reads realpath, lstat, and file bytes exclusively via repositoryFileSystem', async () => {
        const remoteRoot = '/remote-virtual-workspace-never-on-disk/repo';
        const remoteFile = `${remoteRoot}/hello.ts`;
        const fileBytes = Buffer.from('const x = 1;\n', 'utf8');
        const sha = 'a'.repeat(40);

        const realpathSpy = vi.fn(async (p: string) => p);
        const lstatSpy = vi.fn(async (p: string) => {
            if (p === remoteFile) {
                return { dev: 1, ino: 1, size: fileBytes.length, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
            }
            throw makeEnoent(p);
        });
        const readFileSpy = vi.fn(async (p: string) => {
            if (p === remoteFile) return fileBytes;
            throw makeEnoent(p);
        });

        const context: ScmBackendContext = {
            cwd: remoteRoot,
            projectKey: `remote:${remoteRoot}`,
            detection: { isRepo: true, rootPath: remoteRoot, mode: '.git' },
        };

        const blamePayload = [
            `${sha} 1 1 1`,
            'author Remote Dev',
            'author-mail <dev@example.test>',
            'author-time 1700000000',
            'summary initial',
            'filename hello.ts',
            '',
        ].join('\n');

        const response = await runWithBackendRuntimeServices({
            repositoryFileSystem: makeVirtualFileSystem({
                realpath: realpathSpy,
                lstat: lstatSpy,
                readFile: readFileSpy,
            }),
            async runCommand(input) {
                if (input.args[0] === 'ls-files') {
                    return { success: true, stdout: 'hello.ts\n', stderr: '', exitCode: 0 };
                }
                return { success: false, stdout: '', stderr: 'unexpected buffered command', exitCode: 1 };
            },
            async runCommandStreaming(input) {
                if (input.args[0] === 'blame') {
                    input.stdoutConsumer(Buffer.from(blamePayload, 'utf8'));
                    return { success: true, stdout: '', stderr: '', exitCode: 0 };
                }
                return { success: false, stdout: '', stderr: 'unexpected stream command', exitCode: 1 };
            },
        }, () => gitBlameFile({
            context,
            request: { path: 'hello.ts' },
        }));

        expect(response).toMatchObject({
            success: true,
            ranges: [{ startLine: 1, lineCount: 1, commitIndex: 0 }],
            commits: [{ sha, authorName: 'Remote Dev', summary: 'initial' }],
        });
        expect(realpathSpy).toHaveBeenCalledWith(remoteRoot);
        expect(realpathSpy).toHaveBeenCalledWith(remoteFile);
        expect(lstatSpy).toHaveBeenCalledWith(remoteFile);
        expect(readFileSpy).toHaveBeenCalledTimes(2);
    });
});
