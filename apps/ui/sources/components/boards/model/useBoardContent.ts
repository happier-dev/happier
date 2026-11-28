import * as React from 'react';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { canSessionListFilterIncludeRunsV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { useShallow } from 'zustand/react/shallow';
import {
    buildWorkBoardItemKeyV1,
    buildWorkBoardWidgetKeyV1,
    resolveWorkBoardItemOrderV1,
    type BoardItemRefV1,
    type WorkBoardV1,
    type WorkBoardWidgetPlacementV1,
} from '@happier-dev/protocol/boards/workBoardV1';

import { useInboxWorkMembershipWhen } from '@/hooks/inbox/useInboxWorkProjection';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { buildSessionListFilterQueryHomes } from '@/components/sessions/shell/search/sessionListViewFilters';
import { useWorkflowDefinitionLibrary, useWorkflowRunWindow, type WorkflowLibraryDefinition } from '@/components/workflows/library/workflowLibraryReads';
import { useWorkflowLibrarySummaries, type WorkflowLibraryRunSummary } from '@/components/workflows/library/useWorkflowLibrarySummaries';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '@/components/workflows/presentation/workflowProblemPresentation';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { readSessionListRowForServerId, readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListRenderableDelta } from '@/sync/store/domains/sessionListIndexFinalization';
import { useSessionListQueryHomeStates } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { compileSessionListRowLocalFilter, compileWorkflowRunSessionListFilter, resolveWorkflowRunUnavailableHomes } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { getStorage, useWorkspaceRefs, useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useSessionListRowsByServerId, useWorkflowRunRows, useMachineListByServerId } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';
import { resolveMachineDestinationPurposeEligibility } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { machineWorkSummaryKey, useMachineWorkSummaries, type MachineWorkSummaryTarget } from '@/components/sharing/machines/machineWorkSummary';
import { readMachineInventoryRowReadiness, resolveServerScopedMachineInventory, selectMachineInventoryRowsById } from '@/sync/domains/machines/resolveServerScopedMachines';
import { t } from '@/text';
import { useProjectAccountRows, useProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import {
    createBoardCardProjection,
    createBoardSummaryProjection,
    createBoardMachineSessionProjection,
    type BoardCard,
    type BoardCardFacts,
    type BoardWorkflowFacts,
} from './boardCards';
import { NO_UNDETERMINED_BOARD_MEMBERSHIP, createBoardMembershipProjection, type BoardMembership, type BoardMembershipSources, type BoardUndeterminedMembership } from './boardMembership';
import { fromStoredSessionListFilter } from '@/components/sessions/shell/search/storedSessionListFilter';
import { isSessionListHomeOpening } from '@/sync/domains/session/listing/sessionListHomeObservation';
import { createBoardSessionSourceProjection, readBoardMachineSourceState, readBoardPagedEntitySourceState, shouldLoadNextBoardEntityPage } from './boardEntityBinding';
import { useBoardTaskItems } from './useBoardTaskItems';
import { useBoardMembershipState } from './useBoardMembershipState';

/**
 * The live board: which items are on it (each source from its existing owner) and one summary card
 * per item. Summaries are what By status, the column counts and every card frame read; detail —
 * a card's compact map — mounts only inside an expanded, visible card.
 */

export type BoardHomes = Readonly<{
    /** The active Home's portable id: Account-scoped reads (workflow runs, workflows) belong to it. */
    activeServerId: string | null;
    mountedServerIds: readonly string[];
    isHomeMounted: (serverId: string) => boolean;
}>;

const NO_IDS: readonly string[] = Object.freeze([]);
const NO_MACHINES: Readonly<Record<string, Machine[] | null>> = Object.freeze({});

/** The open Add surface consumes each library's real lifecycle, independently of its current rows. */
export function useBoardAddSources(homes: BoardHomes): {
    rowsByServerId: ReturnType<typeof useSessionListRowsByServerId>;
    machineLists: ReturnType<typeof useMachineListByServerId>;
    library: ReturnType<typeof useWorkflowDefinitionLibrary>;
    runs: ReturnType<typeof useWorkflowRunWindow>;
    loading: { sessions: boolean; workflows: boolean; runs: boolean; machines: boolean };
} {
    const rowsByServerId = useSessionListRowsByServerId(homes.mountedServerIds);
    const machineLists = useMachineListByServerId();
    const library = useWorkflowDefinitionLibrary();
    const runs = useWorkflowRunWindow('all');
    const sessionsOpening = getStorage()(state => homes.mountedServerIds.some(serverId => isSessionListHomeOpening(state, serverId)));
    const machinesLoading = getStorage()(state => homes.mountedServerIds.some(serverId => {
        const inventory = resolveServerScopedMachineInventory<Machine>({ serverId, activeServerId: '', activeMachines: [],
            machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId });
        return inventory.status === 'loading' || inventory.machines === null && inventory.status !== 'error' && inventory.status !== 'signedOut';
    }));
    return { rowsByServerId, machineLists, library, runs, loading: {
        sessions: sessionsOpening,
        workflows: homes.activeServerId !== null && (library.status === 'loading' || library.loadingMore),
        runs: homes.activeServerId !== null && (runs.status === 'loading' || runs.loadingMore),
        machines: machinesLoading,
    } };
}

function useBoardMachineLists(enabled: boolean) {
    return getStorage()((state) => enabled ? state.machineListByServerId : NO_MACHINES);
}

type BoardWorkflowEntry = Readonly<{
    definition: WorkflowLibraryDefinition;
    summary: WorkflowLibraryRunSummary | null;
    summaryFailed: boolean;
    facts: BoardWorkflowFacts;
}>;

/** The Homes this device has mounted, from the canonical Home-selection owner. */
export function useBoardHomes(): BoardHomes {
    const selection = useSessionListSelectionState();
    return React.useMemo(() => {
        const raw = selection.allowedServerIds?.length
            ? selection.allowedServerIds
            : selection.activeServerId ? [selection.activeServerId] : NO_IDS;
        const mountedServerIds = [...new Set(raw.map((id) => resolveServerProfileScopeIdForIdentifier(id)).filter(Boolean))];
        const activeServerId = selection.activeServerId ? resolveServerProfileScopeIdForIdentifier(selection.activeServerId) : null;
        return {
            activeServerId,
            mountedServerIds,
            isHomeMounted: (serverId: string) => mountedServerIds.some((mounted) => areServerProfileIdentifiersEquivalent(mounted, serverId)),
        };
    }, [selection.activeServerId, selection.allowedServerIds]);
}

function sessionRef(serverId: string, id: string): BoardItemRefV1 {
    return { kind: 'session', qualifiedId: { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, id } };
}

function runRef(serverId: string, id: string): BoardItemRefV1 {
    return { kind: 'workflow_run', qualifiedId: { serverId, id } };
}

/** Boards publish an answered relation, never a page prefix. Refresh keeps the last settled relation
 * in this exact selection/credential scope; list pagination remains owned by the list/window reader. */
function useStableRefs(next: readonly BoardItemRefV1[] | null, settled = true, scope?: unknown): readonly BoardItemRefV1[] | null {
    const ref = React.useRef<Readonly<{ key: string; refs: readonly BoardItemRefV1[] | null; scope: unknown }>>({ key: '\u0000', refs: null, scope });
    if (ref.current.scope !== scope) ref.current = { key: '\u0000', refs: null, scope };
    if (!settled) return ref.current.refs;
    if (next === ref.current.refs) return next;
    const key = next === null ? '\u0000' : next.map(buildWorkBoardItemKeyV1).join('\n');
    if (ref.current.key !== key) ref.current = { key, refs: next, scope };
    return ref.current.refs;
}

/** Whether a board reads the Inbox model (its Needs you section); only such boards need an Inbox boundary. */
export function boardReadsNeedsYou(board: WorkBoardV1): boolean {
    return board.source.sections?.includes('needs_you') === true;
}

function useNeedsYouRefs(enabled: boolean, activeServerId: string | null) {
    // Read only when the board shows Needs you; without a boundary above, the section has not answered.
    const membership = useInboxWorkMembershipWhen(enabled);
    const lifetime = useActiveServerAccountScopeLifetime();
    const scope = React.useMemo(() => ({}), [enabled, activeServerId, lifetime]);
    const work = membership && !membership.isLoading ? membership : null;
    const refs = React.useMemo(() => {
        if (!work) return null;
        return work.refs.flatMap(ref => ref.kind === 'session'
            ? [sessionRef(ref.address.serverId, ref.address.sessionId)]
            : activeServerId ? [runRef(activeServerId, ref.runId)] : []);
    }, [activeServerId, work]);
    const stable = useStableRefs(refs, refs !== null, scope);
    return { refs: stable, complete: refs !== null };
}

function useRunningRefs(enabled: boolean, activeServerId: string | null) {
    const window = useWorkflowRunWindow('active', { enabled, readMode: 'complete' });
    const lifetime = useActiveServerAccountScopeLifetime();
    const scope = React.useMemo(() => ({}), [enabled, activeServerId, lifetime]);
    const refs = React.useMemo(() => {
        if (!enabled || !activeServerId || window.status === 'loading') return null;
        return window.rows.map((row) => runRef(activeServerId, row.id));
    }, [activeServerId, enabled, window.rows, window.status]);
    const complete = activeServerId !== null && window.status === 'loaded'
        && !window.hasMore && !window.loadingMore && !window.loadMoreFailed;
    const stable = useStableRefs(refs, complete, scope);
    return { refs: stable, complete, settled: stable !== null };
}

function useMachineRefs(enabled: boolean, homes: BoardHomes, machineLists: Readonly<Record<string, Machine[] | null>>) {
    const statuses = getStorage()(state => enabled ? state.machineListStatusByServerId : null);
    const bindings = useServerCredentialAccountScopeBindings(enabled ? homes.mountedServerIds : NO_IDS);
    const selectionKey = JSON.stringify(homes.mountedServerIds);
    const credentialScopeKey = JSON.stringify([...bindings].map(([id, binding]) => [id, binding.accountId, binding.revision, binding.isCurrent()]));
    const answers = React.useMemo(() => new Map<string, readonly BoardItemRefV1[]>(), [enabled, selectionKey, credentialScopeKey]);
    // The census owns membership; pending hydration/refresh cannot replace its last answer.
    // Exact Home credentials bound that answer, while current coverage still controls pruning.
    const source = React.useMemo(() => {
        let complete = !enabled || homes.mountedServerIds.length > 0;
        let settled = complete;
        const next: BoardItemRefV1[] = [];
        for (const serverId of enabled ? homes.mountedServerIds : NO_IDS) {
            const inventory = resolveServerScopedMachineInventory<Machine>({ serverId, activeServerId: '', activeMachines: [],
                machineListByServerId: machineLists, machineListStatusByServerId: statuses ?? undefined });
            const portable = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
            const ready = inventory.status === 'idle' && inventory.machines !== null
                && inventory.machines.every(machine => readMachineInventoryRowReadiness(machine) !== 'pending');
            if (ready || !answers.has(serverId)) {
                const refs = (inventory.machines ?? []).filter(machine =>
                    resolveMachineDestinationPurposeEligibility('boards', undefined, machine, null).eligible)
                    .map((machine): BoardItemRefV1 => ({ kind: 'machine', qualifiedId: { serverId: portable, id: machine.id } }));
                if (ready) answers.set(serverId, refs);
                else if (inventory.status !== 'signedOut') next.push(...refs);
            }
            if (!ready) complete = false;
            if (inventory.status === 'signedOut') answers.delete(serverId);
            const answer = answers.get(serverId);
            if (answer) next.push(...answer);
            else settled = false;
        }
        return { refs: enabled ? next : null, complete, settled };
    }, [answers, enabled, homes.mountedServerIds, machineLists, statuses]);
    const stable = useStableRefs(source.refs, true, answers);
    return { ...source, refs: stable };
}

type FilterSourceAnswer = Readonly<{
    refs: readonly BoardItemRefV1[];
    undetermined: BoardUndeterminedMembership;
}>;
type SessionFilterCandidate = Readonly<{
    row: SessionListRenderableSession | null;
    match: ReturnType<ReturnType<typeof compileSessionListRowLocalFilter>>;
    reason: BoardUndeterminedMembership['reasons'][number]['reason'];
}>;
type SessionFilterSnapshot = {
    addresses: readonly Readonly<{ sessionId: string }>[];
    rows: Readonly<Record<string, SessionListRenderableSession>> | null;
    context: unknown;
    delta: SessionListRenderableDelta | undefined;
    candidates: Map<string, SessionFilterCandidate>;
    withheld: number;
    answer: FilterSourceAnswer;
};

function filterAnswer(refs: readonly BoardItemRefV1[], reasons: BoardUndeterminedMembership['reasons']): FilterSourceAnswer {
    return { refs, undetermined: reasons.length === 0 ? NO_UNDETERMINED_BOARD_MEMBERSHIP
        : { count: reasons.reduce((count, reason) => count + reason.count, 0), reasons } };
}

/** One answered Home relation. Row publications update only their producer-declared ids;
 * a new query relation, predicate context or skipped delta takes the complete read. */
function projectBoardSessionFilter(input: Readonly<{
    previous?: SessionFilterSnapshot;
    serverId: string;
    addresses: SessionFilterSnapshot['addresses'];
    rows: SessionFilterSnapshot['rows'];
    context: unknown;
    delta: SessionListRenderableDelta | undefined;
    withheld: number;
    evaluate: (row: SessionListRenderableSession | null) => Omit<SessionFilterCandidate, 'row'>;
}>): SessionFilterSnapshot {
    const { previous, addresses, rows, context, delta } = input;
    const sameRelation = previous?.addresses === addresses && previous.context === context;
    const candidates = sameRelation ? previous.candidates : new Map<string, SessionFilterCandidate>();
    let changed = !sameRelation || previous.withheld !== input.withheld;
    const evaluate = (id: string) => {
        const row = rows?.[id] ?? null;
        const old = previous?.candidates.get(id);
        const candidate = old?.row === row && previous?.context === context ? old : { row, ...input.evaluate(row) };
        candidates.set(id, candidate);
        if (candidate.match !== old?.match || candidate.reason !== old?.reason) changed = true;
    };
    if (!sameRelation) {
        for (const address of addresses) evaluate(address.sessionId);
    } else if (previous.rows !== rows) {
        if (delta && previous.delta && delta.revision === previous.delta.revision + 1) {
            for (const id of new Set([...delta.changedSessionIds, ...delta.removedSessionIds])) {
                if (candidates.has(id)) evaluate(id);
            }
        } else for (const address of addresses) evaluate(address.sessionId);
    }
    let answer = previous?.answer;
    if (changed || !answer) {
        const refs: BoardItemRefV1[] = [];
        const counts = new Map<SessionFilterCandidate['reason'], number>();
        if (input.withheld) counts.set('filter_facts_unavailable', input.withheld);
        for (const address of addresses) {
            const candidate = candidates.get(address.sessionId)!;
            if (candidate.match === 'match') refs.push(sessionRef(input.serverId, address.sessionId));
            if (candidate.match === 'unavailable') counts.set(candidate.reason, (counts.get(candidate.reason) ?? 0) + 1);
        }
        const stableRefs = answer && answer.refs.length === refs.length && refs.every((ref, index) =>
            buildWorkBoardItemKeyV1(ref) === buildWorkBoardItemKeyV1(answer!.refs[index]!)) ? answer.refs : refs;
        const next = filterAnswer(stableRefs, [...counts].map(([reason, count]) => ({ kind: 'session', reason, count })));
        if (!answer || answer.refs !== next.refs || JSON.stringify(answer.undetermined) !== JSON.stringify(next.undetermined)) answer = next;
    }
    return { addresses, rows, context, delta, candidates, withheld: input.withheld, answer };
}

function useFilteredWorkRefs(board: WorkBoardV1, homes: BoardHomes, enabled: boolean): Readonly<{
    refs: readonly BoardItemRefV1[] | null | undefined;
    complete: boolean;
    settled: boolean;
    undetermined: BoardUndeterminedMembership;
    withdrawn: boolean;
}> {
    const filter = React.useMemo(() => enabled && board.source.filter
        ? fromStoredSessionListFilter(board.source.filter, homes.mountedServerIds)
        : null, [board.source.filter, homes.mountedServerIds, enabled]);
    const includesSessions = filter !== null && filter.show !== 'runs';
    const includesRuns = filter !== null && canSessionListFilterIncludeRunsV1(filter);
    const readsRuns = includesRuns && homes.activeServerId !== null
        && filter.homeServerIds.some((home) => areServerProfileIdentifiersEquivalent(home, homes.activeServerId));
    // A Board filter, including its pinned summary, demands the whole relation.
    // The shared Run owner completes byte-bounded pages before any queued refresh.
    const window = useWorkflowRunWindow(filter?.underSessionId ? `under:${filter.underSessionId}` : 'all', { enabled: readsRuns, readMode: 'complete' });
    // A Board's Project facet asks its Home for every key the Project's Sessions may carry (owner 11-08).
    const queryWorkspaceRefs = useWorkspaceRefs();
    const projectRefs = filter?.projects?.include.length || filter?.projects?.exclude.length ? queryWorkspaceRefs : undefined;
    const queryHomes = React.useMemo(() => {
        if (!filter || !includesSessions) return [];
        // An empty Home selection means every mounted Home, as in the Sessions list.
        return buildSessionListFilterQueryHomes(filter, {
            workspaceRefs: projectRefs,
            storage: 'active',
            includeInactive: false,
            // The ordinary exhaustive corpus already contains attention rows. The extra
            // priority lane belongs to visible lists, not to an exhaustive Board census.
            includeAttention: false,
            mountedHomeServerIds: homes.mountedServerIds,
        }).map(home => ({ ...home, readMode: 'complete' as const }));
    }, [filter, homes.mountedServerIds, includesSessions, projectRefs]);
    const states = useSessionListQueryHomeStates({ enabled: includesSessions, homes: queryHomes });
    // The query owner completes each traversal before applying a queued refresh. A
    // consumer continuation effect would let ordinary Home wakes starve later pages.
    const viewerBindings = useServerCredentialAccountScopeBindings(includesSessions || includesRuns ? filter.homeServerIds : NO_IDS);
    const readsProjects = includesSessions && (filter.projects?.include.length ?? 0) + (filter.projects?.exclude.length ?? 0) > 0;
    const workspaceRefs = useProjectAccountWorkspaceRefs(readsProjects);
    const projectReaderAnswered = useProjectAccountRows(rows => rows !== null && rows.status !== 'idle' && rows.status !== 'loading', readsProjects);
    const selectionKey = JSON.stringify(filter);
    const credentialScopeKey = JSON.stringify([...viewerBindings].map(([id, binding]) => [id, binding.accountId, binding.revision, binding.isCurrent()]));
    const filterDeadline = React.useMemo(() => ({ next: null as number | null, revision: 0,
        rows: new WeakMap<SessionListRenderableSession, number | null>() }), [board.id, selectionKey, credentialScopeKey]);
    const readsFilterStatus = includesSessions && Boolean(filter.statuses?.include.length || filter.statuses?.exclude.length);
    // Only a status filter's freshness deadline reads every row here; membership is answered at the row
    // subscription below, so a row write that changes no Board answer renders nothing.
    const sessionRows = useSessionListRowsByServerId(readsFilterStatus ? filter.homeServerIds : NO_IDS);
    const readFilterNextRefreshAtMs = React.useCallback((nowMs: number) => {
        if (!readsFilterStatus) return null;
        // A source publication refreshes the clock hook's instant too. Only an actual
        // admitted deadline invalidates every unchanged status predicate.
        if (filterDeadline.next !== null && nowMs >= filterDeadline.next) filterDeadline.revision += 1;
        let next: number | null = null;
        for (const addresses of Object.values(states.membershipByServerId)) for (const address of addresses ?? []) {
            const row = readSessionListRowForServerId(sessionRows, address.serverId, address.sessionId);
            if (!row) continue;
            let at = filterDeadline.rows.get(row);
            if (at === undefined || at !== null && nowMs >= at) {
                at = readSessionStatusNextRefreshAtMs(row, nowMs);
                filterDeadline.rows.set(row, at);
            }
            if (at !== null) next = next === null ? at : Math.min(next, at);
        }
        filterDeadline.next = next;
        return next;
    }, [readsFilterStatus, filterDeadline, sessionRows, states.membershipByServerId]);
    const filterNowMs = useSessionListRuntimeDeadlineNowMs(readFilterNextRefreshAtMs, readsFilterStatus);
    // Each Home/window answers independently. An unavailable Home cannot withhold another
    // Home's settled cards; no page prefix can replace that source's last settled relation.
    const sourceMembership = React.useMemo<{
        sessions: Map<string, SessionFilterSnapshot>;
        runs?: Readonly<{ rows: typeof window.rows; context: unknown; answer: FilterSourceAnswer }>;
        combined?: Readonly<{ sources: readonly FilterSourceAnswer[]; answer: FilterSourceAnswer }>;
    }>(() => ({ sessions: new Map() }), [board.id, selectionKey, homes.activeServerId, credentialScopeKey]);
    const predicateContext = React.useMemo(() => ({
        sessions: new Map(queryHomes.map(home => [home.serverId, compileSessionListRowLocalFilter(filter!, home.serverId)])),
        runs: filter ? compileWorkflowRunSessionListFilter(filter) : null,
        sessionProjectKeyResolver: createSessionProjectKeyResolverV1(workspaceRefs, workspaceRefResolutionContextV1()),
    }), [sourceMembership, queryHomes, workspaceRefs, filterDeadline.revision, projectReaderAnswered]);
    const selectAnswered = React.useMemo(() => (sessionRows: Parameters<typeof readSessionListRowsForServerId>[0]) => {
        // The delta is only an incremental hint; a missed revision performs a full read.
        const sessionDelta = includesSessions ? getStorage().getState().sessionListRenderableDelta : undefined;
        if (!filter) return { refs: null, complete: true, settled: true, undetermined: NO_UNDETERMINED_BOARD_MEMBERSHIP };
        const sources: FilterSourceAnswer[] = [];
        const runBinding = homes.activeServerId
            ? viewerBindings.get(resolveServerProfileScopeIdForIdentifier(homes.activeServerId) || homes.activeServerId)
            : undefined;
        const runViewerAccountId = runBinding?.isCurrent() ? runBinding.accountId : undefined;
        let complete = !includesSessions || states.coverageComplete;
        // Read settlement is not coverage: a released ordinary corpus can answer the local
        // predicate without certifying the strict query's membership for layout pruning.
        // No readers before discovery, or for an unmounted selected Home, is not an empty answer.
        let settled = !includesSessions || homes.mountedServerIds.length > 0 && filter.homeServerIds.every(homes.isHomeMounted);
        if (includesRuns && resolveWorkflowRunUnavailableHomes({
            selectedHomeServerIds: filter.homeServerIds,
            mountedHomeServerIds: homes.mountedServerIds,
            servedHomeServerId: readsRuns ? homes.activeServerId : null,
            filter,
            runs: window.rows.map(row => row.summary),
            runUnderSessionId: readsRuns ? filter.underSessionId : undefined,
            viewerAccountId: runViewerAccountId,
            // This check owns Home reachability. Candidate predicate unknowns are counted below,
            // not reinterpreted as an unanswered Home (or evaluated a second time).
            runFactsUnavailable: false,
        }).length > 0) { complete = false; settled = false; }
        for (const home of queryHomes) {
            const addresses = states.membershipByServerId[home.serverId];
            const state = states.statesByServerId[home.serverId];
            // Unlike an ordinary refresh/offline retry, the query owner explicitly
            // withdraws this relation on refusal. Never resurrect that retained answer.
            if (state?.failureReason === 'access_denied' && state.appliedQueryKey === null) sourceMembership.sessions.delete(home.serverId);
            // Complete mode applies only exhausted relations. Its applied answer remains
            // valid through queued loading/refresh/error phases, including an empty answer.
            const ready = addresses && state?.appliedQueryKey === home.queryKey
                && !state.hasNext && !state.attentionHasNext
                && (!readsProjects || workspaceRefs !== undefined || projectReaderAnswered);
            if (ready) {
                const binding = viewerBindings.get(resolveServerProfileScopeIdForIdentifier(home.serverId) || home.serverId);
                sourceMembership.sessions.set(home.serverId, projectBoardSessionFilter({
                    previous: sourceMembership.sessions.get(home.serverId), serverId: home.serverId, addresses,
                    rows: readSessionListRowsForServerId(sessionRows, home.serverId), context: predicateContext, delta: sessionDelta,
                    withheld: state.metadataUpgradeRequiredCount ?? 0,
                    evaluate: row => {
                        let fields: readonly string[] = [];
                        const match = predicateContext.sessions.get(home.serverId)!(row, {
                            nowMs: Math.max(filterNowMs, Date.now()), workspaceRefs, sessionProjectKeyResolver: predicateContext.sessionProjectKeyResolver,
                            workspaceRefsServerId: homes.activeServerId ?? undefined,
                            viewerAccountId: binding?.isCurrent() ? binding.accountId : undefined,
                            onUnavailable: unavailable => { fields = unavailable; },
                        });
                        return { match, reason: fields.includes('projects') ? 'project_association_unavailable' : 'filter_facts_unavailable' };
                    },
                }));
            } else complete = false;
            const snapshot = sourceMembership.sessions.get(home.serverId);
            if (snapshot) sources.push(snapshot.answer);
            else settled = false;
            if (snapshot?.answer.undetermined.count) complete = false;
        }
        if (readsRuns && homes.activeServerId) {
            const ready = window.status === 'loaded' && !window.hasMore && !window.loadingMore && !window.loadMoreFailed;
            if (ready && (sourceMembership.runs?.rows !== window.rows || sourceMembership.runs.context !== predicateContext)) {
                const refs: BoardItemRefV1[] = [];
                const counts = new Map<SessionFilterCandidate['reason'], number>();
                for (const row of window.rows) {
                    let fields: readonly string[] = [];
                    const match = row.summary ? predicateContext.runs!(row.summary, homes.activeServerId, runViewerAccountId,
                        filter.underSessionId !== undefined, unavailable => { fields = unavailable; }) : 'unavailable';
                    if (match === 'match') refs.push(runRef(homes.activeServerId, row.id));
                    if (match === 'unavailable') {
                        const reason = fields.includes('projects') ? 'project_association_unavailable' : 'filter_facts_unavailable';
                        counts.set(reason, (counts.get(reason) ?? 0) + 1);
                    }
                }
                sourceMembership.runs = { rows: window.rows, context: predicateContext,
                    answer: filterAnswer(refs, [...counts].map(([reason, count]) => ({ kind: 'workflow_run', reason, count }))) };
            }
            if (!ready) complete = false;
            if (sourceMembership.runs) {
                sources.push(sourceMembership.runs.answer);
                if (sourceMembership.runs.answer.undetermined.count) complete = false;
            } else settled = false;
        } else if (includesRuns && homes.activeServerId === null) {
            complete = false;
            settled = false;
        }
        const combined = sourceMembership.combined;
        if (!combined || combined.sources.length !== sources.length || sources.some((source, index) => source !== combined.sources[index])) {
            const counts = new Map<string, BoardUndeterminedMembership['reasons'][number]>();
            for (const source of sources) for (const reason of source.undetermined.reasons) {
                const key = `${reason.kind}:${reason.reason}`;
                counts.set(key, { ...reason, count: (counts.get(key)?.count ?? 0) + reason.count });
            }
            sourceMembership.combined = { sources, answer: filterAnswer(sources.flatMap(source => source.refs), [...counts.values()]) };
        }
        return { ...sourceMembership.combined!.answer, complete, settled };
    }, [filter, filterNowMs, homes.activeServerId, homes.isHomeMounted, homes.mountedServerIds, includesRuns, includesSessions, queryHomes, readsRuns, workspaceRefs, viewerBindings,
        predicateContext, projectReaderAnswered, readsProjects, sourceMembership, states.coverageComplete, states.membershipByServerId, states.statesByServerId, window.hasMore, window.loadMoreFailed,
        window.loadingMore, window.rows, window.status]);
    const answered = useSessionListRowsByServerId(includesSessions ? filter.homeServerIds : NO_IDS, selectAnswered);
    const stable = useStableRefs(answered.refs, true, sourceMembership);
    const withdrawn = queryHomes.some(home => {
        const state = states.statesByServerId[home.serverId];
        return state?.failureReason === 'access_denied' && state.appliedQueryKey === null;
    });
    return { refs: filter ? stable : undefined, complete: answered.complete, settled: answered.settled, undetermined: answered.undetermined, withdrawn };
}

/** What is on the board now. Sources a board does not use issue no read. */
export function useBoardMembership(board: WorkBoardV1, homes: BoardHomes, enabled = true): ReturnType<ReturnType<typeof createBoardMembershipProjection>> {
    const shared = useBoardMembershipState(board, homes, enabled);
    const readsSources = shared.readsSources;
    const sections = new Set(board.source.sections ?? []);
    const machineLists = useBoardMachineLists(readsSources && sections.has('my_machines'));
    const needsYou = useNeedsYouRefs(readsSources && boardReadsNeedsYou(board), homes.activeServerId);
    const running = useRunningRefs(readsSources && sections.has('running'), homes.activeServerId);
    const myMachines = useMachineRefs(readsSources && sections.has('my_machines'), homes, machineLists);
    const filtered = useFilteredWorkRefs(board, homes, readsSources);
    const tasks = useBoardTaskItems(homes.activeServerId, board.source.picked, filtered.refs, readsSources);
    const sources = React.useMemo<BoardMembershipSources>(() => ({
        isHomeMounted: homes.isHomeMounted,
        isSourceAvailable: (ref) => (ref.kind !== 'workflow_run' && ref.kind !== 'workflow')
            || (homes.activeServerId !== null && areServerProfileIdentifiersEquivalent(homes.activeServerId, ref.qualifiedId.serverId)),
        sections: { needs_you: needsYou.refs, running: running.refs, my_machines: myMachines.refs },
        sectionComplete: { needs_you: needsYou.complete, running: running.complete, my_machines: myMachines.complete },
        sectionSettled: { my_machines: myMachines.settled, running: running.settled },
        filtered: filtered.refs == null ? filtered.refs : [...filtered.refs, ...tasks.linkedRefs],
        filterComplete: filtered.complete && filtered.settled,
        filterSettled: filtered.settled,
        filterUndetermined: filtered.undetermined,
        taskItemsComplete: tasks.complete,
        taskItemsSettled: tasks.settled,
        linkedSessionsForTask: ref => tasks.items.get(buildWorkBoardItemKeyV1(ref))?.linkedSessions.map(link =>
            sessionRef(link.serverId, link.sessionId)) ?? null,
    }), [filtered.complete, filtered.refs, filtered.settled, filtered.undetermined, homes.activeServerId, homes.isHomeMounted, myMachines.complete, myMachines.refs, myMachines.settled, needsYou.complete, needsYou.refs, running.complete, running.refs, running.settled, tasks]);
    React.useLayoutEffect(() => {
        if (readsSources) shared.state.publish(shared.reader, board, sources,
            { taskItems: tasks.items, refreshTaskItems: tasks.refresh }, filtered.withdrawn);
    }, [board, filtered.withdrawn, readsSources, shared.reader, shared.state, sources, tasks.items, tasks.refresh]);
    return shared.membership;
}

const NO_CARDS: readonly BoardCard[] = Object.freeze([]);

/** Widget content is already in the Board document; it never enters work-status classification. */
export function useBoardWidgets(board: WorkBoardV1): WorkBoardWidgetPlacementV1[] {
    return React.useMemo(() => {
        const order = resolveWorkBoardItemOrderV1(board);
        return (board.widgets ?? []).slice().sort((a, b) => order.indexOf(buildWorkBoardWidgetKeyV1(a.ref)) - order.indexOf(buildWorkBoardWidgetKeyV1(b.ref)));
    }, [board.widgets, board.itemOrder, board.source.picked]);
}

/** Only demanded kinds subscribe to their existing data owners. Display fields remain lazy so
 * chrome can use membership/status without joining card titles, triggers or next-run bodies. */
function useBoardFacts(membership: BoardMembership, homes: BoardHomes, enabled = true, readMachineWork = true): BoardCardFacts {
    const members = enabled ? membership.members : NO_MEMBERS;
    const sessionMembers = React.useMemo(() => {
        const linked = new Map(members.filter(member => member.ref.kind === 'session').map(member => [member.key, member]));
        for (const member of members) {
            if (member.ref.kind !== 'task') continue;
            for (const link of membership.taskItems?.get(member.key)?.linkedSessions ?? []) {
                const ref = sessionRef(link.serverId, link.sessionId);
                const key = buildWorkBoardItemKeyV1(ref);
                if (!linked.has(key)) linked.set(key, { key, ref, picked: false, sourced: true, available: homes.isHomeMounted(link.serverId) });
            }
        }
        return [...linked.values()];
    }, [members, membership.taskItems, homes.isHomeMounted]);
    const hasMachines = members.some((member) => member.available && member.ref.kind === 'machine');
    const runIds = React.useMemo(
        () => members.filter((member) => member.available && member.ref.kind === 'workflow_run'
            && homes.activeServerId !== null && areServerProfileIdentifiersEquivalent(homes.activeServerId, member.ref.qualifiedId.serverId))
            .map((member) => member.ref.qualifiedId.id),
        [members, homes.activeServerId],
    );
    const workflowIds = React.useMemo(
        () => members.filter((member) => member.available && member.ref.kind === 'workflow'
            && homes.activeServerId !== null && areServerProfileIdentifiersEquivalent(homes.activeServerId, member.ref.qualifiedId.serverId))
            .map((member) => member.ref.qualifiedId.id),
        [members, homes.activeServerId],
    );
    const lifetime = useActiveServerAccountScopeLifetime();
    const projectSessions = React.useMemo(() => createBoardSessionSourceProjection(), [lifetime]);
    const sessionRefs = React.useMemo(() => sessionMembers.map(member => member.ref), [sessionMembers]);
    // One narrow selector retains the last settled source during a re-read. The Account lifetime
    // and demanded refs bound its continuity; another Account can never inherit it.
    const sessionSources = getStorage()(useShallow(state => projectSessions(state, sessionRefs)));
    // Machine counts read the already-loaded rows of the mounted Homes, only when a machine is on the board.
    const machineSessionProjection = React.useMemo(() => createBoardMachineSessionProjection(), [lifetime]);
    // Admit at the canonical selector, before React can batch two writer publications. Its
    // consecutive delta is only an optimization hint; a missed revision performs a full read.
    const selectMachineSessions = React.useCallback((rows: Parameters<typeof machineSessionProjection.update>[0]) =>
        machineSessionProjection.update(rows, getStorage().getState().sessionListRenderableDelta, Date.now()), [machineSessionProjection]);
    const machineSessions = useSessionListRowsByServerId(hasMachines ? homes.mountedServerIds : NO_IDS, selectMachineSessions);
    const runRows = useWorkflowRunRows(runIds);
    const machineMembers = React.useMemo(() => {
        const byKey = new Map(members.filter(member => member.available && member.ref.kind === 'machine').map(member => [member.key, member]));
        if (homes.activeServerId) for (const row of runRows) {
            if (!row.summary) continue;
            const ref = { kind: 'machine', qualifiedId: { serverId: homes.activeServerId, id: row.summary.machineId } } as const;
            const key = buildWorkBoardItemKeyV1(ref);
            if (!byKey.has(key)) byKey.set(key, { key, ref, picked: false, sourced: true, available: true });
        }
        return [...byKey.values()];
    }, [members, runRows, homes.activeServerId]);
    const managedHomes = React.useMemo(() => [...new Set(members
        .filter(member => member.available && member.ref.kind === 'machine')
        .map(member => member.ref.qualifiedId.serverId))], [members]);
    const { machinesByEnrolledMachineIdByServerId, bindings: machineScopeBindings } = useManagedMachineInventory(managedHomes);
    const reachabilityRevision = useMachineReachabilityRevision(machineMembers.length > 0);
    const machineGroups = React.useMemo(() => {
        const groups = new Map<string, Array<Readonly<{ id: string; index: number }>>>();
        machineMembers.forEach((member, index) => {
            const serverId = resolveServerProfileScopeIdForIdentifier(member.ref.qualifiedId.serverId);
            const group = groups.get(serverId) ?? [];
            group.push({ id: member.ref.qualifiedId.id, index });
            groups.set(serverId, group);
        });
        return groups;
    }, [machineMembers]);
    const machines = getStorage()(useShallow(state => {
        const rows: Array<Machine | null> = Array(machineMembers.length).fill(null);
        for (const [serverId, group] of machineGroups) {
            const inventory = resolveServerScopedMachineInventory<Machine>({ serverId, activeServerId: '', activeMachines: [],
                machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId });
            const selected = selectMachineInventoryRowsById(inventory.machines, group.map(target => target.id));
            group.forEach((target, index) => { rows[target.index] = selected[index] ?? null; });
        }
        return rows;
    }));
    const machineSourceStates = getStorage()(useShallow(state => machineMembers.map(member => readBoardMachineSourceState(state, member.ref))));
    const missingRun = runIds.some(id => !runRows.some(row => row.id === id && row.summary !== null));
    const runWindow = useWorkflowRunWindow('all', { enabled: missingRun });
    const library = useWorkflowDefinitionLibrary({ enabled: workflowIds.length > 0, definitionIds: workflowIds });
    const { summaries, failedIds: failedSummaryIds } = useWorkflowLibrarySummaries(workflowIds);
    // The Run window owns paging and in-flight sharing. Continue only while the
    // exact ref is absent; a first page cannot rule out a later-page match.
    React.useEffect(() => {
        if (shouldLoadNextBoardEntityPage(runWindow, missingRun)) runWindow.loadMore();
    }, [missingRun, runWindow.status, runWindow.hasMore, runWindow.loadingMore, runWindow.loadMoreFailed, runWindow.loadMore]);
    const readsRuntimeTime = enabled && (sessionMembers.length > 0 || machineMembers.length > 0);
    const readNextRefreshAtMs = React.useCallback((nowMs: number) => {
        let next: number | null = null;
        const take = (at: number | null) => { if (at !== null) next = next === null ? at : Math.min(next, at); };
        for (const source of sessionSources) take(source.readNextRefreshAtMs(nowMs));
        // Machine cards also classify the already-loaded Sessions associated with that machine.
        if (hasMachines) take(machineSessionProjection.read(nowMs).refreshAt);
        return next;
    }, [machineSessions, machineSessionProjection, hasMachines, sessionSources]);
    const observedMachines = React.useMemo(() => machines.filter(machine => machine !== null), [machines]);
    const presenceNowMs = useMachinePresenceNowMs(observedMachines);
    const runtimeNowMs = useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs, readsRuntimeTime);
    const machineCounts = machineSessionProjection.read(Math.max(runtimeNowMs, Date.now())).counts;
    const machineScope = React.useCallback((serverId: string) => {
        const binding = machineScopeBindings.get(resolveServerProfileScopeIdForIdentifier(serverId));
        return binding?.isCurrent() ? binding.scope : lifetime?.isCurrent()
            && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, serverId) ? lifetime.scope : null;
    }, [machineScopeBindings, lifetime]);
    const workTargetsByKey = React.useMemo(() => {
        const targets = new Map<string, MachineWorkSummaryTarget>();
        if (!readMachineWork) return targets;
        const cardKeys = new Set(members.filter(member => member.available && member.ref.kind === 'machine').map(member => member.key));
        machineMembers.forEach((member, index) => {
            if (!cardKeys.has(member.key)) return;
            const scope = machineScope(member.ref.qualifiedId.serverId);
            const machine = machines[index];
            if (!scope || !machine) return;
            const reachability = resolveMachineReachability(scope, machine, Math.max(presenceNowMs, Date.now()));
            targets.set(member.key, { scope, machineId: machine.id,
                online: reachability === 'unknown' ? null : reachability === 'reachable' });
        });
        return targets;
    }, [readMachineWork, members, machineMembers, machines, machineScope, reachabilityRevision, presenceNowMs]);
    const workTargets = React.useMemo(() => [...workTargetsByKey.values()], [workTargetsByKey]);
    const workSummaries = useMachineWorkSummaries(workTargets);
    const sessionContext = React.useMemo(() => ({}), [lifetime, sessionRefs, homes.activeServerId]);
    const runContext = React.useMemo(() => ({}), [runRows, homes.activeServerId, lifetime, machineMembers, machines,
        machineScopeBindings, machinesByEnrolledMachineIdByServerId, reachabilityRevision, runWindow.status, runWindow.failure, runWindow.hasMore, runWindow.loadMoreFailed]);
    const machineContext = React.useMemo(() => ({}), [machineCounts, homes.activeServerId, lifetime, machineMembers, machines,
        machineSourceStates, machineScopeBindings, machinesByEnrolledMachineIdByServerId, reachabilityRevision]);

    const workflowEntries = React.useRef(new Map<string, BoardWorkflowEntry>());
    const workflowById = React.useMemo(() => {
        const definitions = new Map(library.definitions.map(definition => [definition.definitionId, definition] as const));
        const next = new Map<string, BoardWorkflowEntry>();
        for (const id of workflowIds) {
            const definition = definitions.get(id);
            if (!definition) continue;
            const summary = summaries?.get(id) ?? null;
            const summaryFailed = summary === null && failedSummaryIds.has(id);
            const previous = workflowEntries.current.get(id);
            next.set(id, previous?.definition === definition && previous.summary === summary
                && previous.summaryFailed === summaryFailed ? previous : {
                definition, summary, summaryFailed, facts: {
                    get title() { return formatWorkflowDefinitionLibraryTitle(definition); },
                    get unavailableReason() { return definition.contentStatus === 'unavailable'
                        ? formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason)
                        : summaryFailed ? t('boards.card.readFailed') : undefined; },
                    get triggers() { return definition.triggers; },
                    get nextRun() { return definition.nextRunAt === null
                        ? { kind: 'unscheduled' as const } : { kind: 'scheduled' as const, at: definition.nextRunAt }; },
                    summary: summary ? { needsYouCount: summary.needsYouCount, lastRun: summary.lastRun } : null,
                },
            });
        }
        workflowEntries.current = next;
        return new Map([...next].map(([id, entry]) => [id, entry.facts] as const));
    }, [library.definitions, summaries, failedSummaryIds, workflowIds]);
    const workflowContext = React.useMemo(() => ({}), [workflowById, homes.activeServerId, lifetime, library.status,
        library.failure, library.hasMore, library.loadMoreFailed, library.deletedDefinitionId]);

    const facts = React.useMemo(() => {
        // A source update or refocus can arrive after an idle clock observation. Never project
        // new facts into the past; deadline wakes themselves use the shared owner's instant.
        const nowMs = Math.max(runtimeNowMs, presenceNowMs, Date.now());
        const runById = new Map(runRows.map((row) => [row.id, row] as const));
        const machineByKey = new Map(machineMembers.map((member, index) => [member.key, machines[index] ?? null] as const));
        const missingReasons = new Map<string, string>();
        machineMembers.forEach((member, index) => {
            if (!machineByKey.get(member.key) && machineSourceStates[index] === 'settled') missingReasons.set(member.key, t('boards.card.missing'));
        });
        const activeServerId = homes.activeServerId;
        const facts: BoardCardFacts = {
            nowMs,
            sessionInputs: { source: sessionSources, context: sessionContext },
            inputContexts: { workflow_run: runContext, machine: machineContext, workflow: workflowContext },
            accountScopedHome: (serverId) => activeServerId !== null && areServerProfileIdentifiersEquivalent(activeServerId, serverId),
            // Normalize only requested keys, including Task links retaining a device-local Home alias.
            session: (ref) => sessionSources.byKey.get(buildWorkBoardItemKeyV1(sessionRef(ref.qualifiedId.serverId, ref.qualifiedId.id)))?.row ?? null,
            task: ref => membership.taskItems?.get(buildWorkBoardItemKeyV1(ref)) ?? null,
            workflowRun: (ref) => runById.get(ref.qualifiedId.id) ?? null,
            machine: (ref) => machineByKey.get(buildWorkBoardItemKeyV1(ref)) ?? null,
            machineScope,
            machineWorkSummary: ref => {
                const target = workTargetsByKey.get(buildWorkBoardItemKeyV1(ref));
                return target ? workSummaries.states.get(machineWorkSummaryKey(target)) : undefined;
            },
            managedMachine: ref => machinesByEnrolledMachineIdByServerId[ref.qualifiedId.serverId]?.[ref.qualifiedId.id] ?? null,
            machineSessionCounts: machineCounts,
            workflow: (ref) => workflowById.get(ref.qualifiedId.id) ?? null,
            missingEntityReason: ref => {
                if (ref.kind === 'session') {
                    const source = sessionSources.byKey.get(buildWorkBoardItemKeyV1(sessionRef(ref.qualifiedId.serverId, ref.qualifiedId.id)));
                    return !source || source.row || source.state === 'loading' ? null
                        : t(source.state === 'retired' ? 'errors.sessionNotFound'
                            : source.state === 'failed' ? 'boards.card.readFailed' : 'boards.card.missing');
                }
                if (ref.kind === 'task') return membership.taskItems?.has(buildWorkBoardItemKeyV1(ref))
                    ? t('boards.card.missing') : null;
                if (ref.kind === 'workflow' && !workflowById.has(ref.qualifiedId.id)) {
                    return library.status === 'failed' || library.loadMoreFailed
                        ? library.failure?.message ?? t('boards.card.notLoaded')
                        : library.deletedDefinitionId === ref.qualifiedId.id || readBoardPagedEntitySourceState(library) === 'settled'
                            ? t('boards.card.missing') : null;
                }
                if (ref.kind === 'workflow_run' && !runById.get(ref.qualifiedId.id)?.summary) {
                    return runWindow.status === 'failed' || runWindow.loadMoreFailed
                        ? runWindow.failure?.message ?? t('boards.card.notLoaded')
                        : readBoardPagedEntitySourceState(runWindow) === 'settled' ? t('boards.card.missing') : null;
                }
                return missingReasons.get(buildWorkBoardItemKeyV1(ref)) ?? null;
            },
        };
        return facts;
    }, [machineCounts, sessionContext, runContext, machineContext, workflowContext, homes.activeServerId, machineScope, machineMembers, machines, machineSourceStates, workTargetsByKey, workSummaries.states, machinesByEnrolledMachineIdByServerId, membership.taskItems, reachabilityRevision, runRows, runWindow.status, runWindow.failure, runWindow.hasMore, runWindow.loadMoreFailed, runtimeNowMs, presenceNowMs, sessionSources, workflowById, library.status, library.failure, library.hasMore, library.loadMoreFailed, library.deletedDefinitionId]);
    return facts;
}

