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
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageDetailRequest } from '@happier-dev/triage-sources/ui';
import {
    triagePagedPanelInitialState,
    triagePagedPanelReducer,
} from '@happier-dev/triage-protocol/v1';
import type {
    TriageDetailSurfaceInputV1,
    TriagePagedPanelEventV1,
    TriagePagedPanelStateV1,
    TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { POSTHOG_ISSUE_EVENTS_MAX_LIMIT } from '../../api/types/events.js';
import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID } from '../../posthogContracts.js';
import {
    PosthogSampledEventsResultV1Schema,
    type PosthogFrozenIssueEventsRequestV1,
    type PosthogSampleIncompleteV1,
    type PosthogSampledEventsResultV1,
} from '../../source/detail/issueEventsContract.js';
import type { PosthogProjectedIssueEvent } from './issueEventProjection.js';
import { buildPosthogDetailGetRequest } from './model.js';

/**
 * The sampled-occurrence state.
 *
 * The four-outcome paged rule is one product contract for every Triage source and
 * lives at `@happier-dev/triage-protocol` (`REQ-04`); this controller held a copy
 * of it, and the copy had already drifted on a user-visible rule. What is
 * genuinely this controller's own is the reader's selection, which is carried
 * beside the reduced state rather than inside it.
 */
export type PosthogSampleStateV1 = TriagePagedPanelStateV1<
    PosthogProjectedIssueEvent,
    TriageSourceFailureV1,
    PosthogSampleIncompleteV1
> & Readonly<{
    selectedUuid: string | null;
    /** Frozen request geometry beside, never inside, the sample rows it produced. */
    frozenPages: readonly Readonly<{
        start: number;
        end: number;
        request: PosthogFrozenIssueEventsRequestV1;
    }>[];
}>;

export type PosthogSampleEventV1 =
    | Readonly<{ kind: 'requestStarted'; token: number }>
    | Readonly<{
        kind: 'pageSettled';
        token: number;
        events: readonly PosthogProjectedIssueEvent[];
        omittedRowCount: number;
        continuation: string | null;
        /** Absent only when an older daemon cannot supply selected-evidence geometry. */
        frozenRequest?: PosthogFrozenIssueEventsRequestV1;
        /**
         * Why the walk stopped short of what the provider offered, when it did. A page
         * with neither this nor a continuation is the provider's own end of the sample.
         */
        incomplete: PosthogSampleIncompleteV1 | null;
    }>
    | Readonly<{ kind: 'pageFailed'; token: number; failure: TriageSourceFailureV1 }>
    | Readonly<{ kind: 'selected'; uuid: string }>
    | Readonly<{ kind: 'identityChanged' }>;

const INITIAL: PosthogSampleStateV1 = Object.freeze({
    ...triagePagedPanelInitialState<
        PosthogProjectedIssueEvent,
        TriageSourceFailureV1,
        PosthogSampleIncompleteV1
    >(),
    selectedUuid: null,
    frozenPages: [],
});

export function posthogSampleInitialState(): PosthogSampleStateV1 {
    return INITIAL;
}

/** Translates this controller's flat event into the shared reducer's page envelope. */
function toPagedEvent(
    event: PosthogSampleEventV1,
): TriagePagedPanelEventV1<
    PosthogProjectedIssueEvent,
    TriageSourceFailureV1,
    PosthogSampleIncompleteV1
> | null {
    switch (event.kind) {
        case 'pageSettled':
            return {
                kind: 'pageSettled',
                token: event.token,
                page: {
                    rows: event.events,
                    omittedRowCount: event.omittedRowCount,
                    // This controller shortens no content of its own.
                    projectionTruncated: false,
                    continuation: event.continuation,
                    incomplete: event.incomplete,
                },
            };
        case 'identityChanged':
            // A different entry or instance is a different detail session: its rows,
            // selection and position are not this one's to keep.
            return { kind: 'panelLeft' };
        case 'selected':
            return null;
        default:
            return event;
    }
}

export function posthogSampleReducer(
    state: PosthogSampleStateV1,
    event: PosthogSampleEventV1,
): PosthogSampleStateV1 {
    if (event.kind === 'selected') {
        const exists = state.rows.some((candidate) => candidate.uuid === event.uuid);
        return exists ? { ...state, selectedUuid: event.uuid } : state;
    }
    if (event.kind === 'identityChanged') return INITIAL;
    const paged = triagePagedPanelReducer<
        PosthogProjectedIssueEvent,
        TriageSourceFailureV1,
        PosthogSampleIncompleteV1
    >(state, toPagedEvent(event) as TriagePagedPanelEventV1<
        PosthogProjectedIssueEvent,
        TriageSourceFailureV1,
        PosthogSampleIncompleteV1
    >);
    if (paged === state) return state;
    const frozenPages = event.kind === 'pageSettled'
        && event.frozenRequest !== undefined
        && event.events.length > 0
        ? [...state.frozenPages, {
            start: state.rows.length,
            end: state.rows.length + event.events.length,
            request: event.frozenRequest,
        }]
        : state.frozenPages;
    // The reader's selection survives an append; only a first page supplies one.
    return {
        ...paged,
        selectedUuid: state.selectedUuid ?? paged.rows[0]?.uuid ?? null,
        frozenPages,
    };
}

export type PosthogOccurrenceControllerV1 = Readonly<{
    state: PosthogSampleStateV1;
    selectedEvent: PosthogProjectedIssueEvent | undefined;
    selectedFrozenRequest: PosthogFrozenIssueEventsRequestV1 | undefined;
    selectedAbsoluteOffset: number | undefined;
    select: (uuid: string) => void;
    loadMore: () => void;
}>;

