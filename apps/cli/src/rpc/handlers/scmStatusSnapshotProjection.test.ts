import { describe, expect, it } from 'vitest';
import { SCM_OPERATION_ERROR_CODES, type ScmStatusSnapshotResponse } from '@happier-dev/protocol/scm';
import { WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';

import { createNonRepositorySnapshot } from '@/scm/runtime';
import { projectScmStatusSnapshot } from './scmStatusSnapshotProjection';

function status(paths: string[]): ScmStatusSnapshotResponse & { snapshot: NonNullable<ScmStatusSnapshotResponse['snapshot']> } {
    const snapshot = createNonRepositorySnapshot({ projectKey: 'machine:/repo', fetchedAt: 1 });
    snapshot.entries = paths.map(path => ({
        path, previousPath: null, kind: 'untracked', includeStatus: '?', pendingStatus: '?',
        hasIncludedDelta: false, hasPendingDelta: true,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
    }));
    return { success: true, snapshot };
}

describe('SCM status page transport boundary', () => {
    it('stops at caller demand even when the socket could carry more entries', () => {
        const response = projectScmStatusSnapshot(status(['first.txt', 'next.txt']), { entriesPage: { limit: 1 } });
        expect(response.snapshot?.entries.map(entry => entry.path)).toEqual(['first.txt']);
        expect(response.snapshot?.entriesPage).toEqual({ totalFiles: 2, nextCursor: 1 });
        expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES);
    });

    it('fits a UTF-8 boundary entry and continues without losing the following entry', () => {
        const input = status(['', 'next.txt']);
        const framingBytes = Buffer.byteLength(JSON.stringify(projectScmStatusSnapshot(input, { entriesPage: { limit: 1 } })), 'utf8');
        const pathBytes = WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES - framingBytes;
        input.snapshot.entries[0]!.path = 'é'.repeat(Math.floor(pathBytes / 2)) + (pathBytes % 2 ? 'x' : '');
        const first = projectScmStatusSnapshot(input, { entriesPage: { limit: 2 } });
        expect(first.success).toBe(true);
        expect(first.snapshot?.entries).toHaveLength(1);
        expect(first.snapshot?.entriesPage).toEqual({ totalFiles: 2, nextCursor: 1 });
        expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBe(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES);
        const next = projectScmStatusSnapshot(input, { entriesPage: { limit: 2, cursor: 1 } });
        expect(next.snapshot?.entries.map(entry => entry.path)).toEqual(['next.txt']);
        expect(next.snapshot?.entriesPage).toEqual({ totalFiles: 2, nextCursor: null });
    });

    it('reports an oversized entry or metadata and allows a later entry to be requested', () => {
        const oversized = 'é'.repeat(Math.ceil(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES / 2));
        const input = status([oversized, 'next.txt']);
        const first = projectScmStatusSnapshot(input, { entriesPage: { limit: 2 } });
        expect(first.success).toBe(false);
        expect(first.errorCode).toBe(SCM_OPERATION_ERROR_CODES.TOO_LARGE);
        expect(first.error).toEqual(expect.any(String));
        expect(first.snapshot).toBeUndefined();
        const exact = projectScmStatusSnapshot(input, { entriesPage: { limit: 1, path: oversized } });
        expect(exact.success).toBe(false);
        expect(exact.errorCode).toBe(SCM_OPERATION_ERROR_CODES.TOO_LARGE);
        const next = projectScmStatusSnapshot(input, { entriesPage: { limit: 1, cursor: 1 } });
        expect(next.snapshot?.entries.map(entry => entry.path)).toEqual(['next.txt']);
        // Older callers retain their existing full-response behavior.
        expect(projectScmStatusSnapshot(input, {}).snapshot?.entries).toHaveLength(2);
        input.snapshot.projectKey = oversized;
        const metadata = projectScmStatusSnapshot(input, { entriesPage: { limit: 1, cursor: 2 } });
        expect(metadata.success).toBe(false);
        expect(metadata.errorCode).toBe(SCM_OPERATION_ERROR_CODES.TOO_LARGE);
        expect(metadata.snapshot).toBeUndefined();
    });
});
