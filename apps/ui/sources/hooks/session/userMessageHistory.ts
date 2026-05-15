import type { Message } from '@/sync/domains/messages/messageTypes';

export type AgentInputHistoryScope = 'perSession' | 'global';

export const DEFAULT_USER_MESSAGE_HISTORY_MAX_ENTRIES = 200;

function isUserTextMessage(message: Message): message is Extract<Message, { kind: 'user-text' }> {
    return message.kind === 'user-text';
}

export function collectUserMessageHistoryEntries(opts: {
    scope: AgentInputHistoryScope;
    sessionId: string | null;
    messagesBySessionId: Record<string, ReadonlyArray<Message> | undefined>;
    maxEntries?: number;
}): string[] {
    const maxEntries = opts.maxEntries ?? DEFAULT_USER_MESSAGE_HISTORY_MAX_ENTRIES;
    const candidates: Array<{ createdAt: number; text: string }> = [];

    if (opts.scope === 'perSession') {
        const messages = opts.sessionId ? (opts.messagesBySessionId[opts.sessionId] ?? []) : [];
        for (const m of messages) {
            if (!isUserTextMessage(m)) continue;
            candidates.push({ createdAt: m.createdAt, text: m.text });
        }
    } else {
        for (const messages of Object.values(opts.messagesBySessionId)) {
            if (!messages) continue;
            for (const m of messages) {
                if (!isUserTextMessage(m)) continue;
                candidates.push({ createdAt: m.createdAt, text: m.text });
            }
        }
    }

    candidates.sort((a, b) => b.createdAt - a.createdAt);

    const out: string[] = [];
    const seen = new Set<string>();

    for (const c of candidates) {
        const trimmed = c.text.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= maxEntries) break;
    }

    return out;
}

export type UserMessageHistoryNavigator = {
    moveUp: (currentText: string) => string | null;
    moveDown: (currentText: string) => string | null;
    pause: (currentText: string) => void;
    reset: () => void;
    warmup: () => void;
    isBrowsing: () => boolean;
    hasRetainedSession: () => boolean;
};

export type UserMessageHistoryMoveState = Readonly<{
    index: number;
    entriesLength: number;
}>;

export type UserMessageHistoryNavigatorOptions = Readonly<{
    onMoveUp?: (state: UserMessageHistoryMoveState) => void;
    onWarmup?: () => void;
}>;

type UserMessageHistoryEntriesSource = ReadonlyArray<string> | (() => ReadonlyArray<string>);

function readHistoryEntries(source: UserMessageHistoryEntriesSource): ReadonlyArray<string> {
    return typeof source === 'function' ? source() : source;
}

type HistorySlot =
    | Readonly<{ kind: 'draft' }>
    | Readonly<{ kind: 'history'; index: number }>;

type HistoryEntrySnapshot = Readonly<{
    originalText: string;
    editedText: string;
}>;

type HistoryNavigationSession = {
    draftText: string;
    currentSlot: HistorySlot;
    historyEditsByIndex: Map<number, HistoryEntrySnapshot>;
    activeBrowsing: boolean;
    lastAppliedText: string | null;
};

export function createUserMessageHistoryNavigator(
    entriesSource: UserMessageHistoryEntriesSource,
    options: UserMessageHistoryNavigatorOptions = {},
): UserMessageHistoryNavigator {
    let session: HistoryNavigationSession | null = null;

    function reset() {
        session = null;
    }

    function warmup() {
        options.onWarmup?.();
    }

    function isBrowsing() {
        return session?.activeBrowsing === true;
    }

    function hasRetainedSession() {
        return session !== null;
    }

    function captureCurrentSlotText(currentText: string, entries: ReadonlyArray<string>) {
        if (!session) return;

        if (session.currentSlot.kind === 'draft') {
            session.draftText = currentText;
            session.lastAppliedText = currentText;
            return;
        }

        const index = session.currentSlot.index;
        const previousSnapshot = session.historyEditsByIndex.get(index);
        const originalText = entries[index]
            ?? previousSnapshot?.originalText
            ?? session.lastAppliedText
            ?? currentText;
        session.historyEditsByIndex.set(index, {
            originalText,
            editedText: currentText,
        });
    }

    function readHistorySlotText(index: number, entries: ReadonlyArray<string>): string | null {
        if (index < 0 || index >= entries.length) return null;
        return session?.historyEditsByIndex.get(index)?.editedText ?? entries[index] ?? null;
    }

    function moveUp(currentText: string): string | null {
        const entries = readHistoryEntries(entriesSource);
        if (entries.length === 0) {
            warmup();
            return null;
        }

        if (!session) {
            session = {
                draftText: currentText,
                currentSlot: { kind: 'draft' },
                historyEditsByIndex: new Map(),
                activeBrowsing: true,
                lastAppliedText: currentText,
            };
        } else {
            captureCurrentSlotText(currentText, entries);
        }

        const nextIndex = session.currentSlot.kind === 'draft'
            ? 0
            : Math.min(session.currentSlot.index + 1, entries.length - 1);
        const entry = readHistorySlotText(nextIndex, entries);
        if (entry === null) return null;

        session.currentSlot = { kind: 'history', index: nextIndex };
        session.activeBrowsing = true;
        session.lastAppliedText = entry;
        options.onMoveUp?.({ index: nextIndex, entriesLength: entries.length });
        return entry;
    }

    function moveDown(currentText: string): string | null {
        if (!session || session.currentSlot.kind === 'draft') return null;

        const entries = readHistoryEntries(entriesSource);
        captureCurrentSlotText(currentText, entries);

        const currentIndex = session.currentSlot.index;
        if (currentIndex <= 0 || entries.length === 0) {
            const draftText = session.draftText;
            session.currentSlot = { kind: 'draft' };
            session.activeBrowsing = false;
            session.lastAppliedText = draftText;
            return draftText;
        }

        const nextIndex = Math.min(currentIndex - 1, entries.length - 1);
        const entry = readHistorySlotText(nextIndex, entries);
        if (entry === null) return null;

        session.currentSlot = { kind: 'history', index: nextIndex };
        session.activeBrowsing = true;
        session.lastAppliedText = entry;
        return entry;
    }

    function pause(currentText: string) {
        if (!session) return;
        captureCurrentSlotText(currentText, readHistoryEntries(entriesSource));
        session.activeBrowsing = false;
    }

    return { moveUp, moveDown, pause, reset, warmup, isBrowsing, hasRetainedSession };
}
