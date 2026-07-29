import {
    resolveSessionMessagePinRowIdentityKey,
    sessionMessagePinRowsMatch,
} from '@/sync/domains/messages/pins/sessionMessagePinIdentity';

import { normalizeTranscriptNavigationTextPreview } from './transcriptNavigationTextPreview';
import type {
    DeriveTranscriptNavigationEntriesParams,
    TranscriptNavigationEntry,
    TranscriptNavigationFallbackLabelKind,
    TranscriptNavigationEntryKind,
    TranscriptNavigationLoadedMessage,
    TranscriptNavigationPin,
    TranscriptNavigationRole,
} from './transcriptNavigationTypes';

export type NavigationEntryWithOrder = Readonly<{
    entry: TranscriptNavigationEntry;
    blockOrder: number;
    pinOrder: number;
}>;

export type UserTurnDraft = Readonly<{
    sessionId: string;
    seq: number;
    routeMessageId: string | null;
    promptPreview: string;
    responsePreview: string | null;
    createdAtMs: number | null;
    loaded: boolean;
    /** Ordering surrogate only (role-ranked when the row has no block index). Never entry identity. */
    blockOrder: number;
    /** Real row block index; null when the loaded row carries none. Used for entry identity. */
    transcriptBlockIndex: number | null;
}>;

function normalizeSessionId(value: string): string {
    return value.trim();
}

function normalizeFiniteInteger(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.trunc(value);
}

function normalizeTextPreview(value: string | null | undefined): string | null {
    return normalizeTranscriptNavigationTextPreview(value);
}

function normalizeRole(role: TranscriptNavigationRole): TranscriptNavigationRole {
    if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role;
    return 'unknown';
}

function roleRank(role: TranscriptNavigationRole): number {
    if (role === 'user') return 0;
    if (role === 'assistant') return 1;
    if (role === 'tool') return 2;
    if (role === 'system') return 3;
    return 4;
}

function normalizeBlockIndex(value: number | null | undefined, role: TranscriptNavigationRole): number {
    const normalized = normalizeFiniteInteger(value);
    if (normalized !== null) return normalized;
    return roleRank(role);
}

function compareLoadedMessage(a: TranscriptNavigationLoadedMessage, b: TranscriptNavigationLoadedMessage): number {
    const aSeq = normalizeFiniteInteger(a.seq);
    const bSeq = normalizeFiniteInteger(b.seq);
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
    if (aSeq !== null && bSeq === null) return -1;
    if (aSeq === null && bSeq !== null) return 1;
    const aCreated = normalizeFiniteInteger(a.createdAtMs);
    const bCreated = normalizeFiniteInteger(b.createdAtMs);
    if (aCreated !== null && bCreated !== null && aCreated !== bCreated) return aCreated - bCreated;
    const blockDelta = normalizeBlockIndex(a.transcriptBlockIndex, a.role) - normalizeBlockIndex(b.transcriptBlockIndex, b.role);
    if (blockDelta !== 0) return blockDelta;
    return a.messageId.localeCompare(b.messageId);
}

function compareEntries(a: NavigationEntryWithOrder, b: NavigationEntryWithOrder): number {
    const aSeq = a.entry.seq;
    const bSeq = b.entry.seq;
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
    if (aSeq !== null && bSeq === null) return -1;
    if (aSeq === null && bSeq !== null) return 1;

    const blockDelta = a.blockOrder - b.blockOrder;
    if (blockDelta !== 0) return blockDelta;

    const aCreated = a.entry.createdAtMs;
    const bCreated = b.entry.createdAtMs;
    if (aCreated !== null && bCreated !== null && aCreated !== bCreated) return aCreated - bCreated;
    if (aCreated !== null && bCreated === null) return -1;
    if (aCreated === null && bCreated !== null) return 1;

    const pinDelta = a.pinOrder - b.pinOrder;
    if (pinDelta !== 0) return pinDelta;

    return a.entry.id.localeCompare(b.entry.id);
}

function userTurnId(sessionId: string, seq: number): string {
    return `${sessionId}:user-turn:${seq}`;
}

