import { buildWorkBoardItemKeyV1, type BoardItemRefV1, type WorkflowRunStateV1, type WorkflowRunSummaryV1, type WorkflowTriggerSummaryInputV1, type WorkBoardV1 } from '@happier-dev/protocol';

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
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import type { BoardMember } from './boardMembership';
import { formatTriggerSetSummary } from '@/components/workflows/triggers/formatTriggerSummary';

/**
 * One card anatomy for every kind (INT §5.1): identity, the state word, "Kind · context", then a
 * kind body. Each kind's facts come from its own owner and its status from `resolveWorkStatusTone`,
 * so a card says what the Inbox, the map and the Work tab say about the same item. Cards hold
 * summaries only: no transcript, no full run.
 */

export type BoardCardAvailability = 'ready' | 'not_loaded' | 'home_unavailable' | 'content_unavailable';

export type MachineSessionCounts = Readonly<{ running: number; needsYou: number }>;

export type BoardCardBody =
    | Readonly<{ kind: 'session'; serverId: string; sessionId: string }>
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
        status: {
            bucket: availability === 'home_unavailable' ? 'offline' : 'idle',
            tone: 'neutral',
            word: availability === 'home_unavailable' ? t('boards.card.unavailable') : t('boards.card.notLoaded'),
        },
        body: { kind: 'none' },
    };
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
            return {
                ...base,
                title: getSessionName(row, serverId),
                status: resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(row, facts.nowMs) }),
                body: { kind: 'session', serverId, sessionId: id },
            };
        }
        case 'workflow_run': {
            const row = facts.workflowRun(member.ref);
            if (!row?.summary) return notLoaded(member, 'not_loaded');
            const waitingForYou = row.summary.attentionRequired === true;
            return {
                ...base,
                title: formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(row.metadata)),
                status: resolveWorkStatusTone({
                    kind: 'workflow_run',
                    facts: {
                        state: row.summary.state,
                        word: describeWorkflowRunState(row.summary.state).label,
                        inAttentionWindow: waitingForYou,
                    },
                }),
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
                status: resolveWorkStatusTone({
                    kind: 'machine',
                    facts: {
                        word: online ? t('boards.card.machine.online') : t('boards.card.machine.offline'),
                        online,
                        needsYouCount: counts.needsYou,
                        runningSessionCount: counts.running,
                    },
                }),
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
            const needsYouCount = workflow.summary?.needsYouCount ?? 0;
            const lastRun = workflow.summary?.lastRun ?? null;
            const lastRunWord = lastRun ? describeWorkflowRunState(lastRun.state).label : null;
            return {
                ...base,
                title: workflow.title,
                status: resolveWorkStatusTone({
                    kind: 'workflow',
                    facts: {
                        word: lastRunWord ?? (workflow.summary === null ? t('boards.card.notLoaded') : t('boards.card.workflow.noRuns')),
                        needsYouCount,
                        hasActiveRun: lastRun !== null && resolveWorkStatusTone({
                            kind: 'workflow_run',
                            facts: { state: lastRun.state, word: lastRunWord ?? '' },
                        }).bucket === 'working',
                    },
                }),
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
    const items = t('boards.meta.items', { count: cards.length + widgetCount });
    return { needYou, text: needYou > 0 ? `${t('boards.meta.needYou', { count: needYou })} · ${items}` : items };
}
