/**
 * The Activity plane's panel-owned reader.
 *
 * Activity is the one detail plane that is neither the entry materialization nor the
 * sampled loader, and the one that keeps nothing. Its lifetime is the panel's active
 * interval: the first page starts when the panel becomes active, paging runs while it
 * stays active, and leaving aborts the request, rejects a late result, and discards every
 * row, page position, total and error. That is why this reader lives beside the panel
 * rather than above the tabs — a detail-root owner would outlive the leave the
 * declaration promises.
 *
 * The state machine is separated from the hook because that is where the risk is. Three
 * outcomes look alike on screen if the reducer confuses them and must not: a page the
 * provider stated as empty, a first page that failed, and a later page that failed after
 * rows were already visible. An empty tab and an unavailable tab are different answers,
 * and neither is the absence of the feature.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import type {
    TriageDetailSurfaceInputV1,
    TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID } from '../../posthogContracts.js';
import {
    PosthogIssueActivityResultV1Schema,
    type PosthogIssueActivityResultV1,
} from '../../source/detail/issueActivityContract.js';
import {
    POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT,
    type PosthogProjectedActivityRecord,
} from './activityProjection.js';

/** The page size one mounted Activity panel asks for. */
export const POSTHOG_ACTIVITY_PAGE_SIZE = POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT;

export type PosthogActivityStateV1 = Readonly<{
    kind: 'idle' | 'loading' | 'ready' | 'unavailable';
    records: readonly PosthogProjectedActivityRecord[];
    omittedRowCount: number;
    /** The provider's stated total, or `null` when it stated none. */
    totalCount: number | null;
    /** A request is in flight for this panel interval. */
    pending: boolean;
    /** The source-minted position of the next page, or `null` when the walk ended. */
    continuation: string | null;
    canLoadMore: boolean;
    /**
     * The last failure, kept visible beside whatever rows survived it. A permission or
     * authentication failure is a fact this plane states, never a reason to look empty.
     */
    failure: TriageSourceFailureV1 | null;
    /** Identifies the request whose result this state will accept. */
    token: number;
}>;

export type PosthogActivityEventV1 =
    | Readonly<{ kind: 'requestStarted'; token: number }>
    | Readonly<{
        kind: 'pageSettled';
        token: number;
        records: readonly PosthogProjectedActivityRecord[];
        omittedRowCount: number;
        totalCount: number | null;
        continuation: string | null;
    }>
    | Readonly<{ kind: 'pageFailed'; token: number; failure: TriageSourceFailureV1 }>
    /** The panel was left. This plane declares `discard`, so nothing survives it. */
    | Readonly<{ kind: 'panelLeft' }>;

const INITIAL: PosthogActivityStateV1 = Object.freeze({
    kind: 'idle' as const,
    records: Object.freeze([]),
    omittedRowCount: 0,
    totalCount: null,
    pending: false,
    continuation: null,
    canLoadMore: false,
    failure: null,
    token: 0,
});

export function posthogActivityInitialState(): PosthogActivityStateV1 {
    return INITIAL;
}

export function posthogActivityReducer(
    state: PosthogActivityStateV1,
    event: PosthogActivityEventV1,
): PosthogActivityStateV1 {
    switch (event.kind) {
        case 'panelLeft':
            return INITIAL;
        case 'requestStarted':
            return {
                ...state,
                kind: state.records.length === 0 ? 'loading' : state.kind,
                pending: true,
                canLoadMore: false,
                failure: null,
                token: event.token,
            };
        case 'pageSettled': {
            if (event.token !== state.token) {
                // The result belongs to a request this panel already replaced.
                return state;
            }
            return {
                kind: 'ready',
                records: [...state.records, ...event.records],
                omittedRowCount: state.omittedRowCount + event.omittedRowCount,
                totalCount: event.totalCount ?? state.totalCount,
                pending: false,
                continuation: event.continuation,
                canLoadMore: event.continuation !== null,
                failure: null,
                token: state.token,
            };
        }
        case 'pageFailed': {
            if (event.token !== state.token) {
                return state;
            }
            // Rows a reader already had survive a later failure — including the
            // authentication failure a mid-panel reconnect produces. Only a first page
            // that never arrived leaves the panel with nothing to show, and it says so
            // rather than showing an empty list.
            return {
                ...state,
                kind: state.records.length === 0 ? 'unavailable' : 'ready',
                pending: false,
                canLoadMore: state.continuation !== null,
                failure: event.failure,
            };
        }
        default:
            return state;
    }
}

