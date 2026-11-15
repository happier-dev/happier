import { buildWorkBoardItemKeyV1, type BoardItemRefV1, type WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import type { WorkflowRunStateV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowTriggerSummaryInputV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { PluginWorkItemV1 } from '@happier-dev/protocol/plugins/contributions/workItems';

import {
    resolveWorkStatusTone,
    resolveManagedMachineWorkStatus,
    isWorkStatusNeedsYou,
    type WorkStatusPresentation,
} from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { readWorkflowRunWorkStatusFacts, type WorkflowRunWorkStatusSummary } from '@/components/work/status/workflowWorkStatusFacts';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import {
    formatWorkflowRunDisplayName,
    resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { resolveMachineReachability, type MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { getSessionName, readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';

import { NO_UNDETERMINED_BOARD_MEMBERSHIP, type BoardMember, type BoardUndeterminedMembership } from './boardMembership';
import { formatTriggerSetSummary } from '@/components/workflows/triggers/formatTriggerSummary';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import type { BoardSessionSources } from './boardEntityBinding';
import type { SessionListRenderableDelta } from '@/sync/store/domains/sessionListIndexFinalization';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { MachineWorkSummaryState } from '@/components/sharing/machines/machineWorkSummary';

/**
 * One card anatomy for every kind (INT §5.1): identity, the state word, "Kind · context", then a
 * kind body. Each kind's facts come from its own owner and its status from `resolveWorkStatusTone`,
 * so a card says what the Inbox, the map and the Work tab say about the same item. Cards hold
 * summaries only: no transcript, no full run.
 */

export type BoardCardAvailability = 'ready' | 'not_loaded' | 'home_unavailable' | 'content_unavailable';

export type MachineSessionCounts = Readonly<{ running: number; needsYou: number }>;

export type BoardCardBody =
    | Readonly<{ kind: 'task'; item: PluginWorkItemV1 }>
    | Readonly<{ kind: 'session'; serverId: string; sessionId: string; statusDetail?: string }>
    | Readonly<{ kind: 'workflow_run'; runId: string; state: WorkflowRunStateV1; attentionLabel: string | null; startedAt: string | null;
        progress: WorkflowRunSummaryV1['stepProgress'] }>
    | Readonly<{ kind: 'workflow'; needsYouCount: number | null; lastRunWord: string | null; lastRunAt: string | null;
        runSummaryAvailable: boolean; triggerSummary: string | null; nextRun: BoardWorkflowNextRun }>
    | Readonly<{ kind: 'machine'; online: boolean | null; counts: MachineSessionCounts }>
    | Readonly<{ kind: 'none' }>;

export type BoardCard = Readonly<{
    key: string;
    ref: BoardItemRefV1;
    picked: boolean;
    availability: BoardCardAvailability;
    unavailableReason?: string;
    title: string;
    status: WorkStatusPresentation;
    body: BoardCardBody;
}>;

/** A date is supplied only by FIN's scheduler summary, never inferred from the schedule. */
export type BoardWorkflowNextRun = Readonly<{ kind: 'scheduled'; at: number }>
    | Readonly<{ kind: 'unscheduled' }> | Readonly<{ kind: 'unavailable' }>;

export type BoardWorkflowFacts = Readonly<{
    title: string;
    unavailableReason?: string;
    triggers?: readonly WorkflowTriggerSummaryInputV1[] | null;
    nextRun?: BoardWorkflowNextRun;
    /** FIN 03's `workflow.run.summaries` entry; `null` until it answers (facts are then omitted). */
    summary: Readonly<{
        needsYouCount: number;
        lastRun: WorkflowRunWorkStatusSummary & Readonly<{ createdAt: string }> | null;
    }> | null;
}>;

/** Lookups into the existing owners; missingEntityReason distinguishes a settled miss from loading. */
export type BoardCardFacts = Readonly<{
    nowMs: number;
    sessionInputs?: Readonly<{ source: BoardSessionSources; context: object }>;
    /** Stable owner inputs, not the freshly assembled facts container. Missing hints use full reads. */
    inputContexts?: Partial<Readonly<Record<BoardItemRefV1['kind'], object>>>;
    session: (ref: BoardItemRefV1) => SessionListRenderableSession | null;
    task?: (ref: Extract<BoardItemRefV1, { kind: 'task' }>) => PluginWorkItemV1 | null;
    workflowRun: (ref: BoardItemRefV1) => WorkflowRunRow | null;
    machine: (ref: BoardItemRefV1) => Machine | null;
    /** The credential-bound Account for this exact Machine Home; absent authority fails closed. */
    machineScope?: (serverId: string) => MachineReachabilityScope | null;
    managedMachine?: (ref: BoardItemRefV1) => ManagedMachineV1 | null;
    machineWorkSummary?: (ref: BoardItemRefV1) => MachineWorkSummaryState | undefined;
    /** Counts from the already-loaded Session rows, by the machine's qualified item key (no extra read). */
    machineSessionCounts: ReadonlyMap<string, MachineSessionCounts>;
    workflow: (ref: BoardItemRefV1) => BoardWorkflowFacts | null;
    /** An absent entity is loading until its canonical reader settles; absence alone is not deletion. */
    missingEntityReason?: (ref: BoardItemRefV1) => string | null;
    /**
     * Whether a Home's workflows and runs are the ones the Account-scoped stores hold (the focused Home).
     * Another Home's workflow or run is unavailable here, never read as the focused Home's same-id item.
     */
    accountScopedHome: (serverId: string) => boolean;
}>;

const NO_SESSIONS: MachineSessionCounts = Object.freeze({ running: 0, needsYou: 0 });

function readMachineSessionContribution(serverId: string, row: SessionListRenderableSession, nowMs: number) {
    if (typeof row.archivedAt === 'number') return null;
    const machineId = typeof row.metadata?.machineId === 'string' ? row.metadata.machineId.trim() : '';
    if (!machineId) return null;
    const status = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(row, nowMs) });
    return { key: buildWorkBoardItemKeyV1({ kind: 'machine', qualifiedId: { serverId, id: machineId } }),
        running: status.bucket === 'working' && !isWorkStatusNeedsYou(status) ? 1 : 0,
        needsYou: isWorkStatusNeedsYou(status) ? 1 : 0,
        refreshAt: readSessionStatusNextRefreshAtMs(row, nowMs) };
}

function readRunMachine(ref: BoardItemRefV1, summary: WorkflowRunSummaryV1, facts: BoardCardFacts) {
    const machineRef = { kind: 'machine', qualifiedId: { serverId: ref.qualifiedId.serverId, id: summary.machineId } } as const;
    const machine = facts.machine(machineRef);
    const managedMachine = facts.managedMachine?.(machineRef);
    const reachability = machine ? resolveMachineReachability(facts.machineScope?.(ref.qualifiedId.serverId), machine, facts.nowMs) : 'unknown';
    return { machine, managedMachine, context: { machineReachable: reachability === 'unknown' ? undefined : reachability === 'reachable',
        machineName: machine ? getMachineDisplayName(machine) : null,
        machineStatus: resolveManagedMachineWorkStatus({ machineId: summary.machineId, revokedAt: machine?.revokedAt,
            online: reachability === 'unknown' ? null : reachability === 'reachable', managedMachine,
            nativeState: machine?.managedInputRuntime?.state }) } };
}

/**
 * Running and needs-you Sessions per machine, classified by the one status owner. Rows come grouped by
 * their Home, and counts are keyed by the machine's qualified item key: the same machine id on two
 * Homes is two machines.
 */
export function countSessionsByMachine(
    rowsByServerId: Iterable<readonly [serverId: string, rows: Iterable<SessionListRenderableSession>]>,
    nowMs: number,
): ReadonlyMap<string, MachineSessionCounts> {
    const counts = new Map<string, { running: number; needsYou: number }>();
    for (const [serverId, rows] of rowsByServerId) {
        for (const row of rows) {
            const contribution = readMachineSessionContribution(serverId, row, nowMs);
            if (!contribution || !contribution.running && !contribution.needsYou) continue;
            const entry = counts.get(contribution.key) ?? { running: 0, needsYou: 0 };
            entry.running += contribution.running;
            entry.needsYou += contribution.needsYou;
            counts.set(contribution.key, entry);
        }
    }
    return counts;
}

/** Visit-local loaded-row contributions. The row writer supplies changes; the shared clock
 * supplies expiry. Missing or skipped publications rebuild through the same classifier. */
export function createBoardMachineSessionProjection() {
    type Rows = Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>> | null | undefined>>;
    type Entry = { serverId: string; row: SessionListRenderableSession; contribution: ReturnType<typeof readMachineSessionContribution> };
    let entries = new Map<string, Entry>();
    let previousRows: Rows | null = null;
    let previousRevision: number | undefined;
    let snapshot: Readonly<{ counts: ReadonlyMap<string, MachineSessionCounts>; refreshAt: number | null }> = { counts: new Map(), refreshAt: null };
    const publish = (changes: readonly (readonly [string, Entry | null])[]) => {
        const touched = new Map<string, { running: number; needsYou: number }>();
        const add = (entry: Entry | undefined | null, sign: number) => {
            const c = entry?.contribution;
            if (!c) return;
            const count = touched.get(c.key) ?? { ...(snapshot.counts.get(c.key) ?? NO_SESSIONS) };
            count.running += sign * c.running;
            count.needsYou += sign * c.needsYou;
            touched.set(c.key, count);
        };
        for (const [key, entry] of changes) {
            add(entries.get(key), -1);
            add(entry, 1);
            if (entry) entries.set(key, entry);
            else entries.delete(key);
        }
        let counts: Map<string, MachineSessionCounts> | null = null;
        for (const [key, count] of touched) {
            const old = snapshot.counts.get(key) ?? NO_SESSIONS;
            if (old.running === count.running && old.needsYou === count.needsYou) continue;
            counts ??= new Map(snapshot.counts);
            if (count.running || count.needsYou) counts.set(key, count);
            else counts.delete(key);
        }
        let refreshAt: number | null = null;
        for (const entry of entries.values()) {
            const at = entry.contribution?.refreshAt;
            if (at !== undefined && at !== null) refreshAt = refreshAt === null ? at : Math.min(refreshAt, at);
        }
        if (counts || refreshAt !== snapshot.refreshAt) snapshot = { counts: counts ?? snapshot.counts, refreshAt };
        return snapshot;
    };
    const read = (nowMs: number) => {
        if (snapshot.refreshAt !== null && nowMs >= snapshot.refreshAt) {
            const changes: [string, Entry][] = [];
            for (const [key, entry] of entries) {
                const at = entry.contribution?.refreshAt;
                if (at !== undefined && at !== null && nowMs >= at) changes.push([key, { ...entry,
                    contribution: readMachineSessionContribution(entry.serverId, entry.row, nowMs) }]);
            }
            publish(changes);
        }
        return snapshot;
    };
    return { read, update(rows: Rows, delta: SessionListRenderableDelta | undefined, nowMs: number) {
        if (rows !== previousRows) {
            const changes: [string, Entry | null][] = [];
            const homes = Object.keys(rows);
            const oldRows = previousRows;
            const consecutive = oldRows && delta && previousRevision !== undefined && delta.revision === previousRevision + 1
                && homes.length === Object.keys(oldRows).length && homes.every(home => Object.hasOwn(oldRows, home));
            const ids = consecutive ? new Set([...delta.changedSessionIds, ...delta.removedSessionIds]) : null;
            if (!ids) for (const key of entries.keys()) changes.push([key, null]);
            for (const home of homes) {
                const serverId = resolveServerProfileScopeIdForIdentifier(home) || home;
                for (const id of ids ?? Object.keys(rows[home] ?? {})) {
                    const key = `${home}\0${id}`;
                    const old = entries.get(key);
                    const row = rows[home]?.[id];
                    if (ids && old?.row === row) continue;
                    changes.push([key, row ? { serverId, row, contribution: readMachineSessionContribution(serverId, row, nowMs) } : null]);
                }
            }
            publish(changes);
            previousRows = rows;
            previousRevision = delta?.revision;
        }
        return read(nowMs);
    } };
}

function notLoaded(member: BoardMember, availability: Exclude<BoardCardAvailability, 'ready'>): BoardCard {
    return {
        key: member.key,
        ref: member.ref,
        picked: member.picked,
        availability,
        // Only a still-arriving item is loading; a settled miss or an unavailable Home is named by its kind, and
        // the status and one reason line say why. No placeholder title repeats them.
        title: availability === 'not_loaded' ? t('common.loading') : t(`boards.kinds.${member.ref.kind}`),
        // Not work state: the item cannot be read here. It sits with Offline and never claims trouble.
        status: unavailableStatus(availability),
        body: { kind: 'none' },
    };
}

function unavailableStatus(availability: Exclude<BoardCardAvailability, 'ready'>): WorkStatusPresentation {
    return {
        state: availability,
        attentionType: null,
        bucket: availability === 'not_loaded' ? 'idle' : 'offline', tone: 'neutral',
        word: availability === 'not_loaded' ? t('common.loading') : t('boards.card.unavailable'),
    };
}

function missingEntity(member: BoardMember, facts: BoardCardFacts): BoardCard {
    const reason = facts.missingEntityReason?.(member.ref) ?? null;
    return reason === null ? notLoaded(member, 'not_loaded')
        : { ...notLoaded(member, 'content_unavailable'), unavailableReason: reason };
}

/** Card and chrome classification share this owner; title, trigger and body projections are
 * independent of the membership/status facts that the count needs. */
function readBoardWorkStatus(member: BoardMember, facts: BoardCardFacts): WorkStatusPresentation {
    if (!member.available || ((member.ref.kind === 'workflow_run' || member.ref.kind === 'workflow')
        && !facts.accountScopedHome(member.ref.qualifiedId.serverId))) return unavailableStatus('home_unavailable');
    switch (member.ref.kind) {
        case 'task': {
            const task = facts.task?.(member.ref);
            if (!task) return missingEntity(member, facts).status;
            const linkedStatuses = task.linkedSessions.map(link => {
                const ref = { kind: 'session' as const, qualifiedId: { serverId: link.serverId, id: link.sessionId } };
                return readBoardWorkStatus({ ...member, ref, key: buildWorkBoardItemKeyV1(ref) }, facts);
            });
            return resolveWorkStatusTone({ kind: 'task', facts: { category: task.category,
                word: task.categoryLabel, linkedStatuses } });
        }
        case 'session': {
            const row = facts.session(member.ref);
            return row ? resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(row, facts.nowMs) })
                : missingEntity(member, facts).status;
        }
        case 'workflow_run': {
            const row = facts.workflowRun(member.ref);
            return row?.summary ? resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(row.summary,
                readRunMachine(member.ref, row.summary, facts).context) })
                : missingEntity(member, facts).status;
        }
        case 'machine': {
            const machine = facts.machine(member.ref);
            if (!machine) return missingEntity(member, facts).status;
            const reachability = resolveMachineReachability(facts.machineScope?.(member.ref.qualifiedId.serverId), machine, facts.nowMs);
            const online = reachability === 'unknown' ? null : reachability === 'reachable';
            const counts = facts.machineSessionCounts.get(member.key) ?? NO_SESSIONS;
            return resolveWorkStatusTone({ kind: 'machine', facts: {
                // A Machine that needs the person says why ("1 needs you"); its presence word in the attention
                // tone would read as if being online were the problem.
                word: online === null ? t('common.unknown') : !online ? t('boards.card.machine.offline') : counts.needsYou > 0
                    ? t('boards.card.machine.needYou', { count: counts.needsYou }) : t('boards.card.machine.online'),
                online, needsYouCount: counts.needsYou, runningSessionCount: counts.running,
                machineId: machine.id, revokedAt: machine.revokedAt, managedMachine: facts.managedMachine?.(member.ref),
                nativeState: machine.managedInputRuntime?.state,
                workSummary: facts.machineWorkSummary?.(member.ref),
            } });
        }
        case 'workflow': {
            const workflow = facts.workflow(member.ref);
            if (!workflow) return missingEntity(member, facts).status;
            if (workflow.unavailableReason) return unavailableStatus('content_unavailable');
            if (workflow.summary === null) return unavailableStatus('not_loaded');
            const lastRun = workflow.summary.lastRun;
            const lastRunStatus = lastRun ? resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(lastRun) }) : null;
            return resolveWorkStatusTone({ kind: 'workflow', facts: {
                word: lastRunStatus?.word ?? t('boards.card.workflow.noRuns'),
                needsYouCount: workflow.summary.needsYouCount,
                lastRunStatus,
                hasActiveRun: lastRun !== null && resolveWorkStatusTone({ kind: 'workflow_run',
                    facts: { state: lastRun.state, workflowCustodyState: lastRun.workflowCustodyState, word: '' } }).bucket === 'working',
            } });
        }
    }
}

