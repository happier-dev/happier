import { WorkflowActionOutputSchemasV1, projectWorkflowRunMembershipV1, type WorkflowActivityListRequestV1, type WorkflowRunListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readServerAccountScopeOwnerLifetime, serverAccountScopedResourceKey, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { readMachineActivity, readMachinePresenceAnswer } from '@/sync/domains/machines/machineActivity';
import { ViewDemandSync } from '@/sync/engine/viewDemandSync';
import { subscribeMachineUpdates } from '@/sync/store/domains/machines';
import { isBeyondWorkflowRunListSpan, workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { readWorkflowRunAccountChangeRunId } from '@/sync/runtime/orchestration/changesPlanner';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { refreshWorkflowRunsByIds } from './refreshWorkflowRun';
import { projectWorkflowActivityRunFact, workflowActivityTurnEvents, type WorkflowActivityLiveFact, type WorkflowActivityObserver, type WorkflowActivitySource } from '@/sync/domains/workflows/workflowActivityTypes';

const sources = new WeakMap<ServerAccountScopeLifetime, WorkflowActivitySource>();

function compareRuns(left: WorkflowRunSummaryV1, right: WorkflowRunSummaryV1): number {
    const leftPosition = { id: left.id, createdAt: Date.parse(left.createdAt) };
    const rightPosition = { id: right.id, createdAt: Date.parse(right.createdAt) };
    return isBeyondWorkflowRunListSpan(leftPosition, rightPosition) ? 1
        : isBeyondWorkflowRunListSpan(rightPosition, leftPosition) ? -1 : 0;
}

function createSource(lifetime: ServerAccountScopeLifetime): WorkflowActivitySource {
    const observers = new Set<WorkflowActivityObserver>();
    const serverId = resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId);
    let since: number | null = null;
    let page: WorkflowRunListResultV1 | undefined;
    const retainedRuns = new Map<string, WorkflowRunSummaryV1>();
    let failed = false;
    let queue: ViewDemandSync | null = null;
    let controller: AbortController | null = null;
    let detach: (() => void)[] = [];

    const readPage = async (input: WorkflowActivityListRequestV1 = {}): Promise<WorkflowRunListResultV1> => {
        const signal = controller?.signal;
        const result = await callWorkflowAction({ actionId: 'workflow.activity.list', input,
            parseResult: WorkflowActionOutputSchemasV1['workflow.activity.list'].parse,
            accountLifetime: lifetime, signal });
        // Only retained Event subjects and their Started from it rows need Run names.
        // Keep other Runs in public membership without opening their accepted content.
        const runIds = result.retained.runs.flatMap(run => {
            const cause = run.origin.kind === 'automation' ? run.origin.cause : undefined;
            if (cause?.kind === 'trigger' && cause.triggerKind === 'runLifecycle') {
                return cause.evidence.source.kind === 'workflow_run' ? [run.id, cause.evidence.source.runId] : [run.id];
            }
            if (cause?.kind === 'trigger' && cause.triggerKind === 'sessionLifecycle') return [run.id];
            return projectWorkflowActivityRunFact(run, 'terminal', 'retained') ? [run.id] : [];
        });
        await refreshWorkflowRunsByIds(runIds, { accountLifetime: lifetime, signal,
            fence: { isCurrent: () => lifetime.isCurrent() && !signal?.aborted } });
        return result.retained;
    };
    const publish = (batch: WorkflowActivityLiveFact[]) => {
        if (batch.length === 0) return;
        for (const observer of observers) observer.onLive(batch);
    };
    const publishPage = (nextPage: WorkflowRunListResultV1, changedRuns: readonly WorkflowRunSummaryV1[], recovered = false) => {
        // Recovery changes freshness even when the retained rows are identical.
        const recoveredFromFailure = recovered && failed;
        if (recovered) failed = false;
        if (nextPage === page && !recoveredFromFailure) return;
        page = nextPage;
        for (const observer of observers) observer.onRetained(nextPage, changedRuns);
    };
    const mergePage = (retained: WorkflowRunListResultV1, recovered = false) => {
        const changedRuns: WorkflowRunSummaryV1[] = [];
        for (const run of retained.runs) {
            const previous = retainedRuns.get(run.id);
            const member = retainDeep(previous, run);
            if (member === previous) continue;
            retainedRuns.set(run.id, member);
            changedRuns.push(member);
        }
        const runs = page && changedRuns.length === 0 ? page.runs : [...retainedRuns.values()].sort(compareRuns);
        publishPage(retainDeep(page, { ...retained, runs }), changedRuns, recovered);
    };
    const close = () => {
        for (const release of detach.splice(0)) release();
        controller?.abort();
        controller = null;
        queue?.stop();
        queue = null;
        failed = false;
        since = null;
    };
    const open = () => {
        const listeningSince = Date.now();
        since = listeningSince;
        controller = new AbortController();
        const signal = controller.signal;
        const snapshot = storage.getState();
        const machines = new Map<string, { active: boolean; transitions: Machine['presenceTransitions'] }>();
        const projectMachine = (machine: Machine, batch: WorkflowActivityLiveFact[]) => {
            const transitions = machine.presenceTransitions;
            if (transitions === undefined && !readMachinePresenceAnswer(machine)) return;
            const activity = readMachineActivity(machine);
            const previous = machines.get(machine.id);
            machines.set(machine.id, { active: activity.active, transitions });
            const append = (event: 'offline' | 'online', sourceRevision: number, occurredAt: number, coverage: 'retained' | 'live') => {
                batch.push({ kind: 'machine', machineId: machine.id, event, sourceRevision, occurredAt, coverage,
                    key: serverAccountScopedResourceKey(lifetime.scope, 'machine', machine.id, event, String(sourceRevision)) });
            };
            if (transitions !== undefined) {
                for (const event of ['offline', 'online'] as const) {
                    const occurrence = transitions?.[event];
                    if (!occurrence || occurrence.revision === previous?.transitions?.[event]?.revision) continue;
                    append(event, occurrence.revision, occurrence.occurredAt,
                        occurrence.occurredAt >= listeningSince ? 'live' : 'retained');
                }
            } else if (previous && previous.transitions === undefined && previous.active !== activity.active) {
                // Older Homes only publish current presence.
                const occurredAt = activity.activeAt ?? machine.activeAt;
                append(activity.active ? 'online' : 'offline', occurredAt, occurredAt, 'live');
            }
        };
        const initialMachineFacts: WorkflowActivityLiveFact[] = [];
        for (const machine of Object.values(snapshot.machineRecordsByServerId[serverId] ?? {})) {
            projectMachine(machine, initialMachineFacts);
        }
        const runs = new Map<string, Pick<WorkflowRunSummaryV1, 'state' | 'attentionRequired'>>();
        for (const row of Object.values(snapshot.workflowRunsById)) {
            const summary = row.summary;
            if (summary && snapshot.workflowRunsById[workflowRunStoreKey(summary.id, lifetime.scope)] === row) {
                runs.set(summary.id, { state: summary.state, attentionRequired: summary.attentionRequired });
            }
        }
        detach.push(storage.subscribe((next, previous) => {
            if (next.sessionListRenderableDelta === previous.sessionListRenderableDelta) return;
            const batch: WorkflowActivityLiveFact[] = [];
            const ids = new Set([...next.sessionListRenderableDelta.changedSessionIds,
                ...(next.sessionListRenderableDelta.hydratedSessionIds ?? [])]);
            for (const id of ids) {
                const listed = next.sessionListRowsByServerId[serverId]?.[id];
                const oldListed = previous.sessionListRowsByServerId[serverId]?.[id];
                const row = listed ?? next.sessions[id];
                const old = oldListed ?? previous.sessions[id];
                if (!row || 'serverId' in row && row.serverId
                    && resolveServerProfileScopeIdForIdentifier(row.serverId) !== serverId) continue;
                if (!old && row.createdAt >= listeningSince) batch.push({ kind: 'session', sessionId: id,
                    event: 'started', sourceRevision: row.seq, occurredAt: row.createdAt, coverage: 'live',
                    key: serverAccountScopedResourceKey(lifetime.scope, 'session', id, 'started') });
                if (row.archivedAt && !old?.archivedAt && row.archivedAt >= listeningSince) batch.push({ kind: 'session', sessionId: id,
                    event: 'archived', sourceRevision: row.seq, occurredAt: row.archivedAt, coverage: 'live',
                    key: serverAccountScopedResourceKey(lifetime.scope, 'session', id, 'archived', String(row.archivedAt)) });
                const turnEvent = row.latestTurnStatus ? workflowActivityTurnEvents[row.latestTurnStatus] : null;
                if (turnEvent && row.latestTurnId && (row.latestTurnId !== old?.latestTurnId || row.latestTurnStatus !== old?.latestTurnStatus)
                    && row.latestTurnStatusObservedAt != null && row.latestTurnStatusObservedAt >= listeningSince) {
                    batch.push({ kind: 'session', sessionId: id, event: turnEvent, turnId: row.latestTurnId,
                        sourceRevision: row.seq, occurredAt: row.latestTurnStatusObservedAt, coverage: 'live',
                        key: serverAccountScopedResourceKey(lifetime.scope, 'session', id, turnEvent, row.latestTurnId) });
                }
                const request = listed?.currentRequestRef;
                const occurredAt = listed?.pendingRequestObservedAt;
                if (occurredAt != null && occurredAt >= listeningSince && occurredAt !== oldListed?.pendingRequestObservedAt
                    && (listed?.hasPendingPermissionRequests || listed?.hasPendingUserActionRequests)) {
                    // The compact list update proves pending attention, while exact attribution
                    // requires a newly visible request with its own Turn identity.
                    const exact = request?.turnId && request !== oldListed?.currentRequestRef ? {
                        turnId: request.turnId, requestId: request.requestId,
                        requestKind: request.kind === 'permission' ? 'permission' as const : 'user_action' as const,
                    } : {};
                    batch.push({ kind: 'session', sessionId: id, event: 'userActionRequired', ...exact,
                        sourceRevision: row.seq, occurredAt, coverage: 'live',
                        key: serverAccountScopedResourceKey(lifetime.scope, 'session', id, 'userActionRequired', String(occurredAt)) });
                }
            }
            publish(batch);
        }));
        detach.push(subscribeMachineUpdates((home, ids) => {
            if (resolveServerProfileScopeIdForIdentifier(home) !== serverId) return;
            const batch: WorkflowActivityLiveFact[] = [];
            const records = storage.getState().machineRecordsByServerId[serverId];
            for (const id of ids) {
                const machine = records?.[id];
                if (!machine) {
                    machines.delete(id);
                    continue;
                }
                projectMachine(machine, batch);
            }
            publish(batch);
        }));
        detach.push(subscribeHomeAccountChange(event => {
            if (!event.workflowRunsMaterialized) return;
            const batch: WorkflowActivityLiveFact[] = [];
            const changedRuns: WorkflowRunSummaryV1[] = [];
            let memberRemoved = false;
            const frontier = page?.runs.at(-1);
            for (const entityId of event.entityIds ?? []) {
                const id = readWorkflowRunAccountChangeRunId(entityId);
                if (!id) continue;
                const row = storage.getState().workflowRunsById[workflowRunStoreKey(id, lifetime.scope)]?.summary;
                if (!row) {
                    runs.delete(id);
                    if (retainedRuns.delete(id)) memberRemoved = true;
                    continue;
                }
                const previousMember = retainedRuns.get(id);
                if (page && (previousMember || !page.nextCursor || !frontier
                    || !isBeyondWorkflowRunListSpan({ id, createdAt: Date.parse(row.createdAt) },
                        { id: frontier.id, createdAt: Date.parse(frontier.createdAt) }))) {
                    const member = retainDeep(previousMember, projectWorkflowRunMembershipV1(row));
                    if (member !== previousMember) {
                        retainedRuns.set(id, member);
                        changedRuns.push(member);
                    }
                }
                const previous = runs.get(id);
                runs.set(id, { state: row.state, attentionRequired: row.attentionRequired });
                const terminal = previous?.state !== row.state
                    ? projectWorkflowActivityRunFact(row, 'terminal', 'live') : null;
                if (terminal && terminal.occurredAt >= listeningSince) batch.push(terminal);
                const attention = !previous?.attentionRequired
                    ? projectWorkflowActivityRunFact(row, 'needs_attention', 'live') : null;
                if (attention && attention.occurredAt >= listeningSince) batch.push(attention);
            }
            if (page && (changedRuns.length > 0 || memberRemoved)) {
                publishPage({ ...page, runs: [...retainedRuns.values()].sort(compareRuns) }, changedRuns);
            }
            publish(batch);
        }, { serverIds: [serverId] }));
        const reportError = (error: unknown) => {
            if (signal.aborted) return;
            failed = true;
            for (const observer of observers) observer.onHistoryError?.(error);
        };
        queue = new ViewDemandSync(async () => {
            const retained = await readPage();
            if (signal.aborted) return;
            mergePage(retained, true);
        }, { onError: reportError, onRetryFailure: reportError });
        if (initialMachineFacts.length > 0) queueMicrotask(() => {
            if (!signal.aborted) publish(initialMachineFacts);
        });
    };
    // Requested membership follows the Account across view handoffs; live listeners follow demand.
    lifetime.onRetire(() => { close(); page = undefined; retainedRuns.clear(); observers.clear(); });
    return {
        acquire(observer) {
            if (!lifetime.isCurrent()) return () => {};
            if (observers.size === 0) open();
            const subscription = { ...observer };
            observers.add(subscription);
            const releaseDemand = queue!.acquire();
            if (page) observer.onRetained(page, page.runs);
            return () => {
                if (!observers.delete(subscription)) return;
                releaseDemand();
                if (observers.size === 0) close();
            };
        },
        hasDemand: () => observers.size > 0,
        listeningSince: () => since,
        readPage,
        loadMore: async () => {
            const signal = controller?.signal;
            const cursor = page?.nextCursor;
            if (!signal || !cursor) return;
            const retained = await readPage({ cursor });
            if (!signal.aborted) mergePage(retained);
        },
        retry: async () => { if (queue) await queue.read(); },
    };
}

export function getWorkflowActivitySource(addressed: ServerAccountScopeLifetime | null = captureActiveServerAccountScopeLifetime()): WorkflowActivitySource | null {
    if (!addressed?.isCurrent()) return null;
    const lifetime = readServerAccountScopeOwnerLifetime(addressed);
    // Live sync is owned by the mounted Account, rather than a background credential reader.
    if (lifetime !== captureActiveServerAccountScopeLifetime()) return null;
    let source = sources.get(lifetime);
    if (!source) sources.set(lifetime, source = createSource(lifetime));
    return source;
}
