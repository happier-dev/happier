import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import {
    storage,
    useAllSessions,
} from '@/sync/domains/state/storage';
import {
    deriveActivityAttentionFlags,
    resolveActivityAttentionSessions,
} from '@/activity/attention/activityAttentionSessions';
import { derivePendingRequestFlagsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { deriveSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { StorageState } from '@/sync/store/types';

import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';
import type {
    PetCompanionActivitySession,
    PetCompanionActivityModel,
    PetCompanionSessionSignals,
} from './petCompanionActivityTypes';

function selectCompanionSessionId(sessions: readonly PetCompanionActivitySession[]): string | null {
    return sessions.find((session) => session.active)?.id ?? sessions[0]?.id ?? null;
}

function hasMessageFailure(message: Message): boolean {
    if (message.kind !== 'tool-call') return false;
    if (message.tool.state === 'error') return true;
    return message.children.some(hasMessageFailure);
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

function isHydratedSession(session: PetCompanionActivitySession): session is Session {
    return 'agentState' in session;
}

function sortSessionsByUpdatedAtDescending<T extends Readonly<{ updatedAt: number }>>(values: Record<string, T>): T[] {
    return Object.values(values).sort((a, b) => b.updatedAt - a.updatedAt);
}

function usePetCompanionSessionListRenderables(): SessionListRenderableSession[] {
    return storage(
        useShallow((state) => sortSessionsByUpdatedAtDescending(state.sessionListRenderables ?? {})),
    );
}

function resolveRenderableLastMessageSubtitle(session: SessionListRenderableSession): string | null {
    return normalizeMessageSubtitleText(session.metadata?.summaryText);
}

function buildSessionSignalsBySessionId(
    state: StorageState,
    sessions: readonly PetCompanionActivitySession[],
    sessionListRenderables: readonly SessionListRenderableSession[],
): Record<string, PetCompanionSessionSignals> {
    const signalsBySessionId: Record<string, PetCompanionSessionSignals> = {};
    const sessionMessages = state.sessionMessages ?? {};
    const sessionPending = state.sessionPending ?? {};
    const renderableById = new Map(sessionListRenderables.map((session) => [session.id, session]));

    for (const session of sessions) {
        const transcript = sessionMessages[session.id];
        const pending = sessionPending[session.id];
        const renderable = renderableById.get(session.id);
        const messages = Object.values(transcript?.messagesById ?? {});
        const attentionFlags = deriveActivityAttentionFlags(session, {
            showPendingPermissionRequests: false,
            showPendingUserActionRequests: false,
            showQueuedUserInput: false,
        });
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
        const pendingRequestFlags = isHydratedSession(session)
            ? derivePendingRequestFlagsFromSession(session, messages)
            : {
                hasPendingPermissionRequests: deriveActivityAttentionFlags(session, {
                    showUnread: false,
                    showPendingUserActionRequests: false,
                    showQueuedUserInput: false,
                }).hasPendingPermissionRequests,
                hasPendingUserActionRequests: deriveActivityAttentionFlags(session, {
                    showUnread: false,
                    showPendingPermissionRequests: false,
                    showQueuedUserInput: false,
                }).hasPendingUserActionRequests,
            };

        signalsBySessionId[session.id] = {
            hasFailure: messages.some(hasMessageFailure),
            hasPendingPermissionRequests: pendingRequestFlags.hasPendingPermissionRequests,
            hasPendingUserActionRequests: pendingRequestFlags.hasPendingUserActionRequests,
            hasUnreadMessages: attentionFlags.hasUnread,
            latestThinkingActivityAtMs: transcript?.latestThinkingMessageActivityAtMs ?? null,
            latestMeaningfulActivityAtMs: deriveSessionListMeaningfulActivityAt({
                sessionCreatedAt: session.createdAt,
                latestCommittedMessageCreatedAt,
                latestThinkingActivityAt: transcript?.latestThinkingMessageActivityAtMs ?? null,
                latestPendingMessageCreatedAt,
            }),
            lastMessageSubtitle: resolveLatestCommittedMessageSubtitle(transcript)
                ?? (renderable ? resolveRenderableLastMessageSubtitle(renderable) : null)
                ?? (!isHydratedSession(session) ? resolveRenderableLastMessageSubtitle(session) : null),
            pendingMessageCount: pending?.messages?.length ?? 0,
        };
    }

    return signalsBySessionId;
}

export function usePetCompanionActivityModel(input?: Readonly<{
    dismissedTrayItemKeys?: ReadonlySet<string>;
}>): PetCompanionActivityModel {
    const sessions = useAllSessions();
    const sessionListRenderables = usePetCompanionSessionListRenderables();
    const state = storage();
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    const activitySessions = React.useMemo(
        () => resolveActivityAttentionSessions({
            sessions,
            sessionRows: sessionListRenderables,
        }),
        [sessions, sessionListRenderables],
    );
    const selectedSessionId = React.useMemo(() => selectCompanionSessionId(activitySessions), [activitySessions]);
    const dismissedTrayItemKeys = input?.dismissedTrayItemKeys;
    const signalsBySessionId = React.useMemo(
        () => buildSessionSignalsBySessionId(state, activitySessions, sessionListRenderables),
        [state, activitySessions, sessionListRenderables],
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