function buildCard(member: BoardMember, facts: BoardCardFacts): BoardCard {
    if (!member.available) return notLoaded(member, 'home_unavailable');
    const accountScoped = member.ref.kind === 'workflow_run' || member.ref.kind === 'workflow';
    if (accountScoped && !facts.accountScopedHome(member.ref.qualifiedId.serverId)) return notLoaded(member, 'home_unavailable');
    const base = { key: member.key, ref: member.ref, picked: member.picked, availability: 'ready' as const };
    const { serverId, id } = member.ref.qualifiedId;
    switch (member.ref.kind) {
        case 'task': {
            const task = facts.task?.(member.ref);
            return task ? { ...base, title: task.title, status: readBoardWorkStatus(member, facts), body: { kind: 'task', item: task } }
                : missingEntity(member, facts);
        }
        case 'session': {
            const row = facts.session(member.ref);
            if (!row) return missingEntity(member, facts);
            const sessionFacts = readSessionWorkStatusFacts(row, facts.nowMs);
            const readable = sessionFacts.awareness.encryption !== undefined
                && isSessionAwarenessContentReadableV1(sessionFacts.awareness.encryption);
            // An unreadable Session has no name to show: it is titled by its kind, like every other
            // settled unavailable card, and gives one reason (its own, else that it cannot be read).
            return {
                ...base,
                title: readable ? getSessionName(row, serverId) : t('boards.kinds.session'),
                status: resolveWorkStatusTone({ kind: 'session', facts: { ...sessionFacts,
                    word: readable ? sessionFacts.word : t('boards.card.unavailable') } }),
                body: { kind: 'session', serverId, sessionId: id,
                    ...(readable ? {} : { statusDetail: sessionFacts.awareness.encryption === 'unknown'
                        ? t('boards.card.readFailed') : sessionFacts.word }) },
            };
        }
        case 'workflow_run': {
            const row = facts.workflowRun(member.ref);
            if (!row?.summary) return missingEntity(member, facts);
            const lifecycle = describeWorkflowRunState(row.summary.state, {
                inAttentionWindow: row.summary.attentionRequired === true,
                workflowCustodyState: row.summary.workflowCustodyState,
                ...readRunMachine(member.ref, row.summary, facts).context,
            });
            return {
                ...base,
                title: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(row.metadata)),
                status: readBoardWorkStatus(member, facts),
                body: { kind: 'workflow_run', runId: id, state: row.summary.state, attentionLabel: lifecycle.attentionLabel, startedAt: row.summary.createdAt,
                    progress: row.summary.stepProgress ?? null },
            };
        }
        case 'machine': {
            const machine = facts.machine(member.ref);
            if (!machine) return missingEntity(member, facts);
            const reachability = resolveMachineReachability(facts.machineScope?.(serverId), machine, facts.nowMs);
            const online = reachability === 'unknown' ? null : reachability === 'reachable';
            const counts = facts.machineSessionCounts.get(member.key) ?? NO_SESSIONS;
            return {
                ...base,
                title: getMachineDisplayName(machine),
                status: readBoardWorkStatus(member, facts),
                body: { kind: 'machine', online, counts },
            };
        }
        case 'workflow': {
            const workflow = facts.workflow(member.ref);
            if (!workflow) return missingEntity(member, facts);
            if (workflow.unavailableReason) return {
                ...base,
                availability: 'content_unavailable',
                title: workflow.title,
                unavailableReason: workflow.unavailableReason,
                status: unavailableStatus('content_unavailable'),
                body: { kind: 'none' },
            };
            const lastRun = workflow.summary?.lastRun ?? null;
            const lastRunWord = lastRun ? readWorkflowRunWorkStatusFacts(lastRun).word : null;
            return {
                ...base,
                title: workflow.title,
                status: readBoardWorkStatus(member, facts),
                body: { kind: 'workflow', needsYouCount: workflow.summary?.needsYouCount ?? null,
                    runSummaryAvailable: workflow.summary !== null, lastRunWord, lastRunAt: lastRun?.createdAt ?? null,
                    triggerSummary: workflow.triggers ? formatTriggerSetSummary(workflow.triggers) : null,
                    nextRun: workflow.nextRun ?? (workflow.triggers && !workflow.triggers.some(trigger => trigger.kind === 'schedule')
                        ? { kind: 'unscheduled' } : { kind: 'unavailable' }) },
            };
        }
    }
}

