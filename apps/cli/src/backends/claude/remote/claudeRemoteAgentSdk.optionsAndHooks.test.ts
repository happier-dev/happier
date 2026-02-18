import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

describe('claudeRemoteAgentSdk options and hooks', () => {
    it('sets allowDangerouslySkipPermissions only when permissionMode is bypassPermissions', async () => {
        let capturedOptions: any = null;

        const createQuery = vi.fn((_params: any) => {
            capturedOptions = _params.options;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        const runOnce = async (permissionMode: any) => {
            capturedOptions = null;
            let didSendFirst = false;
            const nextMessage = vi.fn(async () => {
                if (didSendFirst) return null;
                didSendFirst = true;
                return { message: 'hello', mode: makeMode({ permissionMode }) };
            });

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
                allowedTools: [],
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                createQuery,
            } as any);

            return capturedOptions;
        };

        expect((await runOnce('default'))?.allowDangerouslySkipPermissions).toBe(false);
        expect((await runOnce('bypassPermissions'))?.allowDangerouslySkipPermissions).toBe(true);
    });

    it('prefers CLI model overrides over mode.model', async () => {
        let capturedOptions: any = null;

        const createQuery = vi.fn((_params: any) => {
            capturedOptions = _params.options;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return {
                message: 'hello',
                mode: makeMode({ model: 'mode-model', fallbackModel: 'mode-fallback' } as any),
            };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: ['--model', 'cli-model', '--fallback-model', 'cli-fallback'],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedOptions?.model).toBe('cli-model');
        expect(capturedOptions?.fallbackModel).toBe('cli-fallback');
    });

    it('does not crash when remote settings updates fail', async () => {
        let response: any = null;
        const createQuery = vi.fn((_params: any) => {
            response = {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(async () => {
                    throw new Error('setPermissionMode failed');
                }),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
            return response;
        });

        let callCount = 0;
        const nextMessage = vi.fn(async () => {
            callCount += 1;
            if (callCount === 1) return { message: 'first', mode: makeMode() };
            if (callCount === 2) return { message: 'second', mode: makeMode() };
            return null;
        });

        await expect(
            claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
                allowedTools: [],
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                createQuery,
            } as any),
        ).resolves.toBeUndefined();

        expect(createQuery).toHaveBeenCalledTimes(1);
        expect(response?.setPermissionMode).toHaveBeenCalledTimes(1);
    });

    it('uses SessionStart hook to publish sessionId + transcript path', async () => {
        const onSessionFound = vi.fn();

        let capturedHooks: any = null;

        const createQuery = vi.fn((_params: any) => {
            capturedHooks = _params.options?.hooks;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode() };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound,
            onMessage: () => {},
            createQuery,
        } as any);

        expect(createQuery).toHaveBeenCalledTimes(1);
        expect(capturedHooks?.SessionStart?.[0]?.hooks?.length).toBe(1);

        await capturedHooks.SessionStart[0].hooks[0](
            {
                hook_event_name: 'SessionStart',
                session_id: 'sess_123',
                transcript_path: '/tmp/sess_123.jsonl',
                cwd: '/tmp',
            },
            undefined,
            { signal: new AbortController().signal },
        );

        expect(onSessionFound).toHaveBeenCalledWith(
            'sess_123',
            expect.objectContaining({ transcript_path: '/tmp/sess_123.jsonl' }),
        );
    });

    it('derives a transcript path when SessionStart hook omits transcript_path/transcriptPath', async () => {
        const onSessionFound = vi.fn();

        let capturedHooks: any = null;

        const createQuery = vi.fn((_params: any) => {
            capturedHooks = _params.options?.hooks;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode() };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeEnvVars: { CLAUDE_CONFIG_DIR: '/tmp/claude_cfg' },
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound,
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedHooks?.SessionStart?.[0]?.hooks?.length).toBe(1);

        await capturedHooks.SessionStart[0].hooks[0](
            {
                hook_event_name: 'SessionStart',
                session_id: 'sess_999',
                cwd: '/tmp',
            },
            undefined,
            { signal: new AbortController().signal },
        );

        expect(onSessionFound).toHaveBeenCalledWith(
            'sess_999',
            expect.objectContaining({
                transcript_path: '/tmp/claude_cfg/projects/-tmp/sess_999.jsonl',
            }),
        );
    });

    it('supports SessionStart hook sessionId (camelCase) when publishing transcript path', async () => {
        const onSessionFound = vi.fn();

        let capturedHooks: any = null;

        const createQuery = vi.fn((_params: any) => {
            capturedHooks = _params.options?.hooks;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode() };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeEnvVars: { CLAUDE_CONFIG_DIR: '/tmp/claude_cfg' },
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound,
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedHooks?.SessionStart?.[0]?.hooks?.length).toBe(1);

        await capturedHooks.SessionStart[0].hooks[0](
            {
                hook_event_name: 'SessionStart',
                sessionId: 'sess_abc',
                cwd: '/tmp',
            },
            undefined,
            { signal: new AbortController().signal },
        );

        expect(onSessionFound).toHaveBeenCalledWith(
            'sess_abc',
            expect.objectContaining({
                transcript_path: '/tmp/claude_cfg/projects/-tmp/sess_abc.jsonl',
            }),
        );
    });

    it('supports SessionStart hook transcriptPath (camelCase) when publishing transcript path', async () => {
        const onSessionFound = vi.fn();

        let capturedHooks: any = null;

        const createQuery = vi.fn((_params: any) => {
            capturedHooks = _params.options?.hooks;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode() };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound,
            onMessage: () => {},
            createQuery,
        } as any);

        expect(createQuery).toHaveBeenCalledTimes(1);

        await capturedHooks.SessionStart[0].hooks[0](
            {
                hook_event_name: 'SessionStart',
                session_id: 'sess_456',
                transcriptPath: '/tmp/sess_456.jsonl',
                cwd: '/tmp',
            },
            undefined,
            { signal: new AbortController().signal },
        );

        expect(onSessionFound).toHaveBeenCalledWith('sess_456', expect.objectContaining({ transcriptPath: '/tmp/sess_456.jsonl' }));
    });

    it('publishes a derived transcript path when system init provides session_id without SessionStart hook data', async () => {
        const onSessionFound = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'system', subtype: 'init', session_id: 'sess_init' } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode() };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeEnvVars: { CLAUDE_CONFIG_DIR: '/tmp/claude_cfg' },
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound,
            onMessage: () => {},
            createQuery,
        } as any);

        expect(onSessionFound).toHaveBeenCalledWith(
            'sess_init',
            expect.objectContaining({
                transcript_path: '/tmp/claude_cfg/projects/-tmp/sess_init.jsonl',
            }),
        );
    });

    it('maps claudeRemoteSettingSources into Agent SDK settingSources', async () => {
        let capturedOptions: any = null;

        const createQuery = vi.fn((_params: any) => {
            capturedOptions = _params.options;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteSettingSources: 'user_project' as any, claudeRemoteAgentSdkEnabled: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedOptions?.settingSources).toEqual(['user', 'project']);
    });

    it('publishes supportedCommands to callback without blocking the loop', async () => {
        const onCapabilities = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => [{ command: '/compact', description: 'Compact context' }]),
                supportedModels: vi.fn(async () => [{ id: 'm1', displayName: 'Model 1' }]),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onCapabilities,
            createQuery,
        } as any);

        expect(onCapabilities).toHaveBeenCalledWith(
            expect.objectContaining({
                slashCommands: ['/compact'],
                slashCommandDetails: [{ command: '/compact', description: 'Compact context' }],
            }),
        );
    });

    it('applies allowlisted advanced options JSON without allowing control-plane overrides', async () => {
        let capturedOptions: any = null;
        const prevArtifactsDir = process.env.HAPPIER_CLAUDE_DEBUG_ARTIFACTS_DIR;
        process.env.HAPPIER_CLAUDE_DEBUG_ARTIFACTS_DIR = '/tmp/happier-claude-debug-artifacts';

        try {
            const createQuery = vi.fn((_params: any) => {
                capturedOptions = _params.options;
                return {
                    async *[Symbol.asyncIterator]() {
                        yield { type: 'result' } as any;
                    },
                    close: vi.fn(),
                    setPermissionMode: vi.fn(),
                    setModel: vi.fn(),
                    setMaxThinkingTokens: vi.fn(),
                    supportedCommands: vi.fn(async () => []),
                    supportedModels: vi.fn(async () => []),
                } as any;
            });

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
                allowedTools: [],
                mcpServers: {},
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage: async () => ({
                    message: 'hello',
                    mode: makeMode({
                        claudeRemoteAgentSdkEnabled: true,
                        claudeRemoteAdvancedOptionsJson: JSON.stringify({
                            plugins: [{ type: 'local', path: '/tmp/plugin' }],
                            hooks: { SessionStart: [] },
                        }),
                    }),
                }),
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                createQuery,
            } as any);

            expect(capturedOptions?.plugins).toEqual([{ type: 'local', path: '/tmp/plugin' }]);
            expect(capturedOptions?.hooks?.SessionStart?.[0]?.hooks?.length).toBe(1);
            expect(typeof capturedOptions?.debugFile).toBe('string');
            expect(capturedOptions?.debugFile).toMatch(/^\/tmp\/happier-claude-debug-artifacts\//);
            expect(typeof capturedOptions?.stderr).toBe('function');
        } finally {
            if (typeof prevArtifactsDir === 'string') process.env.HAPPIER_CLAUDE_DEBUG_ARTIFACTS_DIR = prevArtifactsDir;
            else delete process.env.HAPPIER_CLAUDE_DEBUG_ARTIFACTS_DIR;
        }
    });

    it('omits debugFile and stderr when subprocess artifacts are disabled', async () => {
        const prevEnabled = process.env.HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED;

        let capturedOptions: any = null;
        const createQuery = vi.fn((_params: any) => {
            capturedOptions = _params.options;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        try {
            process.env.HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED = '0';

            let didSendFirst = false;
            const nextMessage = vi.fn(async () => {
                if (didSendFirst) return null;
                didSendFirst = true;
                return { message: 'hello', mode: makeMode() };
            });

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
                allowedTools: [],
                mcpServers: {},
                claudeEnvVars: {},
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                createQuery,
            } as any);

            expect(capturedOptions?.debugFile).toBeUndefined();
            expect(capturedOptions?.stderr).toBeUndefined();
        } finally {
            if (prevEnabled === undefined) delete process.env.HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED;
            else process.env.HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED = prevEnabled;
        }
    });

    it('forwards toolUseID/agentID to canCallTool via canUseTool', async () => {
        let capturedOptions: any = null;
        const canCallTool = vi.fn(async () => ({ behavior: 'allow', updatedInput: {} }));

        const createQuery = vi.fn((_params: any) => {
            capturedOptions = _params.options;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode() };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool,
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(typeof capturedOptions?.canUseTool).toBe('function');

        await capturedOptions.canUseTool(
            'Read',
            { file_path: '/tmp/file.txt' },
            {
                signal: new AbortController().signal,
                toolUseID: 'toolu_123',
                agentID: 'agent_456',
            },
        );

        expect(canCallTool).toHaveBeenCalledWith(
            'Read',
            { file_path: '/tmp/file.txt' },
            expect.anything(),
            expect.objectContaining({ toolUseId: 'toolu_123', agentId: 'agent_456' }),
        );
    });

    it('registers PermissionRequest hook and returns decision payload', async () => {
        const canCallTool = vi.fn(async () => ({ behavior: 'deny', message: 'nope' }));

        let capturedHooks: any = null;
        const createQuery = vi.fn((_params: any) => {
            capturedHooks = _params.options?.hooks;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode() };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            allowedTools: [],
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool,
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedHooks?.PermissionRequest?.[0]?.hooks?.length).toBe(1);

        const output = await capturedHooks.PermissionRequest[0].hooks[0](
            {
                hook_event_name: 'PermissionRequest',
                session_id: 'sess_1',
                transcript_path: '/tmp/sess_1.jsonl',
                cwd: '/tmp',
                tool_name: 'Read',
                tool_input: { file_path: '/tmp/file.txt' },
            },
            'toolu_123',
            { signal: new AbortController().signal },
        );

        expect(canCallTool).toHaveBeenCalledWith(
            'Read',
            { file_path: '/tmp/file.txt' },
            expect.anything(),
            expect.objectContaining({ toolUseId: 'toolu_123' }),
        );

        expect(output).toEqual(
            expect.objectContaining({
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'deny', message: 'nope' },
                },
            }),
        );
    });

});
