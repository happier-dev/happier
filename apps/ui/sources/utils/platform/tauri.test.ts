import { afterEach, describe, expect, it, vi } from 'vitest';

import { isTauriDesktop, listenTauriEvent } from './tauri';

const TAURI_INTERNALS_KEY = '__TAURI_INTERNALS__';
const TAURI_KEY = '__TAURI__';

function readInternals() {
    return (globalThis as any)[TAURI_INTERNALS_KEY];
}

function writeInternals(value: unknown) {
    if (value === undefined) {
        delete (globalThis as any)[TAURI_INTERNALS_KEY];
        return;
    }
    (globalThis as any)[TAURI_INTERNALS_KEY] = value;
}

function readTauriApi() {
    return (globalThis as any)[TAURI_KEY];
}

function writeTauriApi(value: unknown) {
    if (value === undefined) {
        delete (globalThis as any)[TAURI_KEY];
        return;
    }
    (globalThis as any)[TAURI_KEY] = value;
}

describe('isTauriDesktop', () => {
    const original = readInternals();
    const originalTauriApi = readTauriApi();
    const originalNavigator = (globalThis as any).navigator;

    afterEach(() => {
        writeInternals(original);
        writeTauriApi(originalTauriApi);
        if (originalNavigator === undefined) {
            delete (globalThis as any).navigator;
        } else {
            (globalThis as any).navigator = originalNavigator;
        }
    });

    it('returns false when no Tauri internals are present', () => {
        writeInternals(undefined);
        writeTauriApi(undefined);
        expect(isTauriDesktop()).toBe(false);
    });

    it('returns false when internals exist without invoke()', () => {
        writeInternals({});
        writeTauriApi(undefined);
        expect(isTauriDesktop()).toBe(false);
    });

    it('returns true when internals expose invoke()', () => {
        writeInternals({ invoke: () => null });
        expect(isTauriDesktop()).toBe(true);
    });

    it('returns true when the Tauri core API exposes invoke() without internals.invoke()', () => {
        writeInternals({ plugins: {} });
        writeTauriApi({
            core: {
                invoke: () => null,
            },
        });
        expect(isTauriDesktop()).toBe(true);
    });

    it('returns true when the user agent indicates a Tauri host before invoke() is ready', () => {
        writeInternals(undefined);
        writeTauriApi(undefined);
        (globalThis as any).navigator = { userAgent: 'Mozilla/5.0 (Tauri)' };
        expect(isTauriDesktop()).toBe(true);
    });
});

describe('listenTauriEvent', () => {
    const original = readInternals();
    const originalTauriApi = readTauriApi();

    afterEach(() => {
        writeInternals(original);
        writeTauriApi(originalTauriApi);
    });

    it('returns a noop unlistener instead of importing the Tauri event module when no event bridge exists', async () => {
        writeInternals(undefined);
        writeTauriApi(undefined);
        const handler = vi.fn();

        const unlisten = await listenTauriEvent('desktop_pet_overlay_window_state_changed', handler);

        expect(handler).not.toHaveBeenCalled();
        expect(unlisten).toEqual(expect.any(Function));
        expect(() => unlisten()).not.toThrow();
    });

    it('uses the global Tauri event listener when withGlobalTauri exposes it', async () => {
        writeInternals(undefined);
        const listen = vi.fn(async (_event: string, handler: (event: { payload: string }) => void) => {
            handler({ payload: 'payload-1' });
            return () => undefined;
        });
        writeTauriApi({
            event: { listen },
        });
        const handler = vi.fn();

        const unlisten = await listenTauriEvent<string>('desktop_pet_overlay_window_state_changed', handler);

        expect(listen).toHaveBeenCalledWith(
            'desktop_pet_overlay_window_state_changed',
            expect.any(Function),
        );
        expect(handler).toHaveBeenCalledWith('payload-1');
        expect(unlisten).toEqual(expect.any(Function));
    });
});
