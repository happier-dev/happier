import type { TeamDirectorySourceSummaryV1 } from '@happier-dev/protocol/teams';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

import type { IdentityAdministrationFailure } from './identityAdministrationState';

export type DirectoryAdministrationState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; failure: IdentityAdministrationFailure }>
    | Readonly<{
        kind: 'ready';
        items: readonly TeamDirectorySourceSummaryV1[];
        nextCursor: string | null;
        refreshing: boolean;
        loadingMore: boolean;
        stale: boolean;
        failure: IdentityAdministrationFailure | null;
    }>;

export type DirectorySourceAdministrationState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; failure: IdentityAdministrationFailure }>
    | Readonly<{
        kind: 'ready';
        item: TeamDirectorySourceSummaryV1;
        refreshing: boolean;
        stale: boolean;
        failure: IdentityAdministrationFailure | null;
    }>;

export const INITIAL_DIRECTORY_ADMINISTRATION_STATE: DirectoryAdministrationState = Object.freeze({
    kind: 'loading' as const,
});

export const INITIAL_DIRECTORY_SOURCE_ADMINISTRATION_STATE: DirectorySourceAdministrationState = Object.freeze({
    kind: 'loading' as const,
});

export function beginDirectoryAdministrationRefresh(
    state: DirectoryAdministrationState,
): DirectoryAdministrationState {
    return state.kind === 'ready'
        ? Object.freeze({ ...state, refreshing: true, loadingMore: false, failure: null })
        : INITIAL_DIRECTORY_ADMINISTRATION_STATE;
}

export function beginDirectoryAdministrationContinuation(
    state: DirectoryAdministrationState,
): DirectoryAdministrationState {
    return state.kind === 'ready' && state.nextCursor !== null && !state.refreshing
        ? Object.freeze({ ...state, loadingMore: true, failure: null })
        : state;
}

export function settleDirectoryAdministrationRefresh(
    state: DirectoryAdministrationState,
    result: Readonly<
        | { ok: true; items: readonly TeamDirectorySourceSummaryV1[]; nextCursor: string | null }
        | { ok: false; failure: IdentityAdministrationFailure }
    >,
): DirectoryAdministrationState {
    if (!result.ok) {
        if (state.kind === 'ready') {
            return Object.freeze({
                ...state,
                refreshing: false,
                stale: true,
                failure: result.failure,
            });
        }
        return Object.freeze({ kind: 'unavailable' as const, failure: result.failure });
    }
    return Object.freeze({
        kind: 'ready' as const,
        items: retainKeyedRows(
            state.kind === 'ready' ? state.items : undefined,
            [...result.items].sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id)),
            row => row.id,
        ),
        nextCursor: result.nextCursor,
        refreshing: false,
        loadingMore: false,
        stale: false,
        failure: null,
    });
}

export function settleDirectoryAdministrationContinuation(
    state: DirectoryAdministrationState,
    result: Readonly<
        | { ok: true; items: readonly TeamDirectorySourceSummaryV1[]; nextCursor: string | null }
        | { ok: false; failure: IdentityAdministrationFailure }
    >,
): DirectoryAdministrationState {
    if (state.kind !== 'ready') return state;
    if (!result.ok) {
        return Object.freeze({
            ...state,
            loadingMore: false,
            failure: result.failure,
        });
    }
    const byId = new Map(state.items.map((item) => [item.id, item]));
    for (const item of result.items) byId.set(item.id, item);
    return settleDirectoryAdministrationRefresh(state, { ok: true, items: [...byId.values()], nextCursor: result.nextCursor });
}

export function beginDirectorySourceAdministrationRefresh(
    state: DirectorySourceAdministrationState,
): DirectorySourceAdministrationState {
    return state.kind === 'ready'
        ? Object.freeze({ ...state, refreshing: true })
        : INITIAL_DIRECTORY_SOURCE_ADMINISTRATION_STATE;
}

export function settleDirectorySourceAdministrationRefresh(
    state: DirectorySourceAdministrationState,
    result: Readonly<
        | { ok: true; item: TeamDirectorySourceSummaryV1 }
        | { ok: false; failure: IdentityAdministrationFailure }
    >,
): DirectorySourceAdministrationState {
    if (!result.ok) {
        if (state.kind === 'ready') {
            return Object.freeze({
                ...state,
                refreshing: false,
                stale: true,
                failure: result.failure,
            });
        }
        return Object.freeze({ kind: 'unavailable' as const, failure: result.failure });
    }
    return Object.freeze({
        kind: 'ready' as const,
        item: result.item,
        refreshing: false,
        stale: false,
        failure: null,
    });
}
