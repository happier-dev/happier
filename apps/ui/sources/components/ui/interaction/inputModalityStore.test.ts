import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CapturedListener = (event: unknown) => void;

type FakeDom = Readonly<{
    listeners: Map<string, CapturedListener[]>;
    dispatch: (type: string, event: unknown) => void;
    addEventListenerCallCount: () => number;
}>;

const originalDocument = (globalThis as { document?: unknown }).document;

function installFakeDom(): FakeDom {
    const listeners = new Map<string, CapturedListener[]>();
    let addCalls = 0;

    (globalThis as { document?: unknown }).document = {
        addEventListener: (type: string, listener: CapturedListener) => {
            addCalls += 1;
            listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        removeEventListener: (type: string, listener: CapturedListener) => {
            listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener));
        },
    };

    return {
        listeners,
        dispatch: (type, event) => {
            for (const listener of listeners.get(type) ?? []) listener(event);
        },
        addEventListenerCallCount: () => addCalls,
    };
}

async function loadStore() {
    vi.resetModules();
    return import('@/components/ui/interaction/inputModalityStore');
}

afterEach(() => {
    if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
    } else {
        (globalThis as { document?: unknown }).document = originalDocument;
    }
});

describe('inputModalityStore', () => {
    let dom: FakeDom;

    beforeEach(() => {
        dom = installFakeDom();
    });

    it('starts on pointer, so a touch never raises a focus ring', async () => {
        const store = await loadStore();
        expect(store.getInputModality()).toBe('pointer');
    });

    it('switches to keyboard on a navigation keypress and notifies readers', async () => {
        const store = await loadStore();
        const notified = vi.fn();
        store.subscribeToInputModality(notified);

        dom.dispatch('keydown', { key: 'Tab' });

        expect(store.getInputModality()).toBe('keyboard');
        expect(notified).toHaveBeenCalledTimes(1);
    });

    it('ignores a bare modifier keypress, which is not navigation', async () => {
        const store = await loadStore();
        store.subscribeToInputModality(() => {});

        for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
            dom.dispatch('keydown', { key });
        }

        expect(store.getInputModality()).toBe('pointer');
    });

    it('returns to pointer when the user touches or clicks', async () => {
        const store = await loadStore();
        store.subscribeToInputModality(() => {});
        dom.dispatch('keydown', { key: 'ArrowDown' });
        expect(store.getInputModality()).toBe('keyboard');

        dom.dispatch('pointerdown', {});

        expect(store.getInputModality()).toBe('pointer');
    });

    it('does not notify when the modality is unchanged', async () => {
        const store = await loadStore();
        const notified = vi.fn();
        store.subscribeToInputModality(notified);

        dom.dispatch('keydown', { key: 'Tab' });
        dom.dispatch('keydown', { key: 'Tab' });

        expect(notified).toHaveBeenCalledTimes(1);
    });

    it('attaches one listener set however many readers subscribe', async () => {
        const store = await loadStore();
        store.subscribeToInputModality(() => {});
        const attachedAfterFirst = dom.addEventListenerCallCount();

        store.subscribeToInputModality(() => {});
        store.subscribeToInputModality(() => {});

        expect(attachedAfterFirst).toBeGreaterThan(0);
        expect(dom.addEventListenerCallCount()).toBe(attachedAfterFirst);
    });

    it('stops notifying an unsubscribed reader', async () => {
        const store = await loadStore();
        const notified = vi.fn();
        const unsubscribe = store.subscribeToInputModality(notified);

        unsubscribe();
        dom.dispatch('keydown', { key: 'Tab' });

        expect(notified).not.toHaveBeenCalled();
        expect(store.getInputModality()).toBe('keyboard');
    });

    it('stays on pointer where there is no DOM to listen to', async () => {
        delete (globalThis as { document?: unknown }).document;
        const store = await loadStore();

        expect(() => store.subscribeToInputModality(() => {})()).not.toThrow();
        expect(store.getInputModality()).toBe('pointer');
    });
});