export function buildBoardCards(members: readonly BoardMember[], facts: BoardCardFacts): BoardCard[] {
    return members.map((member) => buildCard(member, facts)).filter(hasKnownBoardCardStatus);
}

// A pending card has no status column yet. Keep its membership, but publish the card only
// after its owning reader answers; a settled unavailable item still belongs in Offline.
function hasKnownBoardCardStatus(card: BoardCard): boolean {
    return card.status.state !== 'not_loaded';
}

/** Reuse unchanged source inputs before constructing a projection. Session expiry comes from its
 * status owner; machine online transitions use its presence owner, so reuse cannot freeze freshness. */
function createBoardProjection<T>(project: (member: BoardMember, facts: BoardCardFacts) => T) {
    type Entry = { inputs: readonly unknown[]; refreshAt: number | null; value: T; workSummary: MachineWorkSummaryState | undefined };
    let entries = new Map<string, Entry>();
    let previousMembers: readonly BoardMember[] | null = null;
    let previousSessionInputs: BoardCardFacts['sessionInputs'];
    let previousContexts: BoardCardFacts['inputContexts'];
    return (members: readonly BoardMember[], facts: BoardCardFacts): readonly T[] => {
        const sessionInputs = facts.sessionInputs;
        const sameSessionContext = sessionInputs && previousSessionInputs?.context === sessionInputs.context;
        const unchangedSessions = sameSessionContext && previousSessionInputs?.source.token === sessionInputs.source.token;
        const changes = sessionInputs?.source.changes;
        const changedSessionKeys = sameSessionContext && changes && changes.previous === previousSessionInputs?.source.token
            ? new Set(changes.keys) : null;
        const next = new Map<string, Entry>();
        const values = members.map(member => {
            const prior = entries.get(member.key);
            const workSummary = member.ref.kind === 'machine' ? facts.machineWorkSummary?.(member.ref) : undefined;
            const stableInputs = member.ref.kind === 'session'
                ? unchangedSessions || changedSessionKeys !== null && !changedSessionKeys.has(member.key)
                : member.ref.kind !== 'task' && facts.inputContexts?.[member.ref.kind] !== undefined
                    && facts.inputContexts[member.ref.kind] === previousContexts?.[member.ref.kind];
            if (members === previousMembers && prior && stableInputs && workSummary === prior.workSummary && (prior.refreshAt === null || facts.nowMs < prior.refreshAt)) {
                next.set(member.key, prior);
                return prior.value;
            }
            let source: unknown = null;
            let refreshAt: number | null = null;
            let machineOnline: boolean | null = null;
            let runMachine: Machine | null = null;
            let runManagedMachine: ManagedMachineV1 | null | undefined;
            switch (member.ref.kind) {
                case 'task': {
                    const task = facts.task?.(member.ref);
                    source = task;
                    if (task) {
                        const linkedRows = task.linkedSessions.map(link => facts.session({ kind: 'session',
                            qualifiedId: { serverId: link.serverId, id: link.sessionId } }));
                        // Include linked rows in the projection inputs: unchanged tracker facts cannot freeze agent state.
                        for (const row of linkedRows) {
                            if (!row) continue;
                            const at = readSessionStatusNextRefreshAtMs(row, facts.nowMs);
                            if (at !== null) refreshAt = refreshAt === null ? at : Math.min(refreshAt, at);
                        }
                    }
                    break;
                }
                case 'session': {
                    const row = facts.session(member.ref);
                    source = row;
                    const prior = entries.get(member.key);
                    if (row && (!prior || prior.inputs[0] !== row || (prior.refreshAt !== null && facts.nowMs >= prior.refreshAt))) {
                        refreshAt = readSessionStatusNextRefreshAtMs(row, facts.nowMs);
                    } else refreshAt = prior?.refreshAt ?? null;
                    break;
                }
                case 'workflow_run': {
                    const row = facts.workflowRun(member.ref);
                    source = row;
                    if (row?.summary && facts.accountScopedHome(member.ref.qualifiedId.serverId)) {
                        const current = readRunMachine(member.ref, row.summary, facts);
                        runMachine = current.machine;
                        runManagedMachine = current.managedMachine;
                        machineOnline = current.context.machineReachable ?? null;
                    }
                    break;
                }
                case 'workflow': source = facts.workflow(member.ref); break;
                case 'machine': {
                    const machine = facts.machine(member.ref);
                    source = machine;
                    const reachability = machine ? resolveMachineReachability(facts.machineScope?.(member.ref.qualifiedId.serverId), machine, facts.nowMs) : 'unknown';
                    machineOnline = reachability === 'unknown' ? null : reachability === 'reachable';
                    break;
                }
            }
            const counts = member.ref.kind === 'machine' ? facts.machineSessionCounts.get(member.key) : undefined;
            const inputs = [source, member.available, member.picked, facts.accountScopedHome(member.ref.qualifiedId.serverId),
                machineOnline, runMachine, runManagedMachine, counts?.needsYou ?? 0, counts?.running ?? 0,
                member.ref.kind === 'machine' ? facts.managedMachine?.(member.ref) : undefined,
                facts.missingEntityReason?.(member.ref) ?? null, workSummary];
            if (member.ref.kind === 'task') {
                for (const link of facts.task?.(member.ref)?.linkedSessions ?? []) {
                    const ref = { kind: 'session' as const, qualifiedId: { serverId: link.serverId, id: link.sessionId } };
                    inputs.push(facts.session(ref), facts.missingEntityReason?.(ref) ?? null);
                }
            }
            const entry = prior && inputs.every((input, index) => input === prior.inputs[index])
                && (prior.refreshAt === null || facts.nowMs < prior.refreshAt)
                ? prior : { inputs, refreshAt, value: project(member, facts), workSummary };
            next.set(member.key, entry);
            return entry.value;
        });
        entries = next;
        previousMembers = members;
        previousSessionInputs = sessionInputs;
        previousContexts = facts.inputContexts;
        return values;
    };
}

