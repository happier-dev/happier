import { access, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashWorkspaceFile } from '../workspaceExportPackaging/hashWorkspaceFile';
import { createWorkspaceStagingDescriptor, createWorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { stageWorkspaceFileEntry } from './stageWorkspaceFileEntry';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

describe('stageWorkspaceFileEntry', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('stages blob bytes and materializes a workspace file entry with canonical mode', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-staging-file-entry-'),
            stagingId: 'stage_file_entry_1',
        });
        const content = Buffer.from('# staged workspace\n', 'utf8');
        const digestSourceDirectory = await makeTempDir('workspace-staging-file-entry-source-');
        const digestSourcePath = join(digestSourceDirectory, 'README.md');
        await writeFile(digestSourcePath, content);
        const digest = await hashWorkspaceFile({ filePath: digestSourcePath });

        const stagedFile = await stageWorkspaceFileEntry({
            stagingRoot,
            relativePath: 'docs/README.md',
            digest,
            sourceFilePath: digestSourcePath,
            executable: false,
        });

        expect(stagedFile.relativePath).toBe('docs/README.md');
        await expect(readFile(stagedFile.filePath)).resolves.toEqual(content);
        await expect(readFile(stagedFile.blob.filePath)).resolves.toEqual(content);
        const stagedStats = await lstat(stagedFile.filePath);
        expect((stagedStats.mode & 0o111) !== 0).toBe(false);
    });

    it('rejects workspace paths that escape the staging workspace root before materializing files', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-staging-file-entry-outside-'),
            stagingId: 'stage_file_entry_outside',
        });
        const content = Buffer.from('outside\n', 'utf8');
        const digestSourceDirectory = await makeTempDir('workspace-staging-file-entry-outside-source-');
        const digestSourcePath = join(digestSourceDirectory, 'outside.txt');
        await writeFile(digestSourcePath, content);
        const digest = await hashWorkspaceFile({ filePath: digestSourcePath });

        await expect(stageWorkspaceFileEntry({
            stagingRoot,
            relativePath: '../outside.txt',
            digest,
            sourceFilePath: digestSourcePath,
            executable: false,
        })).rejects.toThrow(/workspace root/i);
        await expect(access(join(stagingRoot.workspaceDirectory, 'outside.txt'))).rejects.toThrow();
    });

    it('rejects blob bytes whose staged digest does not match the declared digest before materializing the workspace file', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-staging-file-entry-digest-mismatch-'),
            stagingId: 'stage_file_entry_digest_mismatch',
        });

        const wrongContent = Buffer.from('# wrong digest\n', 'utf8');
        const sourceDirectory = await makeTempDir('workspace-staging-file-entry-digest-mismatch-source-');
        const sourceFilePath = join(sourceDirectory, 'README.md');
        await writeFile(sourceFilePath, wrongContent);

        await expect(stageWorkspaceFileEntry({
            stagingRoot,
            relativePath: 'README.md',
            digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
            sourceFilePath,
            executable: true,
        })).rejects.toThrow(/digest mismatch/i);
        await expect(access(join(stagingRoot.workspaceDirectory, 'README.md'))).rejects.toThrow();
    });

    it('refuses to materialize a workspace file entry into an unverified staging root descriptor', async () => {
        const parentDirectory = await makeTempDir('workspace-staging-file-entry-unverified-');
        const stagingRoot = createWorkspaceStagingDescriptor({
            parentDirectory,
            stagingId: 'missing_marker',
        });

        const sourceDirectory = await makeTempDir('workspace-staging-file-entry-unverified-source-');
        const sourceFilePath = join(sourceDirectory, 'README.md');
        await writeFile(sourceFilePath, '# staged workspace\n', 'utf8');

        await expect(stageWorkspaceFileEntry({
            stagingRoot,
            relativePath: 'README.md',
            digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
            sourceFilePath,
            executable: false,
        })).rejects.toThrow(/workspace staging root marker/i);
    });
});
