import { access, mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkspaceStagingDescriptor, createWorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { stageWorkspaceDirectory } from './stageWorkspaceDirectory';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

describe('stageWorkspaceDirectory', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('creates a staged directory under the verified staging workspace using the canonical relative path', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-directory-root-'),
            stagingId: 'stage_directory_1',
        });

        const stagedDirectory = await stageWorkspaceDirectory({
            stagingRoot,
            relativePath: './src//nested',
        });

        expect(stagedDirectory.relativePath).toBe('src/nested');
        expect(stagedDirectory.directoryPath).toBe(join(stagingRoot.workspaceDirectory, 'src', 'nested'));
        await expect(access(stagedDirectory.directoryPath)).resolves.toBeUndefined();
    });

    it('refuses to stage a directory into an unverified staging root descriptor', async () => {
        const parentDirectory = await makeTempDir('workspace-stage-directory-unverified-');
        const stagingRoot = createWorkspaceStagingDescriptor({
            parentDirectory,
            stagingId: 'missing_marker',
        });

        await expect(stageWorkspaceDirectory({
            stagingRoot,
            relativePath: 'src',
        })).rejects.toThrow(/workspace staging root marker/i);
        await expect(access(join(stagingRoot.workspaceDirectory, 'src'))).rejects.toThrow();
    });

    it('rejects workspace paths that escape the staging workspace root before creating directories', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-directory-invalid-'),
            stagingId: 'stage_directory_invalid',
        });

        await expect(stageWorkspaceDirectory({
            stagingRoot,
            relativePath: '../outside',
        })).rejects.toThrow(/workspace root/i);
        await expect(access(join(stagingRoot.workspaceDirectory, 'outside'))).rejects.toThrow();
    });

    it('rejects paths that already resolve to a symlink', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-directory-symlink-'),
            stagingId: 'stage_directory_symlink',
        });
        await symlink('./target', join(stagingRoot.workspaceDirectory, 'src-link'));

        await expect(stageWorkspaceDirectory({
            stagingRoot,
            relativePath: 'src-link',
        })).rejects.toThrow(/directory/i);
        await expect(readlink(join(stagingRoot.workspaceDirectory, 'src-link'))).resolves.toBe('./target');
    });
});
