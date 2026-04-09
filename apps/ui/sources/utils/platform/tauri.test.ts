import { afterEach, describe, expect, it } from 'vitest';

import { isTauriDesktop } from './tauri';

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
        writeTauriApi(undefined);
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

    it('returns true when the user agent indicates a Tauri host even if invoke() is not yet available', () => {
        writeInternals(undefined);
        writeTauriApi(undefined);
        (globalThis as any).navigator = { userAgent: 'Mozilla/5.0 (Tauri)' };
        expect(isTauriDesktop()).toBe(true);
    });
});
