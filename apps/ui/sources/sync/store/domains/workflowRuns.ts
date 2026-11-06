import { WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1, mergeWorkflowNotificationConditionV1, type WorkflowRunInvocationIndexV1, type WorkflowRunSummaryV1, type WorkflowNotificationConditionV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowRunPrivateMetadataV1, WorkflowRunGetResultV1, WorkflowInvocationGetResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';

import type { StoreGet, StoreSet } from './_shared';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Run ids are opaque within a Home/Account, including when another Home is active. */
export function workflowRunStoreKey(id: string, scope: ServerAccountScope | null = getActiveServerAccountScope()): string {
    return scope ? serverAccountScopedResourceKey(scope, id) : id;
}

/** A query's membership and opaque cursor belong to the same Home/Account as its Run bodies. */
export function workflowRunListWindowStoreKey(id: WorkflowRunListWindowId, scope: ServerAccountScope): `account:${string}` {
    return `account:${serverAccountScopedResourceKey(scope, id)}`;
}
export type WorkflowRunListWindowStoreId = WorkflowRunListWindowId | `account:${string}` | `session:${string}` | `discussion:${string}`;

/** Session relation membership is query evidence, independent of the retained Run bodies. */
export function sessionWorkflowRunWindowId(scope: ServerAccountScope, sessionId: string, relation: 'origin' | 'destination'): `session:${string}` {
    return `session:${serverAccountScopedResourceKey(scope, sessionId, relation)}`;
}

/** Discussion membership uses the same retained query windows as Session relations. */
export function discussionWorkflowRunWindowId(scope: ServerAccountScope, discussionId: string): `discussion:${string}` {
    return `discussion:${serverAccountScopedResourceKey(scope, discussionId, 'origin')}`;
}

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
    /** Authored support, opened by the list owner; lifecycle and permission stay separate. */
    supportsAnotherRound?: boolean;
    callerAccess?: WorkflowRunGetResultV1['callerAccess'];
}>;

export type WorkflowRunsById = Record<string, WorkflowRunRow>;

/**
 * The one Account-scoped map of workflow Run bodies. Every transport that reads
 * Runs normalizes into it and keeps only its own ordered `runId` window beside
 * it, so two surfaces showing the same Run cannot diverge.
 */
export type WorkflowRunsDomain = {
    workflowRunsById: WorkflowRunsById;
    workflowRunListWindows: Partial<Record<WorkflowRunListWindowStoreId, WorkflowRunListWindow>>;
    /** Per Run: the one invocation fact map plus the windows and evidence that reference it. */
    workflowRunInvocationsByRunId: Record<string, WorkflowRunInvocations>;
    /**
     * Merge exact Run bodies by `runId`. This is the entry point an exact read,
     * a list page or an invalidation uses; it joins no window, because a Run is
     * discoverable by identity whether or not a list containing it is loaded.
     */
    upsertWorkflowRuns: (runs: readonly WorkflowRunRow[], scope?: ServerAccountScope | null) => void;
    removeWorkflowRun: (runId: string, scope?: ServerAccountScope | null) => void;
    applyWorkflowRunListPage: (input: Readonly<{
        scope?: ServerAccountScope | null;
        windowId: WorkflowRunListWindowStoreId;
        runs: readonly WorkflowRunSummaryV1[];
        projection?: 'membership';
        automationRuns?: readonly AutomationDefinitionRun[];
        metadataByRunId?: Readonly<Record<string, WorkflowRunPrivateMetadataV1 | null>>;
        supportsAnotherRoundByRunId?: Readonly<Record<string, boolean>>;
        callerAccessByRunId?: Readonly<Record<string, WorkflowRunGetResultV1['callerAccess']>>;
        nextCursor: string | null;
        /** Refresh readers collect their loaded span before replacing it atomically. */
        mode: 'replace' | 'append';
        attentionRunIds?: readonly string[];
        lastSuccessfulReadAt?: number;
    }>) => void;
    /**
     * Merge a page into the Run's fact map and restate one window's membership.
     * `history` (the default) is the unfiltered traversal; `attention` is the
     * filter-bound actionable window, whose `refresh` restates the complete
     * loaded span (`refreshLoadedAttentionSpan`) so its cursor is authoritative.
     */
    applyWorkflowRunInvocationPage: (input: Readonly<{
        scope?: ServerAccountScope | null;
        runId: string;
        window?: WorkflowRunInvocationWindowId;
        invocations: readonly WorkflowRunInvocationIndexV1[];
        /** Same-page opened observations land with their indices in one publication. */
        invocationDetails?: readonly WorkflowInvocationGetResultV1['invocation'][];
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
        scope?: ServerAccountScope | null;
        runId: string;
        invocation: WorkflowRunInvocationFact;
        parentRevision: number;
    }>) => void;
    /** Record the exact first-failure evidence (`null`: the Run has none). */
    setWorkflowRunFirstFailedInvocation: (input: Readonly<{
        scope?: ServerAccountScope | null;
        runId: string;
        invocation: WorkflowRunInvocationFact | null;
    }>) => void;
};

