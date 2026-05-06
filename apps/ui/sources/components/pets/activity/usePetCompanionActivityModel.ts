import * as React from 'react';
import type {
    PrimaryTurnStatusV1,
    SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import {
    storage,
    useAllSessions,
} from '@/sync/domains/state/storage';
import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { derivePendingRequestFlagsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { deriveSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/deriveSessionListActivity';
import { deriveSessionAttentionState } from '@/sync/domains/session/attention/deriveSessionAttentionState';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { StorageState } from '@/sync/store/types';

import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';
import type {
    PetCompanionActivityModel,
    PetCompanionSessionSignals,
} from './petCompanionActivityTypes';

function selectCompanionSessionId(sessions: readonly Session[]): string | null {
    return sessions.find((session) => session.active)?.id ?? sessions[0]?.id ?? null;
}

function normalizeMessageSubtitleText(value: string | null | undefined): string | null {
    const text = value?.replace(/\s+/g, ' ').trim() ?? '';
    return text.length > 0 ? text : null;
}

function resolveMessageSubtitle(message: Message): string | null {
    switch (message.kind) {
        case 'agent-text':
            return normalizeMessageSubtitleText(message.text);
        case 'user-text':
            return normalizeMessageSubtitleText(message.displayText ?? message.text);
        case 'tool-call':
            return (
                normalizeMessageSubtitleText(message.tool.description)
                ?? normalizeMessageSubtitleText(message.tool.name)
            );
        case 'agent-event':
            return null;
    }
}

function resolveLatestCommittedMessageSubtitle(transcript: SessionMessages | undefined): string | null {
    const messageIdsOldestFirst = transcript?.messageIdsOldestFirst ?? [];
    for (let index = messageIdsOldestFirst.length - 1; index >= 0; index -= 1) {
        const messageId = messageIdsOldestFirst[index];
        if (!messageId) continue;
        const message = transcript?.messagesById?.[messageId] ?? transcript?.messagesMap?.[messageId];
        if (!message) continue;
        const subtitle = resolveMessageSubtitle(message);
        if (subtitle) return subtitle;
    }
    return null;
}

function buildSessionSignalsBySessionId(
    state: StorageState,
    sessions: readonly Session[],
): Record<string, PetCompanionSessionSignals> {
    const signalsBySessionId: Record<string, PetCompanionSessionSignals> = {};
    const sessionMessages = state.sessionMessages ?? {};
    const sessionPending = state.sessionPending ?? {};

    for (const session of sessions) {
        const transcript = sessionMessages[session.id];
        const pending = sessionPending[session.id];
        const messages = Object.values(transcript?.messagesById ?? {});
        const latestCommittedMessageId =
            transcript?.messageIdsOldestFirst?.length
                ? transcript.messageIdsOldestFirst[transcript.messageIdsOldestFirst.length - 1] ?? null
                : null;
        const latestCommittedMessageCreatedAt =
            latestCommittedMessageId != null
                ? transcript?.messagesById?.[latestCommittedMessageId]?.createdAt ?? null
                : null;

        let latestPendingMessageCreatedAt: number | null = null;
        for (const pendingMessage of pending?.messages ?? []) {
            const createdAt = pendingMessage?.createdAt;
            if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) continue;
            latestPendingMessageCreatedAt =
                latestPendingMessageCreatedAt == null ? createdAt : Math.max(latestPendingMessageCreatedAt, createdAt);
        }
        const pendingRequestFlags = derivePendingRequestFlagsFromSession(session, messages);

        const hasUnreadMessages = computeHasUnreadActivity({
            sessionSeq: session.seq ?? 0,
            pendingActivityAt: 0,
            lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
            lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
        });
        const hasWaitingActivity =
            pendingRequestFlags.hasPendingPermissionRequests
            || pendingRequestFlags.hasPendingUserActionRequests
            || (session.pendingCount ?? 0) > 0
            || (pending?.messages?.length ?? 0) > 0;
        const attentionState = deriveSessionAttentionState({
            latestTurnStatus: (session as { latestTurnStatus?: PrimaryTurnStatusV1 | null }).latestTurnStatus ?? null,
            lastRuntimeIssue: (session as { lastRuntimeIssue?: SessionRuntimeIssueV1 | null }).lastRuntimeIssue ?? null,
            hasWaitingActivity,
            isRunning: session.thinking === true,
            hasReviewActivity: hasUnreadMessages,
        });

        signalsBySessionId[session.id] = {
            hasFailure: attentionState === 'failed',
            hasPendingPermissionRequests: pendingRequestFlags.hasPendingPermissionRequests,
            hasPendingUserActionRequests: pendingRequestFlags.hasPendingUserActionRequests,
            hasUnreadMessages,
            latestThinkingActivityAtMs: transcript?.latestThinkingMessageActivityAtMs ?? null,
            latestMeaningfulActivityAtMs: deriveSessionListMeaningfulActivityAt({
                sessionCreatedAt: session.createdAt,
                latestCommittedMessageCreatedAt,
                latestThinkingActivityAt: transcript?.latestThinkingMessageActivityAtMs ?? null,
                latestPendingMessageCreatedAt,
            }),
            lastMessageSubtitle: resolveLatestCommittedMessageSubtitle(transcript),
            pendingMessageCount: pending?.messages?.length ?? 0,
        };
    }

    return signalsBySessionId;
}

export function usePetCompanionActivityModel(input?: Readonly<{
    dismissedTrayItemKeys?: ReadonlySet<string>;
}>): PetCompanionActivityModel {
    const sessions = useAllSessions();
    const state = storage();
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    const activitySessions = React.useMemo(
        () => sessions.filter(isUserFacingSession),
        [sessions],
    );
    const selectedSessionId = React.useMemo(() => selectCompanionSessionId(activitySessions), [activitySessions]);
    const dismissedTrayItemKeys = input?.dismissedTrayItemKeys;
    const signalsBySessionId = React.useMemo(
        () => buildSessionSignalsBySessionId(state, activitySessions),
        [activitySessions, state],
    );

    const model = React.useMemo(() => buildPetCompanionActivityModel({
        sessions: activitySessions,
        selectedSessionId,
        signalsBySessionId,
        dismissedTrayItemKeys,
        nowMs,
    }), [activitySessions, dismissedTrayItemKeys, nowMs, selectedSessionId, signalsBySessionId]);

    React.useEffect(() => {
        let nextExpiryAtMs: number | null = null;
        for (const item of model.trayItems) {
            if (typeof item.expiresAtMs !== 'number' || !Number.isFinite(item.expiresAtMs)) continue;
            if (item.expiresAtMs <= nowMs) continue;
            nextExpiryAtMs = nextExpiryAtMs === null ? item.expiresAtMs : Math.min(nextExpiryAtMs, item.expiresAtMs);
        }
        if (nextExpiryAtMs === null) return undefined;
        const delayMs = Math.max(1, nextExpiryAtMs - nowMs + 1);
        const timeout = setTimeout(() => {
            setNowMs(Date.now());
        }, delayMs);
        return () => clearTimeout(timeout);
    }, [model.trayItems, nowMs]);

    return model;
}