function pinRowIdentityKey(pin: TranscriptNavigationPin): string | null {
    return resolveSessionMessagePinRowIdentityKey({
        sessionId: pin.sessionId,
        seq: pin.seq,
        transcriptBlockIndex: pin.transcriptBlockIndex,
        routeMessageId: pin.routeMessageId,
        role: pin.role,
    });
}

function pinnedEntryId(sessionId: string, pin: TranscriptNavigationPin): string {
    return `${sessionId}:pinned:${pinRowIdentityKey(pin) ?? `${pin.role}:${pin.seq}:${pin.transcriptBlockIndex ?? 'none'}`}`;
}

function pinnedKindForRole(role: TranscriptNavigationRole): TranscriptNavigationEntryKind {
    if (role === 'user') return 'pinned-user';
    if (role === 'assistant') return 'pinned-assistant';
    if (role === 'tool') return 'pinned-tool';
    return 'deep-link-target';
}

function isSamePinTarget(message: TranscriptNavigationLoadedMessage, pin: TranscriptNavigationPin): boolean {
    return sessionMessagePinRowsMatch({
        sessionId: message.sessionId,
        seq: message.seq,
        transcriptBlockIndex: message.transcriptBlockIndex,
        routeMessageId: message.routeMessageId,
        role: message.role,
    }, {
        sessionId: pin.sessionId,
        seq: pin.seq,
        transcriptBlockIndex: pin.transcriptBlockIndex,
        routeMessageId: pin.routeMessageId,
        role: pin.role,
    });
}

function findLoadedMessageForPin(
    loadedMessages: readonly TranscriptNavigationLoadedMessage[],
    pin: TranscriptNavigationPin,
): TranscriptNavigationLoadedMessage | null {
    return loadedMessages.find((message) => isSamePinTarget(message, pin)) ?? null;
}

function buildUniquePins(sessionId: string, pins: readonly TranscriptNavigationPin[]): TranscriptNavigationPin[] {
    const seen = new Set<string>();
    const out: TranscriptNavigationPin[] = [];
    for (const pin of pins) {
        if (normalizeSessionId(pin.sessionId) !== sessionId) continue;
        const seq = normalizeFiniteInteger(pin.seq);
        const pinnedAtMs = normalizeFiniteInteger(pin.pinnedAtMs);
        if (seq === null || pinnedAtMs === null) continue;
        const key = pinRowIdentityKey(pin);
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            ...pin,
            seq,
            pinnedAtMs,
            role: normalizeRole(pin.role),
        });
    }
    return out;
}

function normalizeLoadedMessage(message: TranscriptNavigationLoadedMessage): TranscriptNavigationLoadedMessage {
    if (message.preNormalized === true) return message;

    return {
        ...message,
        seq: normalizeFiniteInteger(message.seq),
        transcriptBlockIndex: normalizeFiniteInteger(message.transcriptBlockIndex),
        role: normalizeRole(message.role),
        createdAtMs: normalizeFiniteInteger(message.createdAtMs),
        routeMessageId: normalizeTextPreview(message.routeMessageId),
        text: normalizeTextPreview(message.text),
    };
}

function findPinForUserSeq(pins: readonly TranscriptNavigationPin[], seq: number): TranscriptNavigationPin | null {
    return pins.find((pin) => pin.role === 'user' && normalizeFiniteInteger(pin.seq) === seq) ?? null;
}

