import { log } from '@/log';
import { ensureSessionSuggestionCatalogs } from '@/sync/ops/sessionCatalogs';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import type { FileSuggestionScope } from '@/sync/domains/input/suggestionFile';

import type {
    AutocompleteSuggestion,
    AutocompleteSuggestionUpdate,
} from './autocompleteTypes';
import {
    readComposerSuggestionCatalogs,
    type ComposerSuggestionCatalogs,
} from './composerSuggestionCatalogs';
import {
    resolveComposerSuggestionKindsForTrigger,
    resolveComposerSuggestionScope,
    type ComposerReferenceSearchHost,
    type ComposerSuggestionKindDefinition,
    type ComposerSuggestionKindId,
} from './composerSuggestionKinds';
import { COMPOSER_SUGGESTION_KIND_DEADLINE_MS as SHARED_COMPOSER_SUGGESTION_KIND_DEADLINE_MS } from './composerSuggestionDeadlines';
import type { PluginContributedActionDescriptor } from '@/components/plugins/actions/pluginContributedActionController';
import {
    COMPOSER_SUGGESTION_KIND_IDS,
    parseComposerSuggestionQuery,
    type ComposerSuggestionTrigger,
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
 * Wall clock one kind gets to produce rows for one query.
 *
 * `Promise.allSettled` alone does not satisfy INV-2: it does not settle until
 * every promise settles, so a single hung kind would hide every healthy section
 * (D-25). The catalog kinds perform daemon RPC, so "hung" is a real state and not
 * a hypothetical one. Past this bound the kind contributes no rows, the other
 * sections still render, and the user has typed on anyway.
 */
export const COMPOSER_SUGGESTION_KIND_DEADLINE_MS = SHARED_COMPOSER_SUGGESTION_KIND_DEADLINE_MS;

/**
 * How much longer a COLD query may wait once the deadline has passed and every
 * section is still empty.
 *
 * The extended wait exists so a first late row can still appear, and `signal`
 * releases it when the user types on. Neither covers the user who stops typing
 * while a transport is stuck: without a second bound the query never settles
 * and the picker never learns the query is over.
 *
 * The bound is not chosen, it is inherited. Every cold producer here — catalog
 * hydration and the file index alike — bottoms out on a server-scoped daemon
 * RPC whose unqualified operation ceiling is
 * `DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS`. Anything still unsettled past that is
 * stuck rather than slow, so the total wait for one query is exactly that
 * ceiling and this grace is the part of it the deadline has not already spent.
 *
 * When it fires: the pending kinds are aborted, one diagnostic per kind names
 * what was dropped, and the query completes with no rows — the same terminal
 * publication a genuinely empty query makes. Catalog hydration is deliberately
 * signal-independent, so it keeps running and warms the next keystroke.
 */
export const COMPOSER_SUGGESTION_COLD_START_GRACE_MS =
    DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS - COMPOSER_SUGGESTION_KIND_DEADLINE_MS;

const EMPTY_CATALOGS: ComposerSuggestionCatalogs = Object.freeze({});
const KIND_DEADLINE_EXPIRED = Symbol('composer-suggestion-kind-deadline-expired');

export type GetSuggestionsOptions = Readonly<{
    /** Bypasses the session-metadata catalog read entirely (test seam, SB-8). */
    catalogs?: ComposerSuggestionCatalogs;
    /** The host's eligible-kind subset (R-9). Defaults to every registered kind. */
    kinds?: readonly ComposerSuggestionKindId[];
    /**
     * The machine + folder this composer's file search is addressed to.
     *
     * A composer attached to an existing session must NOT resolve this itself — it goes
     * through `resolveSessionComposerSuggestions`, which is the one place a session becomes a
     * workspace address. This option exists for the new-session composer, the one host with
     * no session to resolve one from.
     */
    workspace?: FileSuggestionScope | null;
    /**
     * The server whose sessions are referenceable, when the host has no session to derive it
     * from. Only the new-session composer sets it (D-8).
     */
    serverId?: string | null;
    /**
     * Aborts when this query is superseded or the host goes away (D-15).
     *
     * Public reference and file search receive this signal all the way to their
     * daemon effects. Catalog hydration remains deliberately independent so a
     * cold query can warm the next one after its picker work is superseded.
     */
    signal?: AbortSignal;
    /** Current session-composer daemon facts for the reference kind only. */
    composerReferenceHost?: ComposerReferenceSearchHost | null;
    /** Controller-admitted external Actions for the slash kind. */
    contributedActions?: readonly PluginContributedActionDescriptor[];
    /** Current aggregate rows as individual kinds settle; final settlement is marked complete. */
    onUpdate?: AutocompleteSuggestionUpdate;
}>;

function describeSuggestionFailure(reason: unknown): string {
    if (reason instanceof Error) return reason.message;
    return typeof reason === 'string' ? reason : 'unknown error';
}

/**
 * Settles `work` under a deadline and an abort signal without leaking either the
 * timer or the abort listener when the normal path wins.
 */
function withKindDeadline<T>(
    work: Promise<T>,
    deadlineMs: number,
    signal: AbortSignal | undefined,
): Promise<T | typeof KIND_DEADLINE_EXPIRED> {
    return new Promise<T | typeof KIND_DEADLINE_EXPIRED>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (apply: () => void) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            apply();
        };

        function onAbort() {
            finish(() => reject(new Error('superseded')));
        }

        signal?.addEventListener('abort', onAbort);
        timer = setTimeout(
            () => finish(() => resolve(KIND_DEADLINE_EXPIRED)),
            deadlineMs,
        );
        work.then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error)),
        );
    });
}

