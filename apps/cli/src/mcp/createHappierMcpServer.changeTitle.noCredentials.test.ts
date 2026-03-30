import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = process.env;

describe('createHappierMcpServer (change_title without credentials)', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env = { ...env };
        delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    });

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
                sendClaudeSessionMessage: () => {},
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
    });
});
