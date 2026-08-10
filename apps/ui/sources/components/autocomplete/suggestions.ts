import { log } from '@/log';
import type { FileSuggestionScope } from '@/sync/domains/input/fileSuggestionScope';
import { ensureSessionSuggestionCatalogs } from '@/sync/ops/sessionCatalogs';

import type { AutocompleteSuggestion } from './autocompleteTypes';
import {
    readComposerSuggestionCatalogs,
    type ComposerSuggestionCatalogs,
} from './composerSuggestionCatalogs';
import {
    resolveComposerSuggestionKindsForTrigger,
    resolveComposerSuggestionScope,
    type ComposerSuggestionKindDefinition,
    type ComposerSuggestionKindId,
} from './composerSuggestionKinds';
import {
    COMPOSER_SUGGESTION_KIND_IDS,
    parseComposerSuggestionQuery,
} from './composerSuggestionGrammar';

export type { ComposerSuggestionCatalogs } from './composerSuggestionCatalogs';

/**
 * The composer suggestion dispatcher.
 *
 * It parses the active token once, resolves the eligible kinds for that trigger
 * from the registry, and fans out over all of them. Kind-specific behaviour lives
 * in `composerSuggestionKinds.ts`; nothing here knows what a file, plugin, skill
 * or command is.
 *
 * **No kind suppresses another (INV-2).** The predecessor asked a path-likeness
 * question about the query and used the answer to discard a whole kind: a bare
 * `@gm` returned zero files whenever one enabled plugin matched, and `@src/foo`
 * returned zero plugins. Both directions are gone; every eligible kind resolves,
 * and the result is a flat list ordered by section.
 */

/**
 * Wall clock one kind gets to produce rows for one query **while another kind
 * already has rows to show**.
 *
 * `Promise.allSettled` alone does not satisfy INV-2: it does not settle until
 * every promise settles, so a single hung kind would hide every healthy section
 * (D-25). The catalog kinds perform daemon RPC, so "hung" is a real state and not
 * a hypothetical one. Past this bound the kind contributes no rows, the other
 * sections still render, and the user has typed on anyway.
 *
 * The deadline is a TRIM, not a CUT-OFF. D-25 exists to stop a hung kind hiding a
 * healthy one; when nothing is healthy there is no section to protect and cutting
 * the fan-out short only delivers an empty picker. That is not hypothetical: the
 * file kind's first query in a session builds the index through a daemon ripgrep
 * RPC, measured at 3–26 s on a live host, so on a cold `@` EVERY eligible kind is
 * past the bound and the trim used to discard a completed result that arrived
 * milliseconds later. `getSuggestions` settles once per query, so a discarded
 * result is gone for good — the picker stayed empty until the next keystroke.
 * See `everyKindStillEmpty` below.
 */
export const COMPOSER_SUGGESTION_KIND_DEADLINE_MS = 2_500;

const EMPTY_CATALOGS: ComposerSuggestionCatalogs = Object.freeze({});

export type GetSuggestionsOptions = Readonly<{
    /** Bypasses the session-metadata catalog read entirely (test seam, SB-8). */
    catalogs?: ComposerSuggestionCatalogs;
    /** The host's eligible-kind subset (R-9). Defaults to every registered kind. */
    kinds?: readonly ComposerSuggestionKindId[];
    /**
     * The server this composer targets, for a host with no session yet (the new-session
     * composer). Hosts with a real session omit it and the session's own server is used.
     */
    serverId?: string | null;
    /**
     * The machine and folder the file kind searches — the identity a file search is actually
     * scoped by. An existing session resolves its own through
     * `resolveSessionFileSuggestionScope`; the new-session composer passes the machine and
     * directory the user picked. Omitted means no folder is chosen and files are not offered.
     */
    workspace?: FileSuggestionScope | null;
    /**
     * Aborts when this query is superseded or the host goes away (D-15).
     *
     * Ceiling, deliberately not engineered around: neither the file-search cache,
     * `searchCommands`, nor `sessionRpcWithServerScope` accepts a signal, so the
     * work already handed to them cannot be recalled — only stopped being waited
     * on, and never applied. Cancellation therefore means "this query's fan-out
     * settles immediately and contributes nothing", which is what the caller needs
     * and what the transports permit. If a transport ever gains real cancellation,
     * thread the signal down instead of widening this comment.
     */
    signal?: AbortSignal;
}>;

function describeSuggestionFailure(reason: unknown): string {
    if (reason instanceof Error) return reason.message;
    return typeof reason === 'string' ? reason : 'unknown error';
}

/**
 * What one kind produced for one query. A kind never rejects into the dispatcher:
 * its failure is a value, so it is reported once, from one place, and can never
 * become an unobserved rejection when the dispatcher stops waiting on it.
 */
