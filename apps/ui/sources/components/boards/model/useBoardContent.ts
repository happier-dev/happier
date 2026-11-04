import * as React from 'react';
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

import { useInboxModelWhen } from '@/hooks/inbox/useInboxModel';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { buildSessionListFilterQueryHomes } from '@/components/sessions/shell/search/sessionListViewFilters';
import { useWorkflowDefinitionLibrary, useWorkflowRunWindow, type WorkflowLibraryDefinition } from '@/components/workflows/library/workflowLibraryReads';
import { useWorkflowLibrarySummaries, type WorkflowLibraryRunSummary } from '@/components/workflows/library/useWorkflowLibrarySummaries';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '@/components/workflows/presentation/workflowProblemPresentation';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { useSessionListQueryHomeStates } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { matchSessionListRowLocalFilter, matchWorkflowRunSessionListFilter, resolveWorkflowRunUnavailableHomes } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { getStorage, useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useMachineListByServerId, useSessionListRowsByServerId, useWorkflowRunRows } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';
import { resolveMachineDestinationPurposeEligibility } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { t } from '@/text';
import { useProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import {
    createBoardCardProjection,
    createBoardSummaryProjection,
    countSessionsByMachine,
    type BoardCard,
    type BoardCardFacts,
    type BoardWorkflowFacts,
} from './boardCards';
import { projectBoardMembership, type BoardMembership } from './boardMembership';
import { fromStoredSessionListFilter } from '@/components/sessions/shell/search/storedSessionListFilter';
import { isSessionListHomeOpening } from '@/sync/domains/session/listing/sessionListHomeObservation';
import { createBoardSessionSourceProjection, readBoardMachineSourceState, readBoardPagedEntitySourceState, shouldLoadNextBoardEntityPage } from './boardEntityBinding';
import { useBoardTaskItems } from './useBoardTaskItems';

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

/** Keeps the previous array when it holds the same refs, so an unrelated store write changes nothing. */
function useStableRefs(next: readonly BoardItemRefV1[] | null): readonly BoardItemRefV1[] | null {
    const ref = React.useRef<Readonly<{ key: string; refs: readonly BoardItemRefV1[] | null }>>({ key: '\u0000', refs: null });
    const key = next === null ? '\u0000' : next.map(buildWorkBoardItemKeyV1).join('\n');
    if (ref.current.key !== key) ref.current = { key, refs: next };
    return ref.current.refs;
}

/** Whether a board reads the Inbox model (its Needs you section); only such boards need an Inbox boundary. */
export function boardReadsNeedsYou(board: WorkBoardV1): boolean {
    return board.source.sections?.includes('needs_you') === true;
}

function useNeedsYouRefs(enabled: boolean, activeServerId: string | null): readonly BoardItemRefV1[] | null {
    // Read only when the board shows Needs you; without a boundary above, the section has not answered.
    const inbox = useInboxModelWhen(enabled);
    const workGroups = inbox && !inbox.isLoading ? inbox.workGroups : null;
    const refs = React.useMemo(() => {
        if (!workGroups) return null;
        const next: BoardItemRefV1[] = [];
        for (const group of workGroups) {
            for (const item of group.items) {
                if (item.kind === 'session') {
                    const address = item.entry.candidate.address;
                    if (address) next.push(sessionRef(address.serverId, address.sessionId));
                } else if (item.kind === 'workflow_run' && activeServerId) {
                    next.push(runRef(activeServerId, item.runId));
                }
            }
        }
        return next;
    }, [activeServerId, workGroups]);
    return useStableRefs(refs);
}

function useRunningRefs(enabled: boolean, activeServerId: string | null) {
    const window = useWorkflowRunWindow('active', { enabled });
    // Running promises the active window's membership, not only its first page. Traverse through
    // that owner's continuation; a failed continuation waits for its existing retry path.
    React.useEffect(() => {
        if (enabled && activeServerId && window.status === 'loaded' && window.hasMore
            && !window.loadingMore && !window.loadMoreFailed) window.loadMore();
    }, [activeServerId, enabled, window.hasMore, window.knownAt, window.loadMore, window.loadMoreFailed, window.loadingMore, window.status]);
    const refs = React.useMemo(() => {
        if (!enabled || !activeServerId || window.status === 'loading') return null;
        return window.rows.map((row) => runRef(activeServerId, row.id));
    }, [activeServerId, enabled, window.rows, window.status]);
    const stable = useStableRefs(refs);
    return { refs: stable, complete: activeServerId !== null && window.status === 'loaded'
        && !window.hasMore && !window.loadingMore && !window.loadMoreFailed };
}

function useMachineRefs(enabled: boolean, machineLists: Readonly<Record<string, Machine[] | null>>): readonly BoardItemRefV1[] | null {
    const refs = React.useMemo(() => {
        if (!enabled) return null;
        const next: BoardItemRefV1[] = [];
        for (const [serverId, machines] of Object.entries(machineLists)) {
            const portable = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
            for (const machine of machines ?? []) {
                if (!resolveMachineDestinationPurposeEligibility('boards', undefined, machine, null).eligible) continue;
                next.push({ kind: 'machine', qualifiedId: { serverId: portable, id: machine.id } });
            }
        }
        return next;
    }, [enabled, machineLists]);
    return useStableRefs(refs);
}

function useFilteredWorkRefs(board: WorkBoardV1, homes: BoardHomes): Readonly<{
    refs: readonly BoardItemRefV1[] | null | undefined;
    complete: boolean;
}> {
    const filter = React.useMemo(() => board.source.filter
        ? fromStoredSessionListFilter(board.source.filter, homes.mountedServerIds)
        : null, [board.source.filter, homes.mountedServerIds]);
    const includesSessions = filter !== null && filter.show !== 'runs';
    const includesRuns = filter !== null && canSessionListFilterIncludeRunsV1(filter);
    const readsRuns = includesRuns && homes.activeServerId !== null
        && filter.homeServerIds.some((home) => areServerProfileIdentifiersEquivalent(home, homes.activeServerId));
    const window = useWorkflowRunWindow(filter?.underSessionId ? `under:${filter.underSessionId}` : 'all', { enabled: readsRuns });
    // A Board filter (including a pinned summary) needs the whole relation, not
    // just the visible Session list's first page. Keep failure and Retry at the window.
    React.useEffect(() => {
        if (readsRuns && window.status === 'loaded' && window.hasMore
            && !window.loadingMore && !window.loadMoreFailed) window.loadMore();
    }, [readsRuns, window.hasMore, window.knownAt, window.loadMore, window.loadMoreFailed, window.loadingMore, window.status]);
    const queryHomes = React.useMemo(() => {
        if (!filter || !includesSessions) return [];
        // An empty Home selection means every mounted Home, as in the Sessions list.
        return buildSessionListFilterQueryHomes(filter, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: homes.mountedServerIds,
        });
    }, [filter, homes.mountedServerIds, includesSessions]);
    const states = useSessionListQueryHomeStates({ enabled: includesSessions, homes: queryHomes });
    const sessionRows = useSessionListRowsByServerId(includesSessions ? filter.homeServerIds : NO_IDS);
    const viewerBindings = useServerCredentialAccountScopeBindings(includesSessions || includesRuns ? filter.homeServerIds : NO_IDS);
    const workspaceRefs = useProjectAccountWorkspaceRefs(includesSessions
        && (filter.projects?.include.length ?? 0) + (filter.projects?.exclude.length ?? 0) > 0);
    const readFilterNextRefreshAtMs = React.useCallback((nowMs: number) => {
        if (!filter?.statuses?.length) return null;
        let next: number | null = null;
        for (const addresses of Object.values(states.membershipByServerId)) for (const address of addresses ?? []) {
            const row = readSessionListRowForServerId(sessionRows, address.serverId, address.sessionId);
            const at = row ? readSessionStatusNextRefreshAtMs(row, nowMs) : null;
            if (at !== null) next = next === null ? at : Math.min(next, at);
        }
        return next;
    }, [filter?.statuses, sessionRows, states.membershipByServerId]);
    const filterNowMs = useSessionListRuntimeDeadlineNowMs(readFilterNextRefreshAtMs, includesSessions && (filter.statuses?.length ?? 0) > 0);
    const answered = React.useMemo(() => {
        if (!filter) return { refs: null, complete: true };
        const next: BoardItemRefV1[] = [];
        const runBinding = homes.activeServerId
            ? viewerBindings.get(resolveServerProfileScopeIdForIdentifier(homes.activeServerId) || homes.activeServerId)
            : undefined;
        const runViewerAccountId = runBinding?.isCurrent() ? runBinding.accountId : undefined;
        let complete = !includesSessions || states.coverageComplete;
        if (includesRuns && resolveWorkflowRunUnavailableHomes({
            selectedHomeServerIds: filter.homeServerIds,
            mountedHomeServerIds: homes.mountedServerIds,
            servedHomeServerId: readsRuns ? homes.activeServerId : null,
            filter,
            runs: window.rows.map(row => row.summary),
            runUnderSessionId: readsRuns ? filter.underSessionId : undefined,
            viewerAccountId: runViewerAccountId,
        }).length > 0) complete = false;
        for (const home of queryHomes) {
            // A Home that has not answered (or cannot serve the filter) adds nothing yet; the others still show.
            const addresses = states.membershipByServerId[home.serverId];
            if (!addresses) {
                complete = false;
                continue;
            }
            for (const address of addresses) {
                const binding = viewerBindings.get(resolveServerProfileScopeIdForIdentifier(home.serverId) || home.serverId);
                const match = matchSessionListRowLocalFilter(readSessionListRowForServerId(sessionRows, home.serverId, address.sessionId),
                    home.serverId, filter, { nowMs: Math.max(filterNowMs, Date.now()), workspaceRefs,
                        viewerAccountId: binding?.isCurrent() ? binding.accountId : undefined });
                if (match === 'unavailable') complete = false;
                if (match === 'match') next.push(sessionRef(home.serverId, address.sessionId));
            }
        }
        if (readsRuns && homes.activeServerId) {
            for (const row of window.rows) {
                if (!row.summary) continue;
                const match = matchWorkflowRunSessionListFilter(row.summary, homes.activeServerId, filter, runViewerAccountId,
                    filter.underSessionId !== undefined);
                if (match === 'unavailable') complete = false;
                if (match === 'match') next.push(runRef(homes.activeServerId, row.id));
            }
            if (window.status !== 'loaded' || window.hasMore || window.loadingMore || window.loadMoreFailed) complete = false;
        } else if (includesRuns && homes.activeServerId === null) {
            complete = false;
        }
        return { refs: next, complete };
    }, [filter, filterNowMs, homes.activeServerId, homes.mountedServerIds, includesRuns, includesSessions, queryHomes, readsRuns, sessionRows, workspaceRefs, viewerBindings,
        states.coverageComplete, states.membershipByServerId, window.hasMore, window.loadMoreFailed,
        window.loadingMore, window.rows, window.status]);
    const stable = useStableRefs(answered.refs);
    return { refs: filter ? stable : undefined, complete: answered.complete };
}