export function createBoardCardProjection() {
    const project = createBoardProjection(buildCard);
    let previous: readonly BoardCard[] = [];
    return (members: readonly BoardMember[], facts: BoardCardFacts) => {
        previous = reconcileBoardCards(previous, project(members, facts).filter(hasKnownBoardCardStatus));
        return previous;
    };
}

export type BoardLiveSummary = Readonly<{ itemCount: number | null; needYou: number | null; undetermined: BoardUndeterminedMembership | null }>;

export function createBoardSummaryProjection() {
    const project = createBoardProjection(readBoardWorkStatus);
    let previous: BoardLiveSummary = { itemCount: 0, needYou: 0, undetermined: NO_UNDETERMINED_BOARD_MEMBERSHIP };
    const pending: BoardLiveSummary = Object.freeze({ itemCount: null, needYou: null, undetermined: null });
    return (members: readonly BoardMember[], facts: BoardCardFacts, widgetCount: number, settled = true,
        undetermined: BoardUndeterminedMembership = NO_UNDETERMINED_BOARD_MEMBERSHIP): BoardLiveSummary => {
        if (!settled) return pending;
        const statuses = project(members, facts);
        const needYou = statuses.some(status => status.state === 'not_loaded') ? null
            : statuses.reduce((count, status) => count + (isWorkStatusNeedsYou(status) ? 1 : 0), 0);
        const itemCount = members.length + widgetCount;
        const sameUndetermined = previous.undetermined?.count === undetermined.count
            && previous.undetermined.reasons.length === undetermined.reasons.length
            && previous.undetermined.reasons.every((reason, index) => {
                const next = undetermined.reasons[index];
                return next?.kind === reason.kind && next.reason === reason.reason && next.count === reason.count;
            });
        if (previous.itemCount !== itemCount || previous.needYou !== needYou || !sameUndetermined) previous = { itemCount, needYou, undetermined };
        return previous;
    };
}