type PendingColdSuggestionKind = Readonly<{
    definition: ComposerSuggestionKindDefinition;
    work: Promise<readonly AutocompleteSuggestion[]>;
    abort(): void;
}>;

type KindWork = PendingColdSuggestionKind;

function collectSuggestionRows(
    definitions: readonly ComposerSuggestionKindDefinition[],
    rowsByKind: readonly (readonly AutocompleteSuggestion[] | null)[],
): AutocompleteSuggestion[] {
    const suggestions: AutocompleteSuggestion[] = [];
    for (let index = 0; index < definitions.length; index += 1) {
        const rows = rowsByKind[index];
        if (!rows) continue;
        suggestions.push(...rows.slice(0, definitions[index]!.limit));
    }
    return suggestions;
}

function sameSuggestionRows(
    left: readonly AutocompleteSuggestion[] | null,
    right: readonly AutocompleteSuggestion[],
): boolean {
    return left !== null
        && left.length === right.length
        && left.every((suggestion, index) => suggestion === right[index]);
}

function startKindWork(
    definition: ComposerSuggestionKindDefinition,
    args: KindResolveArgs,
): KindWork {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(args.signal?.reason);
    if (args.signal?.aborted) {
        onParentAbort();
    } else {
        args.signal?.addEventListener('abort', onParentAbort, { once: true });
    }
    const work = resolveKindCandidates(definition, {
        ...args,
        signal: controller.signal,
    }).finally(() => {
        args.signal?.removeEventListener('abort', onParentAbort);
    });
    return {
        definition,
        work,
        abort: () => {
            args.signal?.removeEventListener('abort', onParentAbort);
            controller.abort('composer-suggestion-kind-no-longer-needed');
        },
    };
}

/**
 * The deadline is allowed to trim a kind only after another kind has produced
 * rows. When every section is still empty, keep this one-shot query alive for
 * the first late result — bounded by `COMPOSER_SUGGESTION_COLD_START_GRACE_MS`,
 * and still releasable early through `signal`.
 */
function waitForColdSuggestionRows(
    pending: readonly PendingColdSuggestionKind[],
    signal: AbortSignal | undefined,
): Promise<AutocompleteSuggestion[]> {
    if (signal?.aborted) return Promise.resolve([]);

    return new Promise<AutocompleteSuggestion[]>((resolve) => {
        let settled = false;
        let remaining = pending.length;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (suggestions: AutocompleteSuggestion[]) => {
            if (settled) return;
            settled = true;
            clearTimeout(graceTimer);
            signal?.removeEventListener('abort', onAbort);
            for (const item of pending) item.abort();
            resolve(suggestions);
        };
        const onAbort = () => finish([]);
        graceTimer = setTimeout(() => {
            if (settled) return;
            for (const { definition } of pending) {
                log.log(`[composer-suggestions] stopped waiting on ${definition.id} after ${COMPOSER_SUGGESTION_KIND_DEADLINE_MS + COMPOSER_SUGGESTION_COLD_START_GRACE_MS}ms`);
            }
            finish([]);
        }, COMPOSER_SUGGESTION_COLD_START_GRACE_MS);

        signal?.addEventListener('abort', onAbort);
        for (const { definition, work } of pending) {
            void work.then(
                (rows) => {
                    if (settled) return;
                    const suggestions = rows.slice(0, definition.limit);
                    if (suggestions.length > 0) {
                        finish(suggestions);
                        return;
                    }
                    remaining -= 1;
                    if (remaining === 0) finish([]);
                },
                (reason: unknown) => {
                    if (settled) return;
                    log.log(`[composer-suggestions] kind "${definition.id}" contributed no rows: ${describeSuggestionFailure(reason)}`);
                    remaining -= 1;
                    if (remaining === 0) finish([]);
                },
            );
        }
    });
}

