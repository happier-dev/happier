import { describe, expect, it } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { WorkspaceReplicationBaselineRecord } from '../baseline/workspaceReplicationBaselineStore';

import { buildBaselineManifestComparison } from './buildBaselineManifestComparison';

function createManifest(entries: WorkspaceManifest['entries']): WorkspaceManifest {
    return { entries };
}

function createBaseline(manifest: WorkspaceManifest): WorkspaceReplicationBaselineRecord {
    return {
        manifestFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        manifest,
        savedAtMs: 123,
    };
}

describe('buildBaselineManifestComparison', () => {
    it('compares the current manifest against the persisted baseline manifest', () => {
        const baseline = createBaseline(createManifest([
            {
                kind: 'directory',
                relativePath: 'src',
            },
            {
                kind: 'file',
                relativePath: 'README.md',
                digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                executable: false,
                sizeBytes: 10,
            },
            {
                kind: 'file',
                relativePath: 'obsolete.txt',
                digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
                executable: false,
                sizeBytes: 4,
            },
        ]));
        const currentManifest = createManifest([
            {
                kind: 'directory',
                relativePath: 'src',
            },
            {
                kind: 'file',
                relativePath: 'README.md',
                digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
                executable: false,
                sizeBytes: 12,
            },
            {
                kind: 'file',
                relativePath: 'src/index.ts',
                digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
                executable: true,
                sizeBytes: 20,
            },
        ]);

        expect(buildBaselineManifestComparison({ baseline, currentManifest })).toEqual({
            baseline,
            baselineManifest: baseline.manifest,
            currentManifest,
            added: [
                {
                    kind: 'file',
                    relativePath: 'src/index.ts',
                    digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
                    executable: true,
                    sizeBytes: 20,
                },
            ],
            removed: [
                {
                    kind: 'file',
                    relativePath: 'obsolete.txt',
                    digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
                    executable: false,
                    sizeBytes: 4,
                },
            ],
            changed: [
                {
                    previous: {
                        kind: 'file',
                        relativePath: 'README.md',
                        digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                        executable: false,
                        sizeBytes: 10,
                    },
                    next: {
                        kind: 'file',
                        relativePath: 'README.md',
                        digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
                        executable: false,
                        sizeBytes: 12,
                    },
                },
            ],
            unchanged: [
                {
                    kind: 'directory',
                    relativePath: 'src',
                },
            ],
            hasChangesSinceBaseline: true,
        });
    });

    it('treats equivalent manifests as unchanged even when current manifest fingerprint metadata differs', () => {
        const baseline = createBaseline(createManifest([
            {
                kind: 'directory',
                relativePath: 'src',
            },
            {
                kind: 'file',
                relativePath: 'src/index.ts',
                digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
                executable: false,
                sizeBytes: 8,
            },
        ]));
        const currentManifest = {
            fingerprint: 'sha256:6666666666666666666666666666666666666666666666666666666666666666',
            entries: [
                {
                    kind: 'file',
                    relativePath: 'src/index.ts',
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

        expect(buildBaselineManifestComparison({ baseline, currentManifest })).toEqual({
            baseline,
            baselineManifest: baseline.manifest,
            currentManifest,
            added: [],
            removed: [],
            changed: [],
            unchanged: [
                {
                    kind: 'directory',
                    relativePath: 'src',
                },
                {
                    kind: 'file',
                    relativePath: 'src/index.ts',
                    digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
                    executable: false,
                    sizeBytes: 8,
                },
            ],
            hasChangesSinceBaseline: false,
        });
    });
});
