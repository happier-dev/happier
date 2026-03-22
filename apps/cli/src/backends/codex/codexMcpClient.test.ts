import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { dirname } from 'node:path';
import { getCodexElicitationToolCallId, getCodexEventToolCallId } from './codexMcpClient';
import type { Mock } from 'vitest';
import { getCodexMcpCommand } from './mcp/version';
import { getCodexElicitationToolCallId as getCodexElicitationToolCallIdFromModule } from './mcp/elicitationTypes';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { removeTempDir } from '@/testkit/fs/tempDir';

// NOTE: This test suite uses mocks because the real Codex CLI / MCP transport
// is not guaranteed to be available in CI or local test environments.
vi.mock('child_process', () => ({
    execFileSync: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', async () => {
    const { z } = await import('zod');
    return {
        RequestSchema: z.object({
            jsonrpc: z.literal('2.0').optional(),
            id: z.union([z.string(), z.number()]).optional(),
            method: z.string(),
            params: z.unknown().optional(),
        }).passthrough(),
        ElicitRequestParamsSchema: z.object({
            message: z.string().optional(),
            codex_elicitation: z.string().optional(),
            codex_call_id: z.string().optional(),
            codex_mcp_tool_call_id: z.string().optional(),
        }).passthrough(),
        ElicitRequestSchema: z.object({
            method: z.literal('elicitation/create'),
            params: z.unknown(),
        }).passthrough(),
    };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
    const instances: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];

    class StdioClientTransport {
        public command: string;
        public args: string[];
        public env: Record<string, string>;

        constructor(opts: { command: string; args: string[]; env: Record<string, string> }) {
            this.command = opts.command;
            this.args = opts.args;
            this.env = opts.env;
            instances.push(this);
        }
    }

    return { StdioClientTransport, __transportInstances: instances };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
    class Client {
        setNotificationHandler() {}
        setRequestHandler() {}
        async connect() {}
        async close() {}
    }

    return { Client };
});

const envKeys = ['PATH', 'HAPPIER_CODEX_PATH'] as const;
const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function createFakeCodexBinary(): Promise<string> {
    const binPath = await createExecutableShim({
        dirPrefix: 'happier-codex-mcp-client-',
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
    });
    const dir = dirname(binPath);
    TEMP_DIRS.add(dir);
    return binPath;
}

beforeEach(async () => {
    process.env.PATH = '';
    process.env.HAPPIER_CODEX_PATH = await createFakeCodexBinary();
});

afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    for (const dir of TEMP_DIRS) await removeTempDir(dir);
    TEMP_DIRS.clear();
});

describe('CodexMcpClient elicitation ids', () => {
    it('prefers codex_call_id over codex_mcp_tool_call_id', () => {
        expect(getCodexElicitationToolCallId({
            codex_mcp_tool_call_id: 'mcp-1',
            codex_call_id: 'call-1',
        })).toBe('call-1');
    });

    it('falls back to codex_mcp_tool_call_id when codex_call_id is missing', () => {
        expect(getCodexElicitationToolCallId({
            codex_mcp_tool_call_id: 'mcp-1',
        })).toBe('mcp-1');
    });

    it('returns undefined when ids are missing or not strings', () => {
        expect(getCodexElicitationToolCallId({ codex_call_id: 1 })).toBeUndefined();
        expect(getCodexElicitationToolCallId({ codex_mcp_tool_call_id: null })).toBeUndefined();
        expect(getCodexElicitationToolCallId({})).toBeUndefined();
    });
});

describe('Codex MCP extracted module surfaces', () => {
    it('exposes version-driven mcp command selection helper', () => {
        expect(getCodexMcpCommand('codex')).toMatch(/^(mcp|mcp-server)$/);
    });

    it('exposes elicitation id helper from extracted module', () => {
        expect(getCodexElicitationToolCallIdFromModule({ codex_call_id: 'call-1' })).toBe('call-1');
    });
});

describe('CodexMcpClient event ids', () => {
    it('prefers call_id over mcp_tool_call_id', () => {
        expect(getCodexEventToolCallId({
            mcp_tool_call_id: 'mcp-1',
            call_id: 'call-1',
        })).toBe('call-1');
    });

    it('falls back to mcp_tool_call_id when call_id is missing', () => {
        expect(getCodexEventToolCallId({
            mcp_tool_call_id: 'mcp-1',
        })).toBe('mcp-1');
    });

    it('accepts codex_call_id/codex_mcp_tool_call_id aliases', () => {
        expect(getCodexEventToolCallId({
            codex_call_id: 'call-2',
            codex_mcp_tool_call_id: 'mcp-2',
        })).toBe('call-2');
    });

    it('returns undefined when event ids are missing or invalid', () => {
        expect(getCodexEventToolCallId({ call_id: 123 })).toBeUndefined();
        expect(getCodexEventToolCallId({ mcp_tool_call_id: [] })).toBeUndefined();
        expect(getCodexEventToolCallId({})).toBeUndefined();
    });
});