const NO_MEMBERS: BoardMembership['members'] = Object.freeze([]);

/** The data-active Board constructs only cards whose canonical source inputs changed. */
export function useBoardCards(membership: BoardMembership, homes: BoardHomes, options?: Readonly<{ enabled?: boolean }>): readonly BoardCard[] {
    const enabled = options?.enabled ?? true;
    const isSessionVisible = useSessionRecordingVisibility();
    const visibleMembers = React.useMemo(() => {
        const members = membership.members.filter(member => member.ref.kind !== 'session'
            || isSessionVisible({ serverId: member.ref.qualifiedId.serverId, sessionId: member.ref.qualifiedId.id }));
        return members.length === membership.members.length ? membership.members : members;
    }, [membership.members, isSessionVisible]);
    const visibleMembership = React.useMemo(() => visibleMembers === membership.members ? membership
        : { ...membership, members: visibleMembers }, [membership, visibleMembers]);
    const facts = useBoardFacts(visibleMembership, homes, enabled);
    const scope = useActiveServerAccountScope();
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const projection = React.useMemo(() => createBoardCardProjection(), [scopeKey]);
    const previousRef = React.useRef<Readonly<{ scopeKey: string | null; cards: readonly BoardCard[] }>>({ scopeKey: null, cards: NO_CARDS });
    const cards = React.useMemo(() => {
        if (enabled) return projection(visibleMembers, facts);
        const candidates = previousRef.current.scopeKey === scopeKey ? previousRef.current.cards : NO_CARDS;
        const visible = candidates.filter(card => card.ref.kind !== 'session'
            || isSessionVisible({ serverId: card.ref.qualifiedId.serverId, sessionId: card.ref.qualifiedId.id }));
        return visible.length === candidates.length ? candidates : visible;
    }, [enabled, facts, visibleMembers, projection, scopeKey, isSessionVisible]);
    React.useLayoutEffect(() => { previousRef.current = { scopeKey, cards }; }, [cards, scopeKey]);
    return cards;
}

