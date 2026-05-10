import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceManifest } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { hashWorkspaceFile } from '../workspaceExportPackaging/hashWorkspaceFile';
import { createWorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { verifyStagedWorkspace } from './verifyStagedWorkspace';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

async function writeBlobFile(params: Readonly<{
    blobsDirectory: string;
    digest: string;
    content: string;
}>): Promise<void> {
    const [algorithm, hash] = params.digest.split(':', 2);
    const algorithmDirectory = join(params.blobsDirectory, algorithm);
    await mkdir(algorithmDirectory, { recursive: true });
    await writeFile(join(algorithmDirectory, `${hash}.blob`), params.content, 'utf8');
}

async function createExpectedFixture(stagingWorkspaceDirectory: string): Promise<Readonly<{
    manifest: WorkspaceManifest;
    fileContentsByDigest: ReadonlyMap<string, string>;
}>> {
    const appDirectory = join(stagingWorkspaceDirectory, 'src');
    const scriptPath = join(appDirectory, 'run.sh');
    const readmePath = join(stagingWorkspaceDirectory, 'README.md');

    await mkdir(appDirectory, { recursive: true });
    await writeFile(readmePath, '# staged workspace\n', 'utf8');
    await writeFile(scriptPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(scriptPath, 0o755);
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
                    sizeBytes: Buffer.byteLength('# staged workspace\n'),
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
                    sizeBytes: Buffer.byteLength('#!/bin/sh\nexit 0\n'),
                    executable: true,
                },
            ],
        },
        fileContentsByDigest: new Map([
            [readmeDigest, await readFile(readmePath, 'utf8')],
            [scriptDigest, await readFile(scriptPath, 'utf8')],
        ]),
    };
}

describe('verifyStagedWorkspace', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('verifies a staged workspace when manifest entries and staged blobs match the expected inputs', async () => {
        const parentDirectory = await makeTempDir('verify-staged-workspace-pass-');
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory,
            stagingId: 'verify-pass',
        });
        const expectedFixture = await createExpectedFixture(stagingRoot.workspaceDirectory);
        const expectedManifest = expectedFixture.manifest;
        const expectedBlobDigests = expectedManifest.entries
            .filter((entry) => entry.kind === 'file')
            .map((entry) => entry.digest);

        await Promise.all(expectedBlobDigests.map(async (digest) => await writeBlobFile({
            blobsDirectory: stagingRoot.blobsDirectory,
            digest,
            content: expectedFixture.fileContentsByDigest.get(digest) ?? '',
        })));

        const result = await verifyStagedWorkspace({
            workspaceDirectory: stagingRoot.workspaceDirectory,
            blobsDirectory: stagingRoot.blobsDirectory,
            expectedManifest,
            expectedBlobDigests,
        });

        expect(result.isVerified).toBe(true);
        expect(result.manifestComparison.hasChanges).toBe(false);
        expect(result.blobFailures).toEqual([]);
    });

    it('reports staged workspace manifest drift when current staged files differ from the expected manifest', async () => {
        const parentDirectory = await makeTempDir('verify-staged-workspace-drift-');
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory,
            stagingId: 'verify-drift',
        });
        const expectedManifest = (await createExpectedFixture(stagingRoot.workspaceDirectory)).manifest;

        await writeFile(join(stagingRoot.workspaceDirectory, 'README.md'), '# drifted workspace\n', 'utf8');
        await writeFile(join(stagingRoot.workspaceDirectory, 'UNEXPECTED.txt'), 'surprise\n', 'utf8');

        const result = await verifyStagedWorkspace({
            workspaceDirectory: stagingRoot.workspaceDirectory,
            blobsDirectory: stagingRoot.blobsDirectory,
            expectedManifest,
            expectedBlobDigests: [],
        });

        expect(result.isVerified).toBe(false);
        expect(result.manifestComparison.changed.map((entry) => entry.next.relativePath)).toEqual(['README.md']);
        expect(result.manifestComparison.added.map((entry) => entry.relativePath)).toEqual(['UNEXPECTED.txt']);
    });

    it('reports missing and digest-mismatched staged blobs', async () => {
        const parentDirectory = await makeTempDir('verify-staged-workspace-blobs-');
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory,
            stagingId: 'verify-blobs',
        });
        const expectedManifest = (await createExpectedFixture(stagingRoot.workspaceDirectory)).manifest;
        const [firstDigest, secondDigest] = expectedManifest.entries
            .filter((entry) => entry.kind === 'file')
            .map((entry) => entry.digest);

        await writeBlobFile({
            blobsDirectory: stagingRoot.blobsDirectory,
            digest: firstDigest,
            content: 'wrong blob contents',
        });

        const result = await verifyStagedWorkspace({
            workspaceDirectory: stagingRoot.workspaceDirectory,
            blobsDirectory: stagingRoot.blobsDirectory,
            expectedManifest,
            expectedBlobDigests: [firstDigest, secondDigest],
        });

        expect(result.isVerified).toBe(false);
        expect(result.blobFailures).toEqual([
            {
                digest: firstDigest,
                reason: 'digest_mismatch',
                actualDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            },
            {
                digest: secondDigest,
                reason: 'missing',
            },
        ]);
    });

    it('verifies git admin entries when the expected manifest already includes them', async () => {
        const parentDirectory = await makeTempDir('verify-staged-workspace-git-');
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory,
            stagingId: 'verify-git',
        });
        const expectedFixture = await createExpectedFixture(stagingRoot.workspaceDirectory);
        const gitDirectory = join(stagingRoot.workspaceDirectory, '.git');
        const gitHeadPath = join(gitDirectory, 'HEAD');

        await mkdir(gitDirectory, { recursive: true });
        await writeFile(gitHeadPath, 'ref: refs/heads/main\n', 'utf8');

        const gitHeadDigest = await hashWorkspaceFile({ filePath: gitHeadPath });
        const expectedManifest: WorkspaceManifest = {
            entries: [
                ...expectedFixture.manifest.entries,
                {
                    relativePath: '.git',
                    kind: 'directory',
                },
                {
                    relativePath: '.git/HEAD',
                    kind: 'file',
                    digest: gitHeadDigest,
                    sizeBytes: Buffer.byteLength('ref: refs/heads/main\n'),
                    executable: false,
                },
            ],
        };
        const expectedBlobDigests = expectedManifest.entries
            .filter((entry) => entry.kind === 'file')
            .map((entry) => entry.digest);

        await Promise.all(expectedBlobDigests.map(async (digest) => await writeBlobFile({
            blobsDirectory: stagingRoot.blobsDirectory,
            digest,
            content: digest === gitHeadDigest
                ? 'ref: refs/heads/main\n'
                : expectedFixture.fileContentsByDigest.get(digest) ?? '',
        })));

        const result = await verifyStagedWorkspace({
            workspaceDirectory: stagingRoot.workspaceDirectory,
            blobsDirectory: stagingRoot.blobsDirectory,
            expectedManifest,
            expectedBlobDigests,
        });

        expect(result.isVerified).toBe(true);
        expect(result.manifestComparison.hasChanges).toBe(false);
        expect(result.blobFailures).toEqual([]);
    });
});
