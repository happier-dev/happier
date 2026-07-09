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
    TranscriptNavigationRemoteUserTurn,
    TranscriptNavigationRole,
} from './transcriptNavigationTypes';

type NavigationEntryWithOrder = Readonly<{
    entry: TranscriptNavigationEntry;
    blockOrder: number;
    pinOrder: number;
}>;

type UserTurnDraft = Readonly<{
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
    const facts = message.derivationFacts;
    if (facts) {
        return {
            sessionId: facts.sessionId,
            messageId: message.messageId,
            routeMessageId: facts.routeMessageId,
            seq: facts.seq,
            transcriptBlockIndex: facts.transcriptBlockIndex,
            role: facts.role,
            text: facts.textPreview,
            createdAtMs: facts.createdAtMs,
            loaded: message.loaded,
            derivationFacts: facts,
        };
    }

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
    let activeResponsePreview: string | null = null;

    const commitActiveUser = () => {
        if (!activeUser) return;
        const seq = normalizeFiniteInteger(activeUser.seq);
        const promptPreview = activeUser.text;
        if (seq === null || !promptPreview) {
            activeUser = null;
            activeResponsePreview = null;
            return;
        }

        turnsBySeq.set(seq, {
            sessionId,
            seq,
            routeMessageId: activeUser.routeMessageId,
            promptPreview,
            responsePreview: activeResponsePreview,
            createdAtMs: normalizeFiniteInteger(activeUser.createdAtMs),
            loaded: activeUser.loaded !== false,
            blockOrder: normalizeBlockIndex(activeUser.transcriptBlockIndex, 'user'),
            transcriptBlockIndex: normalizeFiniteInteger(activeUser.transcriptBlockIndex),
        });
        activeUser = null;
        activeResponsePreview = null;
    };

    for (const message of loadedMessages) {
        if (message.role === 'user') {
            commitActiveUser();
            activeUser = message;
            activeResponsePreview = null;
            continue;
        }
        if (!activeUser || message.role !== 'assistant') continue;
        // Seqs are per-message (the assistant reply never shares the user
        // turn's seq), so turn membership is positional: assistant rows after
        // this user message and before the next one belong to this turn. Only
        // reject rows whose seq is out of order relative to the active turn.
        const assistantSeq = normalizeFiniteInteger(message.seq);
        const activeUserSeq = normalizeFiniteInteger(activeUser.seq);
        if (assistantSeq !== null && activeUserSeq !== null && assistantSeq < activeUserSeq) continue;
        const responsePreview = message.text;
        if (responsePreview) {
            activeResponsePreview = responsePreview;
        }
    }
    commitActiveUser();

    return turnsBySeq;
}

type LoadedSeqCoverage = Readonly<{ minSeq: number; maxSeq: number }>;

function resolveLoadedSeqCoverage(
    loadedMessages: readonly TranscriptNavigationLoadedMessage[],
): LoadedSeqCoverage | null {
    let minSeq: number | null = null;
    let maxSeq: number | null = null;
    for (const message of loadedMessages) {
        const seq = normalizeFiniteInteger(message.seq);
        if (seq === null) continue;
        minSeq = minSeq === null ? seq : Math.min(minSeq, seq);
        maxSeq = maxSeq === null ? seq : Math.max(maxSeq, seq);
    }
    if (minSeq === null || maxSeq === null) return null;
    return { minSeq, maxSeq };
}

function collectLoadedRouteMessageIds(
    loadedMessages: readonly TranscriptNavigationLoadedMessage[],
): ReadonlySet<string> {
    const routeMessageIds = new Set<string>();
    for (const message of loadedMessages) {
        const routeMessageId = typeof message.routeMessageId === 'string' ? message.routeMessageId.trim() : '';
        if (routeMessageId) routeMessageIds.add(routeMessageId);
    }
    return routeMessageIds;
}

function addRemoteUserTurns(
    sessionId: string,
    turnsBySeq: Map<number, UserTurnDraft>,
    remoteUserTurns: readonly TranscriptNavigationRemoteUserTurn[],
    loadedMessages: readonly TranscriptNavigationLoadedMessage[],
): void {
    const coverage = resolveLoadedSeqCoverage(loadedMessages);
    const loadedRouteMessageIds = collectLoadedRouteMessageIds(loadedMessages);
    for (const remoteTurn of remoteUserTurns) {
        if (remoteTurn.sessionId && normalizeSessionId(remoteTurn.sessionId) !== sessionId) continue;
        const seq = normalizeFiniteInteger(remoteTurn.seq);
        const promptPreview = normalizeTextPreview(remoteTurn.text);
        if (seq === null || !promptPreview || turnsBySeq.has(seq)) continue;
        // Identity-merge with the loaded window: inside the loaded seq coverage the loaded
        // rows are the source of truth, so a remote-seeded turn either already exists as a
        // loaded turn or was absorbed/deduped by transcript reconciliation. Never resurrect
        // it as a phantom "unloaded" entry (QA-4).
        if (coverage && seq >= coverage.minSeq && seq <= coverage.maxSeq) continue;
        const remoteRouteMessageId = typeof remoteTurn.routeMessageId === 'string' ? remoteTurn.routeMessageId.trim() : '';
        if (remoteRouteMessageId && loadedRouteMessageIds.has(remoteRouteMessageId)) continue;
        turnsBySeq.set(seq, {
            sessionId,
            seq,
            routeMessageId: null,
            promptPreview,
            responsePreview: null,
            createdAtMs: normalizeFiniteInteger(remoteTurn.createdAtMs),
            loaded: false,
            blockOrder: 0,
            transcriptBlockIndex: null,
        });
    }
}

function findNearestUserTurn(turns: readonly UserTurnDraft[], seq: number): UserTurnDraft | null {
    let nearest: UserTurnDraft | null = null;
    for (const turn of turns) {
        if (turn.seq > seq) break;
        nearest = turn;
    }
    return nearest;
}

function buildUserEntry(turn: UserTurnDraft, mode: 'all' | 'pinned', pin: TranscriptNavigationPin | null): NavigationEntryWithOrder | null {
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
    const turnsBySeq = deriveLoadedUserTurns(sessionId, loadedMessages);
    addRemoteUserTurns(sessionId, turnsBySeq, params.remoteUserTurns, loadedMessages);

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
