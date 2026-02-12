import { afterEach, describe, expect, it, vi } from 'vitest';

describe('bugReportLogBuffer (missing console methods)', () => {
    const consoleAny = console as any;
    const originalDebug = consoleAny.debug;

    afterEach(() => {
        consoleAny.debug = originalDebug;
        vi.resetModules();
    });

    it('does not throw when console.debug is missing', async () => {
        consoleAny.debug = undefined;

        vi.resetModules();
        const mod = await import('./bugReportLogBuffer');

        expect(() => mod.installBugReportConsoleCapture({ maxEntries: 3 })).not.toThrow();
    });
});