/**
 * How a page lands in a window that may already hold a loaded traversal.
 *
 * - `replace` publishes a complete freshly read span: a first page or the
 *   previously loaded ordering frontier collected by the reader on refresh.
 * - `append` extends the traversal with the continuation the window's cursor
 *   asked for.
 * - Invocation-only `refresh` merges a leading page with retained invocation
 *   history. Run-list windows instead restate their loaded frontier through
 *   the list reader; retaining an old end cursor can skip newly inserted Runs.
 */
export type WorkflowLoadedSpanMode = 'replace' | 'append' | 'refresh';

export type WorkflowRunListWindowId = import('@/sync/domains/workflows/workflowRunListActions').WorkflowRunListFilterId | 'automationAttention';
export type WorkflowRunListWindow = Readonly<{
    /** Also binds nextCursor; promotion must restart with a full first page. */
    projection?: 'membership';
    /** Oldest traversed list position, including when membership has never opened a body. */
    frontier?: WorkflowRunListFrontier;
    runIds: readonly string[];
    /** Source access routing from the list projection, even before a body is opened. */
    sourceArtifactIdsByRunId?: Readonly<Record<string, string>>;
    nextCursor: string | null;
    loaded: boolean;
    /** Explicitly scoped windows can outlive the consumer that queried them. */
    scope?: ServerAccountScope;
    attentionRunIds?: readonly string[];
    lastSuccessfulReadAt?: number;
}>;

export type WorkflowRunInvocationWindowId = 'history' | 'attention';

