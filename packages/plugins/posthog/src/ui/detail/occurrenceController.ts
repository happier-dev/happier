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

/** The page size one detail session asks for; the provider ceiling is the only bound. */
export const POSTHOG_DETAIL_SAMPLE_PAGE_SIZE = POSTHOG_ISSUE_EVENTS_MAX_LIMIT;

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
 * Pages can begin at a nonzero provider offset after "Load more", so a selected row
 * must carry its own absolute offset rather than asking the evidence resolver to infer
 * it from the page start or a later, mutable list position.
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
    if (page === undefined || event === undefined) return undefined;
    return Object.freeze({
        event,
        frozenRequest: page.request,
        selectedAbsoluteOffset: page.request.offset + selectedIndex - page.start,
    });
}

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
            ...(parsed.frozenRequest === undefined ? {} : { frozenRequest: parsed.frozenRequest }),
            continuation: parsed.continuation ?? null,
            incomplete: parsed.incomplete ?? null,
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
