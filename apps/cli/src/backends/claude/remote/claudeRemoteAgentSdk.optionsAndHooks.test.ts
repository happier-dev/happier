import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import { resolveClaudeProjectId } from '../utils/path';

const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const { ensureJavaScriptRuntimeExecutableMock } = vi.hoisted(() => ({
    ensureJavaScriptRuntimeExecutableMock: vi.fn(async () => '/managed/js-runtime'),
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
    ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

afterEach(() => {
    if (typeof ORIGINAL_CLAUDE_CONFIG_DIR === 'string') {
        process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
    } else {
        delete process.env.CLAUDE_CONFIG_DIR;
    }
});

describe('claudeRemoteAgentSdk options and hooks', () => {
    afterEach(() => {
        ensureJavaScriptRuntimeExecutableMock.mockReset();
        ensureJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');
    });

    it('yields stream-json user messages as objects (Agent SDK stringifies them)', async () => {
        let promptFirstChunk: unknown = null;
        let promptReadPromise: Promise<void> | null = null;

        const createQuery = vi.fn((_params: any) => {
            promptReadPromise = (async () => {
                const prompt = _params.prompt as AsyncIterable<unknown>;
                const iterator = prompt[Symbol.asyncIterator]();
                const first = await iterator.next();
                promptFirstChunk = first.value;
            })();

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
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
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

        await promptReadPromise;

        expect(typeof promptFirstChunk).toBe('object');
        expect(promptFirstChunk).toBeTruthy();
        const message = promptFirstChunk as any;
        expect(message.type).toBe('user');
        expect(message.message?.role).toBe('user');
        expect(message.message?.content?.[0]?.type).toBe('text');
        expect(message.message?.content?.[0]?.text).toBe('hello');
    });

    it('does not set allowedTools when the mode does not provide an allowlist override', async () => {
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
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
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

        expect(capturedOptions).toBeTruthy();
        expect(capturedOptions.allowedTools).toBeUndefined();
    });

    it('passes debug and verbose flags via extraArgs when enabled', async () => {
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
                mode: makeMode({
                    permissionMode: 'default',
                    claudeRemoteDebugEnabled: true,
                    claudeRemoteVerboseEnabled: true,
                    claudeRemoteDebugCategories: ['mcp', 'api', 'bogus', 'file'],
                } as any),
            };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
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

        expect(capturedOptions).toBeTruthy();
        // Debug categories normalized to stable order, invalid dropped.
        expect(capturedOptions.extraArgs).toMatchObject({
            debug: 'api,mcp,file',
            verbose: null,
        });
    });

    it('passes effort when the mode specifies a reasoningEffort', async () => {
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
                mode: makeMode({ permissionMode: 'default', model: 'claude-opus-4-6', reasoningEffort: 'max' } as any),
            };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
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

        expect(capturedOptions).toBeTruthy();
        expect(capturedOptions.model).toBe('claude-opus-4-6');
        expect(capturedOptions.effort).toBe('max');
    });

    it('exposes a turn interrupt handler that calls query.interrupt()', async () => {
        const interrupt = vi.fn(async () => {});
        let capturedTurnInterrupt: null | (() => Promise<void>) = null;

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                interrupt,
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
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            setTurnInterrupt: (next: (() => Promise<void>) | null) => {
                if (next) capturedTurnInterrupt = next;
            },
            createQuery,
        } as any);

        if (!capturedTurnInterrupt) {
            throw new Error('Expected claudeRemoteAgentSdk to register a turn interrupt handler');
        }
        await (capturedTurnInterrupt as unknown as () => Promise<void>)();
        expect(interrupt).toHaveBeenCalled();
    });

    it('omits effort when the mode specifies reasoningEffort=high (provider default)', async () => {
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
                mode: makeMode({ permissionMode: 'default', model: 'claude-opus-4-6', reasoningEffort: 'high' } as any),
            };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
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

        expect(capturedOptions).toBeTruthy();
        expect(capturedOptions.model).toBe('claude-opus-4-6');
        expect('effort' in capturedOptions ? capturedOptions.effort : undefined).toBeUndefined();
    });

    it('uses the resolved JavaScript runtime path instead of a raw node default', async () => {
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
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
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

        expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalled();
        expect(capturedOptions?.executable).toBe('/managed/js-runtime');
    });

    it('passes all settingSources by default (Agent SDK defaults to an empty list when unset)', async () => {
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
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
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

        expect(capturedOptions).toBeTruthy();
        expect(capturedOptions.settingSources).toEqual(['user', 'project', 'local']);
    });

    it('forwards settingSources when explicitly set on the mode', async () => {
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
                mode: makeMode({ permissionMode: 'default', claudeRemoteSettingSources: 'project' } as any),
            };
        });

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
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

        expect(capturedOptions).toBeTruthy();
        expect(capturedOptions.settingSources).toEqual(['project']);
    });

    it('keeps settingSources fail-closed when the legacy mode explicitly selects none', async () => {
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
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ permissionMode: 'default', claudeRemoteSettingSources: 'none' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedOptions).toBeTruthy();
        expect(capturedOptions.settingSources).toEqual([]);
    });

    it('sets resumeSessionAt when resuming and caller provides an anchor uuid', async () => {
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

        const dir = await mkdtemp(join(tmpdir(), 'happier-claude-agent-sdk-'));
        const transcriptPath = join(dir, 'sess_1.jsonl');
        await writeFile(transcriptPath, `${JSON.stringify({ uuid: 'line_1' })}\n`);

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

        await claudeRemoteAgentSdk({
            sessionId: 'sess_1',
            transcriptPath,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            resumeSessionAt: 'asst_uuid_99',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedOptions?.resume).toBe('sess_1');
        expect(capturedOptions?.resumeSessionAt).toBe('asst_uuid_99');
    });

    it('injects Happier MCP servers when provided', async () => {
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
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

        const happierMcpServers = {
            happier: { command: 'node', args: ['happier-mcp.mjs', '--url', 'http://127.0.0.1:1234'] },
        };

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                happierMcpServers,
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedOptions).toBeTruthy();
        expect(capturedOptions.mcpServers).toEqual(happierMcpServers);
    });

    it('merges --mcp-config mcpServers into injected MCP servers when using the Agent SDK runner', async () => {
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
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

        const happierMcpServers = {
            happier: { command: 'node', args: ['happier-mcp.mjs', '--url', 'http://127.0.0.1:1234'] },
        };
        const userMcpConfig = JSON.stringify({
            mcpServers: {
                custom: { type: 'http', url: 'http://127.0.0.1:9999' },
            },
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: ['--mcp-config', userMcpConfig],
            claudeExecutablePath: '/tmp/claude',
            happierMcpServers,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedOptions).toBeTruthy();
        expect(capturedOptions.mcpServers).toEqual(expect.objectContaining({
            custom: { type: 'http', url: 'http://127.0.0.1:9999' },
            happier: expect.anything(),
        }));
        // Happier MCP always wins on name collisions.
        expect(capturedOptions.mcpServers.happier).toEqual(happierMcpServers.happier);
    });

    it('forwards explicit GUI/profile env keys into the Claude subprocess env even when not allowlisted', async () => {
        const originalToken = process.env.GITHUB_TOKEN;
        const originalMarker = process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON;
        process.env.GITHUB_TOKEN = 'ghp_test';
        process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON = JSON.stringify(['GITHUB_TOKEN']);

        try {
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
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
            });

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
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

            expect(capturedOptions).toBeTruthy();
            expect(capturedOptions.env).toBeTruthy();
            expect(capturedOptions.env.GITHUB_TOKEN).toBe('ghp_test');
            expect(capturedOptions.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON).toBeUndefined();
        } finally {
            if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
            else process.env.GITHUB_TOKEN = originalToken;
            if (originalMarker === undefined) delete process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON;
            else process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON = originalMarker;
        }
    });

    it('injects isolated XDG dirs so Claude Code does not contend with global version locks', async () => {
        const originals = {
            XDG_DATA_HOME: process.env.XDG_DATA_HOME,
            XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
            XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        };

        delete process.env.XDG_DATA_HOME;
        delete process.env.XDG_CACHE_HOME;
        delete process.env.XDG_STATE_HOME;

        try {
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
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
            });

            await claudeRemoteAgentSdk({
                sessionId: 'sess_1',
                transcriptPath: null,
                path: '/tmp',
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

            expect(capturedOptions?.env).toBeTruthy();
            expect(typeof capturedOptions.env.XDG_DATA_HOME).toBe('string');
            expect(typeof capturedOptions.env.XDG_CACHE_HOME).toBe('string');
            expect(typeof capturedOptions.env.XDG_STATE_HOME).toBe('string');
            expect(capturedOptions.env.XDG_DATA_HOME).toContain(join(configuration.activeServerDir, 'isolation'));
            expect(capturedOptions.env.XDG_CACHE_HOME).toContain(join(configuration.activeServerDir, 'isolation'));
            expect(capturedOptions.env.XDG_STATE_HOME).toContain(join(configuration.activeServerDir, 'isolation'));
        } finally {
            if (originals.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = originals.XDG_DATA_HOME;
            if (originals.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = originals.XDG_CACHE_HOME;
            if (originals.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = originals.XDG_STATE_HOME;
        }
    });

    it('injects Claude Code experimental Agent Teams env var when enabled on the mode', async () => {
        const original = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
        delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

        try {
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
                    mode: makeMode({ permissionMode: 'default', claudeCodeExperimentalAgentTeamsEnabled: true } as any),
                };
            });

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
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

            expect(capturedOptions).toBeTruthy();
            expect(capturedOptions.env).toBeTruthy();
            expect(capturedOptions.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
        } finally {
            if (typeof original === 'string') process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = original;
            else delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
        }
    });

    it('always sets allowDangerouslySkipPermissions so permission mode can escalate to bypassPermissions at runtime', async () => {
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

        const runOnce = async (modeOverrides: any) => {
            capturedOptions = null;
            let didSendFirst = false;
            const nextMessage = vi.fn(async () => {
                if (didSendFirst) return null;
                didSendFirst = true;
                return { message: 'hello', mode: makeMode(modeOverrides) };
            });

                await claudeRemoteAgentSdk({
                    sessionId: null,
                    transcriptPath: null,
                    path: '/tmp',
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

        expect((await runOnce({ permissionMode: 'default' }))?.allowDangerouslySkipPermissions).toBe(true);
        expect((await runOnce({ permissionMode: 'bypassPermissions' }))?.allowDangerouslySkipPermissions).toBe(true);
        expect((await runOnce({ permissionMode: 'default', agentModeId: 'plan' }))?.allowDangerouslySkipPermissions).toBe(true);
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
            if (callCount === 2) return { message: 'second', mode: makeMode({ permissionMode: 'yolo' }) };
            return null;
        });

        await expect(
                claudeRemoteAgentSdk({
                    sessionId: null,
                    transcriptPath: null,
                    path: '/tmp',
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

    it('does not redundantly apply runtime settings when mode is unchanged', async () => {
        let response: any = null;
        const createQuery = vi.fn((_params: any) => {
            response = {
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
            return response;
        });

        let callCount = 0;
        const nextMessage = vi.fn(async () => {
            callCount += 1;
            if (callCount === 1) return { message: 'first', mode: makeMode({ permissionMode: 'default', model: 'model-a' }) };
            if (callCount === 2) return { message: 'second', mode: makeMode({ permissionMode: 'default', model: 'model-a' }) };
            return null;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
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

        expect(createQuery).toHaveBeenCalledTimes(1);
        expect(response?.setPermissionMode).toHaveBeenCalledTimes(0);
        expect(response?.setModel).toHaveBeenCalledTimes(0);
        expect(response?.setMaxThinkingTokens).toHaveBeenCalledTimes(0);
    });

    it('switches a follow-up read-only turn into dontAsk before sending it to the running SDK session', async () => {
        let response: any = null;
        const createQuery = vi.fn((_params: any) => {
            response = {
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
            return response;
        });

        let callCount = 0;
        const nextMessage = vi.fn(async () => {
            callCount += 1;
            if (callCount === 1) return { message: 'first', mode: makeMode({ permissionMode: 'default' }) };
            if (callCount === 2) return { message: 'second', mode: makeMode({ permissionMode: 'read-only' }) };
            return null;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
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

        expect(response?.setPermissionMode).toHaveBeenCalledWith('dontAsk');
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

            process.env.CLAUDE_CONFIG_DIR = '/tmp/claude_cfg';

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
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
                transcript_path: `/tmp/claude_cfg/projects/${resolveClaudeProjectId('/tmp')}/sess_999.jsonl`,
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

            process.env.CLAUDE_CONFIG_DIR = '/tmp/claude_cfg';

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
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
                transcript_path: `/tmp/claude_cfg/projects/${resolveClaudeProjectId('/tmp')}/sess_abc.jsonl`,
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

            process.env.CLAUDE_CONFIG_DIR = '/tmp/claude_cfg';

            await claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
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
                transcript_path: `/tmp/claude_cfg/projects/${resolveClaudeProjectId('/tmp')}/sess_init.jsonl`,
            }),
        );
    });

    it('maps claudeRemoteSettingSourcesV2 into Agent SDK settingSources', async () => {
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
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteSettingSourcesV2: ['user', 'project'], claudeRemoteAgentSdkEnabled: true } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedOptions?.settingSources).toEqual(['user', 'project']);
    });

    it('passes all settingSources when claudeRemoteSettingSourcesV2 selects all sources', async () => {
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
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteSettingSourcesV2: ['user', 'project', 'local'], claudeRemoteAgentSdkEnabled: true } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedOptions?.settingSources).toEqual(['user', 'project', 'local']);
    });

    it('keeps settingSources fail-closed when claudeRemoteSettingSourcesV2 explicitly selects no sources', async () => {
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
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteSettingSourcesV2: [], claudeRemoteAgentSdkEnabled: true } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(capturedOptions?.settingSources).toEqual([]);
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

    it('includes updatedPermissions when canCallTool returns permission updates', async () => {
        const canCallTool = vi.fn(async () => ({
            behavior: 'allow',
            updatedInput: { file_path: '/tmp/file.txt' },
            updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        }));

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
                permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
            },
            'toolu_123',
            { signal: new AbortController().signal },
        );

        expect(output).toEqual(
            expect.objectContaining({
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: {
                        behavior: 'allow',
                        updatedInput: { file_path: '/tmp/file.txt' },
                        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
                    },
                },
            }),
        );
    });

    it('registers PreToolUse hook that scrubs sensitive env vars for Bash commands', async () => {
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

        expect(capturedHooks?.PreToolUse?.[0]?.hooks?.length).toBe(1);

        const output = await capturedHooks.PreToolUse[0].hooks[0]({
            hook_event_name: 'PreToolUse',
            session_id: 'sess_1',
            transcript_path: '/tmp/sess_1.jsonl',
            cwd: '/tmp',
            tool_name: 'Bash',
            tool_input: { command: 'echo hi' },
            tool_use_id: 'toolu_123',
        });

        expect(output).toEqual(
            expect.objectContaining({
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: expect.objectContaining({
                    hookEventName: 'PreToolUse',
                    updatedInput: expect.objectContaining({
                        command: expect.stringContaining('unset '),
                    }),
                }),
            }),
        );
        expect(output.hookSpecificOutput.updatedInput.command).toContain('CLAUDE_CODE_OAUTH_TOKEN');
        expect(output.hookSpecificOutput.updatedInput.command).toContain('ANTHROPIC_AUTH_TOKEN');
        expect(output.hookSpecificOutput.updatedInput.command).toContain('echo hi');
    });

});