export type WorkflowRunInvocationFact = WorkflowRunInvocationIndexV1 & Readonly<{
    /** Authored display number from the frozen definition, not the sibling ordinal or event sequence. */
    stepOrdinal?: string;
    /** Actual Notify me condition on this physical result; absence is unknown, not quiet. */
    notificationCondition?: WorkflowNotificationConditionV1;
    /** This exact private display sidecar was opened, including when no condition has evaluated yet. */
    provenanceLoaded?: true;
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
        if (known === invocation) continue;
        const older = known && isWorkflowInvocationFactOlder(invocation, known);
        // Numbering is immutable in the accepted definition. A late display-only read can
        // fill it while retaining every newer lifecycle/content token and opened observation.
        let candidate = older && known ? known : known?.opened && !invocation.opened
            ? { ...invocation, opened: known.opened }
            : invocation;
        if (known?.stepOrdinal && !candidate.stepOrdinal) candidate = { ...candidate, stepOrdinal: known.stepOrdinal };
        if (!candidate.stepOrdinal && invocation.stepOrdinal) candidate = { ...candidate, stepOrdinal: invocation.stepOrdinal };
        // The source row stays immutable; the root's evaluated conditions are monotone
        // across consumers. Do not erase them with a lean source index or a late response.
        const notificationCondition = mergeWorkflowNotificationConditionV1(known?.notificationCondition, invocation.notificationCondition);
        if (notificationCondition && candidate.notificationCondition !== notificationCondition) candidate = { ...candidate, notificationCondition };
        if ((known?.provenanceLoaded || invocation.provenanceLoaded) && !candidate.provenanceLoaded) candidate = { ...candidate, provenanceLoaded: true };
        // A content-only page is not a new recovery decision. Keep the exact
        // read's projection only while both its row and parent tokens match.
        if (invocation.opened && known?.opened?.recoveryAvailability !== undefined
            && invocation.opened.recoveryAvailability === undefined
            && invocation.opened.index.id === known.opened.index.id
            && invocation.opened.index.contentRevision === known.opened.index.contentRevision
            && invocation.opened.parentRevision === known.opened.parentRevision) {
            candidate = { ...candidate, opened: { ...invocation.opened,
                recoveryAvailability: known.opened.recoveryAvailability } };
        }
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

/** Accepted row observations use the same freshness rule for actionable membership. */
function mergeInvocationAttention(
    previous: WorkflowRunInvocationWindow,
    factsById: WorkflowRunInvocations['factsById'],
    incoming: readonly WorkflowRunInvocationFact[],
): WorkflowRunInvocationWindow {
    if (!previous.loaded) return previous;
    let invocationIds = previous.invocationIds;
    for (const invocation of incoming) {
        const current = factsById[invocation.id];
        // Membership follows the accepted fact, including when a delayed page
        // still names a hold the newer observation has already resolved.
        if (!current) continue;
        const needsYou = WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1.some((lifecycle) => lifecycle === current.lifecycle);
        if (needsYou) invocationIds = appendUniqueInvocationIds(invocationIds, [invocation.id]);
        else if (invocationIds.includes(invocation.id)) invocationIds = invocationIds.filter((id) => id !== invocation.id);
    }
    return invocationIds === previous.invocationIds ? previous : { ...previous, invocationIds };
}

/** Root progress carries exact child facts too; keep them in the same row owner as pages and exact reads. */
function reconcileInvocationObservations(
    previous: WorkflowRunInvocations,
    summary: WorkflowRunSummaryV1 | null | undefined,
): WorkflowRunInvocations {
    const observations: WorkflowRunInvocationFact[] = [];
    for (const destination of summary?.stepProgress?.destinations ?? []) {
        const observation = destination.observation;
        if (!observation) continue;
        const known = previous.factsById[observation.recordId];
        // A summary is not a complete index row. It can advance a known exact
        // attempt, but cannot invent ancestry, timestamps or another attempt.
        if (!known || known.sequence !== observation.sequence || known.attempt !== observation.attempt
            || compareDecimalStrings(observation.contentRevision, known.contentRevision) <= 0) continue;
        observations.push({ ...known, contentRevision: observation.contentRevision, lifecycle: observation.lifecycle });
    }
    if (observations.length === 0) return previous;
    const factsById = mergeInvocationFacts(previous.factsById, observations);
    // A row loaded only through attention remains visible after it settles.
    const historyIds = appendUniqueInvocationIds(previous.history.invocationIds, observations.map((row) => row.id));
    const history = historyIds === previous.history.invocationIds ? previous.history : { ...previous.history,
        invocationIds: factsFor(factsById, historyIds).sort(compareInvocationOrder).map((row) => row.id) };
    return { ...previous, factsById, history, attention: mergeInvocationAttention(previous.attention, factsById, observations) };
}

function reconcileRunInvocationObservations(
    previous: WorkflowRunsDomain['workflowRunInvocationsByRunId'],
    rows: readonly WorkflowRunRow[],
    scope: ServerAccountScope | null | undefined,
): WorkflowRunsDomain['workflowRunInvocationsByRunId'] {
    let next: WorkflowRunsDomain['workflowRunInvocationsByRunId'] | null = null;
    for (const row of rows) {
        const key = workflowRunStoreKey(row.id, scope);
        const known = (next ?? previous)[key];
        if (!known) continue;
        const current = reconcileInvocationObservations(known, row.summary);
        if (current === known) continue;
        next ??= { ...previous };
        next[key] = current;
    }
    return next ?? previous;
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
export function compareInvocationOrder(
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
        invocationDetails?: readonly WorkflowInvocationGetResultV1['invocation'][];
        nextCursor?: string | null;
        parentRevision: number;
    }>>;
    previousPageCount: number;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    invocations: readonly WorkflowRunInvocationIndexV1[];
    invocationDetails: readonly WorkflowInvocationGetResultV1['invocation'][];
    nextCursor: string | null;
    parentRevision: number | null;
}>> {
    const targetPages = Math.max(1, Math.floor(params.previousPageCount) || 1);
    const accumulated: WorkflowRunInvocationIndexV1[] = [];
    const invocationDetails: WorkflowInvocationGetResultV1['invocation'][] = [];
    let cursor: string | undefined;
    let nextCursor: string | null = null;
    let parentRevision: number | null = null;
    for (let page = 0; page < targetPages; page += 1) {
        const result = await params.listPage({
            ...(cursor === undefined ? {} : { cursor }),
            ...(params.signal === undefined ? {} : { signal: params.signal }),
        });
        for (const entry of result.invocations) accumulated.push(entry);
        invocationDetails.push(...(result.invocationDetails ?? []));
        parentRevision = parentRevision === null ? result.parentRevision : Math.max(parentRevision, result.parentRevision);
        const pageCursor = result.nextCursor ?? null;
        nextCursor = pageCursor;
        if (pageCursor === null) break;
        cursor = pageCursor;
    }
    return { invocations: accumulated, invocationDetails, nextCursor, parentRevision };
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
export type WorkflowRunListFrontier = Readonly<{ id: string; createdAt: number }>;

export function workflowRunListFrontier(row: WorkflowRunRow): WorkflowRunListFrontier | undefined {
    const createdAt = row.summary ? toEpochMilliseconds(row.summary.createdAt) : row.automation?.createdAt;
    return createdAt === undefined ? undefined : { id: row.id, createdAt };
}

export function isBeyondWorkflowRunListSpan(candidate: WorkflowRunRow | WorkflowRunListFrontier | undefined,
    boundary: WorkflowRunRow | WorkflowRunListFrontier): boolean {
    if (candidate === undefined) return false;
    const candidateCreatedAt = 'createdAt' in candidate ? candidate.createdAt : workflowRunListFrontier(candidate)?.createdAt;
    const boundaryCreatedAt = 'createdAt' in boundary ? boundary.createdAt : workflowRunListFrontier(boundary)?.createdAt;
    if (candidateCreatedAt === undefined || boundaryCreatedAt === undefined) return false;
    if (candidateCreatedAt !== boundaryCreatedAt) return candidateCreatedAt < boundaryCreatedAt;
    return candidate.id < boundary.id;
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
    supportsAnotherRound?: boolean,
    callerAccess?: WorkflowRunGetResultV1['callerAccess'],
): WorkflowRunRow {
    return {
        id: summary.id,
        revision: summary.revision,
        updatedAt: toEpochMilliseconds(summary.updatedAt),
        summary,
        metadata,
        automation: null,
        ...(supportsAnotherRound === undefined ? {} : { supportsAnotherRound }),
        ...(callerAccess === undefined ? {} : { callerAccess }),
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
    for (const key of ['where', 'startedBy', 'sourceSavedBy', 'heldStep', 'heldCount', 'stepProgress', 'stepProgressCurrentness'] as const) {
        if (incomingSummary[key] === undefined && stored.summary[key] !== undefined) {
            incomingSummary = { ...incomingSummary, [key]: stored.summary[key] };
        }
    }
    const parentCurrent = incoming.summary.revision >= stored.summary.revision;
    let summary = incoming.summary.revision > stored.summary.revision
        || (incoming.summary.revision === stored.summary.revision
            && toEpochMilliseconds(incoming.summary.updatedAt) > toEpochMilliseconds(stored.summary.updatedAt))
        ? incomingSummary : stored.summary;
    // Accepted Discussion routing is immutable and opened by the Action host.
    // Raw control rows omit it; equal-revision full reads can first reveal it.
    if (summary.origin.kind === 'direct') {
        const discussion = parentCurrent && incoming.summary.origin.kind === 'direct' && incoming.summary.origin.discussion
            ? incoming.summary.origin.discussion
            : stored.summary.origin.kind === 'direct' ? stored.summary.origin.discussion : undefined;
        if (discussion && !sameStrictJsonValue(summary.origin.discussion, discussion)) {
            summary = { ...summary, origin: { ...summary.origin, discussion } };
        }
    }
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
    for (const key of ['where', 'startedBy', 'sourceSavedBy', 'heldStep', 'heldCount'] as const) {
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
    const supportsAnotherRound = incoming.supportsAnotherRound ?? stored.supportsAnotherRound;
    const callerAccess = incoming.callerAccess === undefined ? stored.callerAccess
        : incoming.callerAccess.canEdit === stored.callerAccess?.canEdit ? stored.callerAccess : incoming.callerAccess;
    if (summary === stored.summary && automation === stored.automation && metadata === stored.metadata && detail === stored.detail
        && supportsAnotherRound === stored.supportsAnotherRound && callerAccess === stored.callerAccess) return stored;
    const revision = Math.max(summary?.revision ?? 0, automation?.revision ?? 0);
    // `updatedAt` follows whichever projection carries the newest revision, so
    // list ordering never regresses when only the other transport refreshes.
    const updatedAt = summary && summary.revision === revision
        ? toEpochMilliseconds(summary.updatedAt)
        : automation && automation.revision === revision
            ? automation.updatedAt
            : stored.updatedAt;
    return { id: stored.id, revision, updatedAt, summary, metadata, automation, ...(detail ? { detail } : {}),
        ...(supportsAnotherRound === undefined ? {} : { supportsAnotherRound }),
        ...(callerAccess === undefined ? {} : { callerAccess }) };
}

/**
 * Merge rows into the shared map, returning the previous map unchanged when
 * nothing advanced so an unrelated store update does not rerender every Run row
 * on the screen.
 */
export function mergeWorkflowRunBodies(
    previous: WorkflowRunsById,
    incoming: readonly WorkflowRunRow[],
    scope: ServerAccountScope | null = getActiveServerAccountScope(),
): WorkflowRunsById {
    let next: WorkflowRunsById | null = null;
    for (const row of incoming) {
        const key = workflowRunStoreKey(row.id, scope);
        const stored = (next ?? previous)[key];
        const current = stored ? mergeRow(stored, row) : row;
        if (current === stored) continue;
        next = next ?? { ...previous };
        next[key] = current;
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
    scope?: ServerAccountScope | null;
}>): WorkflowRunsById {
    const { runsById, releasedRunIds, retainedRunIds } = params;
    let next: WorkflowRunsById | null = null;
    for (const runId of releasedRunIds) {
        if (retainedRunIds.has(runId)) continue;
        const key = workflowRunStoreKey(runId, params.scope);
        const row = (next ?? runsById)[key];
        if (!row?.automation) continue;
        next = next ?? { ...runsById };
        if (row.summary) {
            next[key] = { ...row, automation: null };
        } else {
            delete next[key];
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
    scope: ServerAccountScope | null = getActiveServerAccountScope(),
): WorkflowRunRow[] {
    const rows: WorkflowRunRow[] = [];
    for (const runId of runIds) {
        const row = runsById[workflowRunStoreKey(runId, scope)];
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
    scope: ServerAccountScope | null = getActiveServerAccountScope(),
): AutomationDefinitionRun[] {
    const rows: AutomationDefinitionRun[] = [];
    for (const runId of runIds) {
        const row = runsById[workflowRunStoreKey(runId, scope)];
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
        upsertWorkflowRuns: (runs, scope = getActiveServerAccountScope()) =>
            set((state) => {
                const workflowRunsById = mergeWorkflowRunBodies(state.workflowRunsById, runs, scope);
                const workflowRunInvocationsByRunId = reconcileRunInvocationObservations(state.workflowRunInvocationsByRunId,
                    runs.flatMap((row) => workflowRunsById[workflowRunStoreKey(row.id, scope)] ?? []), scope);
                if (workflowRunsById === state.workflowRunsById && workflowRunInvocationsByRunId === state.workflowRunInvocationsByRunId) return state;
                return { ...state, workflowRunsById, workflowRunInvocationsByRunId };
            }),
        removeWorkflowRun: (runId, scope = getActiveServerAccountScope()) => set((state) => {
            const key = workflowRunStoreKey(runId, scope);
            if (!(key in state.workflowRunsById)) return state;
            const workflowRunsById = { ...state.workflowRunsById };
            delete workflowRunsById[key];
            let workflowRunListWindows = state.workflowRunListWindows;
            for (const [id, window] of Object.entries(state.workflowRunListWindows)) {
                if (!window?.runIds.includes(runId) || !(window.scope
                    ? areServerAccountScopesEqual(scope, window.scope)
                    : !scope || areServerAccountScopesEqual(scope, getActiveServerAccountScope()))) continue;
                if (workflowRunListWindows === state.workflowRunListWindows) workflowRunListWindows = { ...workflowRunListWindows };
                const sourceArtifactIdsByRunId = { ...window.sourceArtifactIdsByRunId };
                delete sourceArtifactIdsByRunId[runId];
                workflowRunListWindows[id as keyof typeof workflowRunListWindows] = { ...window,
                    runIds: window.runIds.filter(candidate => candidate !== runId),
                    ...(window.sourceArtifactIdsByRunId ? { sourceArtifactIdsByRunId } : {}),
                    ...(window.attentionRunIds ? { attentionRunIds: window.attentionRunIds.filter(candidate => candidate !== runId) } : {}) };
            }
            let workflowRunInvocationsByRunId = state.workflowRunInvocationsByRunId;
            if (key in workflowRunInvocationsByRunId) {
                workflowRunInvocationsByRunId = { ...workflowRunInvocationsByRunId };
                delete workflowRunInvocationsByRunId[key];
            }
            return { ...state, workflowRunsById, workflowRunListWindows, workflowRunInvocationsByRunId };
        }),
        applyWorkflowRunListPage: ({ scope = getActiveServerAccountScope(), windowId, runs, projection, automationRuns = [], metadataByRunId, supportsAnotherRoundByRunId, callerAccessByRunId, nextCursor, mode, attentionRunIds, lastSuccessfulReadAt }) =>
            set((state) => {
                const previous = state.workflowRunListWindows[windowId];
                // Membership proves ids/order only. Never publish unopened summaries
                // into the full-body map: existing exact readers treat a missing body
                // as demand, while already opened bodies remain last-known truth.
                const workflowRunsById = projection === 'membership' ? state.workflowRunsById : mergeWorkflowRunBodies(
                    state.workflowRunsById,
                    [...runs.map((run) => workflowRunRowFromSummary(run, metadataByRunId?.[run.id] ?? null,
                        supportsAnotherRoundByRunId?.[run.id], callerAccessByRunId?.[run.id])),
                        ...automationRuns.map(workflowRunRowFromAutomationRun)],
                    scope,
                );
                const pageRunIds = appendUniqueIds([], [...runs.map((run) => run.id), ...automationRuns.map((run) => run.id)]);
                const membership: WorkflowRunListWindow = mode === 'append' && previous
                    ? { runIds: appendUniqueIds(previous.runIds, pageRunIds), nextCursor, loaded: true }
                    : { runIds: pageRunIds, nextCursor, loaded: true };
                const sourceArtifactIdsByRunId = {
                    ...(mode === 'append' ? previous?.sourceArtifactIdsByRunId : {}),
                    ...Object.fromEntries(runs.flatMap(run => run.sourceArtifactId ? [[run.id, run.sourceArtifactId] as const] : [])),
                };
                const tailId = membership.runIds.at(-1);
                const tailSummary = tailId === undefined ? undefined : runs.find(run => run.id === tailId);
                const tailAutomation = tailId === undefined ? undefined : automationRuns.find(run => run.id === tailId);
                const tailBody = tailId === undefined ? undefined : workflowRunsById[workflowRunStoreKey(tailId, scope)];
                const frontier = tailSummary ? { id: tailSummary.id, createdAt: toEpochMilliseconds(tailSummary.createdAt) }
                    : tailAutomation ? { id: tailAutomation.id, createdAt: tailAutomation.createdAt }
                    : tailBody ? workflowRunListFrontier(tailBody) : tailId === previous?.frontier?.id ? previous?.frontier : undefined;
                const window: WorkflowRunListWindow = { ...membership,
                    runIds: previous && sameStrictJsonValue(previous.runIds, membership.runIds) ? previous.runIds : membership.runIds,
                    sourceArtifactIdsByRunId: previous?.sourceArtifactIdsByRunId && sameStrictJsonValue(previous.sourceArtifactIdsByRunId, sourceArtifactIdsByRunId)
                        ? previous.sourceArtifactIdsByRunId : sourceArtifactIdsByRunId,
                    ...(projection === undefined ? {} : { projection }),
                    ...(frontier === undefined ? {} : { frontier: previous?.frontier && sameStrictJsonValue(previous.frontier, frontier) ? previous.frontier : frontier }),
                    ...((windowId.startsWith('account:') || windowId.startsWith('session:') || windowId.startsWith('discussion:')) && scope ? { scope } : {}),
                    ...(attentionRunIds === undefined ? {} : { attentionRunIds: previous?.attentionRunIds && sameStrictJsonValue(previous.attentionRunIds, attentionRunIds) ? previous.attentionRunIds : attentionRunIds }),
                    ...(lastSuccessfulReadAt === undefined ? {} : { lastSuccessfulReadAt }),
                };
                const unchangedWindow = previous !== undefined && sameStrictJsonValue(previous, window);
                const workflowRunInvocationsByRunId = projection === 'membership' ? state.workflowRunInvocationsByRunId : reconcileRunInvocationObservations(state.workflowRunInvocationsByRunId,
                    pageRunIds.flatMap((id) => workflowRunsById[workflowRunStoreKey(id, scope)] ?? []), scope);
                if (unchangedWindow && workflowRunsById === state.workflowRunsById && workflowRunInvocationsByRunId === state.workflowRunInvocationsByRunId) return state;
                return {
                    ...state,
                    workflowRunsById,
                    workflowRunInvocationsByRunId,
                    workflowRunListWindows: unchangedWindow ? state.workflowRunListWindows
                        : { ...state.workflowRunListWindows, [windowId]: window },
                };
            }),
        applyWorkflowRunInvocationPage: ({ runId, scope, window: windowId = 'history', invocations, invocationDetails = [], nextCursor, parentRevision, mode }) =>
            set((state) => {
                const key = workflowRunStoreKey(runId, scope);
                const previous = state.workflowRunInvocationsByRunId[key] ?? EMPTY_RUN_INVOCATIONS;
                const openedFacts = invocationDetails.map(opened => ({ ...opened.index, opened }));
                const factsById = mergeInvocationFacts(previous.factsById, [...invocations, ...openedFacts]);
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
                    invocationIds: sameStrictJsonValue(previousWindow.invocationIds, invocationIds) ? previousWindow.invocationIds : invocationIds,
                    nextCursor: cursor, loaded: true,
                    parentRevision: Math.max(previousWindow.parentRevision ?? 0, parentRevision),
                };
                const nextWindow = sameStrictJsonValue(previousWindow, candidateWindow) ? previousWindow : candidateWindow;
                const history = windowId === 'history' ? nextWindow : previous.history;
                const attention = mergeInvocationAttention(
                    windowId === 'attention' ? nextWindow : previous.attention, factsById, [...invocations, ...openedFacts],
                );
                if (factsById === previous.factsById && history === previous.history && attention === previous.attention) return state;
                return {
                    ...state,
                    workflowRunInvocationsByRunId: {
                        ...state.workflowRunInvocationsByRunId,
                        [key]: reconcileInvocationObservations({ ...previous, factsById, history, attention }, state.workflowRunsById[key]?.summary),
                    },
                };
            }),
        upsertWorkflowRunInvocation: ({ runId, scope, invocation, parentRevision }) =>
            set((state) => {
                const key = workflowRunStoreKey(runId, scope);
                const previous = state.workflowRunInvocationsByRunId[key] ?? EMPTY_RUN_INVOCATIONS;
                const factsById = mergeInvocationFacts(previous.factsById, [invocation]);
                const candidateHistory: WorkflowRunInvocationWindow = {
                    ...previous.history,
                    invocationIds: appendUniqueInvocationIds(previous.history.invocationIds, [invocation.id]),
                    parentRevision: Math.max(previous.history.parentRevision ?? 0, parentRevision),
                };
                const history = sameStrictJsonValue(previous.history, candidateHistory) ? previous.history : candidateHistory;
                const candidateAttention = mergeInvocationAttention(previous.attention, factsById, [invocation]);
                const attention = sameStrictJsonValue(previous.attention, candidateAttention) ? previous.attention : candidateAttention;
                if (factsById === previous.factsById && history === previous.history && attention === previous.attention) return state;
                return {
                    ...state,
                    workflowRunInvocationsByRunId: {
                        ...state.workflowRunInvocationsByRunId,
                        [key]: reconcileInvocationObservations({ ...previous, factsById, history, attention }, state.workflowRunsById[key]?.summary),
                    },
                };
            }),
        setWorkflowRunFirstFailedInvocation: ({ runId, scope, invocation }) =>
            set((state) => {
                const key = workflowRunStoreKey(runId, scope);
                const previous = state.workflowRunInvocationsByRunId[key] ?? EMPTY_RUN_INVOCATIONS;
                const factsById = invocation === null ? previous.factsById : mergeInvocationFacts(previous.factsById, [invocation]);
                const firstFailedId = invocation?.id ?? null;
                if (factsById === previous.factsById && firstFailedId === previous.firstFailedId) return state;
                return {
                    ...state,
                    workflowRunInvocationsByRunId: {
                        ...state.workflowRunInvocationsByRunId,
                        [key]: reconcileInvocationObservations({ ...previous, factsById, firstFailedId }, state.workflowRunsById[key]?.summary),
                    },
                };
            }),
    };
}