function isSameCard(a: BoardCard, b: BoardCard): boolean {
    return a === b || a.key === b.key
        && a.picked === b.picked
        && a.availability === b.availability
        && a.unavailableReason === b.unavailableReason
        && a.title === b.title
        && a.status.bucket === b.status.bucket
        && a.status.tone === b.status.tone
        && a.status.word === b.status.word
        && a.status.state === b.status.state
        && a.status.attentionType === b.status.attentionType
        && a.status.glyph === b.status.glyph
        && JSON.stringify(a.body) === JSON.stringify(b.body);
}

/**
 * Reuses the previous card object for every card whose summary did not change, so a store update on
 * one item re-renders that card only.
 */
export function reconcileBoardCards(previous: readonly BoardCard[], next: readonly BoardCard[]): readonly BoardCard[] {
    const byKey = new Map(previous.map((card) => [card.key, card] as const));
    let changed = previous.length !== next.length;
    const reconciled = next.map((card, index) => {
        const prior = byKey.get(card.key);
        const kept = prior && isSameCard(prior, card) ? prior : card;
        if (kept !== previous[index]) changed = true;
        return kept;
    });
    return changed ? reconciled : previous;
}

/** How many cards need the person: the board header's count and a pinned board's count. */
export function countBoardCardsNeedingYou(cards: readonly BoardCard[]): number {
    return cards.reduce((count, card) => (isWorkStatusNeedsYou(card.status) ? count + 1 : count), 0);
}

