import { describe, it, expect } from 'vitest';

function expectedRuntimeForCurrentProcess(): 'node' | 'bun' | 'deno' | 'unknown' {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return 'bun';
    if (typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined') return 'deno';
    if (process.versions?.bun) return 'bun';
    if (process.versions?.deno) return 'deno';
    if (process.versions?.node) return 'node';
    return 'unknown';
}

describe('Runtime Integration Tests', () => {
    it('runtime detection is consistent across imports', async () => {
        const { getRuntime } = await import('../runtime.js');
        const runtime1 = getRuntime();

        // Re-import to test caching
        const { getRuntime: getRuntime2 } = await import('../runtime.js');
        const runtime2 = getRuntime2();

        expect(runtime1).toBe(runtime2);
        expect(['node', 'bun', 'deno', 'unknown']).toContain(runtime1);
    });

    it('runtime detection works in actual execution environment', async () => {
        const { getRuntime, isNode, isBun, isDeno } = await import('../runtime.js');
        const runtime = getRuntime();
        expect(runtime).toBe(expectedRuntimeForCurrentProcess());
        expect(isNode()).toBe(runtime === 'node');
        expect(isBun()).toBe(runtime === 'bun');
        expect(isDeno()).toBe(runtime === 'deno');
    });

    it('runtime utilities can be imported correctly', async () => {
        const runtimeModule = await import('../runtime.js');

        // Check that all expected exports are available
        expect(typeof runtimeModule.getRuntime).toBe('function');
        expect(typeof runtimeModule.isBun).toBe('function');
        expect(typeof runtimeModule.isNode).toBe('function');
        expect(typeof runtimeModule.isDeno).toBe('function');
        expect(typeof runtimeModule.getRuntime()).toBe('string');
    });
});
