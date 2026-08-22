/**
 * The one paged-detail-panel state machine every Triage source shares.
 *
 * It is here rather than in one copy per source because the rule it enforces is
 * one product contract (`CONTRACT.md` §4, `REQ-04`), and a copy is a place for
 * "nothing here" to start looking like "we could not look". Four outcomes must
 * stay apart, and every source detail body has all four:
 *
 * 1. a collection the provider stated as **empty** — `ready` with no rows;
 * 2. a **first** read that failed — `unavailable`, naming itself;
 * 3. a **later** page that failed after rows were already visible — still
 *    `ready`, keeping what the reader already had, with the failure beside it;
 * 4. a walk that stopped **short of the whole collection** — `ready`, with the
 *    rows it has and an explicit reason.
 *
 * What it deliberately does NOT own is anything the sources genuinely differ on.
 * The failure vocabulary, the cursor bytes and the reason a walk stopped short
 * are all type parameters: GitHub has a documented 3,000-file ceiling that
 * GitLab does not, Bitbucket reports completeness rather than incompleteness,
 * and a source that has no short-walk reason instantiates `TIncomplete` as
 * `never`. Centralizing those would produce the abstraction the next source
 * fights.
 *
 * It lives in the published source contract rather than in a forge-shaped
 * package because the rule is not forge-shaped: an error-tracking source paging
 * occurrences owes its reader exactly these four answers, and a third-party
 * source author receives the rule with the contract (`REQ-09`).
 *
 * It is a pure reducer with no React dependency: the hook that drives it belongs
 * to each source's own mounted surface, where the panel lifetime lives.
 */

export type TriagePagedPanelStateV1<TRow, TFailure, TIncomplete = never> = Readonly<{
    kind: 'idle' | 'loading' | 'ready' | 'unavailable';
    rows: readonly TRow[];
    /** Provider rows the pages read returned but could not be understood. */
    omittedRowCount: number;
    /** `true` when the source shortened any content on the pages read. */
    projectionTruncated: boolean;
    /** A request is in flight for this panel interval. */
    pending: boolean;
    /** The source-minted position of the next page, or `null` when the walk ended. */
    continuation: string | null;
    canLoadMore: boolean;
    /** Why the walk stopped short, when it did. It survives later pages. */
    incomplete: TIncomplete | null;
    /**
     * The last failure, kept visible beside whatever rows survived it. A
     * permission or authentication failure is a fact a panel states, never a
     * reason to look empty.
     */
    failure: TFailure | null;
    /** Identifies the request whose result this state will accept. */
    token: number;
}>;

export type TriagePagedPanelPageV1<TRow, TIncomplete = never> = Readonly<{
    rows: readonly TRow[];
    omittedRowCount: number;
    projectionTruncated: boolean;
    continuation: string | null;
    incomplete: TIncomplete | null;
}>;

export type TriagePagedPanelEventV1<TRow, TFailure, TIncomplete = never> =
    | Readonly<{ kind: 'requestStarted'; token: number }>
    | Readonly<{
        kind: 'pageSettled';
        token: number;
        page: TriagePagedPanelPageV1<TRow, TIncomplete>;
    }>
    | Readonly<{ kind: 'pageFailed'; token: number; failure: TFailure }>
    /** The panel was left. Every source detail plane discards, so nothing survives. */
    | Readonly<{ kind: 'panelLeft' }>;

const INITIAL = Object.freeze({
    kind: 'idle' as const,
    rows: Object.freeze([]),
    omittedRowCount: 0,
    projectionTruncated: false,
    pending: false,
    continuation: null,
    canLoadMore: false,
    incomplete: null,
    failure: null,
    token: 0,
});

export function triagePagedPanelInitialState<TRow, TFailure, TIncomplete = never>():
TriagePagedPanelStateV1<TRow, TFailure, TIncomplete> {
    return INITIAL as TriagePagedPanelStateV1<TRow, TFailure, TIncomplete>;
}

export function triagePagedPanelReducer<TRow, TFailure, TIncomplete = never>(
    state: TriagePagedPanelStateV1<TRow, TFailure, TIncomplete>,
    event: TriagePagedPanelEventV1<TRow, TFailure, TIncomplete>,
): TriagePagedPanelStateV1<TRow, TFailure, TIncomplete> {
    switch (event.kind) {
        case 'panelLeft':
            return triagePagedPanelInitialState<TRow, TFailure, TIncomplete>();
        case 'requestStarted':
            return {
                ...state,
                // A page in flight over rows a reader already has must not flash a
                // loading skeleton over them.
                kind: state.rows.length === 0 ? 'loading' : state.kind,
                pending: true,
                // While a page is in flight the reader cannot ask for another one, but
                // the affordance stays mounted in its busy state rather than vanishing.
                canLoadMore: state.canLoadMore,
                failure: null,
                token: event.token,
            };
        case 'pageSettled': {
            // The result belongs to a request this panel already replaced.
            if (event.token !== state.token) return state;
            return {
                kind: 'ready',
                rows: [...state.rows, ...event.page.rows],
                omittedRowCount: state.omittedRowCount + event.page.omittedRowCount,
                projectionTruncated: state.projectionTruncated || event.page.projectionTruncated,
                pending: false,
                continuation: event.page.continuation,
                canLoadMore: event.page.continuation !== null,
                // A walk that stopped short stays short; a later page cannot retract
                // that fact, only a fresh walk can.
                incomplete: event.page.incomplete ?? state.incomplete,
                failure: null,
                token: state.token,
            };
        }
        case 'pageFailed': {
            if (event.token !== state.token) return state;
            // Rows a reader already had survive a later failure — including the
            // authentication failure a mid-panel reconnect produces. Only a first page
            // that never arrived leaves the panel with nothing to show, and it says so
            // rather than rendering an empty list.
            return {
                ...state,
                kind: state.rows.length === 0 ? 'unavailable' : 'ready',
                pending: false,
                canLoadMore: state.continuation !== null,
                failure: event.failure,
            };
        }
        default:
            return state;
    }
}
