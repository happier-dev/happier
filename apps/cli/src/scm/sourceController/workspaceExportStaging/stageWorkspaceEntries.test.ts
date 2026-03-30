import { access, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceManifest } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashWorkspaceFile } from '../workspaceExportPackaging/hashWorkspaceFile';
import { createWorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import type { StagedWorkspaceDirectory } from './stageWorkspaceDirectory';
import { stageWorkspaceEntries, type WorkspaceExportBlobProvider } from './stageWorkspaceEntries';
import type { StagedWorkspaceFileBlob } from './stageWorkspaceFileBlob';
import type { StagedWorkspaceSymlink } from './stageWorkspaceSymlink';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

async function createFileEntryFixture(): Promise<Readonly<{
    manifest: WorkspaceManifest;
    digest: string;
    content: Uint8Array;
    filePath: string;
}>> {
    const fixtureDirectory = await makeTempDir('workspace-stage-entries-fixture-');
    const filePath = join(fixtureDirectory, 'README.md');
    const content = Buffer.from('# staged workspace\n', 'utf8');

    await writeFile(filePath, content);

    const digest = await hashWorkspaceFile({ filePath });

    return {
        manifest: {
            entries: [
                {
                    relativePath: 'README.md',
                    kind: 'file',
                    digest,
                    sizeBytes: content.byteLength,
                    executable: false,
                },
                {
                    relativePath: 'docs',
                    kind: 'directory',
                },
                {
                    relativePath: 'docs/readme-link',
                    kind: 'symlink',
                    target: '../README.md',
                },
            ],
        },
        digest,
        content,
        filePath,
    };
}

describe('stageWorkspaceEntries', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('stages directories, symlinks, and blobs together before verifying the staged workspace', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-entries-pass-'),
            stagingId: 'stage_entries_pass',
        });
        const fixture = await createFileEntryFixture();

        const result = await stageWorkspaceEntries({
            stagingRoot,
            expectedManifest: fixture.manifest,
            blobProvider: {
                getBlobFilePath: (digest: string) => (digest === fixture.digest ? fixture.filePath : null),
            },
        });

        expect(result.stagedDirectories.map((entry: StagedWorkspaceDirectory) => entry.relativePath)).toEqual(['docs']);
        expect(result.stagedSymlinks.map((entry: StagedWorkspaceSymlink) => entry.relativePath)).toEqual(['docs/readme-link']);
        expect(result.stagedBlobs.map((entry: StagedWorkspaceFileBlob) => entry.digest)).toEqual([fixture.digest]);
        await expect(readFile(join(stagingRoot.workspaceDirectory, 'README.md'))).resolves.toEqual(fixture.content);
        await expect(readlink(join(stagingRoot.workspaceDirectory, 'docs', 'readme-link'))).resolves.toBe('../README.md');
        expect(result.verification.isVerified).toBe(true);
    });

    it('fails closed before staging anything when a manifest file digest is missing blob contents', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-entries-missing-blob-'),
            stagingId: 'stage_entries_missing_blob',
        });
        const fixture = await createFileEntryFixture();

        await expect(stageWorkspaceEntries({
            stagingRoot,
            expectedManifest: fixture.manifest,
            blobProvider: {
                getBlobFilePath: () => null,
            },
        })).rejects.toThrow(fixture.digest);
        await expect(access(join(stagingRoot.workspaceDirectory, 'docs'))).rejects.toThrow();
        await expect(access(join(stagingRoot.workspaceDirectory, 'blobs', 'sha256'))).rejects.toThrow();
    });

    it('returns verifier drift details when the staged workspace does not match the expected manifest', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-entries-drift-'),
            stagingId: 'stage_entries_drift',
        });
        const fixtureDirectory = await makeTempDir('workspace-stage-entries-drift-fixture-');
        const filePath = join(fixtureDirectory, 'README.md');
        await writeFile(filePath, '# staged workspace\n', 'utf8');
        const expectedDigest = await hashWorkspaceFile({ filePath });
        const expectedManifest: WorkspaceManifest = {
            entries: [
                {
                    relativePath: 'README.md',
                    kind: 'file',
                    digest: expectedDigest,
                    sizeBytes: Buffer.byteLength('# staged workspace\n') + 1,
                    executable: false,
                },
                {
                    relativePath: 'docs',
                    kind: 'directory',
                },
            ],
        };

        const result = await stageWorkspaceEntries({
            stagingRoot,
            expectedManifest,
            blobProvider: {
                getBlobFilePath: (digest: string) => (digest === expectedDigest ? filePath : null),
            },
        });

        expect(result.verification.isVerified).toBe(false);
        expect(result.verification.manifestComparison.changed.map((entry: { next: { relativePath: string } }) => entry.next.relativePath)).toEqual(['README.md']);
    });

    it('consults a blob provider when staging file blobs from disk-backed sources', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-entries-provider-'),
            stagingId: 'stage_entries_provider',
        });
        const fixture = await createFileEntryFixture();
        const sourceDirectory = await makeTempDir('workspace-stage-entries-source-');
        const sourceFilePath = join(sourceDirectory, 'README.md');
        await writeFile(sourceFilePath, fixture.content);

        const blobProvider = {
            getBlobFilePath: vi.fn((digest: string) => (digest === fixture.digest ? sourceFilePath : null)),
        } satisfies WorkspaceExportBlobProvider;

        const result = await stageWorkspaceEntries({
            stagingRoot,
            expectedManifest: fixture.manifest,
            blobProvider,
        });

        expect(blobProvider.getBlobFilePath).toHaveBeenCalledTimes(1);
        expect(blobProvider.getBlobFilePath).toHaveBeenCalledWith(fixture.digest);
        expect(result.stagedBlobs.map((entry: StagedWorkspaceFileBlob) => entry.digest)).toEqual([fixture.digest]);
        await expect(readFile(join(stagingRoot.workspaceDirectory, 'README.md'))).resolves.toEqual(fixture.content);
        expect(result.verification.isVerified).toBe(true);
    });

    it('requires a file-backed blobProvider', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-entries-require-provider-'),
            stagingId: 'stage_entries_require_provider',
        });
        const fixture = await createFileEntryFixture();
        await expect(stageWorkspaceEntries({
            stagingRoot,
            expectedManifest: fixture.manifest,
        })).rejects.toThrow(/blobProvider/i);

        await expect(access(join(stagingRoot.workspaceDirectory, 'docs'))).rejects.toThrow();
        await expect(access(join(stagingRoot.workspaceDirectory, 'blobs', 'sha256'))).rejects.toThrow();
    });

    it('invokes assertCanContinue while staging so long staging phases can be cancelled', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-entries-assert-continue-'),
            stagingId: 'stage_entries_assert_continue',
        });
        const fixture = await createFileEntryFixture();
        const assertCanContinue = vi.fn(async () => undefined);

        const result = await stageWorkspaceEntries({
            stagingRoot,
            expectedManifest: fixture.manifest,
            blobProvider: {
                getBlobFilePath: (digest: string) => (digest === fixture.digest ? fixture.filePath : null),
            },
            assertCanContinue,
        });

        expect(result.verification.isVerified).toBe(true);
        // directories + symlinks + files loops should consult liveness at least once each
        expect(assertCanContinue).toHaveBeenCalledTimes(3);
    });
});