/** What is on the board now. Sources a board does not use issue no read. */
export function useBoardMembership(board: WorkBoardV1, homes: BoardHomes, enabled = true): BoardMembership {
    const sections = new Set(board.source.sections ?? []);
    const machineLists = useBoardMachineLists(sections.has('my_machines'));
    const needsYou = useNeedsYouRefs(boardReadsNeedsYou(board), homes.activeServerId);
    const running = useRunningRefs(sections.has('running'), homes.activeServerId);
    const myMachines = useMachineRefs(sections.has('my_machines'), machineLists);
    const filtered = useFilteredWorkRefs(board, homes);
    const tasks = useBoardTaskItems(homes.activeServerId, board.source.picked, filtered.refs, enabled);
    return React.useMemo(() => ({ ...projectBoardMembership(board, {
        isHomeMounted: homes.isHomeMounted,
        isSourceAvailable: (ref) => (ref.kind !== 'workflow_run' && ref.kind !== 'workflow')
            || (homes.activeServerId !== null && areServerProfileIdentifiersEquivalent(homes.activeServerId, ref.qualifiedId.serverId)),
        sections: { needs_you: needsYou, running: running.refs, my_machines: myMachines },
        sectionComplete: { running: running.complete },
        filtered: filtered.refs === undefined ? undefined : [...(filtered.refs ?? []), ...tasks.linkedRefs],
        filterComplete: filtered.complete && tasks.complete,
        linkedSessionsForTask: ref => tasks.items.get(buildWorkBoardItemKeyV1(ref))?.linkedSessions.map(link =>
            sessionRef(link.serverId, link.sessionId)) ?? null,
    }), taskItems: tasks.items }), [board, filtered.complete, filtered.refs, homes.activeServerId, homes.isHomeMounted, myMachines, needsYou, running.complete, running.refs, tasks]);
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
function useBoardFacts(membership: BoardMembership, homes: BoardHomes, enabled = true): BoardCardFacts {
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
    const sessionRows = React.useMemo(() => sessionSources.map(source => source.row), [sessionSources]);
    const sessionSourceStates = React.useMemo(() => sessionSources.map(source => source.state), [sessionSources]);
    // Machine counts read the already-loaded rows of the mounted Homes, only when a machine is on the board.
    const allRows = useSessionListRowsByServerId(hasMachines ? homes.mountedServerIds : NO_IDS);
    const machineMembers = React.useMemo(() => members.filter(member => member.available && member.ref.kind === 'machine'), [members]);
    const managedHomes = React.useMemo(() => [...new Set(machineMembers.map(member => member.ref.qualifiedId.serverId))], [machineMembers]);
    const { machinesByEnrolledMachineIdByServerId, bindings: machineScopeBindings } = useManagedMachineInventory(managedHomes);
    const reachabilityRevision = useMachineReachabilityRevision(hasMachines);
    const machines = getStorage()(useShallow(state => machineMembers.map(member => resolveServerScopedMachineInventory<Machine>({
        serverId: member.ref.qualifiedId.serverId, activeServerId: '', activeMachines: [],
        machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId,
    }).machines?.find(machine => machine.id === member.ref.qualifiedId.id) ?? null)));
    const machineSourceStates = getStorage()(useShallow(state => machineMembers.map(member => readBoardMachineSourceState(state, member.ref))));
    const runRows = useWorkflowRunRows(runIds);
    const missingRun = runIds.some(id => !runRows.some(row => row.id === id && row.summary !== null));
    const runWindow = useWorkflowRunWindow('all', { enabled: missingRun });
    const library = useWorkflowDefinitionLibrary({ enabled: workflowIds.length > 0 });
    const { summaries } = useWorkflowLibrarySummaries(workflowIds);
    const missingWorkflow = workflowIds.some(id => !library.definitions.some(definition => definition.definitionId === id));
    // These readers already own paging and in-flight sharing. Continue only while the Board's
    // exact ref is absent; a first page is not evidence that a later page cannot supply it.
    React.useEffect(() => {
        if (shouldLoadNextBoardEntityPage(runWindow, missingRun)) runWindow.loadMore();
    }, [missingRun, runWindow.status, runWindow.hasMore, runWindow.loadingMore, runWindow.loadMoreFailed, runWindow.loadMore]);
    React.useEffect(() => {
        if (shouldLoadNextBoardEntityPage(library, missingWorkflow)) library.loadMore();
    }, [missingWorkflow, library.status, library.hasMore, library.loadingMore, library.loadMoreFailed, library.loadMore]);
    const readsRuntimeTime = enabled && (sessionMembers.length > 0 || hasMachines);
    const readNextRefreshAtMs = React.useCallback((nowMs: number) => {
        let next: number | null = null;
        const take = (at: number | null) => { if (at !== null) next = next === null ? at : Math.min(next, at); };
        for (const row of sessionRows) {
            if (row) take(readSessionStatusNextRefreshAtMs(row, nowMs));
        }
        // Machine cards also classify the already-loaded Sessions associated with that machine.
        if (hasMachines) for (const rows of Object.values(allRows)) {
            for (const row of Object.values(rows ?? {})) take(readSessionStatusNextRefreshAtMs(row, nowMs));
        }
        for (const machine of machines) {
            if (machine) take(readMachineStatusNextRefreshAtMs(machine, nowMs));
        }
        return next;
    }, [allRows, hasMachines, machines, sessionRows]);
    const runtimeNowMs = useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs, readsRuntimeTime);

    const workflowEntries = React.useRef(new Map<string, BoardWorkflowEntry>());
    const workflowById = React.useMemo(() => {
        const definitions = new Map(library.definitions.map(definition => [definition.definitionId, definition] as const));
        const next = new Map<string, BoardWorkflowEntry>();
        for (const id of workflowIds) {
            const definition = definitions.get(id);
            if (!definition) continue;
            const summary = summaries?.get(id) ?? null;
            const previous = workflowEntries.current.get(id);
            next.set(id, previous?.definition === definition && previous.summary === summary ? previous : {
                definition, summary, facts: {
                    get title() { return formatWorkflowDefinitionLibraryTitle(definition); },
                    get unavailableReason() { return definition.contentStatus === 'unavailable'
                        ? formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason) : undefined; },
                    get triggers() { return definition.triggers; },
                    get nextRun() { return definition.nextRunAt === null
                        ? { kind: 'unscheduled' as const } : { kind: 'scheduled' as const, at: definition.nextRunAt }; },
                    summary: summary ? { needsYouCount: summary.needsYouCount, lastRun: summary.lastRun } : null,
                },
            });
        }
        workflowEntries.current = next;
        return new Map([...next].map(([id, entry]) => [id, entry.facts] as const));
    }, [library.definitions, summaries, workflowIds]);

    const facts = React.useMemo(() => {
        // A source update or refocus can arrive after an idle clock observation. Never project
        // new facts into the past; deadline wakes themselves use the shared owner's instant.
        const nowMs = Math.max(runtimeNowMs, Date.now());
        // Task links may retain a device-local Home alias. Normalize both sides through
        // the existing Session-ref owner, just as linked membership does above.
        const sessionByKey = new Map(sessionMembers.map((member, index) => [buildWorkBoardItemKeyV1(
            sessionRef(member.ref.qualifiedId.serverId, member.ref.qualifiedId.id)), sessionRows[index] ?? null] as const));
        const runById = new Map(runRows.map((row) => [row.id, row] as const));
        const machineByKey = new Map(machineMembers.map((member, index) => [member.key, machines[index] ?? null] as const));
        const missingReasons = new Map<string, string>();
        sessionMembers.forEach((member, index) => {
            if (sessionRows[index] || sessionSourceStates[index] === 'loading') return;
            missingReasons.set(buildWorkBoardItemKeyV1(sessionRef(member.ref.qualifiedId.serverId, member.ref.qualifiedId.id)),
                t(sessionSourceStates[index] === 'retired' ? 'errors.sessionNotFound'
                : sessionSourceStates[index] === 'failed' ? 'boards.card.readFailed' : 'boards.card.missing'));
        });
        machineMembers.forEach((member, index) => {
            if (!machineByKey.get(member.key) && machineSourceStates[index] === 'settled') missingReasons.set(member.key, t('boards.card.missing'));
        });
        const activeServerId = homes.activeServerId;
        const facts: BoardCardFacts = {
            nowMs,
            accountScopedHome: (serverId) => activeServerId !== null && areServerProfileIdentifiersEquivalent(activeServerId, serverId),
            session: (ref) => sessionByKey.get(buildWorkBoardItemKeyV1(sessionRef(ref.qualifiedId.serverId, ref.qualifiedId.id))) ?? null,
            task: ref => membership.taskItems?.get(buildWorkBoardItemKeyV1(ref)) ?? null,
            workflowRun: (ref) => runById.get(ref.qualifiedId.id) ?? null,
            machine: (ref) => machineByKey.get(buildWorkBoardItemKeyV1(ref)) ?? null,
            machineScope: serverId => {
                const binding = machineScopeBindings.get(resolveServerProfileScopeIdForIdentifier(serverId));
                return binding?.isCurrent() ? binding.scope : null;
            },
            managedMachine: ref => machinesByEnrolledMachineIdByServerId[ref.qualifiedId.serverId]?.[ref.qualifiedId.id] ?? null,
            machineSessionCounts: hasMachines
                ? countSessionsByMachine(Object.entries(allRows).map(([serverId, rows]) => [
                    resolveServerProfileScopeIdForIdentifier(serverId) || serverId,
                    Object.values(rows ?? {}),
                ] as const), nowMs)
                : new Map(),
            workflow: (ref) => workflowById.get(ref.qualifiedId.id) ?? null,
            missingEntityReason: ref => {
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
                return missingReasons.get(buildWorkBoardItemKeyV1(ref.kind === 'session'
                    ? sessionRef(ref.qualifiedId.serverId, ref.qualifiedId.id) : ref)) ?? null;
            },
        };
        return facts;
    }, [allRows, hasMachines, homes.activeServerId, machineMembers, machines, machineSourceStates, machineScopeBindings, machinesByEnrolledMachineIdByServerId, membership.taskItems, reachabilityRevision, runRows, runWindow.status, runWindow.failure, runWindow.hasMore, runWindow.loadMoreFailed, runtimeNowMs, sessionMembers, sessionRows, sessionSourceStates, workflowById, library.status, library.failure, library.hasMore, library.loadMoreFailed, library.deletedDefinitionId]);
    return facts;
}

