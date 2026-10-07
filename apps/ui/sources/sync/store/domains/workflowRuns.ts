import {
    WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1,
    type WorkflowRunInvocationIndexV1,
    type WorkflowRunSummaryV1,
    type WorkflowRunPrivateMetadataV1,
    type WorkflowRunGetResultV1,
    type WorkflowInvocationGetResultV1,
    sameStrictJsonValue,
} from '@happier-dev/protocol';

import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';

import type { StoreGet, StoreSet } from './_shared';

/**
 * One Run, including an Automation failure before Session creation, as this Account can read it.
 *
 * A Run is identified by its own `runId`, never by the Automation that happened
 * to admit it, so an exact read, an invalidation or a deep link reaches the row
 * with no list loaded.
 *
 * Two transports produce Runs and neither is a downgrade of the other:
 *
 * - `workflow.run.*` Actions return `WorkflowRunSummaryV1` — origin, custody,
 *   frozen machine and the canonical availability of each control.
 * - the incumbent `/v3/automations/:automationId/runs` REST route returns the
 *   Automation projection — trigger cause, dispatch state and reply handoff.
 *
 * Their state vocabularies are genuinely different contracts, so this row keeps
 * both projections side by side instead of flattening them into one guessed
 * enum. Each projection carries its own `revision`, which is the Run's exact
 * persisted currentness counter, so each slot knows independently how fresh it
 * is and a read from one transport never blanks what the other observed.
 */
export type WorkflowRunRow = Readonly<{
    id: string;
    /** The newest Run revision observed through any transport. */
    revision: number;
    /** Epoch milliseconds, normalized across both transports for ordering. */
    updatedAt: number;
    summary: WorkflowRunSummaryV1 | null;
    /** Account-private accepted display metadata, never sourced from the public summary. */
    metadata: WorkflowRunPrivateMetadataV1 | null;
    automation: AutomationDefinitionRun | null;
    /** Opened exact content; list/control projections never erase this observation. */
    detail?: WorkflowRunGetResultV1;
}>;

export type WorkflowRunsById = Record<string, WorkflowRunRow>;

/**
 * The one Account-scoped map of workflow Run bodies. Every transport that reads
 * Runs normalizes into it and keeps only its own ordered `runId` window beside
 * it, so two surfaces showing the same Run cannot diverge.
 */
export type WorkflowRunsDomain = {
    workflowRunsById: WorkflowRunsById;
    workflowRunListWindows: Partial<Record<WorkflowRunListWindowId, WorkflowRunListWindow>>;
    /** Per Run: the one invocation fact map plus the windows and evidence that reference it. */
    workflowRunInvocationsByRunId: Record<string, WorkflowRunInvocations>;
    /**
     * Merge exact Run bodies by `runId`. This is the entry point an exact read,
     * a list page or an invalidation uses; it joins no window, because a Run is
     * discoverable by identity whether or not a list containing it is loaded.
     */
    upsertWorkflowRuns: (runs: readonly WorkflowRunRow[]) => void;
    removeWorkflowRun: (runId: string) => void;
    applyWorkflowRunListPage: (input: Readonly<{
        windowId: WorkflowRunListWindowId;
        runs: readonly WorkflowRunSummaryV1[];
        automationRuns?: readonly AutomationDefinitionRun[];
        metadataByRunId?: Readonly<Record<string, WorkflowRunPrivateMetadataV1 | null>>;
        nextCursor: string | null;
        mode: WorkflowLoadedSpanMode;
    }>) => void;
    /**
     * Merge a page into the Run's fact map and restate one window's membership.
     * `history` (the default) is the unfiltered traversal; `attention` is the
     * filter-bound actionable window, whose `refresh` restates the complete
     * loaded span (`refreshLoadedAttentionSpan`) so its cursor is authoritative.
     */
    applyWorkflowRunInvocationPage: (input: Readonly<{
        runId: string;
        window?: WorkflowRunInvocationWindowId;
        invocations: readonly WorkflowRunInvocationIndexV1[];
        nextCursor: string | null;
        parentRevision: number;
        mode: WorkflowLoadedSpanMode;
    }>) => void;
    /**
     * Merge one exact row without disturbing the currently loaded page. Its
     * fresh lifecycle decides its attention membership: a settled row leaves
     * the actionable window while history keeps it.
     */
    upsertWorkflowRunInvocation: (input: Readonly<{
        runId: string;
        invocation: WorkflowRunInvocationFact;
        parentRevision: number;
    }>) => void;
    /** Record the exact first-failure evidence (`null`: the Run has none). */
    setWorkflowRunFirstFailedInvocation: (input: Readonly<{
        runId: string;
        invocation: WorkflowRunInvocationIndexV1 | null;
    }>) => void;
};

