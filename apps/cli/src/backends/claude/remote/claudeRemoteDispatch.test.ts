import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteDispatch } from './claudeRemoteDispatch';

describe('claudeRemoteDispatch', () => {
    it('routes to Agent SDK runner when enabled on first message', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('falls back to legacy runner when Agent SDK runner fails with an authentication error before consuming additional messages', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {
            throw new Error(
                'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
            );
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenNthCalledWith(1, 'agentSdk');
        expect(onRunnerSelected).toHaveBeenNthCalledWith(2, 'legacy');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to legacy runner if Agent SDK has already started a session before failing with an authentication error', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async (params: any) => {
            params.onSessionFound?.('sess_started');
            throw new Error(
                'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
            );
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await expect(
            claudeRemoteDispatch(
                {
                    onSessionFound: vi.fn(),
                    onRunnerSelected,
                    nextMessage: async () => {
                        if (sent) return null;
                        sent = true;
                        return {
                            message: 'hello',
                            mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                        };
                    },
                } as any,
                { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/Failed to authenticate/);

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('still routes to Agent SDK runner when enabled even if --mcp-config flags are present (runner parses and maps to mcpServers)', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                claudeArgs: ['--mcp-config', '{"mcpServers":{}}'],
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('routes to legacy runner when Agent SDK is not enabled on first message', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: false } as any,
                    };
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('legacy');
        expect(mockAgentSdk).toHaveBeenCalledTimes(0);
        expect(mockLegacy).toHaveBeenCalledTimes(1);
    });
});
