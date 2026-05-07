import { chmod, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend } from '@/scm/types';
import type { WorkspaceManifestEntry } from '@/scm/sourceController/workspaceExportPackaging/buildWorkspaceManifestEntry';
import { scanWorkspaceManifest, type ScannedWorkspaceFile } from './scanWorkspaceManifest';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

function createAdministrativePathTestBackend(matchesAdministrativeWorkspacePath: (relativePath: string) => boolean): ScmBackend {
    return {
        id: 'sapling',
        selection: {
            modeSelectionScores: {
                '.git': 200,
            },
        },
        sourceController: {
            inspectWorkspaceLocation: async () => null,
            isAdministrativeWorkspacePath: ({ relativePath }) => matchesAdministrativeWorkspacePath(relativePath),
        },
        detectRepo: async () => ({
            isRepo: true,
            mode: '.git',
            rootPath: '/repo',
        }),
        getCapabilities: () => ({
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            readBranches: true,
            readStash: true,
            writeInclude: true,
            writeExclude: true,
            writeDiscard: true,
            writeCommit: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            writeRemotePublish: true,
            worktreeCreate: false,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
            writeBranchCreate: true,
            writeBranchCheckout: true,
            writeStash: true,
        }),
        describeBackend: async () => {
            throw new Error('not needed in this test');
        },
        statusSnapshot: async () => {
            throw new Error('not needed in this test');
        },
        diffFile: async () => {
            throw new Error('not needed in this test');
        },
        diffCommit: async () => {
            throw new Error('not needed in this test');
        },
        changeInclude: async () => {
            throw new Error('not needed in this test');
        },
        changeExclude: async () => {
            throw new Error('not needed in this test');
        },
        changeDiscard: async () => {
            throw new Error('not needed in this test');
        },
        commitCreate: async () => {
            throw new Error('not needed in this test');
        },
        commitBackout: async () => {
            throw new Error('not needed in this test');
        },
        logList: async () => {
            throw new Error('not needed in this test');
        },
        branchList: async () => {
            throw new Error('not needed in this test');
        },
        branchCreate: async () => {
            throw new Error('not needed in this test');
        },
        branchCheckout: async () => {
            throw new Error('not needed in this test');
        },
        branchMerge: async () => {
            throw new Error('not needed in this test');
        },
        branchRebase: async () => {
            throw new Error('not needed in this test');
        },
        branchOperationContinue: async () => {
            throw new Error('not needed in this test');
        },
        branchOperationAbort: async () => {
            throw new Error('not needed in this test');
        },
        worktreeCreate: async () => {
            throw new Error('not needed in this test');
        },
        worktreeRemove: async () => {
            throw new Error('not needed in this test');
        },
        worktreePrune: async () => {
            throw new Error('not needed in this test');
        },
        remoteAdd: async () => {
            throw new Error('not needed in this test');
        },
        remoteSetUrl: async () => {
            throw new Error('not needed in this test');
        },
        remoteRemove: async () => {
            throw new Error('not needed in this test');
        },
        remoteFetch: async () => {
            throw new Error('not needed in this test');
        },
        remotePull: async () => {
            throw new Error('not needed in this test');
        },
        remotePush: async () => {
            throw new Error('not needed in this test');
        },
        remotePublish: async () => {
            throw new Error('not needed in this test');
        },
        stashList: async () => {
            throw new Error('not needed in this test');
        },
        stashDrop: async () => {
            throw new Error('not needed in this test');
        },
        stashPop: async () => {
            throw new Error('not needed in this test');
        },
        stashApply: async () => {
            throw new Error('not needed in this test');
        },
        stashShow: async () => {
            throw new Error('not needed in this test');
        },
    } satisfies ScmBackend;
}

