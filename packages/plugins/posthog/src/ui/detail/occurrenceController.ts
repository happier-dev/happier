/**
 * The detail-instance sampled-occurrence controller.
 *
 * One controller, keyed by the exact configured instance and entry, owns the sampled
 * rows, the selected occurrence and the paging position for all three sampled-data
 * panels. Occurrences, Stack Trace and Affected Sessions read from it; none of them
 * fetches, caches or cancels. Switching between them therefore neither aborts the
 * request nor starts a second one, which is the whole point of putting this state above
 * the tabs rather than inside one of them.
 *
 * The state machine is separated from the hook because that is where the risk is. A
 * sampled page that settles after its request was superseded, a failed second page that
 * blanks rows a reader already had, and a selection pointing at a row the sample no
 * longer carries are all silent defects; each is a reducer case with a test, not a
 * behaviour hidden in an effect.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useExecutePluginAction } from '@happier-dev/plugin-ui';
import type {
    TriageDetailSurfaceInputV1,
    TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { POSTHOG_ISSUE_EVENTS_MAX_LIMIT } from '../../api/types/events.js';
import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID } from '../../posthogContracts.js';
import {
    PosthogSampledEventsResultV1Schema,
    type PosthogSampledEventsResultV1,
} from '../../source/detail/issueEventsContract.js';
import type { PosthogProjectedIssueEvent } from './issueEventProjection.js';

/** The page size one detail session asks for; the provider ceiling is the only bound. */
export const POSTHOG_DETAIL_SAMPLE_PAGE_SIZE = POSTHOG_ISSUE_EVENTS_MAX_LIMIT;

export type PosthogSampleStateV1 = Readonly<{
    kind: 'idle' | 'loading' | 'ready' | 'unavailable';
    events: readonly PosthogProjectedIssueEvent[];
    omittedRowCount: number;
    selectedUuid: string | null;
    /** A request is in flight for this exact detail instance. */
    pending: boolean;
    /** The source-minted position of the next page, or `null` when the sample ended. */
    continuation: string | null;
    canLoadMore: boolean;
    failure: TriageSourceFailureV1 | null;
    /** Identifies the request whose result this state will accept. */
    token: number;
}>;

export type PosthogSampleEventV1 =
    | Readonly<{ kind: 'requestStarted'; token: number }>
    | Readonly<{
        kind: 'pageSettled';
        token: number;
        events: readonly PosthogProjectedIssueEvent[];
        omittedRowCount: number;
        continuation: string | null;
    }>
    | Readonly<{ kind: 'pageFailed'; token: number; failure: TriageSourceFailureV1 }>
    | Readonly<{ kind: 'selected'; uuid: string }>
    | Readonly<{ kind: 'identityChanged' }>;

const INITIAL: PosthogSampleStateV1 = Object.freeze({
    kind: 'idle' as const,
    events: Object.freeze([]),
    omittedRowCount: 0,
    selectedUuid: null,
    pending: false,
    continuation: null,
    canLoadMore: false,
    failure: null,
    token: 0,
});

export function posthogSampleInitialState(): PosthogSampleStateV1 {
    return INITIAL;
}

