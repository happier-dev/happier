import { readMessageDisplayText } from '@/sync/domains/messages/messageDisplayText';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    readSessionRollbackRangesV1FromMetadata,
    type SessionRollbackTarget,
    type TurnChangeSet,
} from '@happier-dev/protocol';
import {
    supportsAgentLifecycleCapability,
    type CurrentProjectedAgentCapabilities,
} from '@/agents/backendCatalog/currentAgentCapabilities';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type TranscriptRollbackAction = Readonly<{
    target: SessionRollbackTarget;
    restoredDraftText: string | null;
    /** Exact declaration rechecked by the execution boundary for external Agents. */
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
    checkpointCodeRollback?: Readonly<{
        conversationRollbackSupported: boolean;
        turnId: string;
        cwd: string;
        expectedStartRef: string;
        expectedFinalRef: string;
    }>;
}>;

export type SessionRollbackRangeV1 = Readonly<{
    startSeqInclusive: number;
    endSeqInclusive: number;
}>;

const EMPTY_SESSION_ROLLBACK_RANGES: readonly SessionRollbackRangeV1[] = Object.freeze([]);
const EMPTY_TRANSCRIPT_ROLLBACK_ACTIONS: Readonly<Record<string, TranscriptRollbackAction>> = Object.freeze({});

function readFiniteSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.trunc(value);
}

function listTrustedRuntimeTurnStartSeqs(session: Session | null | undefined): ReadonlySet<number> {
    const startSeqs = new Set<number>();
    for (const rawStartUserMessageSeq of session?.rollbackEligibleTurnStarts ?? []) {
        const startUserMessageSeq = readFiniteSeq(rawStartUserMessageSeq);
        if (startUserMessageSeq != null) startSeqs.add(startUserMessageSeq);
    }
    return startSeqs;
}

function hasConversationRollbackCapability(
    session: Session | null | undefined,
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null,
): boolean {
    if (!session || session.accessLevel === 'view') return false;
    const metadata = readSessionOwnerMetadataView(session);
    return supportsAgentLifecycleCapability({
        agentId: resolveAgentIdFromSessionMetadata(metadata),
        capability: 'sessionRollback.conversation',
        metadata,
        sessionActive: session.active === true,
        currentAgentCapabilities,
    });
}

export function resolveConversationRollbackSupport(params: Readonly<{
    session: Session | null | undefined;
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}>): Readonly<{
    supportsLatestTurnRollback: boolean;
    supportsRollbackToPoint: boolean;
}> {
    const session = params.session ?? null;
    if (!session || session.active !== true || session.accessLevel === 'view') {
        return {
            supportsLatestTurnRollback: false,
            supportsRollbackToPoint: false,
        };
    }
    const conversationSupported = hasConversationRollbackCapability(
        session,
        params.currentAgentCapabilities,
    );
    return {
        supportsLatestTurnRollback: conversationSupported,
        supportsRollbackToPoint: conversationSupported,
    };
}

export function canRollbackConversation(params: Readonly<{
    session: Session | null | undefined;
    target?: SessionRollbackTarget;
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}>): boolean {
    const target = params.target ?? { type: 'latest_turn' };
    if (target.type === 'before_user_message') {
        const userMessageSeq = readFiniteSeq(target.userMessageSeq);
        return userMessageSeq != null
            && hasConversationRollbackCapability(params.session, params.currentAgentCapabilities)
            && listTrustedRuntimeTurnStartSeqs(params.session).has(userMessageSeq);
    }
    const support = resolveConversationRollbackSupport(params);
    return support.supportsLatestTurnRollback;
}

export function readSessionRollbackRangesV1(metadata: Record<string, unknown> | null | undefined): readonly SessionRollbackRangeV1[] {
    const parsed = readSessionRollbackRangesV1FromMetadata(metadata);
    const raw = parsed?.ranges ?? [];
    if (raw.length === 0) return EMPTY_SESSION_ROLLBACK_RANGES;
    const ranges: SessionRollbackRangeV1[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const startSeqInclusive = readFiniteSeq((entry as { startSeqInclusive?: unknown }).startSeqInclusive);
        const endSeqInclusive = readFiniteSeq((entry as { endSeqInclusive?: unknown }).endSeqInclusive);
        if (startSeqInclusive == null || endSeqInclusive == null) continue;
        if (endSeqInclusive < startSeqInclusive) continue;
        ranges.push({ startSeqInclusive, endSeqInclusive });
    }
    return ranges.length > 0 ? ranges : EMPTY_SESSION_ROLLBACK_RANGES;
}

export function isMessageRolledBack(params: Readonly<{
    message: Message | null | undefined;
    rollbackRanges: readonly SessionRollbackRangeV1[];
}>): boolean {
    const seq = readFiniteSeq((params.message as { seq?: unknown } | null | undefined)?.seq);
    if (seq == null) return false;
    return params.rollbackRanges.some((range) => seq >= range.startSeqInclusive && seq <= range.endSeqInclusive);
}

export function resolveLatestActiveMessageId(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    rollbackRanges: readonly SessionRollbackRangeV1[];
}>): string | null {
    for (let index = params.messageIdsOldestFirst.length - 1; index >= 0; index -= 1) {
        const messageId = params.messageIdsOldestFirst[index];
        if (!messageId) continue;
        const message = params.messagesById[messageId];
        if (!message) continue;

        // Tool-call and agent-event rows do not host the transcript action strip.
        // Anchor rollback on the nearest adjacent user/agent message instead.
        if (message.kind === 'tool-call' || message.kind === 'agent-event') continue;

        if (!isMessageRolledBack({ message, rollbackRanges: params.rollbackRanges })) {
            return messageId;
        }
    }
    return null;
}

