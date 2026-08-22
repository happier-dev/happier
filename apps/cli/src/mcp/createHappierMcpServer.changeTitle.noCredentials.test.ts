import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = process.env;

describe('createHappierMcpServer (change_title without credentials)', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env = { ...env };
        delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    });

    // `vi.resetModules()` plus the in-test dynamic import means this case pays the
    // full cold transform of the `createHappierMcpServer` module graph. Measured
    // here: ~19-25s of transform against ~1-4ms of actual `changeTitle` work, so
    // the default 30s budget flakes whenever the machine is loaded. The budget
    // covers module loading; it is not a tolerance for a slow product path.
    it('can change the current session title without user credentials', async () => {
        const updateMetadata = vi.fn();
        const captured: { deps?: any } = {};

        vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/mcp/server/registerHappierMcpBuiltInTools')>();
            return {
                ...actual,
                registerHappierMcpBuiltInTools: (_server: any, params: any) => {
                    captured.deps = params.deps;
                    return { toolNames: [] };
                },
            };
        });

        const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
        createHappierMcpServer(
            {
                sessionId: 'sess_change_title_no_creds_2',
                rpcHandlerManager: { invokeLocal: async () => ({}) },
                updateMetadata,
            } as any,
            { credentials: null },
        );

        expect(captured.deps).toBeDefined();
        await expect(captured.deps.changeTitle('sess_change_title_no_creds_2', 'New title')).resolves.toEqual({
            success: true,
            title: 'New title',
        });
        expect(updateMetadata.mock.calls.length).toBeGreaterThanOrEqual(1);
    }, 120_000);
});
