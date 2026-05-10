import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupWorkspaceStaging } from './cleanupWorkspaceStaging';
import { createWorkspaceStagingRoot, resolveWorkspaceStagingRootDirectory } from './createWorkspaceStagingRoot';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

describe('workspaceStaging', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('creates a deterministic staging root with the expected subdirectories and marker file', async () => {
        const parentDirectory = await makeTempDir('workspace-staging-parent-');

        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory,
            stagingId: 'run_123',
        });

        expect(stagingRoot.rootDirectory).toBe(resolveWorkspaceStagingRootDirectory({
            parentDirectory,
            stagingId: 'run_123',
        }));
        await expect(access(stagingRoot.workspaceDirectory)).resolves.toBeUndefined();
        await expect(access(stagingRoot.blobsDirectory)).resolves.toBeUndefined();
        await expect(access(stagingRoot.metadataDirectory)).resolves.toBeUndefined();
        await expect(readFile(stagingRoot.markerFilePath, 'utf8')).resolves.toContain('"stagingId": "run_123"');
    });

    it('cleans up only a verified staging root created by the staging helper', async () => {
        const parentDirectory = await makeTempDir('workspace-staging-cleanup-');
        const stagingRoot = await createWorkspaceStagingRoot({
            parentDirectory,
            stagingId: 'run_cleanup',
        });

        await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory });

        await expect(access(stagingRoot.rootDirectory)).rejects.toThrow();
    });

    it('refuses to delete a directory that is not marked as a workspace staging root', async () => {
        const parentDirectory = await makeTempDir('workspace-staging-unsafe-');

        await expect(cleanupWorkspaceStaging({ rootDirectory: parentDirectory })).rejects.toThrow(
            /workspace staging root marker/i,
        );
        await expect(access(parentDirectory)).resolves.toBeUndefined();
    });
});
