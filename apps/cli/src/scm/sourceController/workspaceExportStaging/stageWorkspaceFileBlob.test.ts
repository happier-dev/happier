import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkspaceStagingDescriptor, createWorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { stageWorkspaceFileBlob } from './stageWorkspaceFileBlob';

const tempRoots: string[] = [];
const blobDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

describe('stageWorkspaceFileBlob', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('stages blob bytes under the verified staging root using digest-addressed layout', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-staging-blob-root-'),
            stagingId: 'stage_blob_1',
        });
        const content = Buffer.from('staged blob payload\n', 'utf8');

        const stagedBlob = await stageWorkspaceFileBlob({
            stagingRoot,
            digest: blobDigest,
            content,
        });

        expect(stagedBlob.filePath).toBe(join(stagingRoot.blobsDirectory, 'sha256', '1111111111111111111111111111111111111111111111111111111111111111.blob'));
        await expect(readFile(stagedBlob.filePath)).resolves.toEqual(content);
    });

    it('refuses to stage a blob into an unverified staging root descriptor', async () => {
        const parentDirectory = await makeTempDir('workspace-staging-blob-unverified-');
        const stagingRoot = createWorkspaceStagingDescriptor({
            parentDirectory,
            stagingId: 'missing_marker',
        });

        await expect(stageWorkspaceFileBlob({
            stagingRoot,
            digest: blobDigest,
            content: Buffer.from('staged blob payload\n', 'utf8'),
        })).rejects.toThrow(/workspace staging root marker/i);
        await expect(access(stagingRoot.blobsDirectory)).rejects.toThrow();
    });

    it('rejects invalid blob digests before writing any files', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-staging-blob-invalid-'),
            stagingId: 'stage_blob_invalid',
        });

        await expect(stageWorkspaceFileBlob({
            stagingRoot,
            digest: 'sha256:not-a-valid-digest',
            content: Buffer.from('staged blob payload\n', 'utf8'),
        })).rejects.toThrow();
        await expect(access(join(stagingRoot.blobsDirectory, 'sha256'))).rejects.toThrow();
    });

    it('stages blob bytes from a source file without requiring in-memory blob contents', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-staging-blob-file-'),
            stagingId: 'stage_blob_file',
        });
        const sourceDirectory = await makeTempDir('workspace-staging-blob-source-');
        const sourceFilePath = join(sourceDirectory, 'blob.txt');
        const content = Buffer.from('file-backed blob payload\n', 'utf8');
        await writeFile(sourceFilePath, content);

        const stageWorkspaceFileBlobModule = await import('./stageWorkspaceFileBlob') as Readonly<{
            stageWorkspaceFileBlobFromFile?: (params: Readonly<{
                stagingRoot: typeof stagingRoot;
                digest: string;
                sourceFilePath: string;
            }>) => Promise<Readonly<{ digest: string; filePath: string }>>;
        }>;

        expect(stageWorkspaceFileBlobModule.stageWorkspaceFileBlobFromFile).toBeTypeOf('function');
        const stagedBlob = await stageWorkspaceFileBlobModule.stageWorkspaceFileBlobFromFile!({
            stagingRoot,
            digest: blobDigest,
            sourceFilePath,
        });

        expect(stagedBlob.digest).toBe(blobDigest);
        await expect(readFile(stagedBlob.filePath)).resolves.toEqual(content);
    });
});