export function posthogSampleReducer(
    state: PosthogSampleStateV1,
    event: PosthogSampleEventV1,
): PosthogSampleStateV1 {
    switch (event.kind) {
        case 'identityChanged':
            // A different entry or instance is a different detail session: its rows,
            // selection and position are not this one's to keep.
            return INITIAL;
        case 'requestStarted':
            return {
                ...state,
                kind: state.events.length === 0 ? 'loading' : state.kind,
                pending: true,
                canLoadMore: false,
                failure: null,
                token: event.token,
            };
        case 'pageSettled': {
            if (event.token !== state.token) {
                // The result belongs to a request this controller already replaced.
                return state;
            }
            const events = [...state.events, ...event.events];
            return {
                kind: 'ready',
                events,
                omittedRowCount: state.omittedRowCount + event.omittedRowCount,
                selectedUuid: state.selectedUuid ?? events[0]?.uuid ?? null,
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
            // Rows a reader already had survive a later failure. Only a first page that
            // never arrived leaves the panel with nothing to show.
            return {
                ...state,
                kind: state.events.length === 0 ? 'unavailable' : 'ready',
                pending: false,
                canLoadMore: state.continuation !== null,
                failure: event.failure,
            };
        }
        case 'selected': {
            const exists = state.events.some((candidate) => candidate.uuid === event.uuid);
            return exists ? { ...state, selectedUuid: event.uuid } : state;
        }
        default:
            return state;
    }
}

export type PosthogOccurrenceControllerV1 = Readonly<{
    state: PosthogSampleStateV1;
    selectedEvent: PosthogProjectedIssueEvent | undefined;
    select: (uuid: string) => void;
    loadMore: () => void;
}>;

function detailIdentity(input: TriageDetailSurfaceInputV1): string {
    const { entryRef } = input.observation;
    return [
        input.instance.instance.sourceInstanceId,
        entryRef.collisionScope,
        entryRef.entryId,
    ].join('\0');
}

function readSampledResult(result: unknown): PosthogSampledEventsResultV1 | null {
    const parsed = PosthogSampledEventsResultV1Schema.safeParse(result);
    return parsed.success ? parsed.data : null;
}

const MALFORMED_RESULT_FAILURE: TriageSourceFailureV1 = Object.freeze({
    class: 'unsupportedContract',
    code: 'posthog/sampled-result-unreadable',
});

/**
 * Drives the sampled read for one mounted detail instance.
 *
 * The first page starts when the surface mounts and restarts only when the exact
 * instance/entry changes. `RenderContext.signal` is the detail-instance lifetime: the
 * host aborts it when the surface is retired, and this hook aborts its own controller
 * when the identity changes, so a late result can reach neither this state nor a panel.
 */
export function usePosthogOccurrenceController(
    input: TriageDetailSurfaceInputV1,
    signal: AbortSignal,
): PosthogOccurrenceControllerV1 {
    const [state, dispatch] = useReducer(posthogSampleReducer, INITIAL);
    // The current detail session's own lifetime. Paging uses it too, so a page requested
    // just before an identity change is aborted rather than left to be rejected by its
    // token after the fact.
    const lifetime = useRef<AbortController | null>(null);
    const identity = detailIdentity(input);
    const action = useMemo(
        () => ({ pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.issueEvents }),
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
            limit: POSTHOG_DETAIL_SAMPLE_PAGE_SIZE,
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
                        ? 'posthog/sampled-read-not-dispatched'
                        : execution.code,
                },
            });
            return;
        }
        const parsed = readSampledResult(execution.result);
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
            events: parsed.events,
            omittedRowCount: parsed.omittedRowCount,
            continuation: parsed.continuation ?? null,
        });
    }, [execute, input.instance, input.observation.entryRef]);

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        const abort = (): void => {
            controller.abort();
        };
        signal.addEventListener('abort', abort);
        dispatch({ kind: 'identityChanged' });
        void readPage(1, null, controller.signal);
        return () => {
            signal.removeEventListener('abort', abort);
            controller.abort();
        };
    }, [identity, readPage, signal]);

    const select = useCallback((uuid: string) => {
        dispatch({ kind: 'selected', uuid });
    }, []);

    const loadMore = useCallback(() => {
        const pageSignal = lifetime.current?.signal;
        if (!state.canLoadMore || state.continuation === null || pageSignal === undefined) {
            return;
        }
        void readPage(state.token + 1, state.continuation, pageSignal);
    }, [readPage, state.canLoadMore, state.continuation, state.token]);

    const selectedEvent = useMemo(
        () => state.events.find((candidate) => candidate.uuid === state.selectedUuid),
        [state.events, state.selectedUuid],
    );

    return useMemo(
        () => ({ state, selectedEvent, select, loadMore }),
        [loadMore, select, selectedEvent, state],
    );
}
