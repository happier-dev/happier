import {
    SCM_OPERATION_ERROR_CODES,
    SCM_STATUS_ENTRIES_MAX_PAGE,
    type ScmStatusEntriesRequest,
    type ScmStatusEntriesResponse,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../types';
import { getGitSnapshot } from './repository';

/**
 * This RPC's one deterministic total order over entry paths: code-point
 * comparison, NOT `localeCompare` (locale-dependent — the repo already bans
 * it for signatures). Defined here for this RPC contract only; the ordering
 * of `snapshot.entries` itself is unchanged.
 */
function compareEntryPaths(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/**
 * Paged entry-list delivery for the Files surface (`scm.status.entries`).
 *
 * Every page is a fresh bounded read (no generation/lease/pinning machinery,
 * no TTL cache — the snapshot handler's coalescing cache is the only cache);
 * the surface re-fetches when its snapshot signature advances. The read runs
 * in 'all' mode so per-file rows — including the files under a collapsed
 * directory row from a 'normal'-mode snapshot — are always available to page
 * and to expand.
 */
export async function gitStatusEntries(input: {
    context: ScmBackendContext;
    request: ScmStatusEntriesRequest;
}): Promise<ScmStatusEntriesResponse> {
    const { context, request } = input;
    const snapshotResponse = await getGitSnapshot({ context, request: {} });
    const fetchedAt = Date.now();
    if (snapshotResponse.success !== true || !snapshotResponse.snapshot) {
        return {
            success: false,
            entries: [],
            hasMore: false,
            fetchedAt,
            error: snapshotResponse.error,
            errorCode: snapshotResponse.errorCode,
        };
    }

    let entries = snapshotResponse.snapshot.entries;
    if (typeof request.expandPath === 'string' && request.expandPath.length > 0) {
        const prefix = request.expandPath.endsWith('/') ? request.expandPath : `${request.expandPath}/`;
        entries = entries.filter((entry) => entry.path.startsWith(prefix));
    }
    if (request.area === 'included') {
        entries = entries.filter((entry) => entry.hasIncludedDelta);
    } else if (request.area === 'pending') {
        entries = entries.filter((entry) => entry.hasPendingDelta);
    }

    const sorted = [...entries].sort((left, right) => compareEntryPaths(left.path, right.path));
    const limit = Math.min(
        Math.max(1, Math.floor(request.limit ?? SCM_STATUS_ENTRIES_MAX_PAGE)),
        SCM_STATUS_ENTRIES_MAX_PAGE,
    );
    // The cursor is exclusive: the page starts at the first path strictly
    // greater than `afterPath`.
    const afterPath = request.afterPath;
    const startIndex = afterPath === undefined
        ? 0
        : sorted.findIndex((entry) => compareEntryPaths(entry.path, afterPath) > 0);
    if (startIndex < 0) {
        return { success: true, entries: [], hasMore: false, fetchedAt };
    }
    const page = sorted.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < sorted.length;
    return {
        success: true,
        entries: page,
        hasMore,
        ...(hasMore && page.length > 0 ? { nextCursor: page[page.length - 1]!.path } : {}),
        fetchedAt,
    };
}
