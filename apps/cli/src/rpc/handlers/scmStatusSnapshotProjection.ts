import { createHash } from 'node:crypto';
import { SCM_OPERATION_ERROR_CODES, summarizeScmChanges, type ScmStatusSnapshotRequest, type ScmStatusSnapshotResponse, type ScmStatusSnapshotTransportResponse } from '@happier-dev/protocol/scm';
import { WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import type { ScmWorkingEntry } from '@happier-dev/protocol/scm/workingSnapshot';

function projectEntry(entry: ScmWorkingEntry) {
    return {
        path: entry.path, kind: entry.kind,
        includeStatus: entry.includeStatus, pendingStatus: entry.pendingStatus,
        previousPath: entry.previousPath === null ? undefined : entry.previousPath,
        hasIncludedDelta: entry.hasIncludedDelta || undefined,
        hasPendingDelta: entry.hasPendingDelta || undefined,
        stats: {
            includedAdded: entry.stats.includedAdded || undefined,
            includedRemoved: entry.stats.includedRemoved || undefined,
            pendingAdded: entry.stats.pendingAdded || undefined,
            pendingRemoved: entry.stats.pendingRemoved || undefined,
            isBinary: entry.stats.isBinary || undefined,
            isComplete: entry.stats.isComplete,
        },
    };
}

const listRevisions = new WeakMap<ScmStatusSnapshotResponse, string>();

/**
 * Content revision of the full changed-file list delivered from one settled computation. Observation
 * times are excluded, so a fresh scan of an unchanged working copy keeps its revision. Computed once
 * per shared computation (the status cache serves the same object to every concurrent reader).
 */
function readListRevision(response: ScmStatusSnapshotResponse, snapshot: NonNullable<ScmStatusSnapshotResponse['snapshot']>): string {
    let revision = listRevisions.get(response);
    if (revision === undefined) {
        const { freshness: _freshness, snapshot: _snapshot, ...facts } = response;
        const { fetchedAt: _fetchedAt, freshness: _snapshotFreshness, pullRequestStatus, ...snapshotFacts } = snapshot;
        // `checkedAt` is when the cached PR projection was read, not a PR fact.
        const { checkedAt: _checkedAt, ...pullRequestFacts } = pullRequestStatus ?? {};
        revision = createHash('sha256').update(JSON.stringify({ ...facts,
            snapshot: { ...snapshotFacts, pullRequestStatus: pullRequestStatus ? pullRequestFacts : pullRequestStatus } })).digest('base64url');
        listRevisions.set(response, revision);
    }
    return revision;
}

/** Project delivery only after the shared full status computation has settled. */
export function projectScmStatusSnapshot(response: ScmStatusSnapshotResponse, request: ScmStatusSnapshotRequest): ScmStatusSnapshotTransportResponse {
    const snapshot = response.snapshot;
    if (!snapshot) return response;
    if (request.detail) return {
        ...response,
        snapshot: {
            ...snapshot, entries: [], detail: request.detail,
            ...(request.detail === 'summary' ? { summary: snapshot.summary ?? summarizeScmChanges(snapshot.entries, snapshot.totals) } : {}),
        },
    };
    const page = request.entriesPage;
    const cursor = page?.cursor ?? 0;
    const selected = page?.path ? snapshot.entries.find(entry => entry.path === page.path) : undefined;
    const entries = page?.path ? (selected ? [selected] : [])
        : page ? snapshot.entries.slice(cursor, cursor + page.limit) : snapshot.entries;
    if (!page && entries.length === 0) return response;
    if (!page) {
        // A held, still-current full list is answered by its revision alone.
        const listRevision = readListRevision(response, snapshot);
        if (request.knownListRevision === listRevision) return { success: true, unchanged: true };
        return { ...response, snapshot: { ...snapshot, entries: entries.map(projectEntry), listRevision } };
    }
    const projectedEntries: ReturnType<typeof projectEntry>[] = [];
    const projected = {
        ...response,
        snapshot: {
            ...snapshot,
            entriesPage: {
                totalFiles: snapshot.entries.length,
                nextCursor: null as number | null,
            },
            entries: projectedEntries,
        },
    };
    // Count the fixed envelope once and each demanded entry once, including JSON commas.
    // Cursor bytes are adjusted from the envelope's literal null for each candidate page.
    let bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8');
    if (bytes > WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES) return {
        success: false, errorCode: SCM_OPERATION_ERROR_CODES.TOO_LARGE,
        error: 'SCM status metadata exceeds the socket response limit.',
    };
    for (const entry of entries) {
        const projectedEntry = projectEntry(entry);
        const entryBytes = Buffer.byteLength(JSON.stringify(projectedEntry), 'utf8') + (projectedEntries.length ? 1 : 0);
        const nextCursor = !page.path && cursor + projectedEntries.length + 1 < snapshot.entries.length
            ? cursor + projectedEntries.length + 1 : null;
        const cursorBytes = nextCursor === null ? 0 : String(nextCursor).length - 'null'.length;
        if (bytes + entryBytes + cursorBytes > WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES) {
            if (!projectedEntries.length) return {
                success: false, errorCode: SCM_OPERATION_ERROR_CODES.TOO_LARGE,
                error: 'An SCM status entry exceeds the socket response limit.',
            };
            break;
        }
        bytes += entryBytes;
        projectedEntries.push(projectedEntry);
        projected.snapshot.entriesPage.nextCursor = nextCursor;
    }
    return projected;
}