export type PosthogActivityControllerV1 = Readonly<{
    state: PosthogActivityStateV1;
    loadMore: () => void;
}>;

function readActivityResult(result: unknown): PosthogIssueActivityResultV1 | null {
    const parsed = PosthogIssueActivityResultV1Schema.safeParse(result);
    return parsed.success ? parsed.data : null;
}

const MALFORMED_RESULT_FAILURE: TriageSourceFailureV1 = Object.freeze({
    class: 'unsupportedContract',
    code: 'posthog/activity-result-unreadable',
});

/**
 * Drives the activity read for one mounted Activity panel.
 *
 * The active interval is the whole lifetime: `activity.activeSignal` ends when the panel
 * is left, which aborts the in-flight page, and the reducer is reset in the same pass so
 * a re-entry starts from page one with nothing carried over.
 */
export function usePosthogActivityController(
    input: TriageDetailSurfaceInputV1,
): PosthogActivityControllerV1 {
    const [state, dispatch] = useReducer(posthogActivityReducer, INITIAL);
    const { active, activeSignal } = useTabPanelActivity();
    const interval = useRef<AbortSignal | null>(null);
    const action = useMemo(
        () => ({ pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.issueActivity }),
        [],
    );
    const { execute } = useExecutePluginAction(action);

    const readPage = useCallback(async (
        token: number,
        continuation: string | null,
        pageSignal: AbortSignal,
    ): Promise<void> => {
        dispatch({ kind: 'requestStarted', token });
        const execution = await execute({
            v: 1,
            instance: input.instance,
            localRef: {
                kindId: input.observation.entryRef.kindId,
                collisionScope: input.observation.entryRef.collisionScope,
                entryId: input.observation.entryRef.entryId,
            },
            limit: POSTHOG_ACTIVITY_PAGE_SIZE,
            ...(continuation === null ? {} : { continuation }),
        }, { signal: pageSignal });
        if (pageSignal.aborted) {
            return;
        }
        if (execution.status !== 'success') {
            dispatch({
                kind: 'pageFailed',
                token,
                failure: {
                    class: execution.status === 'error' ? 'transient' : 'unknown',
                    code: execution.status === 'idle' || execution.status === 'pending'
                        ? 'posthog/activity-read-not-dispatched'
                        : execution.code,
                },
            });
            return;
        }
        const parsed = readActivityResult(execution.result);
        if (parsed === null) {
            dispatch({ kind: 'pageFailed', token, failure: MALFORMED_RESULT_FAILURE });
            return;
        }
        if (parsed.kind === 'unavailable') {
            dispatch({ kind: 'pageFailed', token, failure: parsed.failure });
            return;
        }
        dispatch({
            kind: 'pageSettled',
            token,
            records: parsed.records,
            omittedRowCount: parsed.omittedRowCount,
            totalCount: parsed.totalCount ?? null,
            continuation: parsed.continuation ?? null,
        });
    }, [execute, input.instance, input.observation.entryRef]);

    useEffect(() => {
        if (!active) {
            return undefined;
        }
        interval.current = activeSignal;
        dispatch({ kind: 'panelLeft' });
        void readPage(1, null, activeSignal);
        return () => {
            interval.current = null;
            dispatch({ kind: 'panelLeft' });
        };
    }, [active, activeSignal, readPage]);

    const loadMore = useCallback(() => {
        const pageSignal = interval.current;
        if (!state.canLoadMore || state.continuation === null || pageSignal === null) {
            return;
        }
        void readPage(state.token + 1, state.continuation, pageSignal);
    }, [readPage, state.canLoadMore, state.continuation, state.token]);

    return useMemo(() => ({ state, loadMore }), [loadMore, state]);
}
