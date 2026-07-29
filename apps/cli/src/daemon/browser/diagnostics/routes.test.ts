import { describe, expect, it } from 'vitest';

describe('daemon browser diagnostics routes', () => {
    it('serves a daemon-owned browser diagnostics snapshot', async () => {
        const mod = await import('./routes');

        expect(mod?.createBrowserDiagnosticsRoutes).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsRoutes) return;

        const routes = mod.createBrowserDiagnosticsRoutes({
            store: {
                getSnapshot: () => ({
                    v: 1,
                    machineId: 'machine_1',
                    generatedAt: 1_000,
                    refreshState: 'idle',
                    events: [],
                    diagnostics: [],
                }),
            },
        });

        await expect(routes.getSnapshot()).resolves.toEqual({
            v: 1,
            machineId: 'machine_1',
            generatedAt: 1_000,
            refreshState: 'idle',
            events: [],
            diagnostics: [],
        });
    });
});
