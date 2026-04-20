import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { dispatchClaudeRemoteSession as claudeRemoteDispatch } from '../runtime/remote/dispatch';
import { getProjectPath } from '../utils/path';

describe('claudeRemoteDispatch', () => {
    it('repairs interrupted tool calls before invoking the runner (preflight)', async () => {
        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-remote-dispatch-preflight-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const workDir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(workDir, { recursive: true });

        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
        try {
            const transcriptPath = join(getProjectPath(workDir, claudeConfigDir), 'sess_1.jsonl');
            await mkdir(dirname(transcriptPath), { recursive: true });
            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: { command: 'sleep 1000' },
                            },
                        ],
                    },
                })}\n`,
            );

            const mockAgentSdk = vi.fn(async () => {
                const contents = await readFile(transcriptPath, 'utf8');
                expect(contents).toMatch(/\"type\":\"tool_result\"/);
            });

            let sent = false;
            await claudeRemoteDispatch(
                {
                    sessionId: 'sess_1',
                    transcriptPath: null,
                    path: workDir,
                    nextMessage: async () => {
                        if (sent) return null;
                        sent = true;
                        return { message: 'continue', mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any };
                    },
                } as any,
                { runClaudeRemoteAgentSdk: mockAgentSdk },
            );

            expect(mockAgentSdk).toHaveBeenCalledTimes(1);
        } finally {
            if (previousClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
            }
        }
    });

    it('routes to Agent SDK runner when enabled on first message', async () => {
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
            { runClaudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
    });

    it('routes to Agent SDK runner when the enablement flag is missing on first message (back-compat default)', async () => {
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
            { runClaudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to legacy runner when Agent SDK runner fails with an authentication error before consuming additional messages', async () => {
        const mockAgentSdk = vi.fn(async () => {
            throw new Error(
                'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
            );
        });
        const onRunnerSelected = vi.fn();

        let sent = false;
        await expect(
            claudeRemoteDispatch(
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
                { runClaudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/Failed to authenticate/);

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to legacy runner if Agent SDK has already started a session before failing with an authentication error', async () => {
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
                { runClaudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/Failed to authenticate/);

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to legacy runner when Agent SDK runner exits with code 1 before emitting any messages', async () => {
        const mockAgentSdk = vi.fn(async () => {
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
                { runClaudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/exited with code 1/);

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to legacy runner when Agent SDK exits with code 1 after emitting a message', async () => {
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
                { runClaudeRemoteAgentSdk: mockAgentSdk },
            ),
        ).rejects.toThrow(/exited with code 1/);

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
    });

    it('still routes to Agent SDK runner when enabled even if --mcp-config flags are present (runner parses and maps to mcpServers)', async () => {
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
            { runClaudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
    });

    it('routes to Agent SDK runner even when the enablement flag is disabled on first message', async () => {
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
            { runClaudeRemoteAgentSdk: mockAgentSdk },
        );

        expect(onRunnerSelected).toHaveBeenCalledWith('agentSdk');
        expect(mockAgentSdk).toHaveBeenCalledTimes(1);
    });
});
