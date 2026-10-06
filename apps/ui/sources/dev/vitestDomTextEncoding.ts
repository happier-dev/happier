import { afterAll } from 'vitest';
import { getVitestNodeBuiltin } from './vitestNodeBuiltins';

// JSDOM replaces Uint8Array but can retain Node's TextEncoder, whose output belongs
// to Node's original realm. Install before any Protocol module captures an encoder.
const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
const CurrentTextEncoder = globalThis.TextEncoder;
if (typeof CurrentTextEncoder !== 'function' || !(new CurrentTextEncoder().encode() instanceof Uint8Array)) {
    const { TextEncoder: NodeTextEncoder } = getVitestNodeBuiltin<typeof import('node:util')>('node:util');
    class DomTextEncoder extends NodeTextEncoder {
        override encode(input?: string) {
            return new Uint8Array(super.encode(input));
        }
    }

    Object.defineProperty(globalThis, 'TextEncoder', {
        value: DomTextEncoder,
        configurable: true,
        enumerable: originalDescriptor?.enumerable ?? true,
        writable: true,
    });
    // This is a suite-owned SDK adapter, not a vi.stubGlobal removed between tests.
    afterAll(() => {
        if (globalThis.TextEncoder !== DomTextEncoder) return;
        if (originalDescriptor) Object.defineProperty(globalThis, 'TextEncoder', originalDescriptor);
        else Reflect.deleteProperty(globalThis, 'TextEncoder');
    });
}
