import { describe, expect, it } from 'vitest';

import { ensureGlobalBuffer } from './ensureGlobalBuffer';

describe('ensureGlobalBuffer', () => {
    it('sets global Buffer when missing', () => {
        const original = (globalThis as unknown as { Buffer?: unknown }).Buffer;
        try {
            (globalThis as unknown as { Buffer?: unknown }).Buffer = undefined;
            ensureGlobalBuffer();
            expect(typeof (globalThis as unknown as { Buffer?: unknown }).Buffer).toBe('function');
        } finally {
            (globalThis as unknown as { Buffer?: unknown }).Buffer = original;
        }
    });

    it('does not override an existing Buffer', () => {
        const original = (globalThis as unknown as { Buffer?: unknown }).Buffer;
        const sentinel = () => {};
        try {
            (globalThis as unknown as { Buffer?: unknown }).Buffer = sentinel;
            ensureGlobalBuffer();
            expect((globalThis as unknown as { Buffer?: unknown }).Buffer).toBe(sentinel);
        } finally {
            (globalThis as unknown as { Buffer?: unknown }).Buffer = original;
        }
    });
});
