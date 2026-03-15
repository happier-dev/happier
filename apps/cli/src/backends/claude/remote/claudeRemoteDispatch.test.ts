import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteDispatch } from './claudeRemoteDispatch';

describe('claudeRemoteDispatch', () => {
    it('routes to Agent SDK runner when enabled on first message', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});

        let sent = false;
        await claudeRemoteDispatch(
            {
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

        let sent = false;
        await claudeRemoteDispatch(
            {
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

        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(1);
    });

    it('still routes to Agent SDK runner when enabled even if --mcp-config flags are present (runner parses and maps to mcpServers)', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {});

        let sent = false;
        await claudeRemoteDispatch(
            {
                claudeArgs: ['--mcp-config', '{"mcpServers":{}}'],
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

        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });
});