/**
 * The exact selected row and the frozen native query geometry that produced it.
 *
 * The offset comes from the row itself, which is the only place it survives. A page can
 * begin at a nonzero provider offset after "Load more", a malformed sibling shortens the
 * accepted array without renumbering the provider's rows, and the Action envelope may
 * drop a suffix — so counting positions from the list is counting the wrong thing. A row
 * whose source never stated its position is not addressed by guessing one: it discloses
 * nothing, and the dispatch-time UUID equality gate remains unchanged beneath it.
 */
export function resolvePosthogSelectedEvidence(state: PosthogSampleStateV1): Readonly<{
    event: PosthogProjectedIssueEvent;
    frozenRequest: PosthogFrozenIssueEventsRequestV1;
    selectedAbsoluteOffset: number;
}> | undefined {
    const selectedIndex = state.rows.findIndex((candidate) => candidate.uuid === state.selectedUuid);
    if (selectedIndex < 0) return undefined;
    const page = state.frozenPages.find((candidate) => (
        selectedIndex >= candidate.start && selectedIndex < candidate.end
    ));
    const event = state.rows[selectedIndex];
    if (page === undefined || event === undefined || event.providerOffset === undefined) {
        return undefined;
    }
    return Object.freeze({
        event,
        frozenRequest: page.request,
        selectedAbsoluteOffset: event.providerOffset,
    });
}

function readSampledResult(result: unknown): PosthogSampledEventsResultV1 | null {
    const parsed = PosthogSampledEventsResultV1Schema.safeParse(result);
    return parsed.success ? parsed.data : null;
}

const MALFORMED_RESULT_FAILURE: TriageSourceFailureV1 = Object.freeze({
    class: 'unsupportedContract',
    code: 'posthog/sampled-result-unreadable',
});

/** Stable source-owned read authority across freshly parsed host panel inputs. */
export function usePosthogDetailRequest(input: TriageDetailSurfaceInputV1) {
    const request = useTriageDetailRequest(input);
    // Panel inputs are parsed afresh by the host. Only a change to the exact
    // request authority replaces this detail's sample; object allocation does not.
    return useMemo(() => ({
        ...request,
        overview: buildPosthogDetailGetRequest(input),
    }), [request]);
}

/**
 * Source panels share one sample. Hiding the source aborts unfinished paging;
 * its next root interval resumes that position without discarding settled rows.
 * Replacing the exact authority resets the sample, and retirement rejects late results.
 */
export function usePosthogOccurrenceController(
    input: TriageDetailSurfaceInputV1,
    signal: AbortSignal,
): PosthogOccurrenceControllerV1 {
    const [state, dispatch] = useReducer(posthogSampleReducer, INITIAL);
    // Paging shares the exact detail lifetime, not a source panel's interval.
    const lifetime = useRef<AbortController | null>(null);
    const action = useMemo(
        () => ({ pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.issueEvents }),
        [],
    );
    const { execute } = useExecutePluginAction(action);
    const request = usePosthogDetailRequest(input);
    const { active, activeSignal } = useTabPanelActivity();
    const previousRequest = useRef(request);
    if (previousRequest.current !== request) {
        previousRequest.current = request;
        dispatch({ kind: 'identityChanged' });
    }
    const currentState = useRef(state);
    currentState.current = state;

    const readPage = useCallback(async (
        token: number,
        continuation: string | null,
        pageSignal: AbortSignal,
    ): Promise<void> => {
        dispatch({ kind: 'requestStarted', token });
        const execution = await execute({
            v: 1,
            instance: request.instance,
            localRef: request.localRef,
            // The provider contract owns this ceiling; the controller adds no
            // second page-size policy.
            limit: POSTHOG_ISSUE_EVENTS_MAX_LIMIT,
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
            ...(parsed.frozenRequest === undefined ? {} : { frozenRequest: parsed.frozenRequest }),
            continuation: parsed.continuation ?? null,
            incomplete: parsed.incomplete ?? null,
        });
    }, [execute, request]);

    useEffect(() => {
        if (!active || activeSignal.aborted || signal.aborted) return undefined;
        const controller = new AbortController();
        lifetime.current = controller;
        const abort = (): void => {
            controller.abort();
        };
        signal.addEventListener('abort', abort);
        activeSignal.addEventListener('abort', abort);
        const current = currentState.current;
        if (current.kind === 'idle' || current.pending) {
            void readPage(current.token + 1, current.continuation, controller.signal);
        }
        return () => {
            signal.removeEventListener('abort', abort);
            activeSignal.removeEventListener('abort', abort);
            controller.abort();
        };
    }, [active, activeSignal, readPage, signal]);

    const select = useCallback((uuid: string) => {
        dispatch({ kind: 'selected', uuid });
    }, []);

    const loadMore = useCallback(() => {
        const pageSignal = lifetime.current?.signal;
        if (!active || !state.canLoadMore || state.continuation === null || pageSignal === undefined || pageSignal.aborted) {
            return;
        }
        void readPage(state.token + 1, state.continuation, pageSignal);
    }, [active, readPage, state.canLoadMore, state.continuation, state.token]);

    const selectedEvent = useMemo(
        () => state.rows.find((candidate) => candidate.uuid === state.selectedUuid),
        [state.rows, state.selectedUuid],
    );
    const selectedEvidence = useMemo(
        () => resolvePosthogSelectedEvidence(state),
        [state],
    );
    const selectedFrozenRequest = selectedEvidence?.frozenRequest;
    const selectedAbsoluteOffset = selectedEvidence?.selectedAbsoluteOffset;

    return useMemo(
        () => ({
            state,
            selectedEvent,
            selectedFrozenRequest,
            selectedAbsoluteOffset,
            select,
            loadMore,
        }),
        [loadMore, select, selectedAbsoluteOffset, selectedEvent, selectedFrozenRequest, state],
    );
}
