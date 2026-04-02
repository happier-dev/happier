declare const require: (id: string) => unknown;

export function ensureGlobalBuffer(): void {
    const globalValue = globalThis as unknown as { Buffer?: unknown };
    if (typeof globalValue.Buffer !== 'undefined') {
        return;
    }

    try {
        const mod = require('buffer') as { Buffer?: unknown } | undefined;
        if (mod && typeof mod.Buffer === 'function') {
            globalValue.Buffer = mod.Buffer;
        }
    } catch {
        // ignore (best-effort polyfill)
    }
}
