import { buildWorkBoardItemKeyV1, type BoardItemRefV1, type WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import type { WorkflowRunStateV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowTriggerSummaryInputV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import {
    resolveWorkStatusTone,
    type WorkStatusPresentation,
} from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
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
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { getSessionName, readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';

import type { BoardMember } from './boardMembership';
import { formatTriggerSetSummary } from '@/components/workflows/triggers/formatTriggerSummary';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';

/**
 * One card anatomy for every kind (INT §5.1): identity, the state word, "Kind · context", then a
 * kind body. Each kind's facts come from its own owner and its status from `resolveWorkStatusTone`,
 * so a card says what the Inbox, the map and the Work tab say about the same item. Cards hold
 * summaries only: no transcript, no full run.
 */

export type BoardCardAvailability = 'ready' | 'not_loaded' | 'home_unavailable' | 'content_unavailable';

export type MachineSessionCounts = Readonly<{ running: number; needsYou: number }>;

export type BoardCardBody =
    | Readonly<{ kind: 'session'; serverId: string; sessionId: string; statusDetail?: string }>
    | Readonly<{ kind: 'workflow_run'; runId: string; waitingForYou: boolean; startedAt: string | null;
        progress: WorkflowRunSummaryV1['stepProgress'] }>
    | Readonly<{ kind: 'workflow'; needsYouCount: number | null; lastRunWord: string | null; lastRunAt: string | null;
        runSummaryAvailable: boolean; triggerSummary: string | null; nextRun: BoardWorkflowNextRun }>
    | Readonly<{ kind: 'machine'; online: boolean; counts: MachineSessionCounts }>
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
        lastRun: Readonly<{ state: WorkflowRunStateV1; createdAt: string }> | null;
    }> | null;
}>;

/** Lookups into the existing owners; `null` means the item is not (yet) loaded on this device. */
export type BoardCardFacts = Readonly<{
    nowMs: number;
    session: (ref: BoardItemRefV1) => SessionListRenderableSession | null;
    workflowRun: (ref: BoardItemRefV1) => WorkflowRunRow | null;
    machine: (ref: BoardItemRefV1) => Machine | null;
    managedMachine?: (ref: BoardItemRefV1) => ManagedMachineV1 | null;
    /** Counts from the already-loaded Session rows, by the machine's qualified item key (no extra read). */
    machineSessionCounts: ReadonlyMap<string, MachineSessionCounts>;
    workflow: (ref: BoardItemRefV1) => BoardWorkflowFacts | null;
    /**
     * Whether a Home's workflows and runs are the ones the Account-scoped stores hold (the focused Home).
     * Another Home's workflow or run is unavailable here, never read as the focused Home's same-id item.
     */
    accountScopedHome: (serverId: string) => boolean;
}>;

const NO_SESSIONS: MachineSessionCounts = Object.freeze({ running: 0, needsYou: 0 });

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
            if (typeof row.archivedAt === 'number') continue;
            const machineId = typeof row.metadata?.machineId === 'string' ? row.metadata.machineId.trim() : '';
            if (!machineId) continue;
            const { bucket } = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(row, nowMs) });
            if (bucket !== 'needs_you' && bucket !== 'working') continue;
            const key = buildWorkBoardItemKeyV1({ kind: 'machine', qualifiedId: { serverId, id: machineId } });
            const entry = counts.get(key) ?? { running: 0, needsYou: 0 };
            if (bucket === 'needs_you') entry.needsYou += 1;
            else entry.running += 1;
            counts.set(key, entry);
        }
    }
    return counts;
}

function notLoaded(member: BoardMember, availability: Exclude<BoardCardAvailability, 'ready'>): BoardCard {
    return {
        key: member.key,
        ref: member.ref,
        picked: member.picked,
        availability,
        title: t('boards.card.untitled'),
        // Not work state: the item cannot be read here. It sits with Offline and never claims trouble.
        status: unavailableStatus(availability),
        body: { kind: 'none' },
    };
}

function unavailableStatus(availability: Exclude<BoardCardAvailability, 'ready'>): WorkStatusPresentation {
    return {
        bucket: availability === 'home_unavailable' ? 'offline' : 'idle', tone: 'neutral',
        word: availability === 'home_unavailable' ? t('boards.card.unavailable') : t('boards.card.notLoaded'),
    };
}

