import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import { sessionTagKey } from './sessionTagUtils';

const EMPTY_SEARCH_TEXT_BY_SESSION_KEY: Readonly<Record<string, string>> = Object.freeze({});

type SessionSearchKey = Readonly<{
    serverId: string;
    sessionId: string;
    key: string;
}>;

type SearchableSessionMetadata = Readonly<{
    name?: string | null;
    summaryText?: string | null;
    path?: string | null;
    host?: string | null;
    machineId?: string | null;
}>;

function appendText(parts: string[], value: string | null | undefined): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length > 0) parts.push(trimmed);
}

function appendSessionMetadataText(parts: string[], metadata: SearchableSessionMetadata | null | undefined): void {
    appendText(parts, metadata?.name);
    appendText(parts, metadata?.summaryText);
    appendText(parts, metadata?.path);
    appendText(parts, metadata?.host);
    appendText(parts, metadata?.machineId);
}

function appendRenderableText(parts: string[], renderable: SessionListRenderableSession | null | undefined): void {
    appendSessionMetadataText(parts, renderable?.metadata ?? null);
}

function readMessageText(message: Message): string | null {
    if (message.kind === 'user-text') return message.displayText ?? message.text;
    if (message.kind === 'agent-text') return message.text;
    if (message.kind === 'tool-call') return message.tool.description ?? null;
    return null;
}

function collectSessionKeys(items: ReadonlyArray<SessionListIndexItem>): ReadonlyArray<SessionSearchKey> {
    const keys: SessionSearchKey[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (item.type !== 'session') continue;
        const serverId = String(item.serverId ?? '').trim();
        const sessionId = String(item.sessionId ?? '').trim();
        if (!serverId || !sessionId) continue;
        const key = sessionTagKey(serverId, sessionId);
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push({ serverId, sessionId, key });
    }
    return keys;
}

function buildSearchTextBySessionKey(
    state: StorageState,
    sessionKeys: ReadonlyArray<SessionSearchKey>,
): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of sessionKeys) {
        const parts: string[] = [];
        appendText(parts, entry.sessionId);
        appendRenderableText(
            parts,
            readSessionListRowForServerId(state.sessionListRowStateByServerId, entry.serverId, entry.sessionId)
                ?? state.sessionListRenderables?.[entry.sessionId]
                ?? null,
        );
        const session = state.sessions?.[entry.sessionId] ?? null;
        appendSessionMetadataText(parts, session ? readSessionOwnerMetadataView(session) : null);

        for (const message of readStoredSessionMessages(state, entry.sessionId)) {
            appendText(parts, readMessageText(message));
        }

        const pending = state.sessionPending?.[entry.sessionId];
        for (const pendingMessage of (pending?.messages ?? []) as PendingMessage[]) {
            appendText(parts, pendingMessage.displayText ?? pendingMessage.text);
        }
        for (const discardedMessage of (pending?.discarded ?? []) as PendingMessage[]) {
            appendText(parts, discardedMessage.displayText ?? discardedMessage.text);
        }

        if (parts.length > 0) {
            out[entry.key] = parts.join('\n');
        }
    }

    return Object.keys(out).length > 0 ? out : EMPTY_SEARCH_TEXT_BY_SESSION_KEY;
}

export function createSessionListSearchTextSelector(
    items: ReadonlyArray<SessionListIndexItem>,
    enabled: boolean,
): (state: StorageState) => Readonly<Record<string, string>> {
    const sessionKeys = collectSessionKeys(items);
    let previousDeltaRevision: number | null = null;
    let previousResult: Readonly<Record<string, string>> | null = null;

    return (state) => {
        if (!enabled || sessionKeys.length === 0) return EMPTY_SEARCH_TEXT_BY_SESSION_KEY;
        const renderableDelta = state.sessionListRenderableDelta;
        if (
            previousResult
            && renderableDelta
            && previousDeltaRevision !== null
            && renderableDelta.revision !== previousDeltaRevision
            && renderableDelta.rebuiltSessionListIndex !== true
            && renderableDelta.changedSessionIds.length === 0
            && renderableDelta.removedSessionIds.length === 0
        ) {
            previousDeltaRevision = renderableDelta.revision;
            return previousResult;
        }

        previousResult = buildSearchTextBySessionKey(state, sessionKeys);
        previousDeltaRevision = renderableDelta?.revision ?? null;
        return previousResult;
    };
}

export function useSessionListSearchTextByKey(
    items: ReadonlyArray<SessionListIndexItem>,
    enabled: boolean,
): Readonly<Record<string, string>> {
    const selector = React.useMemo(() => createSessionListSearchTextSelector(items, enabled), [enabled, items]);
    return getStorage()(useShallow(selector));
}