function deriveLoadedUserTurns(
    sessionId: string,
    loadedMessages: readonly TranscriptNavigationLoadedMessage[],
): Map<number, UserTurnDraft> {
    const turnsBySeq = new Map<number, UserTurnDraft>();
    let activeUser: TranscriptNavigationLoadedMessage | null = null;
    let activeAgentPreview: string | null = null;
    let activeToolPreview: string | null = null;

    const commitActiveUser = () => {
        if (!activeUser) return;
        const seq = normalizeFiniteInteger(activeUser.seq);
        const promptPreview = activeUser.text;
        if (seq === null || !promptPreview) {
            activeUser = null;
            activeAgentPreview = null;
            activeToolPreview = null;
            return;
        }

        turnsBySeq.set(seq, {
            sessionId,
            seq,
            routeMessageId: activeUser.routeMessageId,
            promptPreview,
            // Agent text is the subtitle whenever the turn produced any; a tool-only turn falls
            // back to what the agent did. Thinking rows never reach here: their builders emit no text.
            responsePreview: activeAgentPreview ?? activeToolPreview,
            createdAtMs: normalizeFiniteInteger(activeUser.createdAtMs),
            loaded: activeUser.loaded !== false,
            blockOrder: normalizeBlockIndex(activeUser.transcriptBlockIndex, 'user'),
            transcriptBlockIndex: normalizeFiniteInteger(activeUser.transcriptBlockIndex),
        });
        activeUser = null;
        activeAgentPreview = null;
        activeToolPreview = null;
    };

    for (const message of loadedMessages) {
        if (message.role === 'user') {
            commitActiveUser();
            activeUser = message;
            activeAgentPreview = null;
            activeToolPreview = null;
            continue;
        }
        if (!activeUser) continue;
        if (message.role !== 'assistant' && message.role !== 'tool') continue;
        // Seqs are per-message (the assistant reply never shares the user
        // turn's seq), so turn membership is positional: reply rows after
        // this user message and before the next one belong to this turn. Only
        // reject rows whose seq is out of order relative to the active turn.
        const replySeq = normalizeFiniteInteger(message.seq);
        const activeUserSeq = normalizeFiniteInteger(activeUser.seq);
        if (replySeq !== null && activeUserSeq !== null && replySeq < activeUserSeq) continue;
        const preview = message.text;
        if (!preview) continue;
        if (message.role === 'assistant') {
            activeAgentPreview = preview;
        } else {
            activeToolPreview = preview;
        }
    }
    commitActiveUser();

    return turnsBySeq;
}

/**
 * Merge remote history rows into the loaded window on row identity (route id, else seq).
 *
 * A loaded window can hold non-contiguous seq ranges after a target-window jump, so a global
 * `[minSeq, maxSeq]` filter would silently swallow every turn inside an unloaded gap. Identity
 * merging keeps those turns as unloaded anchors while still letting the loaded row win whenever
 * both sides describe the same message.
 */
function mergeRemoteNavigationMessages(
    sessionId: string,
    loadedMessages: readonly TranscriptNavigationLoadedMessage[],
    remoteMessages: readonly TranscriptNavigationLoadedMessage[],
): TranscriptNavigationLoadedMessage[] {
    const claimedIdentities = new Set<string>();
    for (const message of loadedMessages) {
        const routeMessageId = typeof message.routeMessageId === 'string' ? message.routeMessageId.trim() : '';
        if (routeMessageId) claimedIdentities.add(`route:${routeMessageId}`);
        const seq = normalizeFiniteInteger(message.seq);
        if (seq !== null) claimedIdentities.add(`seq:${seq}`);
    }

    const merged = [...loadedMessages];
    for (const remoteMessage of remoteMessages) {
        if (normalizeSessionId(remoteMessage.sessionId) !== sessionId) continue;
        const seq = normalizeFiniteInteger(remoteMessage.seq);
        if (seq === null) continue;
        const routeMessageId = typeof remoteMessage.routeMessageId === 'string' ? remoteMessage.routeMessageId.trim() : '';
        if (routeMessageId && claimedIdentities.has(`route:${routeMessageId}`)) continue;
        if (claimedIdentities.has(`seq:${seq}`)) continue;
        if (routeMessageId) claimedIdentities.add(`route:${routeMessageId}`);
        claimedIdentities.add(`seq:${seq}`);
        merged.push({ ...remoteMessage, loaded: false });
    }
    return merged;
}

function findNearestUserTurn(turns: readonly UserTurnDraft[], seq: number): UserTurnDraft | null {
    let nearest: UserTurnDraft | null = null;
    for (const turn of turns) {
        if (turn.seq > seq) break;
        nearest = turn;
    }
    return nearest;
}