/** Count/line chrome shares membership and classification, with no card or widget projections. */
export function useBoardLiveSummary(board: WorkBoardV1) {
    const homes = useBoardHomes();
    const membership = useBoardMembership(board, homes);
    const facts = useBoardFacts(membership, homes, membership.settled, false);
    const project = React.useMemo(() => createBoardSummaryProjection(), []);
    return React.useMemo(() => project(membership.members, facts, board.widgets?.length ?? 0, membership.settled, membership.undetermined),
        [board.widgets?.length, facts, membership.members, membership.settled, membership.undetermined, project]);
}

/** The open board's live cards: homes → membership → cards, the one chain every Boards surface mounts. */
export function useBoardLiveCards(board: WorkBoardV1, options?: Readonly<{ enabled?: boolean }>): Readonly<{
    homes: BoardHomes;
    membership: ReturnType<typeof useBoardMembership>;
    cards: readonly BoardCard[];
    widgets: readonly WorkBoardWidgetPlacementV1[];
}> {
    const homes = useBoardHomes();
    const membership = useBoardMembership(board, homes, options?.enabled ?? true);
    const isSessionVisible = useSessionRecordingVisibility();
    const cards = useBoardCards(membership, homes, options);
    const widgets = useBoardWidgets(board);
    // Withheld pending cards are still members. An unanswered card-only Board is opening,
    // rather than an answered empty Board; retain membership for layout pruning and removal.
    const presentationMembership = React.useMemo(() => membership.settled && cards.length < membership.members.filter(member => member.ref.kind !== 'session'
        || isSessionVisible({ serverId: member.ref.qualifiedId.serverId, sessionId: member.ref.qualifiedId.id })).length
        ? { ...membership, settled: false } : membership, [membership, cards, isSessionVisible]);
    return { homes, membership: presentationMembership, cards, widgets };
}
