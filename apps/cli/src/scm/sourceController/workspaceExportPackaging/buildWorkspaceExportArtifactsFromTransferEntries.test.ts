import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildWorkspaceExportArtifactsFromTransferEntries } from './buildWorkspaceExportArtifactsFromTransferEntries';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(dir);
    return dir;
}

describe('buildWorkspaceExportArtifactsFromTransferEntries', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('builds replication export artifacts from source-controller style transfer entries', async () => {
        const root = await makeTempDir('workspace-export-artifacts-');
        await mkdir(join(root, 'bin'), { recursive: true });
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n');
        await chmod(join(root, 'bin', 'run.sh'), 0o755);
        await writeFile(join(root, 'docs', 'copy.sh'), '#!/bin/sh\necho hi\n');
        await writeFile(join(root, 'README.md'), 'hello\n');
        await symlink('../README.md', join(root, 'docs', 'readme-link'));

        const artifacts = await buildWorkspaceExportArtifactsFromTransferEntries({
            entries: [
                { relativePath: 'docs/readme-link', sourcePath: join(root, 'docs', 'readme-link') },
                { relativePath: 'bin/run.sh', sourcePath: join(root, 'bin', 'run.sh') },
                { relativePath: 'README.md', sourcePath: join(root, 'README.md') },
                { relativePath: 'docs/copy.sh', sourcePath: join(root, 'docs', 'copy.sh') },
            ],
        });

        expect(artifacts.manifest.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(artifacts.manifest.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ relativePath: 'bin', kind: 'directory' }),
            expect.objectContaining({ relativePath: 'docs', kind: 'directory' }),
            expect.objectContaining({ relativePath: 'docs/readme-link', kind: 'symlink', target: '../README.md' }),
            expect.objectContaining({ relativePath: 'README.md', kind: 'file', executable: false, sizeBytes: 6 }),
            expect.objectContaining({ relativePath: 'bin/run.sh', kind: 'file', executable: true, sizeBytes: 18 }),
            expect.objectContaining({ relativePath: 'docs/copy.sh', kind: 'file', executable: false, sizeBytes: 18 }),
        ]));

        const shellEntries = artifacts.manifest.entries.filter(
            (entry): entry is Extract<(typeof artifacts.manifest.entries)[number], { kind: 'file' }> =>
                entry.kind === 'file' && (entry.relativePath === 'bin/run.sh' || entry.relativePath === 'docs/copy.sh'),
        );
        expect(shellEntries).toHaveLength(2);
        expect(new Set(shellEntries.map((entry) => entry.digest)).size).toBe(1);
        expect(artifacts.blobContentsByDigest.size).toBe(2);
        expect(Buffer.from(artifacts.blobContentsByDigest.get(shellEntries[0]!.digest) ?? []).toString('utf8')).toBe('#!/bin/sh\necho hi\n');
    });

    it('skips unreadable entries when the caller marks the access error as ignorable', async () => {
        const root = await makeTempDir('workspace-export-artifacts-unreadable-');
        await writeFile(join(root, 'README.md'), 'hello\n');
        await writeFile(join(root, 'blocked.txt'), 'blocked\n');
        await chmod(join(root, 'blocked.txt'), 0o000);

        try {
            const artifacts = await buildWorkspaceExportArtifactsFromTransferEntries({
                entries: [
                    { relativePath: 'README.md', sourcePath: join(root, 'README.md') },
                    { relativePath: 'blocked.txt', sourcePath: join(root, 'blocked.txt') },
                ],
                shouldIgnoreAccessError: () => true,
            });

            expect(artifacts.manifest.entries).toEqual(expect.arrayContaining([
                expect.objectContaining({ relativePath: 'README.md', kind: 'file' }),
            ]));
            expect(artifacts.manifest.entries.some((entry) => entry.relativePath === 'blocked.txt')).toBe(false);
            await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toBe('hello\n');
        } finally {
            await chmod(join(root, 'blocked.txt'), 0o644);
        }
    });
});
