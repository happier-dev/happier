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

    it('routes to Agent SDK runner when the enablement flag is missing on first message (back-compat default)', async () => {
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
                        mode: { permissionMode: 'default' } as any,
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

    it('falls back to legacy runner when Agent SDK runner exits with code 1 before emitting any messages', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async () => {
            throw new Error('Claude Code process exited with code 1');
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                onMessage: vi.fn(),
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'continue',
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

    it('falls back to legacy runner when Agent SDK exits with code 1 even after starting a session, as long as it emitted no messages', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async (params: any) => {
            params.onSessionFound?.('sess_started');
            throw new Error('Claude Code process exited with code 1');
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onSessionFound: vi.fn(),
                onRunnerSelected,
                onMessage: vi.fn(),
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'continue',
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

    it('falls back to legacy runner when Agent SDK emits only non-assistant messages and then exits with code 1', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async (params: any) => {
            params.onSessionFound?.('sess_started');
            params.onMessage?.({ type: 'system', message: { role: 'system', content: [] } });
            throw new Error('Claude Code process exited with code 1');
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await claudeRemoteDispatch(
            {
                onSessionFound: vi.fn(),
                onRunnerSelected,
                onMessage: vi.fn(),
                nextMessage: async () => {
                    if (sent) return null;
                    sent = true;
                    return {
                        message: 'continue',
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

    it('does not fall back to legacy runner when Agent SDK exits with code 1 after emitting a message', async () => {
        const mockLegacy = vi.fn(async () => {});
        const mockAgentSdk = vi.fn(async (params: any) => {
            params.onMessage?.({ type: 'assistant', message: { role: 'assistant', content: [] } });
            throw new Error('Claude Code process exited with code 1');
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await expect(
            claudeRemoteDispatch(
                {
                    onRunnerSelected,
                    onMessage: vi.fn(),
                    nextMessage: async () => {
                        if (sent) return null;
                        sent = true;
                        return {
                            message: 'continue',
                            mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any,
                        };
                    },
                } as any,
                { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/exited with code 1/);

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        expect(mockLegacy).toHaveBeenCalledTimes(0);
    });

    it('replays buffered messages when Agent SDK consumes multiple messages and exits with code 1 before any assistant output', async () => {
        const receivedByLegacy: string[] = [];
        const mockLegacy = vi.fn(async (params: any) => {
            while (true) {
                const next = await params.nextMessage();
                if (!next) break;
                receivedByLegacy.push(next.message);
            }
        });
        const mockAgentSdk = vi.fn(async (params: any) => {
            await params.nextMessage(); // first
            await params.nextMessage(); // second
            throw new Error('Claude Code process exited with code 1');
        });
        const onRunnerSelected = vi.fn();

        const messages = [
            { message: 'm1', mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any },
            { message: 'm2', mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any },
        ];
        let index = 0;
        await claudeRemoteDispatch(
            {
                onRunnerSelected,
                nextMessage: async () => {
                    const next = index < messages.length ? messages[index] : null;
                    index++;
                    return next;
                },
            } as any,
            { claudeRemote: mockLegacy, claudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenNthCalledWith(1, 'agentSdk');
        expect(onRunnerSelected).toHaveBeenNthCalledWith(2, 'legacy');
        expect(receivedByLegacy).toEqual(['m1', 'm2']);
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