/** Card and chrome classification share this owner; title, trigger and body projections are
 * independent of the membership/status facts that the count needs. */
function readBoardWorkStatus(member: BoardMember, facts: BoardCardFacts): WorkStatusPresentation {
    if (!member.available || ((member.ref.kind === 'workflow_run' || member.ref.kind === 'workflow')
        && !facts.accountScopedHome(member.ref.qualifiedId.serverId))) return unavailableStatus('home_unavailable');
    switch (member.ref.kind) {
        case 'session': {
            const row = facts.session(member.ref);
            return row ? resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(row, facts.nowMs) })
                : unavailableStatus('not_loaded');
        }
        case 'workflow_run': {
            const row = facts.workflowRun(member.ref);
            return row?.summary ? resolveWorkStatusTone({ kind: 'workflow_run', facts: {
                state: row.summary.state, word: describeWorkflowRunState(row.summary.state).label,
                inAttentionWindow: row.summary.attentionRequired === true,
            } }) : unavailableStatus('not_loaded');
        }
        case 'machine': {
            const machine = facts.machine(member.ref);
            if (!machine) return unavailableStatus('not_loaded');
            const online = isMachineOnline(machine, facts.nowMs);
            const counts = facts.machineSessionCounts.get(member.key) ?? NO_SESSIONS;
            return resolveWorkStatusTone({ kind: 'machine', facts: {
                word: online ? t('boards.card.machine.online') : t('boards.card.machine.offline'),
                online, needsYouCount: counts.needsYou, runningSessionCount: counts.running,
                machineId: machine.id, revokedAt: machine.revokedAt, managedMachine: facts.managedMachine?.(member.ref),
            } });
        }
        case 'workflow': {
            const workflow = facts.workflow(member.ref);
            if (!workflow) return unavailableStatus('not_loaded');
            if (workflow.unavailableReason) return { bucket: 'idle', tone: 'neutral', word: t('boards.card.unavailable') };
            const lastRun = workflow.summary?.lastRun ?? null;
            const lastRunWord = lastRun ? describeWorkflowRunState(lastRun.state).label : null;
            return resolveWorkStatusTone({ kind: 'workflow', facts: {
                word: lastRunWord ?? (workflow.summary === null ? t('boards.card.notLoaded') : t('boards.card.workflow.noRuns')),
                needsYouCount: workflow.summary?.needsYouCount ?? 0,
                hasActiveRun: lastRun !== null && resolveWorkStatusTone({ kind: 'workflow_run',
                    facts: { state: lastRun.state, word: lastRunWord ?? '' } }).bucket === 'working',
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
        case 'session': {
            const row = facts.session(member.ref);
            if (!row) return notLoaded(member, 'not_loaded');
            const sessionFacts = readSessionWorkStatusFacts(row, facts.nowMs);
            const readable = sessionFacts.awareness.encryption !== undefined
                && isSessionAwarenessContentReadableV1(sessionFacts.awareness.encryption);
            return {
                ...base,
                title: getSessionName(row, serverId),
                status: resolveWorkStatusTone({ kind: 'session', facts: { ...sessionFacts,
                    word: readable ? sessionFacts.word : t('boards.card.unavailable') } }),
                body: { kind: 'session', serverId, sessionId: id,
                    ...(!readable && sessionFacts.awareness.encryption !== 'unknown' ? { statusDetail: sessionFacts.word } : {}) },
            };
        }
        case 'workflow_run': {
            const row = facts.workflowRun(member.ref);
            if (!row?.summary) return notLoaded(member, 'not_loaded');
            const waitingForYou = row.summary.attentionRequired === true;
            return {
                ...base,
                title: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(row.metadata)),
                status: readBoardWorkStatus(member, facts),
                body: { kind: 'workflow_run', runId: id, waitingForYou, startedAt: row.summary.createdAt,
                    progress: row.summary.stepProgress ?? null },
            };
        }
        case 'machine': {
            const machine = facts.machine(member.ref);
            if (!machine) return notLoaded(member, 'not_loaded');
            const online = isMachineOnline(machine, facts.nowMs);
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
            if (!workflow) return notLoaded(member, 'not_loaded');
            if (workflow.unavailableReason) return {
                ...base,
                availability: 'content_unavailable',
                title: workflow.title,
                unavailableReason: workflow.unavailableReason,
                status: { bucket: 'idle', tone: 'neutral', word: t('boards.card.unavailable') },
                body: { kind: 'none' },
            };
            const lastRun = workflow.summary?.lastRun ?? null;
            const lastRunWord = lastRun ? describeWorkflowRunState(lastRun.state).label : null;
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
    return members.map((member) => buildCard(member, facts));
}

/** Reuse unchanged source inputs before constructing a projection. Session expiry comes from its
 * status owner; machine online transitions use its presence owner, so reuse cannot freeze freshness. */
function createBoardProjection<T>(project: (member: BoardMember, facts: BoardCardFacts) => T) {
    type Entry = { inputs: readonly unknown[]; refreshAt: number | null; value: T };
    let entries = new Map<string, Entry>();
    return (members: readonly BoardMember[], facts: BoardCardFacts): readonly T[] => {
        const next = new Map<string, Entry>();
        const values = members.map(member => {
            let source: unknown = null;
            let refreshAt: number | null = null;
            let machineOnline: boolean | null = null;
            switch (member.ref.kind) {
                case 'session': {
                    const row = facts.session(member.ref);
                    source = row;
                    const prior = entries.get(member.key);
                    if (row && (!prior || prior.inputs[0] !== row || (prior.refreshAt !== null && facts.nowMs >= prior.refreshAt))) {
                        refreshAt = readSessionStatusNextRefreshAtMs(row, facts.nowMs);
                    } else refreshAt = prior?.refreshAt ?? null;
                    break;
                }
                case 'workflow_run': source = facts.workflowRun(member.ref); break;
                case 'workflow': source = facts.workflow(member.ref); break;
                case 'machine': {
                    const machine = facts.machine(member.ref);
                    source = machine;
                    machineOnline = machine ? isMachineOnline(machine, facts.nowMs) : null;
                    break;
                }
            }
            const counts = member.ref.kind === 'machine' ? facts.machineSessionCounts.get(member.key) : undefined;
            const inputs = [source, member.available, member.picked, facts.accountScopedHome(member.ref.qualifiedId.serverId),
                machineOnline, counts?.needsYou ?? 0, counts?.running ?? 0,
                member.ref.kind === 'machine' ? facts.managedMachine?.(member.ref) : undefined];
            const prior = entries.get(member.key);
            const entry = prior && inputs.every((input, index) => input === prior.inputs[index])
                && (prior.refreshAt === null || facts.nowMs < prior.refreshAt)
                ? prior : { inputs, refreshAt, value: project(member, facts) };
            next.set(member.key, entry);
            return entry.value;
        });
        entries = next;
        return values;
    };
}

export function createBoardCardProjection() {
    const project = createBoardProjection(buildCard);
    let previous: readonly BoardCard[] = [];
    return (members: readonly BoardMember[], facts: BoardCardFacts) => {
        previous = reconcileBoardCards(previous, project(members, facts));
        return previous;
    };
}

export type BoardLiveSummary = Readonly<{ itemCount: number; needYou: number }>;

export function createBoardSummaryProjection() {
    const project = createBoardProjection(readBoardWorkStatus);
    let previous: BoardLiveSummary = { itemCount: 0, needYou: 0 };
    return (members: readonly BoardMember[], facts: BoardCardFacts, widgetCount: number): BoardLiveSummary => {
        const statuses = project(members, facts);
        const needYou = statuses.reduce((count, status) => count + (status.bucket === 'needs_you' ? 1 : 0), 0);
        const itemCount = members.length + widgetCount;
        if (previous.itemCount !== itemCount || previous.needYou !== needYou) previous = { itemCount, needYou };
        return previous;
    };
}

function isSameCard(a: BoardCard, b: BoardCard): boolean {
    return a.key === b.key
        && a.picked === b.picked
        && a.availability === b.availability
        && a.unavailableReason === b.unavailableReason
        && a.title === b.title
        && a.status.bucket === b.status.bucket
        && a.status.tone === b.status.tone
        && a.status.word === b.status.word
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
    return cards.reduce((count, card) => (card.status.bucket === 'needs_you' ? count + 1 : count), 0);
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

export function describeBoardSummaryLine({ needYou, itemCount }: BoardLiveSummary): Readonly<{ needYou: number; text: string }> {
    const items = t('boards.meta.items', { count: itemCount });
    return { needYou, text: needYou > 0 ? `${t('boards.meta.needYou', { count: needYou })} · ${items}` : items };
}