function readCheckpointRollbackCwd(params: Readonly<{
    sessionId: string;
    scopeId: string;
}>): string | null {
    const prefix = `${params.sessionId}:`;
    if (!params.scopeId.startsWith(prefix)) return null;
    const cwd = params.scopeId.slice(prefix.length).trim();
    return cwd.length > 0 ? cwd : null;
}

function findCheckpointRollbackEvidence(params: Readonly<{
    conversationRollbackSupported: boolean;
    messageSeq: number;
    sessionId: string;
    turnChangeSets: readonly TurnChangeSet[];
}>): TranscriptRollbackAction['checkpointCodeRollback'] | undefined {
    for (const turn of params.turnChangeSets) {
        if (turn.sessionId !== params.sessionId) continue;
        if (params.messageSeq < turn.seqRange.startSeqInclusive || params.messageSeq > turn.seqRange.endSeqInclusive) continue;
        const checkpoint = turn.repositoryCheckpoint;
        if (!checkpoint) continue;
        if (checkpoint.contentConfidence !== 'exact') continue;
        if (typeof checkpoint.startRef !== 'string' || checkpoint.startRef.trim().length === 0) continue;
        if (typeof checkpoint.finalRef !== 'string' || checkpoint.finalRef.trim().length === 0) continue;
        const cwd = readCheckpointRollbackCwd({ sessionId: params.sessionId, scopeId: checkpoint.scopeId });
        if (!cwd) continue;
        return {
            conversationRollbackSupported: params.conversationRollbackSupported,
            turnId: turn.turnId,
            cwd,
            expectedStartRef: checkpoint.startRef,
            expectedFinalRef: checkpoint.finalRef,
        };
    }
    return undefined;
}

function withCheckpointRollbackEvidence(
    action: TranscriptRollbackAction,
    evidence: TranscriptRollbackAction['checkpointCodeRollback'] | undefined,
): TranscriptRollbackAction {
    return evidence ? { ...action, checkpointCodeRollback: evidence } : action;
}

export function resolveTranscriptRollbackActions(params: Readonly<{
    session: Session | null | undefined;
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    rollbackRanges: readonly SessionRollbackRangeV1[];
    turnChangeSets?: readonly TurnChangeSet[];
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}>): Readonly<Record<string, TranscriptRollbackAction>> {
    const support = resolveConversationRollbackSupport({
        session: params.session,
        currentAgentCapabilities: params.currentAgentCapabilities,
    });
    const sessionId = params.session?.id ?? null;
    const turnChangeSets = params.turnChangeSets ?? [];
    const capabilitySupportsConversationRollback = hasConversationRollbackCapability(
        params.session,
        params.currentAgentCapabilities,
    );
    const conversationRollbackSupported = support.supportsRollbackToPoint
        || support.supportsLatestTurnRollback
        || capabilitySupportsConversationRollback;
    if (capabilitySupportsConversationRollback) {
        const actions: Record<string, TranscriptRollbackAction> = {};
        for (const messageId of params.messageIdsOldestFirst) {
            const message = params.messagesById[messageId];
            if (!message || message.kind !== 'user-text') continue;
            if (isMessageRolledBack({ message, rollbackRanges: params.rollbackRanges })) continue;
            const seq = readFiniteSeq(message.seq);
            if (seq == null) continue;
            const action = {
                target: { type: 'before_user_message', userMessageSeq: seq },
                restoredDraftText: readMessageDisplayText(message),
                ...(params.currentAgentCapabilities
                    ? { currentAgentCapabilities: params.currentAgentCapabilities }
                    : {}),
            } satisfies TranscriptRollbackAction;
            if (!canRollbackConversation({
                session: params.session,
                target: action.target,
                currentAgentCapabilities: params.currentAgentCapabilities,
            })) continue;
            actions[messageId] = withCheckpointRollbackEvidence(
                action,
                sessionId
                    ? findCheckpointRollbackEvidence({
                        conversationRollbackSupported,
                        messageSeq: seq,
                        sessionId,
                        turnChangeSets,
                    })
                    : undefined,
            );
        }
        return Object.keys(actions).length > 0 ? actions : EMPTY_TRANSCRIPT_ROLLBACK_ACTIONS;
    }

    const latestActiveMessageId = resolveLatestActiveMessageId({
        messageIdsOldestFirst: params.messageIdsOldestFirst,
        messagesById: params.messagesById,
        rollbackRanges: params.rollbackRanges,
    });
    if (!latestActiveMessageId) return EMPTY_TRANSCRIPT_ROLLBACK_ACTIONS;
    const latestActiveMessage = params.messagesById[latestActiveMessageId] ?? null;
    const latestActiveSeq = readFiniteSeq(latestActiveMessage?.seq);
    const checkpointCodeRollback = sessionId && latestActiveSeq != null
        ? findCheckpointRollbackEvidence({
            conversationRollbackSupported,
            messageSeq: latestActiveSeq,
            sessionId,
            turnChangeSets,
        })
        : undefined;
    if (!support.supportsLatestTurnRollback && !checkpointCodeRollback) return EMPTY_TRANSCRIPT_ROLLBACK_ACTIONS;
    return {
        [latestActiveMessageId]: withCheckpointRollbackEvidence({
            target: { type: 'latest_turn' },
            restoredDraftText: null,
            ...(params.currentAgentCapabilities
                ? { currentAgentCapabilities: params.currentAgentCapabilities }
                : {}),
        }, checkpointCodeRollback),
    };
}