/**
 * How a page lands in a window that may already hold a loaded traversal.
 *
 * - `replace` seeds a window from its first page: a new Account, a new filter
 *   or an explicit reload, where nothing earlier is worth keeping.
 * - `append` extends the traversal with the continuation the window's cursor
 *   asked for.
 * - `refresh` restates the leading page of an existing traversal. It is what a
 *   background invalidation uses, and it is the one mode that must never shrink
 *   what the reader already paged to: replacing the window with page one
 *   discarded every later page, the off-page row the reader had selected and
 *   the position they were reading at.
 */
export type WorkflowLoadedSpanMode = 'replace' | 'append' | 'refresh';

export type WorkflowRunListWindowId = 'all' | 'active' | 'attention' | 'automationAttention';
export type WorkflowRunListWindow = Readonly<{
    runIds: readonly string[];
    nextCursor: string | null;
    loaded: boolean;
}>;

export type WorkflowRunInvocationWindowId = 'history' | 'attention';

export type WorkflowRunInvocationFact = WorkflowRunInvocationIndexV1 & Readonly<{
    /** The private observation retains its own index token; a newer index cannot arm it. */
    opened?: WorkflowInvocationGetResultV1['invocation'];
}>;

/** A window owns filter-bound ordered ids and its cursor; the facts live in the Run's one map. */
export type WorkflowRunInvocationWindow = Readonly<{
    invocationIds: readonly string[];
    nextCursor: string | null;
    /** The parent revision the page was read at, so a stale control can be refused. */
    parentRevision: number | null;
    loaded: boolean;
}>;

export type WorkflowRunInvocations = Readonly<{
    /**
     * The one row map (03 §6.2). History pages, attention pages, exact reads and
     * first-failure evidence all merge here; the row's `contentRevision` owns
     * freshness, so no window can hold a second, diverging copy.
     */
    factsById: Readonly<Record<string, WorkflowRunInvocationFact>>;
    history: WorkflowRunInvocationWindow;
    attention: WorkflowRunInvocationWindow;
    /** Exact first-failure evidence; `null` when none is known. */
    firstFailedId: string | null;
}>;

const EMPTY_INVOCATION_WINDOW: WorkflowRunInvocationWindow = { invocationIds: [], nextCursor: null, parentRevision: null, loaded: false };
const EMPTY_RUN_INVOCATIONS: WorkflowRunInvocations = {
    factsById: {}, history: EMPTY_INVOCATION_WINDOW, attention: EMPTY_INVOCATION_WINDOW, firstFailedId: null,
};
const EMPTY_INVOCATION_LIST: readonly WorkflowRunInvocationIndexV1[] = [];

/** Merge facts by row token; an older response never replaces a newer fact. Returns the same map when nothing changed. */
function mergeInvocationFacts(
    factsById: WorkflowRunInvocations['factsById'],
    incoming: readonly WorkflowRunInvocationFact[],
): WorkflowRunInvocations['factsById'] {
    let next: Record<string, WorkflowRunInvocationFact> | null = null;
    for (const invocation of incoming) {
        const known = (next ?? factsById)[invocation.id];
        if (known === invocation || (known && isWorkflowInvocationFactOlder(invocation, known))) continue;
        const candidate = known?.opened && !invocation.opened
            ? { ...invocation, opened: known.opened }
            : invocation;
        if (known && sameStrictJsonValue(known, candidate)) continue;
        next ??= { ...factsById };
        next[invocation.id] = candidate;
    }
    return next ?? factsById;
}

function appendUniqueInvocationIds(existing: readonly string[], incoming: readonly string[]): readonly string[] {
    const known = new Set(existing);
    const added = incoming.filter((id) => {
        if (known.has(id)) return false;
        known.add(id);
        return true;
    });
    return added.length === 0 ? existing : [...existing, ...added];
}

function factsFor(factsById: WorkflowRunInvocations['factsById'], ids: readonly string[]): WorkflowRunInvocationIndexV1[] {
    return ids.flatMap((id) => {
        const fact = factsById[id];
        return fact === undefined ? [] : [fact];
    });
}

const windowProjectionCache = new WeakMap<WorkflowRunInvocationWindow, Readonly<{
    factsById: WorkflowRunInvocations['factsById'];
    invocations: readonly WorkflowRunInvocationIndexV1[];
}>>();

