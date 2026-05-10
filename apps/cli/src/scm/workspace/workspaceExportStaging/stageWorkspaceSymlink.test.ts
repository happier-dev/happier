import { access, lstat, mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkspaceStagingDescriptor, createWorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { stageWorkspaceSymlink } from './stageWorkspaceSymlink';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

describe('stageWorkspaceSymlink', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('creates a staged symlink under the verified staging workspace using the canonical relative path', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-symlink-root-'),
            stagingId: 'stage_symlink_1',
        });

        const stagedSymlink = await stageWorkspaceSymlink({
            stagingRoot,
            relativePath: './links//readme-link',
            target: '../README.md',
        });

        expect(stagedSymlink.relativePath).toBe('links/readme-link');
        expect(stagedSymlink.filePath).toBe(join(stagingRoot.workspaceDirectory, 'links', 'readme-link'));
        await expect(readlink(stagedSymlink.filePath)).resolves.toBe('../README.md');
        await expect(lstat(stagedSymlink.filePath)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    });

    it('refuses to stage a symlink into an unverified staging root descriptor', async () => {
        const parentDirectory = await makeTempDir('workspace-stage-symlink-unverified-');
        const stagingRoot = createWorkspaceStagingDescriptor({
            parentDirectory,
            stagingId: 'missing_marker',
        });

        await expect(stageWorkspaceSymlink({
            stagingRoot,
            relativePath: 'links/readme-link',
            target: '../README.md',
        })).rejects.toThrow(/workspace staging root marker/i);
        await expect(access(join(stagingRoot.workspaceDirectory, 'links', 'readme-link'))).rejects.toThrow();
    });

    it('rejects workspace paths that escape the staging workspace root before creating symlinks', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-symlink-invalid-'),
            stagingId: 'stage_symlink_invalid',
        });

        await expect(stageWorkspaceSymlink({
            stagingRoot,
            relativePath: '../outside-link',
            target: '../README.md',
        })).rejects.toThrow(/workspace root/i);
        await expect(access(join(stagingRoot.workspaceDirectory, 'outside-link'))).rejects.toThrow();
    });

    it('rejects blank symlink targets before creating files', async () => {
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory: await makeTempDir('workspace-stage-symlink-target-'),
            stagingId: 'stage_symlink_target',
        });

        await expect(stageWorkspaceSymlink({
            stagingRoot,
            relativePath: 'links/readme-link',
            target: '   ',
        })).rejects.toThrow(/target/i);
        await expect(access(join(stagingRoot.workspaceDirectory, 'links'))).rejects.toThrow();
    });
});
