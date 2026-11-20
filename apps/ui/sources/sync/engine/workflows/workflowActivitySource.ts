import { WorkflowActionOutputSchemasV1, projectWorkflowRunMembershipV1, type WorkflowActivityListRequestV1, type WorkflowRunListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { MachinePresenceReadResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
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
import { executeMachineAccessHttpAction } from '@/sync/api/machines/machineAccessApi';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { refreshWorkflowRunsByIds } from './refreshWorkflowRun';
import { workflowActivityRunEventKey, type WorkflowActivityLiveFact, type WorkflowActivityObserver, type WorkflowActivitySource } from '@/sync/domains/workflows/workflowActivityTypes';

const sources = new WeakMap<ServerAccountScopeLifetime, WorkflowActivitySource>();

function compareRuns(left: WorkflowRunSummaryV1, right: WorkflowRunSummaryV1): number {
    const leftPosition = { id: left.id, createdAt: Date.parse(left.createdAt) };
    const rightPosition = { id: right.id, createdAt: Date.parse(right.createdAt) };
    return isBeyondWorkflowRunListSpan(leftPosition, rightPosition) ? 1
        : isBeyondWorkflowRunListSpan(rightPosition, leftPosition) ? -1 : 0;
}

function listeningSinceStorageKey(lifetime: ServerAccountScopeLifetime): string {
    return `workflow-events-listening-since-v1:${encodeURIComponent(lifetime.scope.serverId)}:${encodeURIComponent(lifetime.scope.accountId)}`;
}

function readPersistedListeningSince(lifetime: ServerAccountScopeLifetime): number | null {
    const raw = getPersistenceStorage().getString(listeningSinceStorageKey(lifetime));
    if (!raw) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function createSource(lifetime: ServerAccountScopeLifetime): WorkflowActivitySource {
    const observers = new Set<WorkflowActivityObserver>();
    const serverId = resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId);
    let since: number | null = readPersistedListeningSince(lifetime);
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
        // Membership never opens accepted display content. Hydrate its exact Runs and
        // Workflow causes through the existing Account row owner, including off-page sources.
        const runIds = result.retained.runs.flatMap(run => {
            const cause = run.origin.kind === 'automation' ? run.origin.cause : undefined;
            return cause?.kind === 'trigger' && cause.triggerKind === 'runLifecycle'
                && cause.evidence.source.kind === 'workflow_run'
                ? [run.id, cause.evidence.source.runId] : [run.id];
        });
        await refreshWorkflowRunsByIds(runIds, { accountLifetime: lifetime, signal,
            fence: { isCurrent: () => lifetime.isCurrent() && !signal?.aborted } });
        return result.retained;
    };
    const publish = (batch: WorkflowActivityLiveFact[]) => {
        if (batch.length === 0) return;
        for (const observer of observers) observer.onLive(batch);
    };
    const publishPage = (nextPage: WorkflowRunListResultV1, recovered = false) => {
        // Recovery changes freshness even when the retained rows are identical.
        const recoveredFromFailure = recovered && failed;
        if (recovered) failed = false;
        if (nextPage === page && !recoveredFromFailure) return;
        page = nextPage;
        for (const observer of observers) observer.onRetained(nextPage);
    };
    const mergePage = (retained: WorkflowRunListResultV1): WorkflowRunListResultV1 => {
        for (const run of retained.runs) {
            retainedRuns.set(run.id, retainDeep(retainedRuns.get(run.id), run));
        }
        return retainDeep(page, { ...retained, runs: [...retainedRuns.values()].sort(compareRuns) });
    };
    const close = () => {
        for (const release of detach.splice(0)) release();
        controller?.abort();
        controller = null;
        queue?.stop();
        queue = null;
        failed = false;
    };
    const open = () => {
        if (since === null) {
            since = Date.now();
            getPersistenceStorage().set(listeningSinceStorageKey(lifetime), String(since));
        }
        const listeningSince = since;
        controller = new AbortController();
        const snapshot = storage.getState();
        const machines = new Map<string, boolean>(Object.entries(snapshot.machineRecordsByServerId[serverId] ?? {})
            .filter(([, machine]) => readMachinePresenceAnswer(machine))
            .map(([id, machine]) => [id, readMachineActivity(machine).active] as const));
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
                const row = next.sessionListRowsByServerId[serverId]?.[id] ?? next.sessions[id];
                const old = previous.sessionListRowsByServerId[serverId]?.[id] ?? previous.sessions[id];
                if (!row || 'serverId' in row && row.serverId
                    && resolveServerProfileScopeIdForIdentifier(row.serverId) !== serverId) continue;
                if (!old && row.createdAt >= listeningSince) batch.push({ kind: 'session', sessionId: id,
                    event: 'started', sourceRevision: row.seq, occurredAt: row.createdAt, coverage: 'live',
                    key: serverAccountScopedResourceKey(lifetime.scope, 'session', id, 'started') });
                if (row.archivedAt && !old?.archivedAt && row.archivedAt >= listeningSince) batch.push({ kind: 'session', sessionId: id,
                    event: 'archived', sourceRevision: row.seq, occurredAt: row.archivedAt, coverage: 'live',
                    key: serverAccountScopedResourceKey(lifetime.scope, 'session', id, 'archived', String(row.archivedAt)) });
                if (row.latestTurnId && row.latestTurnId !== old?.latestTurnId && row.latestTurnStatus === 'in_progress'
                    && row.latestTurnStatusObservedAt != null && row.latestTurnStatusObservedAt >= listeningSince) {
                    batch.push({ kind: 'session', sessionId: id, event: 'turn_started', turnId: row.latestTurnId,
                        sourceRevision: row.seq, occurredAt: row.latestTurnStatusObservedAt, coverage: 'live',
                        key: serverAccountScopedResourceKey(lifetime.scope, 'session', id, 'turn_started', row.latestTurnId) });
                }
            }
            publish(batch);
        }));
        detach.push(subscribeMachineUpdates((home, ids) => {
            if (resolveServerProfileScopeIdForIdentifier(home) !== serverId) return;
            const batch: WorkflowActivityLiveFact[] = [];
            for (const id of ids) {
                const machine = storage.getState().machineRecordsByServerId[serverId]?.[id];
                if (!machine || !readMachinePresenceAnswer(machine)) continue;
                const activity = readMachineActivity(machine);
                const previous = machines.get(id);
                machines.set(id, activity.active);
                if (previous === undefined || previous === activity.active) continue;
                const event = activity.active ? 'online' : 'offline';
                const sourceRevision = activity.activeAt ?? machine.activeAt;
                batch.push({ kind: 'machine', machineId: id, event, sourceRevision,
                    occurredAt: sourceRevision, coverage: 'live',
                    key: serverAccountScopedResourceKey(lifetime.scope, 'machine', id, event, String(sourceRevision)) });
            }
            publish(batch);
        }));
        detach.push(subscribeHomeAccountChange(event => {
            if (!event.workflowRunsMaterialized) return;
            const batch: WorkflowActivityLiveFact[] = [];
            let membershipChanged = false;
            const frontier = page?.runs.at(-1);
            for (const entityId of event.entityIds ?? []) {
                const id = readWorkflowRunAccountChangeRunId(entityId);
                if (!id) continue;
                const row = storage.getState().workflowRunsById[workflowRunStoreKey(id, lifetime.scope)]?.summary;
                if (!row) {
                    runs.delete(id);
                    if (retainedRuns.delete(id)) membershipChanged = true;
                    continue;
                }
                const previousMember = retainedRuns.get(id);
                if (page && (previousMember || !page.nextCursor || !frontier
                    || !isBeyondWorkflowRunListSpan({ id, createdAt: Date.parse(row.createdAt) },
                        { id: frontier.id, createdAt: Date.parse(frontier.createdAt) }))) {
                    const member = retainDeep(previousMember, projectWorkflowRunMembershipV1(row));
                    if (member !== previousMember) {
                        retainedRuns.set(id, member);
                        membershipChanged = true;
                    }
                }
                const previous = runs.get(id);
                runs.set(id, { state: row.state, attentionRequired: row.attentionRequired });
                const terminalAt = row.finishedAt ? Date.parse(row.finishedAt) : null;
                const updatedAt = Date.parse(row.updatedAt);
                if (isTerminalAutomationRunStateV3(row.state) && previous?.state !== row.state
                    && terminalAt !== null && terminalAt >= listeningSince) batch.push({ kind: 'run', runId: id,
                    event: 'terminal', state: row.state, sourceRevision: row.revision, occurredAt: terminalAt,
                    coverage: 'live', key: workflowActivityRunEventKey({ kind: 'workflow_run', runId: id }, 'terminal', row.revision) });
                if (row.attentionRequired && !previous?.attentionRequired && updatedAt >= listeningSince) batch.push({ kind: 'run', runId: id,
                    event: 'needs_attention', state: row.state, sourceRevision: row.revision, occurredAt: updatedAt,
                    coverage: 'live', key: workflowActivityRunEventKey({ kind: 'workflow_run', runId: id }, 'needs_attention', row.revision) });
            }
            if (page && membershipChanged) {
                publishPage({ ...page, runs: [...retainedRuns.values()].sort(compareRuns) });
            }
            publish(batch);
        }, { serverIds: [serverId] }));
        const signal = controller.signal;
        const reportError = (error: unknown) => {
            if (signal.aborted) return;
            failed = true;
            for (const observer of observers) observer.onHistoryError?.(error);
        };
        queue = new ViewDemandSync(async () => {
            const retained = await readPage();
            if (signal.aborted) return;
            publishPage(mergePage(retained), true);
        }, { onError: reportError, onRetryFailure: reportError });
        void Promise.all([...machines.keys()].map(async machineId => {
            try {
                const result = MachinePresenceReadResultV1Schema.parse(await executeMachineAccessHttpAction({
                    scope: lifetime.scope, actionId: 'machines.presence.read',
                    input: { serverId: lifetime.scope.serverId, machineId },
                    isCurrent: () => lifetime.isCurrent() && !signal.aborted, signal,
                }));
                if (result.kind !== 'present' || !result.transitions || signal.aborted) return;
                const batch: WorkflowActivityLiveFact[] = [];
                for (const event of ['offline', 'online'] as const) {
                    const occurrence = result.transitions[event];
                    if (!occurrence) continue;
                    batch.push({ kind: 'machine', machineId, event, sourceRevision: occurrence.revision,
                        occurredAt: occurrence.occurredAt, coverage: 'retained',
                        key: serverAccountScopedResourceKey(lifetime.scope, 'machine', machineId, event, String(occurrence.revision)) });
                }
                publish(batch);
            } catch {
                // Presence history is additive. A refused or unavailable Machine must not withdraw
                // the live subscription or turn a working Events feed into a listening failure.
            }
        }));
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
            if (page) observer.onRetained(page);
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
            if (!signal.aborted) publishPage(mergePage(retained));
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