describe('scanWorkspaceManifest', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('scans workspace entries recursively into a canonical relative-path-sorted manifest', async () => {
        const root = await makeTempDir('workspace-manifest-');
        await mkdir(join(root, 'bin'), { recursive: true });
        await mkdir(join(root, 'src', 'nested'), { recursive: true });
        await writeFile(join(root, 'README.md'), 'hello\n');
        await writeFile(join(root, 'bin', 'run.sh'), '#!/bin/sh\nexit 0\n');
        await chmod(join(root, 'bin', 'run.sh'), 0o755);
        await writeFile(join(root, 'src', 'nested', 'index.ts'), 'export const value = 1;\n');
        await symlink('../README.md', join(root, 'src', 'readme-link'));

        await expect(scanWorkspaceManifest({ workspaceRoot: root })).resolves.toEqual({
            entries: [
                {
                    kind: 'directory',
                    relativePath: 'bin',
                },
                {
                    kind: 'file',
                    relativePath: 'bin/run.sh',
                    digest: 'sha256:306c6ca7407560340797866e077e053627ad409277d1b9da58106fce4cf717cb',
                    executable: true,
                    sizeBytes: 17,
                },
                {
                    kind: 'file',
                    relativePath: 'README.md',
                    digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                    executable: false,
                    sizeBytes: 6,
                },
                {
                    kind: 'directory',
                    relativePath: 'src',
                },
                {
                    kind: 'directory',
                    relativePath: 'src/nested',
                },
                {
                    kind: 'file',
                    relativePath: 'src/nested/index.ts',
                    digest: 'sha256:5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29',
                    executable: false,
                    sizeBytes: 24,
                },
                {
                    kind: 'symlink',
                    relativePath: 'src/readme-link',
                    target: '../README.md',
                },
            ],
        });
    });

    it('returns canonical metadata for symlinks without following them', async () => {
        const root = await makeTempDir('workspace-manifest-symlink-');
        await writeFile(join(root, 'target.txt'), 'target\n');
        await mkdir(join(root, 'links'), { recursive: true });
        await symlink('../target.txt', join(root, 'links', 'target-link'));

        const manifest = await scanWorkspaceManifest({ workspaceRoot: root });
        const symlinkEntry = manifest.entries.find((entry: WorkspaceManifestEntry) => entry.relativePath === 'links/target-link');
        if (!symlinkEntry || symlinkEntry.kind !== 'symlink') {
            throw new Error('Expected a symlink entry');
        }

        expect(symlinkEntry.target).toBe('../target.txt');
        await expect(readlink(join(root, 'links', 'target-link'))).resolves.toBe('../target.txt');
        await expect(readFile(join(root, 'target.txt'), 'utf8')).resolves.toBe('target\n');
    });

    it('reports hashed file metadata through the optional file-scan hook', async () => {
        const root = await makeTempDir('workspace-manifest-hook-');
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'README.md'), 'hello\n');
        await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');

        const scannedFiles: ScannedWorkspaceFile[] = [];

        await scanWorkspaceManifest({
            workspaceRoot: root,
            onFileScanned: (file) => {
                scannedFiles.push(file);
            },
        });

        expect(scannedFiles).toHaveLength(2);
        expect(scannedFiles).toMatchObject([
            {
                relativePath: 'README.md',
                filePath: join(root, 'README.md'),
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
            },
            {
                relativePath: 'src/index.ts',
                filePath: join(root, 'src', 'index.ts'),
                digest: 'sha256:5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29',
                sizeBytes: 24,
                executable: false,
            },
        ]);
        for (const scannedFile of scannedFiles) {
            expect(scannedFile.mtimeMs).toEqual(expect.any(Number));
            if (scannedFile.inode !== undefined) {
                expect(scannedFile.inode).toEqual(expect.any(Number));
            }
            if (scannedFile.device !== undefined) {
                expect(scannedFile.device).toEqual(expect.any(Number));
            }
        }
    });

    it('aborts scanning when assertCanContinue throws (cancellation/lease-loss)', async () => {
        const root = await makeTempDir('workspace-manifest-abort-');
        await writeFile(join(root, 'a.txt'), 'a\n');
        await writeFile(join(root, 'b.txt'), 'b\n');

        let scannedCount = 0;
        let shouldCancel = false;

        await expect(scanWorkspaceManifest({
            workspaceRoot: root,
            assertCanContinue() {
                if (shouldCancel) {
                    throw new Error('cancelled');
                }
            },
            onFileScanned() {
                scannedCount += 1;
                shouldCancel = true;
            },
        })).rejects.toThrow('cancelled');

        expect(scannedCount).toBe(1);
    });

    it('uses a cached digest from the optional digest resolver before attempting to read file contents', async () => {
        const root = await makeTempDir('workspace-manifest-cache-hit-');
        const filePath = join(root, 'README.md');
        await writeFile(filePath, 'hello\n');
        await chmod(filePath, 0o000);

        try {
            await expect(scanWorkspaceManifest({
                workspaceRoot: root,
                resolveCachedFileDigest: ({ relativePath, sizeBytes, executable }) => {
                    expect(relativePath).toBe('README.md');
                    expect(sizeBytes).toBe(6);
                    expect(executable).toBe(false);
                    return 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
                },
            })).resolves.toEqual({
                entries: [
                    {
                        kind: 'file',
                        relativePath: 'README.md',
                        digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                        executable: false,
                        sizeBytes: 6,
                    },
                ],
            });
        } finally {
            await chmod(filePath, 0o644);
        }
    });

    it('excludes git admin paths from replication manifests by default', async () => {
        const root = await makeTempDir('workspace-manifest-git-default-');
        await mkdir(join(root, '.git', 'refs'), { recursive: true });
        await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        await writeFile(join(root, '.git', 'refs', 'main'), 'abc123\n');
        await writeFile(join(root, 'README.md'), 'hello\n');

        await expect(scanWorkspaceManifest({ workspaceRoot: root })).resolves.toEqual({
            entries: [
                {
                    kind: 'file',
                    relativePath: 'README.md',
                    digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                    executable: false,
                    sizeBytes: 6,
                },
            ],
        });
    });

    it('can include git admin paths when the safe filter policy allows them', async () => {
        const root = await makeTempDir('workspace-manifest-git-include-');
        await mkdir(join(root, '.git', 'refs'), { recursive: true });
        await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        await writeFile(join(root, '.git', 'refs', 'main'), 'abc123\n');

        const manifest = await scanWorkspaceManifest({
            workspaceRoot: root,
            safeFilterPolicy: {
                excludeAdministrativePaths: false,
            },
        });

        expect(manifest.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'directory', relativePath: '.git' }),
            expect.objectContaining({ kind: 'file', relativePath: '.git/HEAD' }),
            expect.objectContaining({ kind: 'directory', relativePath: '.git/refs' }),
            expect.objectContaining({ kind: 'file', relativePath: '.git/refs/main' }),
        ]));
    });

    it('excludes backend-declared administrative paths through the shared SCM seam', async () => {
        const root = await makeTempDir('workspace-manifest-admin-path-');
        await mkdir(join(root, '.sl'), { recursive: true });
        await writeFile(join(root, '.sl', 'store'), 'metadata\n');
        await writeFile(join(root, 'README.md'), 'hello\n');

        await expect(scanWorkspaceManifest({
            workspaceRoot: root,
            scmRegistry: createScmBackendRegistry([
                createAdministrativePathTestBackend((relativePath) => relativePath === '.sl' || relativePath.startsWith('.sl/')),
            ]),
        })).resolves.toEqual({
            entries: [
                {
                    kind: 'file',
                    relativePath: 'README.md',
                    digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                    executable: false,
                    sizeBytes: 6,
                },
            ],
        });
    });

    it('skips unreadable or concurrently missing entries instead of failing the scan', async () => {
        const root = await makeTempDir('workspace-manifest-unreadable-');
        await writeFile(join(root, 'README.md'), 'hello\n');
        await writeFile(join(root, 'blocked.txt'), 'blocked\n');
        await mkdir(join(root, 'private'), { recursive: true });
        await writeFile(join(root, 'private', 'secret.txt'), 'secret\n');

        await chmod(join(root, 'blocked.txt'), 0o000);
        await chmod(join(root, 'private'), 0o000);

        try {
            await expect(scanWorkspaceManifest({ workspaceRoot: root })).resolves.toEqual({
                entries: [
                    {
                        kind: 'directory',
                        relativePath: 'private',
                    },
                    {
                        kind: 'file',
                        relativePath: 'README.md',
                        digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                        executable: false,
                        sizeBytes: 6,
                    },
                ],
            });
        } finally {
            await chmod(join(root, 'blocked.txt'), 0o644);
            await chmod(join(root, 'private'), 0o755);
        }
    });
});
