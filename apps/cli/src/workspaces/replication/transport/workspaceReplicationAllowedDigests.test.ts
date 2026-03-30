import { describe, expect, it } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { assertWorkspaceReplicationDigestsAllowedByManifest } from './workspaceReplicationAllowedDigests';

describe('workspaceReplicationAllowedDigests', () => {
    it('allows digests that are present in the manifest', () => {
        const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const manifest: WorkspaceManifest = {
            entries: [
                {
                    kind: 'file',
                    relativePath: 'README.md',
                    digest,
                    sizeBytes: 1,
                    executable: false,
                },
            ],
        };

        expect(() => assertWorkspaceReplicationDigestsAllowedByManifest(manifest, [digest])).not.toThrow();
    });

    it('rejects digests that are not present in the manifest', () => {
        const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const manifest: WorkspaceManifest = {
            entries: [
                {
                    kind: 'file',
                    relativePath: 'README.md',
                    digest,
                    sizeBytes: 1,
                    executable: false,
                },
            ],
        };

        expect(() => assertWorkspaceReplicationDigestsAllowedByManifest(manifest, ['sha256:missing']))
            .toThrow(/not in manifest/i);
    });
});