export function buildUserEntry(turn: UserTurnDraft, mode: 'all' | 'pinned', pin: TranscriptNavigationPin | null): NavigationEntryWithOrder | null {
    if (mode === 'pinned' && !pin) return null;
    const pinned = pin !== null;
    const pinnedAtMs = pin ? normalizeFiniteInteger(pin.pinnedAtMs) : null;
    const kind: TranscriptNavigationEntryKind = mode === 'pinned' && pinned ? 'pinned-user' : 'user-turn';
    return {
        blockOrder: turn.blockOrder,
        pinOrder: pinnedAtMs ?? Number.MAX_SAFE_INTEGER,
        entry: {
            id: mode === 'pinned' && pinned ? pinnedEntryId(turn.sessionId, pin) : userTurnId(turn.sessionId, turn.seq),
            sessionId: turn.sessionId,
            seq: turn.seq,
            routeMessageId: pin?.routeMessageId ?? turn.routeMessageId,
            transcriptBlockIndex: normalizeFiniteInteger(pin?.transcriptBlockIndex) ?? turn.transcriptBlockIndex,
            kind,
            role: 'user',
            label: normalizeTextPreview(pin?.label) ?? turn.promptPreview,
            promptPreview: turn.promptPreview,
            responsePreview: turn.responsePreview,
            createdAtMs: turn.createdAtMs,
            pinned,
            pinnedAtMs,
            loaded: turn.loaded,
        },
    };
}

function fallbackLabelKindForPinnedRole(role: TranscriptNavigationRole): TranscriptNavigationFallbackLabelKind {
    if (role === 'assistant') return 'pinned-assistant';
    if (role === 'tool') return 'pinned-tool';
    return 'pinned-message';
}

function buildPinnedEntry(params: Readonly<{
    sessionId: string;
    pin: TranscriptNavigationPin;
    loadedMessage: TranscriptNavigationLoadedMessage | null;
    nearestUserTurn: UserTurnDraft | null;
    pinOrder: number;
}>): NavigationEntryWithOrder | null {
    const role = normalizeRole(params.pin.role);
    const seq = normalizeFiniteInteger(params.pin.seq);
    if (seq === null) return null;

    const loadedPreview = params.loadedMessage?.text ?? null;
    const label = normalizeTextPreview(params.pin.label) ?? loadedPreview ?? params.nearestUserTurn?.promptPreview ?? '';
    const fallbackLabelKind = label ? null : fallbackLabelKindForPinnedRole(role);
    const isUser = role === 'user';
    const promptPreview = isUser
        ? loadedPreview ?? params.nearestUserTurn?.promptPreview ?? null
        : params.nearestUserTurn?.promptPreview ?? null;
    const responsePreview = isUser
        ? params.nearestUserTurn?.responsePreview ?? null
        : loadedPreview;
    const identityBlockIndex = normalizeFiniteInteger(
        params.pin.transcriptBlockIndex ?? params.loadedMessage?.transcriptBlockIndex ?? null,
    );
    const blockOrder = normalizeBlockIndex(identityBlockIndex, role);

    return {
        blockOrder,
        pinOrder: params.pinOrder,
        entry: {
            id: pinnedEntryId(params.sessionId, params.pin),
            sessionId: params.sessionId,
            seq,
            routeMessageId: normalizeTextPreview(params.pin.routeMessageId) ?? params.loadedMessage?.routeMessageId ?? null,
            transcriptBlockIndex: identityBlockIndex,
            kind: pinnedKindForRole(role),
            role,
            label,
            fallbackLabelKind,
            promptPreview,
            responsePreview,
            createdAtMs: normalizeFiniteInteger(params.loadedMessage?.createdAtMs) ?? params.nearestUserTurn?.createdAtMs ?? null,
            pinned: true,
            pinnedAtMs: normalizeFiniteInteger(params.pin.pinnedAtMs),
            loaded: params.loadedMessage?.loaded !== false && params.loadedMessage != null,
        },
    };
}

