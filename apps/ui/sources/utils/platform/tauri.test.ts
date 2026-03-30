import { afterEach, describe, expect, it } from 'vitest';

import { isTauriDesktop } from './tauri';

const TAURI_INTERNALS_KEY = '__TAURI_INTERNALS__';

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

describe('isTauriDesktop', () => {
    const original = readInternals();

    afterEach(() => {
        writeInternals(original);
    });

    it('returns false when no Tauri internals are present', () => {
        writeInternals(undefined);
        expect(isTauriDesktop()).toBe(false);
    });

    it('returns false when internals exist without invoke()', () => {
        writeInternals({});
        expect(isTauriDesktop()).toBe(false);
    });

    it('returns true when internals expose invoke()', () => {
        writeInternals({ invoke: () => null });
        expect(isTauriDesktop()).toBe(true);
    });
});