/** One window's rows as current facts; unrelated facts do not invalidate its projection. */
export function selectWorkflowRunWindowInvocations(
    invocations: WorkflowRunInvocations | null | undefined,
    windowId: WorkflowRunInvocationWindowId,
): readonly WorkflowRunInvocationIndexV1[] {
    if (!invocations) return EMPTY_INVOCATION_LIST;
    const window = invocations[windowId];
    if (window.invocationIds.length === 0) return EMPTY_INVOCATION_LIST;
    const cached = windowProjectionCache.get(window);
    if (cached?.factsById === invocations.factsById) return cached.invocations;
    const rows = factsFor(invocations.factsById, window.invocationIds);
    const projected = cached && rows.length === cached.invocations.length
        && rows.every((row, index) => row === cached.invocations[index]) ? cached.invocations : rows;
    windowProjectionCache.set(window, { factsById: invocations.factsById, invocations: projected });
    return projected;
}

export function selectWorkflowRunFirstFailedInvocation(
    invocations: WorkflowRunInvocations | null | undefined,
): WorkflowRunInvocationIndexV1 | null {
    if (!invocations || invocations.firstFailedId === null) return null;
    return invocations.factsById[invocations.firstFailedId] ?? null;
}

function compareDecimalStrings(left: string, right: string): number {
    // Both are canonical nonnegative decimals, so length orders magnitude and
    // a lexicographic compare orders equal magnitudes. This avoids `BigInt` on
    // a hot merge path while staying exact for the server's real values.
    if (left.length !== right.length) return left.length - right.length;
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Compare row facts independently of the parent Run's control revision. */
export function isWorkflowInvocationFactOlder(
    candidate: Pick<WorkflowRunInvocationIndexV1, 'id' | 'contentRevision'>,
    known: Pick<WorkflowRunInvocationIndexV1, 'id' | 'contentRevision'>,
): boolean {
    return candidate.id !== known.id || compareDecimalStrings(candidate.contentRevision, known.contentRevision) < 0;
}

function retainNewerInvocationFacts(
    existing: readonly WorkflowRunInvocationIndexV1[],
    incoming: readonly WorkflowRunInvocationIndexV1[],
): WorkflowRunInvocationIndexV1[] {
    const byId = new Map(existing.map(entry => [entry.id, entry]));
    return incoming.map(entry => {
        const known = byId.get(entry.id);
        return known && isWorkflowInvocationFactOlder(entry, known) ? known : entry;
    });
}

/**
 * The server's total invocation order: `sequence` then `id`, both ascending.
 * The window is a projection of that order, so a refreshed page merged into a
 * longer traversal is re-sorted by the same key rather than appended at the end
 * — otherwise a newly reported attempt would read as the newest work when it
 * belongs beside the step it retried.
 */
function compareInvocationOrder(
    left: WorkflowRunInvocationIndexV1,
    right: WorkflowRunInvocationIndexV1,
): number {
    const bySequence = compareDecimalStrings(left.sequence, right.sequence);
    if (bySequence !== 0) return bySequence;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Restate the leading page of a **lifecycle-filtered** invocation window.
 *
 * Unlike the unfiltered history, membership here is a live predicate: an
 * approval the person answered stops needing them. The refreshed page is
 * therefore authoritative for the span it covers — every row up to and
 * including its last — so a retained row inside that span which the page did
 * not return has left the filter and is dropped, while rows beyond it keep the
 * traversal the reader paged to.
 *
 * The store's attention window applies it to ids over the one fact map; this is
 * the one merge rule, not a second one.
 */
export function mergeRefreshedInvocationFilterSpan(
    existing: readonly WorkflowRunInvocationIndexV1[],
    incoming: readonly WorkflowRunInvocationIndexV1[],
    nextCursor?: string | null,
): WorkflowRunInvocationIndexV1[] {
    const boundary = incoming[incoming.length - 1];
    if (boundary === undefined) return [...incoming];
    // A refreshed span that exhausted the filter is the complete truth: every
    // loaded row the fresh pages did not return has left the filter, including
    // a settled tail beyond the refreshed boundary. Retaining beyond would keep
    // offering a row nobody can act on and keep a stale continuation.
    const refreshed = retainNewerInvocationFacts(existing, incoming);
    if (nextCursor === null) return refreshed.sort(compareInvocationOrder);
    const incomingIds = new Set(incoming.map((entry) => entry.id));
    const retained = existing.filter((entry) => (
        !incomingIds.has(entry.id) && compareInvocationOrder(entry, boundary) > 0
    ));
    return [...refreshed, ...retained].sort(compareInvocationOrder);
}

/**
 * Refetch the complete currently loaded lifecycle-filtered span through the
 * existing invocation pagination API.
 *
 * A background refresh must not restate only the first page: a settled tail
 * beyond it would survive the merge and keep a stale continuation. This
 * replays the traversal the reader already paid for — the same number of
 * pages that produced the loaded span, bounded by that frontier — so rows
 * that left the filter are removed across the span, additions inside it merge,
 * and the returned cursor is the current truth for its end. It keeps no cache:
 * the caller merges the returned pages with the one span rule above.
 */
export async function refreshLoadedAttentionSpan(params: Readonly<{
    listPage: (input: Readonly<{ cursor?: string; signal?: AbortSignal }>) => Promise<Readonly<{
        invocations: readonly WorkflowRunInvocationIndexV1[];
        nextCursor?: string | null;
        parentRevision: number;
    }>>;
    previousPageCount: number;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    invocations: readonly WorkflowRunInvocationIndexV1[];
    nextCursor: string | null;
    parentRevision: number | null;
}>> {
    const targetPages = Math.max(1, Math.floor(params.previousPageCount) || 1);
    const accumulated: WorkflowRunInvocationIndexV1[] = [];
    let cursor: string | undefined;
    let nextCursor: string | null = null;
    let parentRevision: number | null = null;
    for (let page = 0; page < targetPages; page += 1) {
        const result = await params.listPage({
            ...(cursor === undefined ? {} : { cursor }),
            ...(params.signal === undefined ? {} : { signal: params.signal }),
        });
        for (const entry of result.invocations) accumulated.push(entry);
        parentRevision = parentRevision === null ? result.parentRevision : Math.max(parentRevision, result.parentRevision);
        const pageCursor = result.nextCursor ?? null;
        nextCursor = pageCursor;
        if (pageCursor === null) break;
        cursor = pageCursor;
    }
    return { invocations: accumulated, nextCursor, parentRevision };
}

const visibleProjectionCache = new WeakMap<WorkflowRunInvocations, readonly WorkflowRunInvocationIndexV1[]>();

/**
 * The visible union for detail: attention rows history has not paged to yet,
 * the history traversal, and the exact first-failure row when it lies beyond
 * both. Every id reads the one fact map, so no window takes precedence and a
 * settled selection stays visible through history once it leaves attention.
 */
export function resolveVisibleWorkflowInvocations(
    invocations: WorkflowRunInvocations | null | undefined,
): readonly WorkflowRunInvocationIndexV1[] {
    if (!invocations) return EMPTY_INVOCATION_LIST;
    const cached = visibleProjectionCache.get(invocations);
    if (cached) return cached;
    const ids = appendUniqueInvocationIds(
        appendUniqueInvocationIds(invocations.attention.invocationIds, invocations.history.invocationIds),
        invocations.firstFailedId === null ? [] : [invocations.firstFailedId],
    );
    const visible = ids.length === 0 ? EMPTY_INVOCATION_LIST : factsFor(invocations.factsById, ids);
    visibleProjectionCache.set(invocations, visible);
    return visible;
}

/**
 * Whether `candidate` sorts strictly after `boundary` in the Run list's
 * newest-first `(createdAt desc, id desc)` order.
 */
export function isBeyondWorkflowRunListSpan(candidate: WorkflowRunRow | undefined, boundary: WorkflowRunRow): boolean {
    if (candidate === undefined) return false;
    const candidateCreatedAt = candidate.summary ? toEpochMilliseconds(candidate.summary.createdAt) : candidate.automation?.createdAt;
    const boundaryCreatedAt = boundary.summary ? toEpochMilliseconds(boundary.summary.createdAt) : boundary.automation?.createdAt;
    if (candidateCreatedAt === undefined || boundaryCreatedAt === undefined) return false;
    if (candidateCreatedAt !== boundaryCreatedAt) return candidateCreatedAt < boundaryCreatedAt;
    return candidate.id < boundary.id;
}

/**
 * Restate the leading page of a loaded Run window without shrinking it.
 *
 * The refreshed page is authoritative for exactly the span it covers — every
 * Run at least as new as its oldest row — so a previously loaded id inside that
 * span that the page did not return has left this filter and is dropped.
 * Everything strictly older is the traversal the reader paid for page by page;
 * it is preserved, and so is the cursor for the END of that traversal, because
 * the page's own cursor would rewind them to page two.
 */
function refreshWorkflowRunListWindow(params: Readonly<{
    runsById: WorkflowRunsById;
    previous: WorkflowRunListWindow | undefined;
    pageRunIds: readonly string[];
    nextCursor: string | null;
}>): WorkflowRunListWindow {
    const { runsById, previous, pageRunIds, nextCursor } = params;
    // A page that exhausted the filter is the complete list, and a traversal no
    // longer than the page just restated is exactly what reopening the screen
    // would show. Both are fully superseded.
    if (previous === undefined || nextCursor === null || previous.runIds.length <= pageRunIds.length) {
        return { runIds: [...pageRunIds], nextCursor, loaded: true };
    }
    const boundaryId = pageRunIds[pageRunIds.length - 1];
    const boundary = boundaryId === undefined ? undefined : runsById[boundaryId];
    if (boundary === undefined) return { runIds: [...pageRunIds], nextCursor, loaded: true };
    const pageIds = new Set(pageRunIds);
    const retained = previous.runIds.filter((runId) => (
        !pageIds.has(runId) && isBeyondWorkflowRunListSpan(runsById[runId], boundary)
    ));
    return { runIds: [...pageRunIds, ...retained], nextCursor: previous.nextCursor, loaded: true };
}

function appendUniqueIds(existing: readonly string[], incoming: readonly string[]): string[] {
    const seen = new Set(existing);
    const next = [...existing];
    for (const id of incoming) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
    }
    return next;
}

function toEpochMilliseconds(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** Normalize the workflow Action projection into a shared row. */
export function workflowRunRowFromSummary(
    summary: WorkflowRunSummaryV1,
    metadata: WorkflowRunPrivateMetadataV1 | null = null,
): WorkflowRunRow {
    return {
        id: summary.id,
        revision: summary.revision,
        updatedAt: toEpochMilliseconds(summary.updatedAt),
        summary,
        metadata,
        automation: null,
    };
}

/** Normalize the incumbent Automation REST projection into a shared row. */
export function workflowRunRowFromAutomationRun(run: AutomationDefinitionRun): WorkflowRunRow {
    return {
        id: run.id,
        revision: run.revision,
        updatedAt: run.updatedAt,
        summary: null,
        metadata: null,
        automation: run,
    };
}

/**
 * Which of two reads of one projection slot is authoritative.
 *
 * The server increments `revision` on every Run mutation, so a strictly older
 * revision is a delayed page and must not regress the row it lands on. Within
 * one revision the newer `updatedAt` still wins, which is the incumbent
 * last-write rule and keeps a transport that reports progress without a
 * revision bump from being ignored. Only a fully identical read keeps the
 * stored reference, so an idle refresh does not invalidate every subscriber of
 * an unchanged row.
 */
function selectCurrentProjection<T extends Readonly<{ revision: number }>>(
    stored: T | null,
    incoming: T | null,
    updatedAtOf: (value: T) => number,
): T | null {
    if (!incoming) return stored;
    if (!stored) return incoming;
    if (incoming.revision !== stored.revision) {
        return incoming.revision > stored.revision ? incoming : stored;
    }
    return updatedAtOf(incoming) > updatedAtOf(stored) ? incoming : stored;
}

function selectCurrentSummaryProjection(
    stored: Pick<WorkflowRunRow, 'summary' | 'metadata'>,
    incoming: Pick<WorkflowRunRow, 'summary' | 'metadata'>,
): Pick<WorkflowRunRow, 'summary' | 'metadata'> {
    if (!incoming.summary) return stored;
    if (!stored.summary) return incoming;
    let incomingSummary = incoming.summary;
    for (const key of ['where', 'startedBy', 'stepProgress', 'stepProgressCurrentness'] as const) {
        if (incomingSummary[key] === undefined && stored.summary[key] !== undefined) {
            incomingSummary = { ...incomingSummary, [key]: stored.summary[key] };
        }
    }
    const parentCurrent = incoming.summary.revision >= stored.summary.revision;
    let summary = incoming.summary.revision > stored.summary.revision
        || (incoming.summary.revision === stored.summary.revision
            && toEpochMilliseconds(incoming.summary.updatedAt) > toEpochMilliseconds(stored.summary.updatedAt))
        ? incomingSummary : stored.summary;
    // Attention is an indexed child-row fact. A demanded server read can
    // refresh it without moving the parent's control revision or timestamp.
    // Projections that did not read membership cannot clear known attention.
    const attentionRequired = parentCurrent ? incoming.summary.attentionRequired ?? stored.summary.attentionRequired : stored.summary.attentionRequired;
    if (attentionRequired !== undefined && summary.attentionRequired !== attentionRequired) {
        summary = { ...summary, attentionRequired };
    }
    // Private list projections are opened by the authorized list host, including
    // progress which can advance without a parent control revision. Omission by
    // a control operation preserves the observation; explicit unreadability clears it.
    for (const key of ['where', 'startedBy'] as const) {
        const value = incomingSummary[key];
        if (parentCurrent && value !== undefined && (summary[key] === undefined || !sameStrictJsonValue(summary[key], value))) {
            summary = { ...summary, [key]: value };
        }
    }
    // Encrypted root progress has its own currentness. A parent control read can
    // arrive later while carrying an older observation (or no observation at all).
    const nextToken = incoming.summary.stepProgressCurrentness;
    const previousToken = stored.summary.stepProgressCurrentness;
    let acceptProgress = parentCurrent && incoming.summary.stepProgress !== undefined;
    if (nextToken && previousToken) {
        acceptProgress = BigInt(nextToken.attempt) > BigInt(previousToken.attempt)
            || (nextToken.attempt === previousToken.attempt && nextToken.recordId === previousToken.recordId
                && BigInt(nextToken.contentRevision) >= BigInt(previousToken.contentRevision));
    } else if (previousToken && !nextToken && incoming.summary.stepProgress !== null) {
        acceptProgress = false;
    } else if (nextToken) {
        acceptProgress = true;
    }
    const progressSource = acceptProgress ? incoming.summary : stored.summary;
    for (const key of ['stepProgress', 'stepProgressCurrentness'] as const) {
        if (!sameStrictJsonValue(summary[key], progressSource[key])) {
            summary = { ...summary, [key]: progressSource[key] };
        }
    }
    // Opening private content can recover without advancing the server-owned
    // Run revision. At the same accepted revision an available projection is
    // strictly more informative than unavailable, regardless of read order.
    const metadata = incoming.summary.revision > stored.summary.revision
        ? incoming.metadata ?? stored.metadata
        : stored.metadata?.kind === 'available'
        ? stored.metadata
        : incoming.metadata?.kind === 'available'
            ? incoming.metadata
            : summary === incoming.summary
                ? incoming.metadata ?? stored.metadata
                : stored.metadata ?? incoming.metadata;
    return { summary, metadata };
}

function mergeRow(stored: WorkflowRunRow, incoming: WorkflowRunRow): WorkflowRunRow {
    const summaryProjection = selectCurrentSummaryProjection(stored, incoming);
    const { summary, metadata } = summaryProjection;
    const automation = selectCurrentProjection(
        stored.automation,
        incoming.automation,
        (value) => value.updatedAt,
    );
    const detail = incoming.detail && (!stored.detail || incoming.detail.run.revision >= stored.detail.run.revision)
        ? (stored.detail && sameStrictJsonValue(stored.detail, incoming.detail) ? stored.detail : incoming.detail)
        : stored.detail;
    if (summary === stored.summary && automation === stored.automation && metadata === stored.metadata && detail === stored.detail) return stored;
    const revision = Math.max(summary?.revision ?? 0, automation?.revision ?? 0);
    // `updatedAt` follows whichever projection carries the newest revision, so
    // list ordering never regresses when only the other transport refreshes.
    const updatedAt = summary && summary.revision === revision
        ? toEpochMilliseconds(summary.updatedAt)
        : automation && automation.revision === revision
            ? automation.updatedAt
            : stored.updatedAt;
    return { id: stored.id, revision, updatedAt, summary, metadata, automation, ...(detail ? { detail } : {}) };
}

/**
 * Merge rows into the shared map, returning the previous map unchanged when
 * nothing advanced so an unrelated store update does not rerender every Run row
 * on the screen.
 */
export function mergeWorkflowRunBodies(
    previous: WorkflowRunsById,
    incoming: readonly WorkflowRunRow[],
): WorkflowRunsById {
    let next: WorkflowRunsById | null = null;
    for (const row of incoming) {
        const stored = (next ?? previous)[row.id];
        const current = stored ? mergeRow(stored, row) : row;
        if (current === stored) continue;
        next = next ?? { ...previous };
        next[row.id] = current;
    }
    return next ?? previous;
}

/**
 * Drop the bodies a window just stopped referencing.
 *
 * Retention is per-adapter on purpose: a caller releases only the ids its own
 * windows referenced, and only when no window it knows about still holds them.
 * A row reached by identity instead — a deep link, a notification, a Run whose
 * list was never opened — is in neither set and is therefore untouched.
 */
export function releaseWorkflowRunBodies(params: Readonly<{
    runsById: WorkflowRunsById;
    releasedRunIds: Iterable<string>;
    retainedRunIds: ReadonlySet<string>;
}>): WorkflowRunsById {
    const { runsById, releasedRunIds, retainedRunIds } = params;
    let next: WorkflowRunsById | null = null;
    for (const runId of releasedRunIds) {
        if (retainedRunIds.has(runId)) continue;
        const row = (next ?? runsById)[runId];
        if (!row?.automation) continue;
        next = next ?? { ...runsById };
        if (row.summary) {
            next[runId] = { ...row, automation: null };
        } else {
            delete next[runId];
        }
    }
    return next ?? runsById;
}

/**
 * Project an ordered window of ids onto the shared bodies. An id with no loaded
 * body is skipped rather than rendered as a placeholder row: the window records
 * membership, the map records what is actually known.
 */
export function resolveWorkflowRunRows(
    runsById: WorkflowRunsById,
    runIds: readonly string[],
): WorkflowRunRow[] {
    const rows: WorkflowRunRow[] = [];
    for (const runId of runIds) {
        const row = runsById[runId];
        if (row) rows.push(row);
    }
    return rows;
}

/**
 * The Automation projections of an ordered window. Automation surfaces read
 * this rather than the shared row, so their existing contract is unchanged and
 * a Run this client has only ever seen through a workflow Action does not
 * appear in an Automation history with half its fields missing.
 */
export function resolveAutomationRunProjections(
    runsById: WorkflowRunsById,
    runIds: readonly string[],
): AutomationDefinitionRun[] {
    const rows: AutomationDefinitionRun[] = [];
    for (const runId of runIds) {
        const row = runsById[runId];
        if (row?.automation) rows.push(row.automation);
    }
    return rows;
}

export function createWorkflowRunsDomain<S extends WorkflowRunsDomain>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): WorkflowRunsDomain {
    return {
        workflowRunsById: {},
        workflowRunListWindows: {},
        workflowRunInvocationsByRunId: {},
        upsertWorkflowRuns: (runs) =>
            set((state) => {
                const workflowRunsById = mergeWorkflowRunBodies(state.workflowRunsById, runs);
                if (workflowRunsById === state.workflowRunsById) return state;
                return { ...state, workflowRunsById };
            }),
        removeWorkflowRun: (runId) => set((state) => {
            if (!(runId in state.workflowRunsById)) return state;
            const workflowRunsById = { ...state.workflowRunsById };
            delete workflowRunsById[runId];
            const workflowRunListWindows = Object.fromEntries(
                Object.entries(state.workflowRunListWindows).map(([id, window]) => [
                    id,
                    window?.runIds.includes(runId)
                        ? { ...window, runIds: window.runIds.filter((candidate) => candidate !== runId) } : window,
                ]),
            ) as WorkflowRunsDomain['workflowRunListWindows'];
            const workflowRunInvocationsByRunId = { ...state.workflowRunInvocationsByRunId };
            delete workflowRunInvocationsByRunId[runId];
            return { ...state, workflowRunsById, workflowRunListWindows, workflowRunInvocationsByRunId };
        }),
        applyWorkflowRunListPage: ({ windowId, runs, automationRuns = [], metadataByRunId, nextCursor, mode }) =>
            set((state) => {
                const previous = state.workflowRunListWindows[windowId];
                // Bodies merge first so the refreshed span can be measured
                // against the rows the page just restated.
                const workflowRunsById = mergeWorkflowRunBodies(
                    state.workflowRunsById,
                    [...runs.map((run) => workflowRunRowFromSummary(run, metadataByRunId?.[run.id] ?? null)),
                        ...automationRuns.map(workflowRunRowFromAutomationRun)],
                );
                const pageRunIds = [...runs.map((run) => run.id), ...automationRuns.map((run) => run.id)];
                const window: WorkflowRunListWindow = mode === 'append' && previous
                    ? { runIds: appendUniqueIds(previous.runIds, pageRunIds), nextCursor, loaded: true }
                    : mode === 'refresh'
                        ? refreshWorkflowRunListWindow({ runsById: workflowRunsById, previous, pageRunIds, nextCursor })
                        : { runIds: pageRunIds, nextCursor, loaded: true };
                const unchangedWindow = previous !== undefined && sameStrictJsonValue(previous, window);
                if (unchangedWindow && workflowRunsById === state.workflowRunsById) return state;
                return {
                    ...state,
                    workflowRunsById,
                    workflowRunListWindows: unchangedWindow ? state.workflowRunListWindows
                        : { ...state.workflowRunListWindows, [windowId]: window },
                };
            }),
        applyWorkflowRunInvocationPage: ({ runId, window: windowId = 'history', invocations, nextCursor, parentRevision, mode }) =>
            set((state) => {
                const previous = state.workflowRunInvocationsByRunId[runId] ?? EMPTY_RUN_INVOCATIONS;
                const factsById = mergeInvocationFacts(previous.factsById, invocations);
                const previousWindow = previous[windowId];
                const pageIds = invocations.map((entry) => entry.id);
                const byOrder = (ids: Iterable<string>) => [...ids].flatMap((id) => {
                    const fact = factsById[id];
                    return fact === undefined ? [] : [fact];
                }).sort(compareInvocationOrder).map((entry) => entry.id);
                let invocationIds: readonly string[];
                let cursor = nextCursor;
                if (mode === 'append') {
                    invocationIds = appendUniqueInvocationIds(previousWindow.invocationIds, pageIds);
                } else if (mode === 'refresh' && windowId === 'history') {
                    // History rows are append-only for the life of a Run: a
                    // restated leading page can reveal rows but never proves a
                    // loaded one gone, and it does not know where the traversal
                    // ends, so a loaded traversal keeps its continuation.
                    invocationIds = byOrder(new Set([...previousWindow.invocationIds, ...pageIds]));
                    if (previousWindow.loaded) cursor = previousWindow.nextCursor;
                } else if (mode === 'refresh' && previousWindow.loaded) {
                    invocationIds = mergeRefreshedInvocationFilterSpan(
                        factsFor(factsById, previousWindow.invocationIds),
                        factsFor(factsById, pageIds),
                        nextCursor,
                    ).map((entry) => entry.id);
                } else {
                    invocationIds = pageIds;
                }
                const candidateWindow: WorkflowRunInvocationWindow = {
                    invocationIds, nextCursor: cursor, loaded: true,
                    parentRevision: Math.max(previousWindow.parentRevision ?? 0, parentRevision),
                };
                const nextWindow = sameStrictJsonValue(previousWindow, candidateWindow) ? previousWindow : candidateWindow;
                if (factsById === previous.factsById && nextWindow === previousWindow) return state;
                return {
                    ...state,
                    workflowRunInvocationsByRunId: {
                        ...state.workflowRunInvocationsByRunId,
                        [runId]: windowId === 'history'
                            ? { ...previous, factsById, history: nextWindow }
                            : { ...previous, factsById, attention: nextWindow },
                    },
                };
            }),
        upsertWorkflowRunInvocation: ({ runId, invocation, parentRevision }) =>
            set((state) => {
                const previous = state.workflowRunInvocationsByRunId[runId] ?? EMPTY_RUN_INVOCATIONS;
                const factsById = mergeInvocationFacts(previous.factsById, [invocation]);
                const candidateHistory: WorkflowRunInvocationWindow = {
                    ...previous.history,
                    invocationIds: appendUniqueInvocationIds(previous.history.invocationIds, [invocation.id]),
                    parentRevision: Math.max(previous.history.parentRevision ?? 0, parentRevision),
                };
                const history = sameStrictJsonValue(previous.history, candidateHistory) ? previous.history : candidateHistory;
                // Only an accepted (not older) fact may change actionable membership.
                const accepted = !isWorkflowInvocationFactOlder(invocation, factsById[invocation.id]!);
                const needsYou = WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1.some((lifecycle) => lifecycle === invocation.lifecycle);
                const attentionIds = previous.attention.invocationIds;
                const candidateAttention: WorkflowRunInvocationWindow = !accepted || !previous.attention.loaded
                    ? previous.attention
                    : needsYou
                        ? { ...previous.attention, invocationIds: appendUniqueInvocationIds(attentionIds, [invocation.id]) }
                        : attentionIds.includes(invocation.id)
                            ? { ...previous.attention, invocationIds: attentionIds.filter((id) => id !== invocation.id) }
                            : previous.attention;
                const attention = sameStrictJsonValue(previous.attention, candidateAttention) ? previous.attention : candidateAttention;
                if (factsById === previous.factsById && history === previous.history && attention === previous.attention) return state;
                return {
                    ...state,
                    workflowRunInvocationsByRunId: {
                        ...state.workflowRunInvocationsByRunId,
                        [runId]: { ...previous, factsById, history, attention },
                    },
                };
            }),
        setWorkflowRunFirstFailedInvocation: ({ runId, invocation }) =>
            set((state) => {
                const previous = state.workflowRunInvocationsByRunId[runId] ?? EMPTY_RUN_INVOCATIONS;
                const factsById = invocation === null ? previous.factsById : mergeInvocationFacts(previous.factsById, [invocation]);
                const firstFailedId = invocation?.id ?? null;
                if (factsById === previous.factsById && firstFailedId === previous.firstFailedId) return state;
                return {
                    ...state,
                    workflowRunInvocationsByRunId: {
                        ...state.workflowRunInvocationsByRunId,
                        [runId]: { ...previous, factsById, firstFailedId },
                    },
                };
            }),
    };
}
