import { compileCollectionConditionValueCountOptions,
    type CollectionConditionValueCountRequest, type CollectionConditionValueCounts } from '@happier-dev/plugin-ui/components';
import { normalizeSessionListFilterV1, sessionWorkFilterFields, type SessionListFilterFactsV1,
    type SessionListFilterMatchV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { buildSessionListRowFilterFacts, buildWorkflowRunFilterFacts } from './sessionListWorkFilter';
import type { ComputeVisibleSessionListIndexParams, SessionListWorkMembershipProjection } from './computeVisibleSessionListIndex';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type SessionListConditionValueCountRequest = CollectionConditionValueCountRequest;
export type SessionListConditionValueCounts = CollectionConditionValueCounts;

type CountMatch = (facts: SessionListFilterFactsV1) => SessionListFilterMatchV1;
type CountContribution = Readonly<{
    subject: object | null;
    viewerAccountId: string | undefined;
    storageKind?: 'persisted' | 'direct';
    sectionId?: string | null;
    outcomes: readonly (SessionListFilterMatchV1 | undefined)[];
}>;
type CountTotal = Readonly<{ count: number; unavailable: number }>;
export type SessionListConditionValueCountProjection = Readonly<{
    request: SessionListConditionValueCountRequest;
    matchers: readonly (CountMatch | undefined)[];
    result: SessionListConditionValueCounts;
    contributions: ReadonlyMap<string, CountContribution>;
    totals: readonly CountTotal[];
    nowMs: number;
    workspaceRefs: ComputeVisibleSessionListIndexParams['workspaceRefs'];
    workspaceRefsServerId: string | undefined;
}>;

// These fields have real local fact adapters. Structural query membership cannot
// establish frequencies for another Team, tag or subtree selection.
const LOCAL_COUNT_FIELDS = new Set(['statuses', 'show', 'startedBy', 'source', 'homeServerIds',
    'scope', 'attention', 'bot', 'coordinator', 'projects', 'machines', 'agents', 'owners', 'sections', 'branches']);

function compileOptions(request: SessionListConditionValueCountRequest): readonly (CountMatch | undefined)[] {
    const fieldId = request.fieldId === 'excludedStatuses' ? 'statuses' : request.fieldId;
    const field = LOCAL_COUNT_FIELDS.has(fieldId) ? sessionWorkFilterFields.find(candidate => candidate.id === fieldId) : undefined;
    return compileCollectionConditionValueCountOptions(field ? [field] : [], normalizeSessionListFilterV1(),
        { ...request, fieldId });
}

/** Frequencies in the current held ordinary corpus, not a prospective remote query result. */
export function projectSessionListConditionValueCounts(
    params: ComputeVisibleSessionListIndexParams,
    membership: SessionListWorkMembershipProjection,
): SessionListConditionValueCountProjection | undefined {
    const request = params.conditionValueCountRequest;
    if (!request) return undefined;
    const heldPrevious = params.previousMembership?.conditionValueCountProjection;
    const previous = heldPrevious && sameStrictJsonValue(heldPrevious.request, request) ? heldPrevious : undefined;
    const matchers = previous?.matchers ?? compileOptions(request);
    const includeStatus = request.fieldId === 'statuses' || request.fieldId === 'excludedStatuses';
    const sameFactContext = (!includeStatus || previous?.nowMs === membership.nowMs)
        && (request.fieldId !== 'projects' || previous?.workspaceRefs === params.workspaceRefs
            && previous?.workspaceRefsServerId === params.workspaceRefsServerId);
    const contributions = new Map<string, CountContribution>();
    let totals = previous?.totals ?? matchers.map(() => ({ count: 0, unavailable: 0 }));
    let mutableTotals: Array<{ count: number; unavailable: number }> | undefined;
    const apply = (outcomes: CountContribution['outcomes'], delta: number) => {
        if (!mutableTotals) mutableTotals = totals.map(total => ({ ...total }));
        outcomes.forEach((outcome, index) => {
            if (outcome === 'match') mutableTotals![index]!.count += delta;
            if (outcome === 'unavailable') mutableTotals![index]!.unavailable += delta;
        });
    };
    const admit = (key: string, subject: CountContribution['subject'], viewerAccountId: string | undefined,
        storageKind: CountContribution['storageKind'], sectionId: CountContribution['sectionId'],
        readFacts: () => SessionListFilterFactsV1) => {
        const old = previous?.contributions.get(key);
        if (old && sameFactContext && old.subject === subject && old.viewerAccountId === viewerAccountId
            && (request.fieldId !== 'source' || old.storageKind === storageKind)
            && (request.fieldId !== 'sections' || old.sectionId === sectionId)) {
            contributions.set(key, old);
            return;
        }
        // Read one admitted fact object for all options, never once per value.
        const facts = readFacts();
        const outcomes = matchers.map(match => match?.(facts));
        contributions.set(key, { subject, viewerAccountId, storageKind, sectionId, outcomes });
        if (old) apply(old.outcomes, -1);
        apply(outcomes, 1);
    };
    if (matchers.some(Boolean)) {
        for (const [key, entry] of membership.sessions) {
            if (!entry.ordinary || entry.row?.origin?.kind === 'run_step') continue;
            if (entry.row && (params.corpusStorage === 'archived' ? entry.row.archivedAt == null : entry.row.archivedAt != null && entry.row.archiving !== true)) continue;
            const [serverId] = JSON.parse(key) as [string, string];
            admit(`session:${key}`, entry.row, entry.viewerAccountId, entry.storageKind, entry.sectionId,
                () => buildSessionListRowFilterFacts(entry.row, serverId, {
                    nowMs: membership.nowMs, viewerAccountId: entry.viewerAccountId, storageKind: entry.storageKind,
                    workspaceRefs: params.workspaceRefs, workspaceRefsServerId: params.workspaceRefsServerId,
                    sessionProjectKeyResolver: membership.projectKeyResolver,
                    section: entry.sectionId === undefined ? undefined : entry.sectionId === null ? null : { serverId, sectionId: entry.sectionId },
                    includeStatus, includeAgent: request.fieldId === 'agents', includeSource: request.fieldId === 'source',
                }));
        }
        if (params.corpusStorage !== 'archived') for (const entry of membership.runs.values()) {
            admit(`run:${JSON.stringify([entry.serverId, entry.summary.id])}`, entry.summary, entry.viewerAccountId,
                undefined, undefined, () => buildWorkflowRunFilterFacts(entry.summary, entry.serverId, entry.viewerAccountId, undefined, includeStatus));
        }
    }
    if (previous) for (const [key, old] of previous.contributions) {
        if (!contributions.has(key)) apply(old.outcomes, -1);
    }
    totals = mutableTotals ?? totals;
    let countsChanged = !previous;
    const options = request.options.map((option, index) => {
        const count = matchers[index] && !totals[index]!.unavailable ? totals[index]!.count : undefined;
        const old = previous?.result.options[index];
        if (old && old.count === count) return old;
        countsChanged = true;
        return { value: option.value, ...(count === undefined ? {} : { count }) };
    });
    return { request: previous?.request ?? request, matchers, contributions, totals,
        nowMs: membership.nowMs, workspaceRefs: params.workspaceRefs, workspaceRefsServerId: params.workspaceRefsServerId,
        result: countsChanged ? { fieldId: request.fieldId, options } : previous!.result };
}