export function deriveTranscriptNavigationEntries(params: DeriveTranscriptNavigationEntriesParams): TranscriptNavigationEntry[] {
    const sessionId = normalizeSessionId(params.sessionId);
    if (!sessionId) return [];

    const loadedMessages = params.loadedMessages
        .filter((message) => normalizeSessionId(message.sessionId) === sessionId)
        .map(normalizeLoadedMessage)
        .sort(compareLoadedMessage);
    const pins = buildUniquePins(sessionId, params.pins);
    // One row set, one positional pairing pass: remote rows are ordinary unloaded transcript rows,
    // so a head-partial turn (loaded reply, user row outside the window) pairs like any other.
    const turnRows = params.remoteMessages.length === 0
        ? loadedMessages
        : mergeRemoteNavigationMessages(
            sessionId,
            loadedMessages,
            params.remoteMessages.map(normalizeLoadedMessage),
        ).sort(compareLoadedMessage);
    const turnsBySeq = deriveLoadedUserTurns(sessionId, turnRows);

    const userTurns = [...turnsBySeq.values()].sort((a, b) => a.seq - b.seq);
    const entries: NavigationEntryWithOrder[] = [];

    for (const turn of userTurns) {
        const userEntry = buildUserEntry(turn, params.mode, findPinForUserSeq(pins, turn.seq));
        if (userEntry) entries.push(userEntry);
    }

    for (let index = 0; index < pins.length; index += 1) {
        const pin = pins[index]!;
        if (pin.role === 'user') continue;
        if (params.mode === 'all' && pin.role !== 'assistant' && pin.role !== 'tool') continue;
        const seq = normalizeFiniteInteger(pin.seq);
        if (seq === null) continue;
        const loadedMessage = findLoadedMessageForPin(loadedMessages, pin);
        const pinnedEntry = buildPinnedEntry({
            sessionId,
            pin,
            loadedMessage,
            nearestUserTurn: findNearestUserTurn(userTurns, seq),
            pinOrder: index,
        });
        if (pinnedEntry) entries.push(pinnedEntry);
    }

    return shareTranscriptNavigationEntries(
        entries.sort(compareEntries).map((item) => item.entry),
        params.previousEntries,
    );
}

function transcriptNavigationEntriesMatch(
    a: TranscriptNavigationEntry,
    b: TranscriptNavigationEntry,
): boolean {
    return a.id === b.id
        && a.sessionId === b.sessionId
        && a.seq === b.seq
        && a.routeMessageId === b.routeMessageId
        && a.transcriptBlockIndex === b.transcriptBlockIndex
        && a.kind === b.kind
        && a.role === b.role
        && a.label === b.label
        && a.fallbackLabelKind === b.fallbackLabelKind
        && a.promptPreview === b.promptPreview
        && a.responsePreview === b.responsePreview
        && a.createdAtMs === b.createdAtMs
        && a.pinned === b.pinned
        && a.pinnedAtMs === b.pinnedAtMs
        && a.loaded === b.loaded;
}

function shareTranscriptNavigationEntries(
    nextEntries: TranscriptNavigationEntry[],
    previousEntries: readonly TranscriptNavigationEntry[] | null | undefined,
): TranscriptNavigationEntry[] {
    if (!previousEntries || previousEntries.length === 0) return nextEntries;

    const previousById = new Map<string, TranscriptNavigationEntry>();
    for (const entry of previousEntries) {
        previousById.set(entry.id, entry);
    }

    let allEntriesMatchPreviousOrder = previousEntries.length === nextEntries.length;
    const sharedEntries = nextEntries.map((entry, index) => {
        const previousEntry = previousById.get(entry.id);
        const sharedEntry = previousEntry && transcriptNavigationEntriesMatch(previousEntry, entry)
            ? previousEntry
            : entry;
        if (allEntriesMatchPreviousOrder && previousEntries[index] !== sharedEntry) {
            allEntriesMatchPreviousOrder = false;
        }
        return sharedEntry;
    });

    return allEntriesMatchPreviousOrder
        ? previousEntries as TranscriptNavigationEntry[]
        : sharedEntries;
}
