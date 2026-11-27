import { afterEach, describe, expect, it } from 'vitest';

import { Utf8TextDecoder } from '@/utils/runtime/utf8TextDecoder';
import { installUtf8TextDecoder } from './installUtf8TextDecoder.native';

describe('installUtf8TextDecoder (native)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder')!;
    afterEach(() => { Object.defineProperty(globalThis, 'TextDecoder', original); });

    it('replaces a lazily installed platform polyfill with the bulk decoder', () => {
        let polyfillReads = 0;
        // Expo installs TextDecoder as a configurable lazy getter.
        Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, enumerable: true,
            get: () => { polyfillReads += 1; return original.value; } });
        installUtf8TextDecoder();
        const decoder = new globalThis.TextDecoder();
        expect(decoder).toBeInstanceOf(Utf8TextDecoder);
        expect(decoder.decode(new TextEncoder().encode('{"ok":"✓"}'))).toBe('{"ok":"✓"}');
        installUtf8TextDecoder();
        expect(globalThis.TextDecoder).toBe(Utf8TextDecoder);
        expect(polyfillReads).toBe(1);
    });
});
