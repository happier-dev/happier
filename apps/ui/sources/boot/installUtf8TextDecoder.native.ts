import { Utf8TextDecoder } from '@/utils/runtime/utf8TextDecoder';

/**
 * Hermes has no TextDecoder; Expo installs a per-code-point reference polyfill.
 * Every UTF-8 decode in the app (HTTP JSON bodies included) goes through this global,
 * so the bulk decoder replaces it once at boot, before any consumer reads it.
 */
export function installUtf8TextDecoder(): void {
    if (globalThis.TextDecoder === (Utf8TextDecoder as unknown as typeof TextDecoder)) return;
    Object.defineProperty(globalThis, 'TextDecoder', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: Utf8TextDecoder,
    });
}
