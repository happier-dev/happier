import type { Message } from '@happier-dev/session-core/messages';
import { deriveWorkflowSessionInputLocalIdV2, readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { TranscriptTurn, TranscriptTurnContent } from './buildTranscriptTurns';
import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

export type WorkflowTranscriptTurnItem = {
    kind: 'turn';
    id: string;
    turn: TranscriptTurn;
    /** Original linear rows, retained verbatim when quiet evidence does not admit a fold. */
    linearItems?: readonly ChatListItem[];
    /** Present on the one folded row of a run that continued this session through its origin input (05 §5.2). */
    workflowRun?: WorkflowOriginRunFold;
};

export type WorkflowOriginRunFold = Readonly<{ runId: string; turnCount: number }>;

export function readWorkflowTurnProvenance(message: Message | null | undefined) {
    const provenance = message?.kind === 'user-text' ? readSessionMessageProvenance(message.meta, 'stored') : null;
    return provenance?.kind === 'workflow_invocation' ? provenance : null;
}

/** Use the canonical turn builder's membership in linear mode too, never regroup across fork boundaries. */
export function groupWorkflowTranscriptTurns(
    items: readonly ChatListItem[],
    turns: readonly TranscriptTurn[],
    getMessageById: (id: string) => Message | null,
): Array<ChatListItem | WorkflowTranscriptTurnItem> {
    const visibleMessageIds = new Set(items.flatMap((item) => item.kind === 'message' ? [item.messageId] : []));
    const byMessageId = new Map<string, TranscriptTurn>();
    for (const turn of turns) {
        if (!turn.userMessageId || !visibleMessageIds.has(turn.userMessageId) || !readWorkflowTurnProvenance(getMessageById(turn.userMessageId))) continue;
        byMessageId.set(turn.userMessageId, turn);
        for (const content of turn.content) {
            for (const id of content.kind === 'message' ? [content.messageId] : content.toolMessageIds) {
                byMessageId.set(id, turn);
            }
        }
    }
    const emitted = new Map<string, ChatListItem[]>();
    const output: Array<ChatListItem | WorkflowTranscriptTurnItem> = [];
    for (const item of items) {
        const turn = item.kind === 'message' ? byMessageId.get(item.messageId)
            : item.kind === 'tool-calls-group' ? byMessageId.get(item.toolMessageIds[0] ?? '') : undefined;
        if (!turn) { output.push(item); continue; }
        const linearItems = emitted.get(turn.id);
        if (linearItems) { linearItems.push(item); continue; }
        const span = [item];
        emitted.set(turn.id, span);
        output.push({ kind: 'turn', id: turn.id, turn, linearItems: span });
    }
    return output;
}

/**
 * Which loaded messages a workflow wrote into this session through its origin input (U8, ORC O1).
 *
 * The context-only `workflow_step` input has no user message: the host commits one step-input event
 * (its local id is derived from the exact invocation) and stamps `workflowInvocation` on the turn it
 * begins. A prompt-delivered workflow turn (a user message carrying `workflow_invocation`
 * provenance, read by `readWorkflowTurnProvenance`) keeps its own per-turn presentation and is not
 * claimed here. This is the transcript's one provenance reader for both.
 */
export type WorkflowOriginRunMembership = Readonly<{
    byMessageId: ReadonlyMap<string, Readonly<{ runId: string; role: 'input' | 'turn' }>>;
    turnCountByRunId: ReadonlyMap<string, number>;
    /** Runs that fired from a turn end here but wrote no turn: their fold follows this message (U9). */
    zeroTurnRunIdsAfterMessageId: ReadonlyMap<string, readonly string[]>;
}>;

/** The turn end of this Session that fired a trigger Run; a Run of another Session never qualifies. */
function readFiringTurnId(run: WorkflowRunSummaryV1, sessionId: string): string | null {
    const cause = run.origin.kind === 'automation' ? run.origin.cause : undefined;
    if (cause?.kind !== 'trigger' || cause.triggerKind !== 'sessionLifecycle') return null;
    const evidence = cause.evidence;
    return 'sourceTurnId' in evidence && evidence.sourceSessionId === sessionId ? evidence.sourceTurnId : null;
}

function deriveStepInputLocalId(invocation: Readonly<{ runId: string; invocationRecordId: string }>): string | null {
    try {
        return deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', ...invocation });
    } catch {
        return null;
    }
}

export function readWorkflowOriginRunMembership(params: Readonly<{
    sessionId: string;
    sessionTurns: readonly SessionTurnV1[] | null | undefined;
    messageIdsOldestFirst: readonly string[];
    getMessageById: (id: string) => Message | null;
    /** A fork's ancestor rows count seq in another session; only this session's rows are matched. */
    isOwnMessage?: (id: string) => boolean;
    /** This Session's origin Runs, read by the one Account Run row owner; only turn-end firings are placed. */
    triggerRuns?: readonly WorkflowRunSummaryV1[];
}>): WorkflowOriginRunMembership | null {
    const turns = params.sessionTurns;
    if (!turns) return null;
    const firings = (params.triggerRuns ?? []).flatMap((run) => {
        const turnId = readFiringTurnId(run, params.sessionId);
        return turnId === null ? [] : [{ runId: run.id, turnId, createdAt: run.createdAt }];
    });
    if (!turns.some((turn) => turn.workflowInvocation) && firings.length === 0) return null;
    const starts = turns.flatMap((turn) => turn.transcriptAnchors?.startSeqInclusive ?? []).sort((left, right) => left - right);
    const ranges: Array<Readonly<{ runId: string; from: number; to: number }>> = [];
    const inputs = new Map<string, string>();
    const invocationsByRun = new Map<string, Set<string>>();
    for (const turn of turns) {
        const invocation = turn.workflowInvocation;
        if (!invocation) continue;
        const localId = deriveStepInputLocalId(invocation);
        if (localId) inputs.set(localId, invocation.runId);
        const from = turn.transcriptAnchors?.startSeqInclusive;
        if (from === undefined) continue;
        const next = starts.find((start) => start > from);
        const to = turn.transcriptAnchors?.endSeqInclusive ?? (next === undefined ? Number.POSITIVE_INFINITY : next - 1);
        ranges.push({ runId: invocation.runId, from, to });
        const ids = invocationsByRun.get(invocation.runId) ?? new Set<string>();
        ids.add(invocation.invocationRecordId);
        invocationsByRun.set(invocation.runId, ids);
    }
    const candidates = new Map<string, Readonly<{ runId: string; role: 'input' | 'turn' }>>();
    const promptDelivered = new Set<Readonly<{ runId: string; from: number; to: number }>>();
    for (const id of params.messageIdsOldestFirst) {
        if (params.isOwnMessage && !params.isOwnMessage(id)) continue;
        const message = params.getMessageById(id);
        if (!message) continue;
        const inputRunId = message.localId ? inputs.get(message.localId) : undefined;
        if (inputRunId && message.kind === 'agent-event') {
            candidates.set(id, { runId: inputRunId, role: 'input' });
            continue;
        }
        const seq = message.seq;
        if (seq === undefined) continue;
        const range = ranges.find((candidate) => seq >= candidate.from && seq <= candidate.to);
        if (!range) continue;
        // A turn that a user message began is a prompt-delivered (or person) turn, never origin input.
        if (message.kind === 'user-text') promptDelivered.add(range);
        candidates.set(id, { runId: range.runId, role: 'turn' });
    }
    const byMessageId = new Map<string, Readonly<{ runId: string; role: 'input' | 'turn' }>>();
    for (const [id, member] of candidates) {
        const seq = params.getMessageById(id)?.seq;
        if (member.role === 'turn' && seq !== undefined
            && [...promptDelivered].some((range) => seq >= range.from && seq <= range.to)) continue;
        byMessageId.set(id, member);
    }
    const turnCountByRunId = new Map<string, number>();
    for (const [runId, ids] of invocationsByRun) turnCountByRunId.set(runId, ids.size);
    // A firing whose Run wrote no turn of its own is placed after the last message of the turn end that fired it.
    const zeroTurnRunIdsAfterMessageId = new Map<string, string[]>();
    for (const firing of [...firings].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
        if (invocationsByRun.has(firing.runId)) continue;
        const fired = turns.find((turn) => turn.turnId === firing.turnId);
        const from = fired?.transcriptAnchors?.startSeqInclusive;
        if (from === undefined) continue;
        const next = starts.find((start) => start > from);
        const to = fired?.transcriptAnchors?.endSeqInclusive ?? (next === undefined ? Number.POSITIVE_INFINITY : next - 1);
        let anchor: string | undefined;
        for (let index = params.messageIdsOldestFirst.length - 1; index >= 0 && anchor === undefined; index -= 1) {
            const id = params.messageIdsOldestFirst[index]!;
            const seq = params.getMessageById(id)?.seq;
            if (seq !== undefined && seq >= from && seq <= to && (!params.isOwnMessage || params.isOwnMessage(id))) anchor = id;
        }
        if (anchor === undefined) continue;
        turnCountByRunId.set(firing.runId, 0);
        zeroTurnRunIdsAfterMessageId.set(anchor, [...(zeroTurnRunIdsAfterMessageId.get(anchor) ?? []), firing.runId]);
    }
    if (byMessageId.size === 0 && zeroTurnRunIdsAfterMessageId.size === 0) return null;
    return { byMessageId, turnCountByRunId, zeroTurnRunIdsAfterMessageId };
}

type FoldableItem = Readonly<{ kind: string; id: string }>;
type RunFoldDraft = { item: WorkflowTranscriptTurnItem; content: TranscriptTurnContent[]; linear: ChatListItem[] };

function memberOfContent(content: TranscriptTurnContent, membership: WorkflowOriginRunMembership) {
    return membership.byMessageId.get(content.kind === 'message' ? content.messageId : content.toolMessageIds[0] ?? '');
}

function zeroTurnRunIdsAfter(ids: readonly string[], membership: WorkflowOriginRunMembership): readonly string[] {
    return ids.flatMap((id) => membership.zeroTurnRunIdsAfterMessageId.get(id) ?? []);
}

function contentMessageIds(content: TranscriptTurnContent): readonly string[] {
    return content.kind === 'message' ? [content.messageId] : content.toolMessageIds;
}

function linearItemMessageIds(item: FoldableItem): readonly string[] {
    const linear = item as ChatListItem;
    return linear.kind === 'message' ? [linear.messageId] : linear.kind === 'tool-calls-group' ? linear.toolMessageIds : [];
}

function memberOfLinearItem(item: FoldableItem, membership: WorkflowOriginRunMembership) {
    const linear = item as ChatListItem;
    if (linear.kind === 'message') return membership.byMessageId.get(linear.messageId);
    if (linear.kind === 'tool-calls-group') return membership.byMessageId.get(linear.toolMessageIds[0] ?? '');
    return undefined;
}

/**
 * One folded row per run, at the point it began; consecutive runs stay separate (05 §5.2).
 * Works on either layout: canonical turns (whose builder files origin-input rows under the previous
 * person turn, since they carry no user message) or linear rows. Items without members are kept by
 * identity. The step-input event is the run's own marker and is never shown as transcript text.
 */
export function foldWorkflowOriginRuns<T extends FoldableItem>(
    items: readonly T[],
    membership: WorkflowOriginRunMembership | null,
): Array<T | WorkflowTranscriptTurnItem> {
    if (!membership) return [...items];
    const output: Array<T | WorkflowTranscriptTurnItem> = [];
    const drafts = new Map<string, RunFoldDraft>();
    const draftFor = (runId: string): RunFoldDraft => {
        const known = drafts.get(runId);
        if (known) return known;
        const id = `workflow-run:${runId}`;
        const item: WorkflowTranscriptTurnItem = { kind: 'turn', id, turn: { id, userMessageId: null, content: [] },
            workflowRun: { runId, turnCount: membership.turnCountByRunId.get(runId) ?? 1 } };
        const draft: RunFoldDraft = { item, content: [], linear: [] };
        drafts.set(runId, draft);
        output.push(item);
        return draft;
    };
    for (const item of items) {
        const turnItem = item.kind === 'turn' ? item as unknown as WorkflowTranscriptTurnItem : null;
        if (turnItem && !turnItem.workflowRun && !turnItem.linearItems) {
            const turn = turnItem.turn;
            if (!turn.content.some((content) => memberOfContent(content, membership)
                || zeroTurnRunIdsAfter(contentMessageIds(content), membership).length > 0)) { output.push(item); continue; }
            let segment: TranscriptTurnContent[] = [];
            let headEmitted = false;
            let after = 0;
            const flush = () => {
                if (!headEmitted) {
                    headEmitted = true;
                    if (turn.userMessageId !== null || segment.length > 0) {
                        output.push({ ...turnItem, turn: { id: turn.id, userMessageId: turn.userMessageId, content: segment } });
                    }
                } else if (segment.length > 0) {
                    after += 1;
                    const id = `${turn.id}:after:${after}`;
                    output.push({ ...turnItem, id, turn: { id, userMessageId: null, content: segment } });
                }
                segment = [];
            };
            for (const content of turn.content) {
                const member = memberOfContent(content, membership);
                if (!member) {
                    segment.push(content);
                    const zeroTurnRunIds = zeroTurnRunIdsAfter(contentMessageIds(content), membership);
                    if (zeroTurnRunIds.length > 0) {
                        flush();
                        for (const runId of zeroTurnRunIds) draftFor(runId);
                    }
                    continue;
                }
                flush();
                const draft = draftFor(member.runId);
                if (member.role === 'turn') draft.content.push(content);
            }
            flush();
            continue;
        }
        const member = turnItem ? undefined : memberOfLinearItem(item, membership);
        if (!member) {
            output.push(item);
            if (!turnItem) for (const runId of zeroTurnRunIdsAfter(linearItemMessageIds(item), membership)) draftFor(runId);
            continue;
        }
        const draft = draftFor(member.runId);
        if (member.role === 'turn') draft.linear.push(item as unknown as ChatListItem);
    }
    for (const draft of drafts.values()) {
        const index = output.indexOf(draft.item);
        const id = draft.item.id;
        const content = draft.linear.length > 0 ? draft.linear.map(linearToContent) : draft.content;
        output[index] = { ...draft.item, turn: { id, userMessageId: null, content },
            ...(draft.linear.length > 0 ? { linearItems: draft.linear } : {}) };
    }
    return output;
}

function linearToContent(item: ChatListItem): TranscriptTurnContent {
    return item.kind === 'tool-calls-group'
        ? { kind: 'tool_calls', id: item.id, toolMessageIds: item.toolMessageIds }
        : { kind: 'message', messageId: item.kind === 'message' ? item.messageId : item.id };
}