type KindResolveArgs = Readonly<{
    sessionId: string | null;
    workspace: FileSuggestionScope | null;
    serverId: string | null;
    trigger: ComposerSuggestionTrigger;
    query: string;
    scopedQuery: string;
    scope: string | null;
    catalogOverrides: ComposerSuggestionCatalogs | undefined;
    signal: AbortSignal | undefined;
    composerReferenceHost: ComposerReferenceSearchHost | null | undefined;
    contributedActions: readonly PluginContributedActionDescriptor[] | undefined;
    publish?: (suggestions: readonly AutocompleteSuggestion[]) => void;
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
    // A catalog is a SESSION's published snapshot, so a host with no session has none to
    // hydrate or read. That is not the same as an empty catalog arriving late: the kinds that
    // declare one contribute nothing here, and the ones that do not are untouched (INV-2).
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
        trigger: args.trigger,
        query: args.query,
        scopedQuery: args.scopedQuery,
        scope: args.scope,
        catalogs,
        limit: definition.limit,
        signal: args.signal,
        composerReferenceHost: args.composerReferenceHost,
        contributedActions: args.contributedActions,
        ...(args.publish ? { publish: args.publish } : {}),
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
        trigger: parsed.trigger,
        query: parsed.query,
        scopedQuery: scope.scopedQuery,
        scope: scope.scope,
        catalogOverrides: options?.catalogs,
        signal,
        composerReferenceHost: options?.composerReferenceHost,
        contributedActions: options?.contributedActions,
    };

    const rowsByKind: Array<readonly AutocompleteSuggestion[] | null> = definitions.map(() => null);
    let acceptsLiveUpdates = true;
    let lastPublishedRows: AutocompleteSuggestion[] | null = null;
    let lastPublicationWasComplete = false;
    const publishCurrentRows = (complete: boolean) => {
        if (!options?.onUpdate || signal?.aborted) return;
        const suggestions = collectSuggestionRows(definitions, rowsByKind);
        if (
            sameSuggestionRows(lastPublishedRows, suggestions)
            && (!complete || lastPublicationWasComplete)
        ) {
            return;
        }
        lastPublishedRows = suggestions;
        lastPublicationWasComplete = complete;
        options.onUpdate(suggestions, { complete });
    };
    const work = definitions.map((definition, index) => startKindWork(definition, {
        ...args,
        publish: (rows) => {
            if (!acceptsLiveUpdates || signal?.aborted) return;
            rowsByKind[index] = rows.slice(0, definition.limit);
            publishCurrentRows(false);
        },
    }));
    for (let index = 0; index < work.length; index += 1) {
        const kindWork = work[index]!;
        void kindWork.work.then(
            (rows) => {
                if (!acceptsLiveUpdates || signal?.aborted) return;
                rowsByKind[index] = rows.slice(0, kindWork.definition.limit);
                publishCurrentRows(false);
            },
            () => {},
        );
    }
    const settled = await Promise.allSettled(work.map((kindWork) => withKindDeadline(
        kindWork.work,
        COMPOSER_SUGGESTION_KIND_DEADLINE_MS,
        signal,
    )));
    // A superseded query contributes nothing, and reports nothing: a rejection
    // caused by the user typing the next character is not a diagnostic.
    if (signal?.aborted) return [];

    acceptsLiveUpdates = false;
    const pendingColdKinds: PendingColdSuggestionKind[] = [];
    for (let index = 0; index < settled.length; index += 1) {
        const definition = definitions[index]!;
        const result = settled[index]!;
        if (result.status === 'rejected') {
            log.log(`[composer-suggestions] kind "${definition.id}" contributed no rows: ${describeSuggestionFailure(result.reason)}`);
            continue;
        }
        if (result.value === KIND_DEADLINE_EXPIRED) {
            pendingColdKinds.push(work[index]!);
            continue;
        }
        // D-22's per-trigger budget is only real if each kind is actually bounded.
        // `limit` reaches the resolver as a query hint, but a catalog-backed kind
        // cannot push it into its source, so the bound is enforced here — once, for
        // every kind, including kinds added later.
        rowsByKind[index] = result.value.slice(0, definition.limit);
    }
    const suggestions = collectSuggestionRows(definitions, rowsByKind);
    if (suggestions.length > 0) {
        for (const { definition, abort } of pendingColdKinds) {
            log.log(`[composer-suggestions] kind "${definition.id}" contributed no rows: exceeded ${COMPOSER_SUGGESTION_KIND_DEADLINE_MS}ms`);
            abort();
        }
        publishCurrentRows(true);
        return suggestions;
    }
    if (pendingColdKinds.length > 0) {
        // A cold query is deliberately allowed to outlive the normal deadline so
        // its first late row can still appear. That extended wait must be visible:
        // without this diagnostic, an empty picker and a silent transport are
        // indistinguishable while the user decides whether to keep typing.
        for (const { definition } of pendingColdKinds) {
            log.log(`[composer-suggestions] still waiting on ${definition.id} after ${COMPOSER_SUGGESTION_KIND_DEADLINE_MS}ms`);
        }
        const lateSuggestions = await waitForColdSuggestionRows(pendingColdKinds, signal);
        if (!signal?.aborted) {
            options?.onUpdate?.(lateSuggestions, { complete: true });
        }
        return lateSuggestions;
    }
    publishCurrentRows(true);
    return [];
}