/** A board's live line in the Boards column (lab `boards-B1`): "3 need you · 9 items", or just its items. */
/** Whether a board holds anything to show: a live source, hand-picked work, or a configured widget. */
export function hasWorkBoardContent(board: WorkBoardV1): boolean {
    return (board.source.sections?.length ?? 0) > 0 || board.source.filter !== undefined
        || board.source.picked.length > 0 || (board.widgets?.length ?? 0) > 0;
}

/** "3 need you · 9 items": a board's widgets are items too; only work cards can need you. */
export function describeBoardColumnLine(cards: readonly BoardCard[], widgetCount = 0): Readonly<{ needYou: number; text: string }> {
    const needYou = countBoardCardsNeedingYou(cards);
    return describeBoardSummaryLine({ needYou, itemCount: cards.length + widgetCount });
}

/** Unresolved candidates make a proven count a floor ("9+ items"), never a total. */
export function describeBoardItemCount(count: number, undetermined?: BoardUndeterminedMembership | null): string {
    if (!undetermined || undetermined.count === 0) return t('boards.meta.items', { count });
    // "0+ items" says nothing: with no proven match yet, say that.
    return count === 0 ? t('boards.empty.uncheckedTitle') : t('boards.meta.itemsAtLeast', { count });
}

export function describeBoardNeedYouCount(count: number, undetermined?: BoardUndeterminedMembership | null): string {
    return t(undetermined && undetermined.count > 0 ? 'boards.meta.needYouAtLeast' : 'boards.meta.needYou', { count });
}

