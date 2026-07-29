import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
    capabilities: null as unknown,
    handler: null as null | ((request: unknown) => Promise<unknown>),
    close: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    transportUrl: null as URL | null,
    stdioOptions: null as Readonly<Record<string, unknown>> | null,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class {
        constructor(_identity: unknown, options: Readonly<{ capabilities: unknown }>) {
            sdk.capabilities = options.capabilities;
        }
        setRequestHandler(_schema: unknown, handler: (request: unknown) => Promise<unknown>) { sdk.handler = handler; }
        async connect() { await sdk.connect(); }
        async listTools() {
            return { tools: [{ name: 'confirm', inputSchema: { type: 'object' } }] };
        }
        async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; }
        async close() { await sdk.close(); }
    },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: class {
        constructor(url: URL) { sdk.transportUrl = url; }
    },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: class {
        constructor(options: Readonly<Record<string, unknown>>) { sdk.stdioOptions = options; }
    },
}));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({ ElicitRequestSchema: {} }));

import type { ResolvedMcpServerContribution } from '@/plugins/projection/registry/types';
import type { HostCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';
import { createStableDeclaredMcpTransportConnector } from './mcpDeclaredTransport';

describe('stable declared MCP transport connector', () => {
    it('consumes a static HTTP declaration and routes form elicitation through the current session owner', async () => {
        const interactions = vi.fn(async () => ({
            kind: 'questions' as const,
            status: 'answered' as const,
            answers: [{
                questionId: 'approved', selection: 'single' as const,
                answer: { kind: 'choice' as const, choiceId: 'true' },
            }],
        }));
        const declaration: ResolvedMcpServerContribution = {
            provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.static',
            manifestPath: '/plugins/acme.static/plugin.json', manifestDigest: 'sha256:fixture',
            daemonEntryPath: '/plugins/acme.static/daemon.js',
            definition: {
                id: 'remote', title: 'Remote', kind: 'static',
                transport: { kind: 'http', url: 'https://mcp.example.test/' }, sessionScope: 'session',
            },
        };
        const abort = new AbortController();
        const client = await createStableDeclaredMcpTransportConnector()({
            declaration,
            ref: { pluginId: 'acme.static', localId: 'remote' },
            sessionId: 'session-1',
            elicitation: { mode: 'hostMediated', sessionId: 'session-1' },
            seed: {
                plugin: { id: 'caller.plugin', version: '1.0.0' },
                contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
                generation: 'generation-1', correlationId: 'correlation-1', surface: 'agent',
                session: { id: 'session-1' }, currentSession: {
                    interactions: {
                        // The fixture exercises only the questions overload.
                        request: interactions as unknown as HostCurrentSessionInteractionsService['request'],
                    },
                },
                signal: abort.signal, isGenerationCurrent: () => true,
            },
            signal: abort.signal,
        });

        expect(sdk.transportUrl?.href).toBe('https://mcp.example.test/');
        expect(sdk.capabilities).toEqual({ elicitation: { form: {} } });
        await expect(client.listTools()).resolves.toMatchObject({ items: [{ name: 'confirm' }] });
        await expect(client.callTool('confirm', {})).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
        await expect(sdk.handler?.({
            params: {
                mode: 'form', message: 'Approve?',
                requestedSchema: {
                    type: 'object',
                    properties: { approved: { type: 'boolean', title: 'Approved' } },
                    required: ['approved'],
                },
            },
        })).resolves.toEqual({ action: 'accept', content: { approved: true } });
        expect(interactions).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'questions', questions: [expect.objectContaining({ id: 'approved', selection: 'single' })],
        }), expect.objectContaining({ signal: abort.signal }));
        await client.dispose();
        expect(sdk.close).toHaveBeenCalledTimes(1);
    });

    it('resolves a static stdio executable through the host owner and releases it on cleanup', async () => {
        const release = vi.fn();
        const resolveExecutable = vi.fn(async () => Object.freeze({
            command: '/host/bin/acme-mcp',
            args: Object.freeze(['host-owned']),
            env: Object.freeze({ HOST_SECRET: 'attached-by-host' }),
            release,
        }));
        const declaration: ResolvedMcpServerContribution = {
            provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.static',
            manifestPath: '/plugins/acme.static/plugin.json', manifestDigest: 'sha256:fixture',
            daemonEntryPath: '/plugins/acme.static/daemon.js',
            definition: {
                id: 'local', title: 'Local', kind: 'static',
                transport: {
                    kind: 'stdio',
                    executable: { kind: 'systemTool', id: 'acme-mcp' },
                    args: ['serve'],
                },
                sessionScope: 'session',
            },
        };
        const connector = createStableDeclaredMcpTransportConnector({ resolveExecutable });
        const client = await connector({
            declaration,
            ref: { pluginId: 'acme.static', localId: 'local' },
            sessionId: 'session-1',
            elicitation: { mode: 'reject' },
            seed: {
                plugin: { id: 'caller.plugin', version: '1.0.0' },
                contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
                generation: 'generation-1', correlationId: 'correlation-1', surface: 'agent',
                session: { id: 'session-1' },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
        });

        expect(resolveExecutable).toHaveBeenCalledWith(
            { kind: 'systemTool', id: 'acme-mcp' },
            'acme.static',
        );
        expect(sdk.stdioOptions).toEqual({
            command: '/host/bin/acme-mcp',
            args: ['host-owned', 'serve'],
            env: { HOST_SECRET: 'attached-by-host' },
        });

        await client.dispose();
        expect(release).toHaveBeenCalledOnce();
    });
});
