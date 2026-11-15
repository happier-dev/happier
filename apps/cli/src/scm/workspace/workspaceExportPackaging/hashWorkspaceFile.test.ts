import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashWorkspaceFile } from './hashWorkspaceFile';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

describe('hashWorkspaceFile', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('returns a stable sha256-prefixed digest for file contents', async () => {
        const root = await makeTempDir('workspace-hash-');
        const filePath = join(root, 'README.md');
        await writeFile(filePath, 'hello manifest\n');

        await expect(hashWorkspaceFile({ filePath })).resolves.toBe('sha256:65e424f78e976256acdf2c33525f3639cbe7b26d103be74bae89011bd71c3d2e');
    });

    // The scan classified the entry as a regular file; a link at open time is a
    // swap and must not hash (or later ship) the link target's bytes.
    it.skipIf(process.platform === 'win32')('refuses a file that became a link after the scan', async () => {
        const root = await makeTempDir('workspace-hash-link-');
        const secret = join(root, 'secret.txt');
        const filePath = join(root, 'README.md');
        await writeFile(secret, 'daemon-only bytes');
        await symlink(secret, filePath);

        await expect(hashWorkspaceFile({ filePath })).rejects.toMatchObject({ code: 'ELOOP' });
    });

    it('aborts hashing when assertCanContinue throws', async () => {
        const root = await makeTempDir('workspace-hash-abort-');
        const filePath = join(root, 'README.md');
        await writeFile(filePath, 'hello manifest\n');

        let calls = 0;
        await expect(hashWorkspaceFile({
            filePath,
            assertCanContinue() {
                calls += 1;
                throw new Error('cancelled');
            },
        })).rejects.toThrow('cancelled');
        expect(calls).toBeGreaterThan(0);
    });
});
