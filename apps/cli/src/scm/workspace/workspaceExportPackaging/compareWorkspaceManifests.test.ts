import { describe, expect, it } from 'vitest';

import { compareWorkspaceManifests, type WorkspaceManifest } from './compareWorkspaceManifests';

function createManifest(entries: WorkspaceManifest['entries']): WorkspaceManifest {
    return { entries };
}

describe('compareWorkspaceManifests', () => {
    it('classifies added removed changed and unchanged entries by relative path', () => {
        const previousManifest = createManifest([
            {
                kind: 'directory',
                relativePath: 'src',
            },
            {
                kind: 'file',
                relativePath: 'src/index.ts',
                digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                executable: false,
                sizeBytes: 10,
            },
            {
                kind: 'symlink',
                relativePath: 'src/readme-link',
                target: '../README.md',
            },
            {
                kind: 'file',
                relativePath: 'old.txt',
                digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                executable: false,
                sizeBytes: 4,
            },
        ]);

        const nextManifest = createManifest([
            {
                kind: 'directory',
                relativePath: 'src',
            },
            {
                kind: 'file',
                relativePath: 'src/index.ts',
                digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                executable: true,
                sizeBytes: 20,
            },
            {
                kind: 'symlink',
                relativePath: 'src/readme-link',
                target: '../README.md',
            },
            {
                kind: 'file',
                relativePath: 'src/new.ts',
                digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                executable: false,
                sizeBytes: 5,
            },
        ]);

        expect(compareWorkspaceManifests({ previousManifest, nextManifest })).toEqual({
            added: [
                {
                    kind: 'file',
                    relativePath: 'src/new.ts',
                    digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                    executable: false,
                    sizeBytes: 5,
                },
            ],
            removed: [
                {
                    kind: 'file',
                    relativePath: 'old.txt',
                    digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    executable: false,
                    sizeBytes: 4,
                },
            ],
            changed: [
                {
                    previous: {
                        kind: 'file',
                        relativePath: 'src/index.ts',
                        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        executable: false,
                        sizeBytes: 10,
                    },
                    next: {
                        kind: 'file',
                        relativePath: 'src/index.ts',
                        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                        executable: true,
                        sizeBytes: 20,
                    },
                },
            ],
            unchanged: [
                {
                    kind: 'directory',
                    relativePath: 'src',
                },
                {
                    kind: 'symlink',
                    relativePath: 'src/readme-link',
                    target: '../README.md',
                },
            ],
            hasChanges: true,
        });
    });

    it('treats entry kind changes at the same path as changed', () => {
        const previousManifest = createManifest([
            {
                kind: 'directory',
                relativePath: 'bin',
            },
        ]);
        const nextManifest = createManifest([
            {
                kind: 'file',
                relativePath: 'bin',
                digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                executable: true,
                sizeBytes: 12,
            },
        ]);

        expect(compareWorkspaceManifests({ previousManifest, nextManifest })).toMatchObject({
            added: [],
            removed: [],
            changed: [
                {
                    previous: {
                        kind: 'directory',
                        relativePath: 'bin',
                    },
                    next: {
                        kind: 'file',
                        relativePath: 'bin',
                        digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                        executable: true,
                        sizeBytes: 12,
                    },
                },
            ],
            unchanged: [],
            hasChanges: true,
        });
    });

    it('returns deterministic relative-path ordering even when inputs are not sorted', () => {
        const previousManifest = createManifest([
            {
                kind: 'file',
                relativePath: 'z-last.ts',
                digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                executable: false,
                sizeBytes: 1,
            },
            {
                kind: 'file',
                relativePath: 'a-first.ts',
                digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                executable: false,
                sizeBytes: 1,
            },
        ]);
        const nextManifest = createManifest([
            {
                kind: 'file',
                relativePath: 'm-middle.ts',
                digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
                executable: false,
                sizeBytes: 1,
            },
            {
                kind: 'file',
                relativePath: 'a-first.ts',
                digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                executable: false,
                sizeBytes: 1,
            },
            {
                kind: 'file',
                relativePath: 'z-last.ts',
                digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
                executable: false,
                sizeBytes: 2,
            },
        ]);

        const comparison = compareWorkspaceManifests({ previousManifest, nextManifest });

        expect(comparison.added.map((entry) => entry.relativePath)).toEqual(['m-middle.ts']);
        expect(comparison.changed.map((entry) => entry.next.relativePath)).toEqual(['z-last.ts']);
        expect(comparison.unchanged.map((entry) => entry.relativePath)).toEqual(['a-first.ts']);
        expect(comparison.removed).toEqual([]);
    });

    it('reports no changes for equivalent manifests regardless of entry ordering or manifest fingerprint metadata', () => {
        const previousManifest = {
            fingerprint: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
            entries: [
                {
                    kind: 'file',
                    relativePath: 'README.md',
                    digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
                    executable: false,
                    sizeBytes: 8,
                },
                {
                    kind: 'directory',
                    relativePath: 'src',
                },
            ],
        } satisfies WorkspaceManifest;

        const nextManifest = {
            fingerprint: 'sha256:6666666666666666666666666666666666666666666666666666666666666666',
            entries: [
                {
                    kind: 'directory',
                    relativePath: 'src',
                },
                {
                    kind: 'file',
                    relativePath: 'README.md',
                    digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
                    executable: false,
                    sizeBytes: 8,
                },
            ],
        } satisfies WorkspaceManifest;

        expect(compareWorkspaceManifests({ previousManifest, nextManifest })).toEqual({
            added: [],
            removed: [],
            changed: [],
            unchanged: [
                {
                    kind: 'file',
                    relativePath: 'README.md',
                    digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
                    executable: false,
                    sizeBytes: 8,
                },
                {
                    kind: 'directory',
                    relativePath: 'src',
                },
            ],
            hasChanges: false,
        });
    });
});
