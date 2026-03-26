import { describe, expect, it } from 'vitest';

import { assertWorkspaceReplicationBlobPackRequestWithinLimits } from './assertWorkspaceReplicationBlobPackRequestWithinLimits';

describe('assertWorkspaceReplicationBlobPackRequestWithinLimits', () => {
    it('returns total bytes for a valid request', () => {
        const digestIndex = new Map<string, Readonly<{ sizeBytes: number }>>([
            ['sha256:a', { sizeBytes: 2 }],
            ['sha256:b', { sizeBytes: 3 }],
        ]);

        expect(assertWorkspaceReplicationBlobPackRequestWithinLimits({
            digestIndex,
            digests: ['sha256:a', 'sha256:b'],
            blobPackTargetBytes: 10,
            blobPackMaxSingleBlobBytes: 10,
        })).toBe(5);
    });

    it('throws when a digest is not present in the digest index', () => {
        const digestIndex = new Map<string, Readonly<{ sizeBytes: number }>>([
            ['sha256:a', { sizeBytes: 1 }],
        ]);

        expect(() => assertWorkspaceReplicationBlobPackRequestWithinLimits({
            digestIndex,
            digests: ['sha256:missing'],
            blobPackTargetBytes: 10,
            blobPackMaxSingleBlobBytes: 10,
        })).toThrow(/Workspace replication digest not in manifest/u);
    });

    it('throws when a single digest exceeds max single-blob bytes', () => {
        const digestIndex = new Map<string, Readonly<{ sizeBytes: number }>>([
            ['sha256:a', { sizeBytes: 11 }],
        ]);

        expect(() => assertWorkspaceReplicationBlobPackRequestWithinLimits({
            digestIndex,
            digests: ['sha256:a'],
            blobPackTargetBytes: 10,
            blobPackMaxSingleBlobBytes: 10,
        })).toThrow(/Workspace replication blob exceeds max single-blob bytes/u);
    });

    it('throws when multiple digests exceed the blob-pack target bytes', () => {
        const digestIndex = new Map<string, Readonly<{ sizeBytes: number }>>([
            ['sha256:a', { sizeBytes: 6 }],
            ['sha256:b', { sizeBytes: 6 }],
        ]);

        expect(() => assertWorkspaceReplicationBlobPackRequestWithinLimits({
            digestIndex,
            digests: ['sha256:a', 'sha256:b'],
            blobPackTargetBytes: 10,
            blobPackMaxSingleBlobBytes: 10,
        })).toThrow(/Workspace replication blob pack exceeds target bytes/u);
    });

    it('allows a single digest larger than blob-pack target bytes', () => {
        const digestIndex = new Map<string, Readonly<{ sizeBytes: number }>>([
            ['sha256:a', { sizeBytes: 11 }],
        ]);

        expect(assertWorkspaceReplicationBlobPackRequestWithinLimits({
            digestIndex,
            digests: ['sha256:a'],
            blobPackTargetBytes: 10,
            blobPackMaxSingleBlobBytes: 20,
        })).toBe(11);
    });
});
