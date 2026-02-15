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
    moveUp: (draft: string) => string | null;
    moveDown: () => string | null;
    reset: () => void;
};

export function createUserMessageHistoryNavigator(entries: ReadonlyArray<string>): UserMessageHistoryNavigator {
    let index: number | null = null;
    let draft: string = '';

    function reset() {
        index = null;
        draft = '';
    }

    function moveUp(nextDraft: string): string | null {
        if (entries.length === 0) return null;
        if (index === null) {
            draft = nextDraft;
            index = 0;
            return entries[index] ?? null;
        }

        index = Math.min(index + 1, entries.length - 1);
        return entries[index] ?? null;
    }

    function moveDown(): string | null {
        if (index === null) return null;

        if (index === 0) {
            const res = draft;
            reset();
            return res;
        }

        index = Math.max(0, index - 1);
        return entries[index] ?? null;
    }

    return { moveUp, moveDown, reset };
}

