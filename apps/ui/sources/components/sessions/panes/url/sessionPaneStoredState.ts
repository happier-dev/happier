import { parseSessionPaneUrlState, serializeSessionPaneUrlState, type SessionPaneUrlState } from './sessionPaneUrlState';

const SESSION_PANE_STORED_STATE_KEY_PREFIX = 'happier.sessionPaneState.v1:';

function getSessionStorage(): Storage | null {
    const candidate = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!candidate) {
        return null;
    }

    try {
        const probeKey = `${SESSION_PANE_STORED_STATE_KEY_PREFIX}__probe__`;
        candidate.setItem(probeKey, '1');
        candidate.removeItem(probeKey);
        return candidate;
    } catch {
        return null;
    }
}

function createStorageKey(scopeKey: string): string {
    return `${SESSION_PANE_STORED_STATE_KEY_PREFIX}${scopeKey}`;
}

export function readStoredSessionPaneUrlState(scopeKey: string): SessionPaneUrlState | null {
    const storage = getSessionStorage();
    if (!storage) {
        return null;
    }

    const raw = storage.getItem(createStorageKey(scopeKey));
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return parseSessionPaneUrlState(parsed);
    } catch {
        return null;
    }
}

export function writeStoredSessionPaneUrlState(scopeKey: string, state: SessionPaneUrlState | null): void {
    const storage = getSessionStorage();
    if (!storage) {
        return;
    }

    const storageKey = createStorageKey(scopeKey);
    if (!state) {
        storage.removeItem(storageKey);
        return;
    }

    storage.setItem(storageKey, JSON.stringify(serializeSessionPaneUrlState(state)));
}
