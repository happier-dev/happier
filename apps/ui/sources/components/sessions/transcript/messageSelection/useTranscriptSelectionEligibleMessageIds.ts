import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { parseSessionMediaMessageMeta } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { compareTranscriptMessagesOldestFirst } from '@/sync/domains/messages/transcriptOrdering';
import { storage, useSetting } from '@/sync/domains/state/storage';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { isAgentTextMessageActivelyStreamingForSelection, resolveSelectableMessageText } from './resolveSelectableMessageText';
import {
    normalizeTranscriptSelectionThinkingVisibility,
    shouldExcludeMessageFromTranscriptSelection,
} from './transcriptSelectionMessageVisibility';

const EMPTY_ELIGIBLE_MESSAGE_IDS: readonly string[] = Object.freeze([]);
const ELIGIBLE_IDS_CACHE_MAX = 100;

const eligibleIdsBySessionCache = new Map<string, Readonly<{
    signature: string;
    ids: readonly string[];
}>>();

function readDiscardedMessageLocalIds(metadata: Metadata | null | undefined): readonly string[] {
    const localIds = metadata?.discardedCommittedMessageLocalIds;
    if (!Array.isArray(localIds) || localIds.length === 0) return EMPTY_ELIGIBLE_MESSAGE_IDS;
    return localIds
        .map((localId) => (typeof localId === 'string' ? localId.trim() : ''))
        .filter((localId) => localId.length > 0)
        .sort();
}

function buildDiscardedMessageLocalIdsSignature(metadata: Metadata | null | undefined): string {
    return readDiscardedMessageLocalIds(metadata).join('\0');
}

function listMessagesByFallbackOrder(messagesById: Record<string, Message | undefined>): Message[] {
    return Object.values(messagesById)
        .filter((message): message is Message => message != null)
        .sort(compareTranscriptMessagesOldestFirst);
}

function resolveMessageEligibility(message: Message, discarded: boolean, hiddenThinking: boolean): Readonly<{
    token: string;
    eligible: boolean;
}> {
    let token = `${message.id}:unsupported`;
    let eligible = false;

    if (message.kind === 'user-text' || message.kind === 'agent-text') {
        if (discarded) {
            token = `${message.id}:${message.kind}:discarded`;
        } else if (hiddenThinking && shouldExcludeMessageFromTranscriptSelection(message, { sessionThinkingDisplayMode: 'hidden' })) {
            token = `${message.id}:${message.kind}:thinking-hidden`;
        } else if (isAgentTextMessageActivelyStreamingForSelection(message)) {
            // Active assistant segments change text very frequently. Their selection eligibility cannot
            // change until the segment leaves the streaming state, so keep this token independent of text.
            token = `${message.id}:${message.kind}:streaming`;
        } else {
            const parsedSessionMediaMeta = message.kind === 'user-text'
                ? parseSessionMediaMessageMeta(message.meta)
                : null;
            const hasLegacyAttachments = parsedSessionMediaMeta != null
                && 'legacyAttachments' in parsedSessionMediaMeta
                && parsedSessionMediaMeta.legacyAttachments != null;
            const selectable = resolveSelectableMessageText({
                message,
                isStructuredOnly: false,
                hasAttachmentBlockToStrip: message.kind === 'user-text' && hasLegacyAttachments,
            });
            eligible = selectable != null;
            token = `${message.id}:${message.kind}:${eligible ? 'eligible' : 'empty'}`;
        }
    }

    return { token, eligible };
}

function readCachedEligibleIds(cacheKey: string): readonly string[] | null {
    const cached = eligibleIdsBySessionCache.get(cacheKey);
    if (!cached) return null;
    eligibleIdsBySessionCache.delete(cacheKey);
    eligibleIdsBySessionCache.set(cacheKey, cached);
    return cached.ids;
}

function rememberEligibleIds(cacheKey: string, signature: string, ids: readonly string[]): readonly string[] {
    const cached = eligibleIdsBySessionCache.get(cacheKey);
    if (cached?.signature === signature) {
        eligibleIdsBySessionCache.delete(cacheKey);
        eligibleIdsBySessionCache.set(cacheKey, cached);
        return cached.ids;
    }

    const nextIds = ids.length === 0 ? EMPTY_ELIGIBLE_MESSAGE_IDS : ids;
    eligibleIdsBySessionCache.delete(cacheKey);
    eligibleIdsBySessionCache.set(cacheKey, { signature, ids: nextIds });
    while (eligibleIdsBySessionCache.size > ELIGIBLE_IDS_CACHE_MAX) {
        const oldestKey = eligibleIdsBySessionCache.keys().next().value;
        if (typeof oldestKey !== 'string') break;
        eligibleIdsBySessionCache.delete(oldestKey);
    }
    return nextIds;
}

export function useTranscriptSelectionEligibleMessageIds(
    sessionId: string,
    options?: Readonly<{
        enabled?: boolean;
        metadata?: Metadata | null;
    }>,
): readonly string[] {
    const enabled = options?.enabled !== false;
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const thinkingVisibilitySignature = normalizeTranscriptSelectionThinkingVisibility(sessionThinkingDisplayMode);
    const hiddenThinking = thinkingVisibilitySignature === 'hidden';
    const discardedLocalIdsSignature = React.useMemo(
        () => buildDiscardedMessageLocalIdsSignature(options?.metadata ?? null),
        [options?.metadata],
    );

    return storage(useShallow((state) => {
        if (!enabled) return EMPTY_ELIGIBLE_MESSAGE_IDS;

        const sessionMessages = state.sessionMessages[sessionId];
        const messageIds = sessionMessages?.messageIdsOldestFirst;
        const messagesById = sessionMessages?.messagesById ?? {};
        const fallbackMessages = Array.isArray(messageIds) && messageIds.length > 0
            ? null
            : listMessagesByFallbackOrder(messagesById);
        const cacheKey = `${sessionId}\0${discardedLocalIdsSignature}\0thinking:${thinkingVisibilitySignature}`;
        if ((!Array.isArray(messageIds) || messageIds.length === 0) && (!fallbackMessages || fallbackMessages.length === 0)) {
            if (sessionMessages?.isLoaded === false) {
                const cachedIds = readCachedEligibleIds(cacheKey);
                if (cachedIds) return cachedIds;
            }
            return rememberEligibleIds(cacheKey, 'empty', EMPTY_ELIGIBLE_MESSAGE_IDS);
        }

        const discardedLocalIds = discardedLocalIdsSignature.length > 0
            ? new Set(discardedLocalIdsSignature.split('\0'))
            : null;
        const signatureParts: string[] = [];
        const eligibleIds: string[] = [];

        const appendMessageEligibility = (messageId: string, message: Message | undefined) => {
            if (!message) {
                signatureParts.push(`${messageId}:missing`);
                return;
            }

            const discarded = message.kind === 'user-text'
                && typeof message.localId === 'string'
                && discardedLocalIds !== null
                && discardedLocalIds.has(message.localId);
            const eligibility = resolveMessageEligibility(message, discarded, hiddenThinking);
            signatureParts.push(eligibility.token);
            if (eligibility.eligible) eligibleIds.push(message.id);
        };

        if (fallbackMessages) {
            for (const message of fallbackMessages) {
                appendMessageEligibility(message.id, message);
            }
        } else if (Array.isArray(messageIds)) {
            for (const messageId of messageIds) {
                appendMessageEligibility(messageId, messagesById[messageId]);
            }
        }

        return rememberEligibleIds(
            cacheKey,
            signatureParts.join('|'),
            eligibleIds,
        );
    }));
}
