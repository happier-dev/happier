import { access, lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceManifest } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { hashWorkspaceFile } from '../workspaceExportPackaging/hashWorkspaceFile';
import { createWorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { promoteStagedWorkspace } from './promoteStagedWorkspace';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

async function writeBlobFile(params: Readonly<{
    blobsDirectory: string;
    digest: string;
    content: Uint8Array;
}>): Promise<void> {
    const [algorithm, hash] = params.digest.split(':', 2);
    const algorithmDirectory = join(params.blobsDirectory, algorithm);
    await mkdir(algorithmDirectory, { recursive: true });
    await writeFile(join(algorithmDirectory, `${hash}.blob`), params.content);
}

async function createPromotableFixture(stagingWorkspaceDirectory: string): Promise<Readonly<{
    manifest: WorkspaceManifest;
    blobBytesByDigest: ReadonlyMap<string, Uint8Array>;
}>> {
    const srcDirectory = join(stagingWorkspaceDirectory, 'src');
    const readmePath = join(stagingWorkspaceDirectory, 'README.md');
    const scriptPath = join(srcDirectory, 'run.sh');
    const readmeContent = Buffer.from('# staged workspace\n', 'utf8');
    const scriptContent = Buffer.from('#!/bin/sh\nexit 0\n', 'utf8');

    await mkdir(srcDirectory, { recursive: true });
    await writeFile(readmePath, readmeContent, { mode: 0o600 });
    await writeFile(scriptPath, scriptContent, { mode: 0o700 });
    await symlink('./README.md', join(stagingWorkspaceDirectory, 'readme-link'));

    const readmeDigest = await hashWorkspaceFile({ filePath: readmePath });
    const scriptDigest = await hashWorkspaceFile({ filePath: scriptPath });

    return {
        manifest: {
            entries: [
                {
                    relativePath: 'README.md',
                    kind: 'file',
                    digest: readmeDigest,
                    sizeBytes: readmeContent.byteLength,
                    executable: false,
                },
                {
                    relativePath: 'readme-link',
                    kind: 'symlink',
                    target: './README.md',
                },
                {
                    relativePath: 'src',
                    kind: 'directory',
                },
                {
                    relativePath: 'src/run.sh',
                    kind: 'file',
                    digest: scriptDigest,
                    sizeBytes: scriptContent.byteLength,
                    executable: true,
                },
            ],
        },
        blobBytesByDigest: new Map([
            [readmeDigest, readmeContent],
            [scriptDigest, scriptContent],
        ]),
    };
}

describe('promoteStagedWorkspace', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('promotes a verified staged workspace into a missing target workspace root', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-promote-staging-pass-'),
            stagingId: 'promote_pass',
        });
        const targetParentDirectory = await makeTempDir('workspace-promote-target-parent-');
        const targetWorkspaceDirectory = join(targetParentDirectory, 'workspace');
        const fixture = await createPromotableFixture(stagingRoot.workspaceDirectory);

        await Promise.all(
            [...fixture.blobBytesByDigest.entries()].map(async ([digest, content]) => await writeBlobFile({
                blobsDirectory: stagingRoot.blobsDirectory,
                digest,
                content,
            })),
        );

        const result = await promoteStagedWorkspace({
            stagingRoot,
            targetWorkspaceDirectory,
            expectedManifest: fixture.manifest,
        });

        expect(result.targetWorkspaceDirectory).toBe(targetWorkspaceDirectory);
        expect(result.verification.isVerified).toBe(true);
        await expect(readFile(join(targetWorkspaceDirectory, 'README.md'), 'utf8')).resolves.toBe('# staged workspace\n');
        await expect(readFile(join(targetWorkspaceDirectory, 'src', 'run.sh'), 'utf8')).resolves.toBe('#!/bin/sh\nexit 0\n');
        await expect(readlink(join(targetWorkspaceDirectory, 'readme-link'))).resolves.toBe('./README.md');
        await expect(lstat(join(targetWorkspaceDirectory, 'README.md')).then((stats) => stats.mode & 0o777)).resolves.toBe(0o644);
        await expect(lstat(join(targetWorkspaceDirectory, 'src', 'run.sh')).then((stats) => stats.mode & 0o777)).resolves.toBe(0o755);
        await expect(access(stagingRoot.workspaceDirectory)).rejects.toThrow();
    });

    it('refuses to promote when the staging root marker payload does not match the descriptor', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-promote-marker-mismatch-'),
            stagingId: 'promote_marker_mismatch',
        });
        const fixture = await createPromotableFixture(stagingRoot.workspaceDirectory);

        await Promise.all(
            [...fixture.blobBytesByDigest.entries()].map(async ([digest, content]) => await writeBlobFile({
                blobsDirectory: stagingRoot.blobsDirectory,
                digest,
                content,
            })),
        );
        await writeFile(stagingRoot.markerFilePath, JSON.stringify({
            schemaVersion: 1,
            stagingId: 'different_staging_id',
            rootDirectory: stagingRoot.rootDirectory,
        }, null, 2), 'utf8');

        await expect(promoteStagedWorkspace({
            stagingRoot,
            targetWorkspaceDirectory: join(await makeTempDir('workspace-promote-marker-target-'), 'workspace'),
            expectedManifest: fixture.manifest,
        })).rejects.toThrow(/workspace staging root marker/i);
    });

    it('refuses to promote when staged workspace verification fails', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-promote-verify-fail-'),
            stagingId: 'promote_verify_fail',
        });
        const targetParentDirectory = await makeTempDir('workspace-promote-verify-target-');
        const targetWorkspaceDirectory = join(targetParentDirectory, 'workspace');
        const fixture = await createPromotableFixture(stagingRoot.workspaceDirectory);

        await writeFile(join(stagingRoot.workspaceDirectory, 'README.md'), '# drifted workspace\n', 'utf8');

        await expect(promoteStagedWorkspace({
            stagingRoot,
            targetWorkspaceDirectory,
            expectedManifest: fixture.manifest,
        })).rejects.toThrow(/staged workspace verification failed/i);
        await expect(access(targetWorkspaceDirectory)).rejects.toThrow();
    });

    it('refuses to replace an existing target workspace root', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-promote-existing-target-'),
            stagingId: 'promote_existing_target',
        });
        const targetParentDirectory = await makeTempDir('workspace-promote-existing-target-parent-');
        const targetWorkspaceDirectory = join(targetParentDirectory, 'workspace');
        const fixture = await createPromotableFixture(stagingRoot.workspaceDirectory);

        await Promise.all(
            [...fixture.blobBytesByDigest.entries()].map(async ([digest, content]) => await writeBlobFile({
                blobsDirectory: stagingRoot.blobsDirectory,
                digest,
                content,
            })),
        );
        await mkdir(targetWorkspaceDirectory, { recursive: true });
        await writeFile(join(targetWorkspaceDirectory, 'KEEP.txt'), 'keep\n', 'utf8');

        await expect(promoteStagedWorkspace({
            stagingRoot,
            targetWorkspaceDirectory,
            expectedManifest: fixture.manifest,
        })).rejects.toThrow(/target workspace root already exists/i);
        await expect(readFile(join(targetWorkspaceDirectory, 'KEEP.txt'), 'utf8')).resolves.toBe('keep\n');
    });
});