const NO_MEMBERS: BoardMembership['members'] = Object.freeze([]);

/** The data-active Board constructs only cards whose canonical source inputs changed. */
export function useBoardCards(membership: BoardMembership, homes: BoardHomes, options?: Readonly<{ enabled?: boolean }>): readonly BoardCard[] {
    const enabled = options?.enabled ?? true;
    const facts = useBoardFacts(membership, homes, enabled);
    const scope = useActiveServerAccountScope();
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const projection = React.useMemo(() => createBoardCardProjection(), [scopeKey]);
    const previousRef = React.useRef<Readonly<{ scopeKey: string | null; cards: readonly BoardCard[] }>>({ scopeKey: null, cards: NO_CARDS });
    const cards = React.useMemo(() => enabled ? projection(membership.members, facts)
        : previousRef.current.scopeKey === scopeKey ? previousRef.current.cards : NO_CARDS,
    [enabled, facts, membership.members, projection, scopeKey]);
    React.useLayoutEffect(() => { previousRef.current = { scopeKey, cards }; }, [cards, scopeKey]);
    return cards;
}

/** Count/line chrome shares membership and classification, with no card or widget projections. */
export function useBoardLiveSummary(board: WorkBoardV1) {
    const homes = useBoardHomes();
    const membership = useBoardMembership(board, homes);
    const facts = useBoardFacts(membership, homes);
    const project = React.useMemo(() => createBoardSummaryProjection(), []);
    return React.useMemo(() => project(membership.members, facts, board.widgets?.length ?? 0),
        [board.widgets?.length, facts, membership.members, project]);
}

/** The open board's live cards: homes → membership → cards, the one chain every Boards surface mounts. */
export function useBoardLiveCards(board: WorkBoardV1, options?: Readonly<{ enabled?: boolean }>): Readonly<{
    homes: BoardHomes;
    membership: BoardMembership;
    cards: readonly BoardCard[];
    widgets: readonly WorkBoardWidgetPlacementV1[];
}> {
    const homes = useBoardHomes();
    const membership = useBoardMembership(board, homes, options?.enabled ?? true);
    const cards = useBoardCards(membership, homes, options);
    const widgets = useBoardWidgets(board);
    return { homes, membership, cards, widgets };
}
