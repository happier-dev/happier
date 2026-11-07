export type NewSessionStartedNotice = Readonly<{ href: string }>;

let notice: NewSessionStartedNotice | null = null;
const listeners = new Set<() => void>();

/**
 * A launch that outlived its composer reports here. Only a composer that is showing can read it, so a
 * launch finished while none is open does not resurface later; nothing about it needs to persist,
 * because the Session itself is in the list.
 */
export function publishNewSessionStartedNotice(next: NewSessionStartedNotice): void {
    if (listeners.size === 0) return;
    notice = next;
    for (const listener of listeners) listener();
}

export function readNewSessionStartedNotice(): NewSessionStartedNotice | null {
    return notice;
}

export function subscribeNewSessionStartedNotice(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) notice = null;
    };
}

export function resetNewSessionStartedNoticeForTests(): void {
    notice = null;
    listeners.clear();
}