export function describeBoardSummaryLine({ needYou, itemCount, undetermined }: Pick<BoardLiveSummary, 'needYou' | 'itemCount'> & Partial<Pick<BoardLiveSummary, 'undetermined'>>): Readonly<{ needYou: number; text: string }> {
    if (needYou === null || itemCount === null) return { needYou: 0, text: '' };
    const items = describeBoardItemCount(itemCount, undetermined);
    return { needYou, text: needYou > 0 ? `${describeBoardNeedYouCount(needYou, undetermined)} · ${items}` : items };
}

/**
 * An index row's line before its Board is read (owner 11-11): what the saved layout holds — its widgets, then the items
 * picked by hand — or, for a hand-picked Board with nothing on it, that it is empty. A Board a filter or a section fills
 * says nothing until it is read, and a header without a layout says nothing.
 */
export function describeBoardSummaryCounts(
    counts: Readonly<{ widgets: number; picked: number; filtered: boolean }> | null,
    sections: readonly string[],
): string | undefined {
    if (counts === null) return undefined;
    const parts = [
        counts.widgets > 0 ? t('boards.meta.widgets', { count: counts.widgets }) : null,
        counts.picked > 0 ? t('boards.meta.items', { count: counts.picked }) : null,
    ].filter((part): part is string => part !== null);
    if (parts.length > 0) return parts.join(' · ');
    return counts.filtered || sections.length > 0 ? undefined : `${t('boards.meta.handPicked')} · ${t('boards.meta.empty')}`;
}

/**
 * The one line a Board says when its answered filter could not classify some candidates: how many, then why.
 * The count and reasons are the membership owner's; this only words them.
 */
export function describeBoardUndetermined(undetermined: BoardUndeterminedMembership | null | undefined): Readonly<{ headline: string; reason: string }> | null {
    if (!undetermined || undetermined.count === 0) return null;
    const kinds = new Set(undetermined.reasons.map(reason => reason.kind));
    const headline = t(kinds.size === 1 && kinds.has('session') ? 'boards.undetermined.sessions'
        : kinds.size === 1 && kinds.has('workflow_run') ? 'boards.undetermined.runs' : 'boards.undetermined.items', { count: undetermined.count });
    const reasons = new Set(undetermined.reasons.map(reason => reason.reason));
    const reason = [...reasons].map(key => t(key === 'project_association_unavailable'
        ? 'boards.undetermined.projectAssociation' : 'boards.undetermined.filterFacts')).join(' ');
    return { headline, reason };
}