describe('CodexMcpClient command detection', () => {
    async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        if (!descriptor) {
            return run();
        }

        Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
        try {
            return await run();
        } finally {
            Object.defineProperty(process, 'platform', descriptor);
        }
    }

    async function getTransportInstances() {
        const stdioModule = await import('@modelcontextprotocol/sdk/client/stdio.js') as unknown as {
            __transportInstances: Array<{ command: string; args: string[]; env: Record<string, string> }>;
        };
        return stdioModule.__transportInstances;
    }

    async function getExecFileSyncMock(): Promise<Mock> {
        const childProcessModule = await import('child_process');
        return childProcessModule.execFileSync as unknown as Mock;
    }

    it('does not treat "codex <version>" output as "not installed"', async () => {
        vi.resetModules();

        const execFileSync = await getExecFileSyncMock();
        execFileSync.mockReturnValue('codex 0.43.0-alpha.5\n');

        const transportInstances = await getTransportInstances();
        transportInstances.length = 0;

        const mod = await import('./codexMcpClient');

        const client = new mod.CodexMcpClient();
        await expect(client.connect()).resolves.toBeUndefined();

        expect(transportInstances).toHaveLength(1);
        expect(transportInstances[0]?.command).toBe(process.env.HAPPIER_CODEX_PATH);
        expect(transportInstances[0]?.args).toEqual(['mcp-server']);
    });

    it('fails closed when no Codex CLI source is available', async () => {
        vi.resetModules();
        delete process.env.HAPPIER_CODEX_PATH;
        process.env.PATH = '';

        const mod = await import('./codexMcpClient');
        expect(() => new mod.CodexMcpClient()).toThrow(/system install/i);
    });

    it('uses legacy "mcp" subcommand for older codex versions', async () => {
        vi.resetModules();

        const execFileSync = await getExecFileSyncMock();
        execFileSync.mockReturnValue('codex 0.42.0\n');

        const transportInstances = await getTransportInstances();
        transportInstances.length = 0;

        const mod = await import('./codexMcpClient');
        const client = new mod.CodexMcpClient();
        await expect(client.connect()).resolves.toBeUndefined();

        expect(transportInstances).toHaveLength(1);
        expect(transportInstances[0]?.args).toEqual(['mcp']);
    });

    it('throws a clear install error when codex --version fails', async () => {
        vi.resetModules();

        const execFileSync = await getExecFileSyncMock();
        execFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });

        const mod = await import('./codexMcpClient');
        const client = new mod.CodexMcpClient();
        await expect(client.connect()).rejects.toThrow(/not found or not executable/i);
    });

    it('wraps .cmd codex CLIs with cmd.exe on Windows', async () => {
        await withPlatform('win32', async () => {
            vi.resetModules();

            const execFileSync = await getExecFileSyncMock();
            execFileSync.mockReturnValue('codex 0.43.0-alpha.5\n');
            execFileSync.mockClear();

            const transportInstances = await getTransportInstances();
            transportInstances.length = 0;

            const codexCmdPath = 'C:\\Users\\herbz\\AppData\\Roaming\\npm\\codex.CMD';
            const mod = await import('./codexMcpClient');
            const client = new mod.CodexMcpClient({ command: codexCmdPath });
            await expect(client.connect()).resolves.toBeUndefined();

            expect(execFileSync).toHaveBeenCalled();
            const [command, args, options] = execFileSync.mock.calls[0] ?? [];
            expect(command).toBe('cmd.exe');
            expect(args?.slice?.(0, 3)).toEqual(['/d', '/s', '/c']);
            expect(args?.[3]).toContain(codexCmdPath);
            expect(args?.[3]).toContain('--version');
            expect(options).toEqual(expect.objectContaining({ encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }));

            expect(transportInstances).toHaveLength(1);
            expect(transportInstances[0]?.command).toBe(codexCmdPath);
            expect(transportInstances[0]?.args).toEqual(['mcp-server']);
        });
    });

    it('wraps .cmd mcp-server commands with cmd.exe on Windows', async () => {
        await withPlatform('win32', async () => {
            vi.resetModules();

            const execFileSync = await getExecFileSyncMock();
            execFileSync.mockClear();

            const transportInstances = await getTransportInstances();
            transportInstances.length = 0;

            const mcpServerCmdPath = 'C:\\Users\\herbz\\AppData\\Local\\Happier\\some-mcp-server.CMD';
            const mod = await import('./codexMcpClient');
            const client = new mod.CodexMcpClient({
                mode: 'mcp-server',
                command: mcpServerCmdPath,
                args: ['--stdio'],
            });
            await expect(client.connect()).resolves.toBeUndefined();

            expect(execFileSync).not.toHaveBeenCalled();
            expect(transportInstances).toHaveLength(1);
            expect(transportInstances[0]?.command).toBe(mcpServerCmdPath);
            expect(transportInstances[0]?.args).toEqual(['--stdio']);
        });
    });

    it('does not run version detection in mcp-server mode and forwards configured args', async () => {
        vi.resetModules();

        const execFileSync = await getExecFileSyncMock();
        execFileSync.mockClear();

        const transportInstances = await getTransportInstances();
        transportInstances.length = 0;

        const mod = await import('./codexMcpClient');
        const client = new mod.CodexMcpClient({ mode: 'mcp-server', command: '/tmp/some-mcp-server', args: ['--stdio'] });
        await expect(client.connect()).resolves.toBeUndefined();

        expect(execFileSync).not.toHaveBeenCalled();
        expect(transportInstances).toHaveLength(1);
        expect(transportInstances[0]?.command).toBe('/tmp/some-mcp-server');
        expect(transportInstances[0]?.args).toEqual(['--stdio']);
    });
});