type KindOutcome =
    | Readonly<{ status: 'rows'; rows: readonly AutocompleteSuggestion[] }>
    | Readonly<{ status: 'failed'; reason: string }>;

/** The kind is still running: past its deadline, or the query was superseded. */
type KindSettlement = KindOutcome | Readonly<{ status: 'running' }>;

const STILL_RUNNING: KindSettlement = Object.freeze({ status: 'running' });

function startKind(
    definition: ComposerSuggestionKindDefinition,
    args: KindResolveArgs,
): Promise<KindOutcome> {
    return resolveKindCandidates(definition, args).then(
        (rows): KindOutcome => ({ status: 'rows', rows }),
        (reason: unknown): KindOutcome => ({ status: 'failed', reason: describeSuggestionFailure(reason) }),
    );
}

/**
 * Observes `outcome` until it settles, the optional deadline elapses, or the query
 * is superseded — without leaking either the timer or the abort listener when the
 * normal path wins. `deadlineMs: null` waits for as long as the query is current.
 */
function settleKind(
    outcome: Promise<KindOutcome>,
    deadlineMs: number | null,
    signal: AbortSignal | undefined,
): Promise<KindSettlement> {
    if (deadlineMs === null && !signal) return outcome;
    return new Promise<KindSettlement>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (value: KindSettlement) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };

        function onAbort() {
            finish(STILL_RUNNING);
        }

        signal?.addEventListener('abort', onAbort);
        if (deadlineMs !== null) {
            timer = setTimeout(() => finish(STILL_RUNNING), deadlineMs);
        }
        void outcome.then(finish);
    });
}

/**
 * Resolves once every kind has settled, once ANY kind has produced rows, or once the
 * query is superseded — whichever comes first.
 *
 * This is what keeps D-25 true *past* the deadline. The deadline trims a slow kind so
 * a healthy one can render; the same guarantee has to survive the wait that follows,
 * because a kind whose transport never answers would otherwise hide every section
 * that is ready. Measured on an iOS dev client: for a bare `@` the plugin kind
 * produced its row in 12 ms and the picker was still empty ten minutes later, because
 * the file kind never settled at all and the wait had no second bound.
 */
