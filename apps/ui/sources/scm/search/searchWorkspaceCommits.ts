import type { ScmLogEntry, ScmLogListRequest, ScmLogListResponse } from '@happier-dev/protocol';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { machineScmLogList } from '@/sync/ops/scm/machineScm';
import {
    normalizeWorkspaceScopeBase,
    type WorkspaceScopeBase,
} from '@/sync/domains/workspaces/workspaceScope';

/**
 * Bounded commit search for one exact workspace (Universal Search US-05).
 *
 * Scope: the request always carries the full `{ serverId, machineId, rootPath }` tuple as the
 * explicit workspace scope — the same discipline `searchWorkspaceFiles` enforces for files.
 * A scope that names no workspace refuses to issue any RPC; it never falls back to an
 * arbitrary workspace or an arbitrary machine.
 *
 * Honesty: the SCM owner applies the bounded query server-side (SHA prefix, subject/body,
 * author). An older daemon silently ignores the `query` field, so the response's
 * `queryApplied` echo is the only truthful signal:
 * - present  → the entries are real query matches;
 * - absent   → the daemon does not support commit search and the entries are its bounded
 *   recent page, which callers must label as "Recent commits", never as search results;
 * - failure  → typed local truth (offline machine, non-repository, unsupported daemon).
 *
 * There is deliberately no client-side filtering of a recent page and no all-machine or
 * all-repository fanout.
 *
 * Activation: a matched entry carries the exact commit identity (`sha`) for the canonical
 * project-or-Session pane details owner.
 */

export type WorkspaceCommitSearchOutcome =
    | Readonly<{ status: 'matches'; entries: readonly ScmLogEntry[] }>
    | Readonly<{ status: 'recentOnly'; entries: readonly ScmLogEntry[] }>
    | Readonly<{
        status: 'unavailable';
        reason: 'noWorkspaceScope' | 'notRepository' | 'backendUnavailable' | 'unsupported' | 'error';
        message?: string;
    }>;

function unavailable(
    reason: Extract<WorkspaceCommitSearchOutcome, { status: 'unavailable' }>['reason'],
    message?: string,
): WorkspaceCommitSearchOutcome {
    return message ? { status: 'unavailable', reason, message } : { status: 'unavailable', reason };
}

function mapFailureToOutcome(response: ScmLogListResponse): WorkspaceCommitSearchOutcome {
    switch (response.errorCode) {
        case SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY:
            return unavailable('notRepository', response.error);
        case SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE:
            return unavailable('backendUnavailable', response.error);
        case SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED:
            return unavailable('unsupported', response.error);
        default:
            return unavailable('error', response.error);
    }
}

export async function searchWorkspaceCommits(input: Readonly<{
    scope: WorkspaceScopeBase | null;
    accountId?: string | null;
    accountIsCurrent?: () => boolean;
    query: string;
    limit?: number;
    signal?: AbortSignal;
}>): Promise<WorkspaceCommitSearchOutcome> {
    // Fail closed on a scope that names no exact workspace: an unaddressable repository has
    // no owner to query, and guessing one would search the wrong machine's checkout.
    const scope = input.scope ? normalizeWorkspaceScopeBase(input.scope) : null;
    if (!scope) {
        return unavailable('noWorkspaceScope');
    }

    const query = String(input.query ?? '').trim();
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(500, Math.floor(input.limit)))
        : 50;

    const request: ScmLogListRequest = {
        cwd: scope.rootPath,
        limit,
        ...(query ? { query } : {}),
    };
    const response = await machineScmLogList(scope.machineId, request, {
        serverId: scope.serverId,
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    });

    if (input.signal?.aborted || input.accountIsCurrent?.() === false) {
        const error = new Error('Workspace commit search was superseded');
        error.name = 'AbortError';
        throw error;
    }

    if (!response.success) {
        return mapFailureToOutcome(response);
    }

    const entries = response.entries ?? [];
    if (!query) {
        return { status: 'recentOnly', entries };
    }
    // The echo is the only honest signal: absent means an older daemon ignored the query and
    // answered with its bounded recent page.
    if (response.queryApplied !== true) {
        return { status: 'recentOnly', entries };
    }
    return { status: 'matches', entries };
}
