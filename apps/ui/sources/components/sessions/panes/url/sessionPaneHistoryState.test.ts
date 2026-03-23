import { beforeEach, describe, expect, it, vi } from 'vitest';

function installSessionStorage(): Storage {
    const values = new Map<string, string>();
    const storage = {
        get length() {
            return values.size;
        },
        clear() {
            values.clear();
        },
        getItem(key: string) {
            return values.get(key) ?? null;
        },
        key(index: number) {
            return Array.from(values.keys())[index] ?? null;
        },
        removeItem(key: string) {
            values.delete(key);
        },
        setItem(key: string, value: string) {
            values.set(key, value);
        },
    } satisfies Storage;

    Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: storage,
    });

    return storage;
}

function installWindow(href: string) {
    const listeners = new Map<string, Set<(event: { type: string }) => void>>();
    const windowStub = {
        location: { href },
        history: {
            state: null as unknown,
            pushState: vi.fn(),
            replaceState: vi.fn((state: unknown) => {
                windowStub.history.state = state;
            }),
        },
        addEventListener(type: string, listener: (event: { type: string }) => void) {
            const existing = listeners.get(type) ?? new Set<(event: { type: string }) => void>();
            existing.add(listener);
            listeners.set(type, existing);
        },
        removeEventListener(type: string, listener: (event: { type: string }) => void) {
            listeners.get(type)?.delete(listener);
        },
        dispatchEvent(event: { type: string }) {
            for (const listener of listeners.get(event.type) ?? []) {
                listener(event);
            }
            return true;
        },
    };

    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: windowStub,
    });

    return windowStub;
}

describe('sessionPaneHistoryState', () => {
    beforeEach(() => {
        vi.resetModules();
        delete (globalThis as { window?: unknown }).window;
        delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    });

    it('clears stored pane state and records the traversal for pane-less session popstate urls', async () => {
        installSessionStorage();
        const windowStub = installWindow('http://localhost:19364/session/history-popstate?server=http%3A%2F%2Flocalhost%3A53288');

        const { primeSessionPaneHistoryTraversalTracking, consumeSessionPaneHistoryTraversalForCurrentLocation } = await import('./sessionPaneHistoryState');
        const { readStoredSessionPaneUrlState, writeStoredSessionPaneUrlState } = await import('./sessionPaneStoredState');

        writeStoredSessionPaneUrlState('session:history-popstate', { bottomTabId: 'terminal' });
        primeSessionPaneHistoryTraversalTracking();

        windowStub.dispatchEvent({ type: 'popstate' });

        expect(readStoredSessionPaneUrlState('session:history-popstate')).toBeNull();
        expect(consumeSessionPaneHistoryTraversalForCurrentLocation()).toBe(true);
        expect(consumeSessionPaneHistoryTraversalForCurrentLocation()).toBe(false);
    });

    it('preserves stored pane state when popstate lands on a session url that still carries pane params', async () => {
        installSessionStorage();
        const windowStub = installWindow('http://localhost:19364/session/history-pane?server=http%3A%2F%2Flocalhost%3A53288&bottom=terminal');

        const { primeSessionPaneHistoryTraversalTracking, consumeSessionPaneHistoryTraversalForCurrentLocation } = await import('./sessionPaneHistoryState');
        const { readStoredSessionPaneUrlState, writeStoredSessionPaneUrlState } = await import('./sessionPaneStoredState');

        writeStoredSessionPaneUrlState('session:history-pane', { bottomTabId: 'terminal' });
        primeSessionPaneHistoryTraversalTracking();

        windowStub.dispatchEvent({ type: 'popstate' });

        expect(readStoredSessionPaneUrlState('session:history-pane')).toEqual({ bottomTabId: 'terminal' });
        expect(consumeSessionPaneHistoryTraversalForCurrentLocation()).toBe(true);
    });
});