function settleUntilAnyKindHasRows(
    outcomes: readonly Promise<KindOutcome>[],
    signal: AbortSignal | undefined,
): Promise<void> {
    return new Promise<void>((resolve) => {
        let remaining = outcomes.length;
        const finish = () => {
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        signal?.addEventListener('abort', finish);
        for (const outcome of outcomes) {
            void outcome.then((value) => {
                remaining -= 1;
                if (remaining === 0 || (value.status === 'rows' && value.rows.length > 0)) finish();
            });
        }
    });
}

function countRows(settlements: readonly KindSettlement[]): number {
    let total = 0;
    for (const settlement of settlements) {
        if (settlement.status === 'rows') total += settlement.rows.length;
    }
    return total;
}

type KindResolveArgs = Readonly<{
    sessionId: string | null;
    workspace: FileSuggestionScope | null;
    serverId: string | null;
    query: string;
    scopedQuery: string;
    scope: string | null;
    catalogOverrides: ComposerSuggestionCatalogs | undefined;
}>;

/**
 * Hydrates only the catalog this kind declares, then resolves it.
 *
 * The hydration lives inside the per-kind promise on purpose: a shared `ensure`
 * awaited before the fan-out would put the plugin catalog's daemon RPC on the
 * critical path of the Files section, which is the same INV-2 violation in a
 * different costume.
 */
async function resolveKindCandidates(
    definition: ComposerSuggestionKindDefinition,
    args: KindResolveArgs,
): Promise<readonly AutocompleteSuggestion[]> {
    let catalogs = args.catalogOverrides ?? EMPTY_CATALOGS;
    // Session catalogs are published BY a session, so with no session there is nothing to
    // hydrate and nothing to read. The kind still runs and simply finds an empty catalog.
    if (definition.catalog && !args.catalogOverrides && args.sessionId) {
        const catalogRequest: { vendorPlugins?: boolean; skills?: boolean } = {};
        catalogRequest[definition.catalog] = true;
        await ensureSessionSuggestionCatalogs(args.sessionId, catalogRequest);
        catalogs = readComposerSuggestionCatalogs(args.sessionId);
    }
    return await definition.resolve({
        sessionId: args.sessionId,
        workspace: args.workspace,
        serverId: args.serverId,
        query: args.query,
        scopedQuery: args.scopedQuery,
        scope: args.scope,
        catalogs,
        limit: definition.limit,
    });
}

export async function getSuggestions(
    sessionId: string | null,
    query: string,
    options?: GetSuggestionsOptions,
): Promise<AutocompleteSuggestion[]> {
    const parsed = parseComposerSuggestionQuery(query);
    if (!parsed) return [];

    const scope = resolveComposerSuggestionScope(parsed.trigger, parsed.query);
    const triggerKinds = resolveComposerSuggestionKindsForTrigger(
        options?.kinds ?? COMPOSER_SUGGESTION_KIND_IDS,
        parsed.trigger,
    );
    // A scope alias narrows the trigger to exactly one kind by explicit user
    // intent (`@plugin:foo`). That is not the implicit suppression INV-2 forbids.
    const definitions = scope.kind
        ? triggerKinds.filter((definition) => definition.id === scope.kind)
        : triggerKinds;
    if (definitions.length === 0) return [];

    const signal = options?.signal;
    if (signal?.aborted) return [];

    const args: KindResolveArgs = {
        sessionId,
        workspace: options?.workspace ?? null,
        serverId: options?.serverId ?? null,
        query: parsed.query,
        scopedQuery: scope.scopedQuery,
        scope: scope.scope,
        catalogOverrides: options?.catalogs,
    };

    // Started once. Both settlement passes below observe THESE promises, so no kind
    // is resolved twice and the second pass costs no extra work. Each outcome is also
    // recorded the moment it lands, so the second pass can snapshot what has arrived
    // without waiting on what has not — the recorder is registered first, so it has
    // always run by the time any later observer of the same promise resumes.
    const landed: (KindOutcome | undefined)[] = definitions.map(() => undefined);
    const outcomes = definitions.map((definition, index) => {
        const outcome = startKind(definition, args);
        void outcome.then((value) => { landed[index] = value; });
        return outcome;
    });

    let settlements = await Promise.all(outcomes.map(
        (outcome) => settleKind(outcome, COMPOSER_SUGGESTION_KIND_DEADLINE_MS, signal),
    ));
    // A superseded query contributes nothing, and reports nothing: a kind still
    // running because the user typed the next character is not a diagnostic.
    if (signal?.aborted) return [];

    // The deadline trims a slow kind so a HEALTHY one can render (D-25). With no
    // healthy kind there is nothing to render and nothing to protect, so keep
    // waiting rather than discard work that is about to finish — `getSuggestions`
    // settles once per query, so a discarded result never reaches the picker at
    // all. The wait ends the moment a kind becomes healthy, which is D-25 again by
    // its real trigger rather than by the clock, and supersession (D-15) ends it too.
    const everyKindStillEmpty = countRows(settlements) === 0
        && settlements.some((settlement) => settlement.status === 'running');
    if (everyKindStillEmpty) {
        // Reaching here means the user has been looking at an empty picker for the
        // whole deadline. Say so NOW rather than only once the wait ends: a kind
        // whose transport never answers would otherwise produce an empty picker and
        // total silence, which is the state this whole repair exists to end.
        const waitingFor = settlements
            .map((settlement, index) => settlement.status === 'running' ? definitions[index]!.id : null)
            .filter((id): id is ComposerSuggestionKindId => id !== null);
        log.log(`[composer-suggestions] "${query}" has no rows after ${COMPOSER_SUGGESTION_KIND_DEADLINE_MS}ms; still waiting on ${waitingFor.join(', ')}`);
        await settleUntilAnyKindHasRows(outcomes, signal);
        if (signal?.aborted) return [];
        settlements = landed.map((outcome) => outcome ?? STILL_RUNNING);
    }

    const suggestions: AutocompleteSuggestion[] = [];
    for (let index = 0; index < settlements.length; index += 1) {
        const definition = definitions[index]!;
        const settlement = settlements[index]!;
        if (settlement.status !== 'rows') {
            // The ONE place a kind's failure surfaces. A kind must not swallow its
            // own error into an empty array: that is indistinguishable from "no
            // matches" and leaves a broken picker with nothing to debug.
            const cause = settlement.status === 'failed'
                ? settlement.reason
                : `still running after ${COMPOSER_SUGGESTION_KIND_DEADLINE_MS}ms`;
            log.log(`[composer-suggestions] kind "${definition.id}" contributed no rows for "${query}": ${cause}`);
            continue;
        }
        // D-22's per-trigger budget is only real if each kind is actually bounded.
        // `limit` reaches the resolver as a query hint, but a catalog-backed kind
        // cannot push it into its source, so the bound is enforced here — once, for
        // every kind, including kinds added later.
        suggestions.push(...settlement.rows.slice(0, definition.limit));
    }
    return suggestions;
}
