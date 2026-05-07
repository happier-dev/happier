import { afterEach, describe, expect, it, vi } from 'vitest';

describe('installElevenLabsNativeGlobals', () => {
    const originalDOMExceptionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'DOMException');

    afterEach(() => {
        vi.resetModules();
        if (originalDOMExceptionDescriptor) {
            Object.defineProperty(globalThis, 'DOMException', originalDOMExceptionDescriptor);
        } else {
            delete (globalThis as { DOMException?: unknown }).DOMException;
        }
    });

    it('installs a DOMException-compatible constructor when Hermes does not provide one', async () => {
        Object.defineProperty(globalThis, 'DOMException', {
            value: undefined,
            configurable: true,
            writable: true,
        });

        await import('./installElevenLabsNativeGlobals');

        expect(typeof DOMException).toBe('function');
        const abortError = new DOMException('Aborted', 'AbortError');
        expect(abortError).toBeInstanceOf(Error);
        expect(abortError.name).toBe('AbortError');
        expect(abortError.message).toBe('Aborted');
    });
});
