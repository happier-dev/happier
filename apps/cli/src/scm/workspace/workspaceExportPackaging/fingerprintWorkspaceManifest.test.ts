import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkspaceManifestEntry } from './buildWorkspaceManifestEntry';
import { fingerprintWorkspaceManifest } from './fingerprintWorkspaceManifest';
import { scanWorkspaceManifest } from './scanWorkspaceManifest';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

describe('fingerprintWorkspaceManifest', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('returns the same fingerprint for equivalent manifests regardless of entry ordering', () => {
        const orderedEntries: readonly WorkspaceManifestEntry[] = [
            {
                kind: 'directory',
                relativePath: 'bin',
            },
            {
                digest: 'sha256:aaa',
                executable: true,
                kind: 'file',
                relativePath: 'bin/run.sh',
                sizeBytes: 17,
            },
            {
                kind: 'symlink',
                relativePath: 'current',
                target: './releases/current',
            },
        ];
        const reversedEntries = [...orderedEntries].reverse();

        expect(fingerprintWorkspaceManifest({ entries: orderedEntries })).toBe(
            fingerprintWorkspaceManifest({ entries: reversedEntries }),
        );
    });

    it('changes the fingerprint when manifest metadata changes', () => {
        const fingerprint = fingerprintWorkspaceManifest({
            entries: [
                {
                    digest: 'sha256:aaa',
                    executable: false,
                    kind: 'file',
                    relativePath: 'README.md',
                    sizeBytes: 10,
                },
            ],
        });

        const changedFingerprint = fingerprintWorkspaceManifest({
            entries: [
                {
                    digest: 'sha256:aaa',
                    executable: true,
                    kind: 'file',
                    relativePath: 'README.md',
                    sizeBytes: 10,
                },
            ],
        });

        expect(changedFingerprint).not.toBe(fingerprint);
    });

    it('produces a stable sha256 fingerprint from scanned workspace manifests', async () => {
        const root = await makeTempDir('workspace-manifest-fingerprint-');
        await mkdir(join(root, 'bin'), { recursive: true });
        await mkdir(join(root, 'src', 'nested'), { recursive: true });
        await writeFile(join(root, 'README.md'), 'hello\n');
        await writeFile(join(root, 'bin', 'run.sh'), '#!/bin/sh\nexit 0\n');
        await chmod(join(root, 'bin', 'run.sh'), 0o755);
        await writeFile(join(root, 'src', 'nested', 'index.ts'), 'export const value = 1;\n');
        await symlink('../README.md', join(root, 'src', 'readme-link'));

        const manifest = await scanWorkspaceManifest({ workspaceRoot: root });

        expect(fingerprintWorkspaceManifest(manifest)).toBe('sha256:ecc9071a7df045ba58e5f2b770556771fdb62fd37cb1f69d6ff5cc870e6d644e');
    });
});
