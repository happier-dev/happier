import { describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startPluginHostedMcpLoopbackServer } from './startPluginHostedMcpLoopbackServer';

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 3_000): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
    });
    return { promise, resolve, reject };
}

describe('startPluginHostedMcpLoopbackServer', () => {
    it('lists and calls plugin-declared hosted tools through a real MCP client', async () => {
        const calls: unknown[] = [];
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.echo',
                            title: 'Acme Echo',
                            description: 'Echoes text.',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    text: { type: 'string' },
                                },
                                required: ['text'],
                                additionalProperties: false,
                            },
                            handler: async (args, context) => {
                                calls.push({ args, context });
                                const text = typeof (args as { text?: unknown }).text === 'string'
                                    ? (args as { text: string }).text
                                    : '';
                                return {
                                    content: [
                                        {
                                            type: 'text',
                                            text: `${context.pluginId}:${context.serverId}:${context.toolName}:${text}`,
                                            annotations: { audience: ['user'] },
                                        },
                                    ],
                                    structuredContent: { echoed: text },
                                };
                            },
                        },
                    ],
                },
            },
        });
        const client = new Client({ name: 'plugin-hosted-tools-test', version: '1.0.0' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );

            const tools = await withTimeout(client.listTools(), 'list hosted MCP tools');
            expect((tools.tools ?? []).map((tool) => tool.name)).toContain('ext.acme.echo');

            const result = await withTimeout(
                client.callTool({ name: 'ext.acme.echo', arguments: { text: 'hello' } }),
                'call hosted MCP tool',
            );
            expect(result).toEqual(expect.objectContaining({
                content: [
                    {
                        type: 'text',
                        text: 'acme:acme.hosted:ext.acme.echo:hello',
                        annotations: { audience: ['user'] },
                    },
                ],
                structuredContent: { echoed: 'hello' },
            }));
            expect(calls).toEqual([
                expect.objectContaining({
                    args: { text: 'hello' },
                    context: expect.objectContaining({
                        pluginId: 'acme',
                        serverId: 'acme.hosted',
                        toolName: 'ext.acme.echo',
                        signal: expect.any(AbortSignal),
                    }),
                }),
            ]);
        } finally {
            await client.close();
            await server.dispose();
        }
    });

    it('rejects unprefixed hosted tool names before opening a loopback endpoint', async () => {
        const startPromise = startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'acme_echo',
                            handler: async () => ({ content: [{ type: 'text', text: 'unexpected' }] }),
                        },
                    ],
                },
            },
        });
        try {
            await expect(startPromise).rejects.toThrow(/hosted MCP tool name/i);
        } finally {
            await startPromise.then((server) => server.dispose(), () => undefined);
        }
    });

    it('rejects ext namespaces that do not match the current plugin id', async () => {
        const startPromise = startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.other.echo',
                            handler: async () => ({ content: [{ type: 'text', text: 'unexpected' }] }),
                        },
                    ],
                },
            },
        });
        try {
            await expect(startPromise).rejects.toThrow(/plugin namespace/i);
        } finally {
            await startPromise.then((server) => server.dispose(), () => undefined);
        }
    });

    it('rejects hosted tool definitions on non-hosted transports before opening a loopback endpoint', async () => {
        const startPromise = startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.remote',
                name: 'acme-remote',
                transport: { kind: 'http', url: 'https://mcp.example.test' },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.echo',
                            handler: async () => ({ content: [{ type: 'text', text: 'unexpected' }] }),
                        },
                    ],
                },
            },
        });
        try {
            await expect(startPromise).rejects.toThrow(/hosted MCP handlers require hosted transport/i);
        } finally {
            await startPromise.then((server) => server.dispose(), () => undefined);
        }
    });

    it('starts a sanitized loopback MCP endpoint and closes it on dispose', async () => {
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
            },
        });
        let client: Client | null = null;
        try {
            expect(server.endpoint).toMatchObject({
                kind: 'loopbackHttp',
                host: '127.0.0.1',
            });
            expect(server.endpoint.url).toBe(`http://127.0.0.1:${server.endpoint.port}`);

            client = new Client({ name: 'plugin-hosted-test', version: '1.0.0' }, { capabilities: {} });
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );

            expect(client).not.toBeNull();
        } finally {
            await client?.close();
            await server.dispose();
        }

        const closedClient = new Client({ name: 'plugin-hosted-closed-test', version: '1.0.0' }, { capabilities: {} });
        await expect(withTimeout(
            closedClient.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
            'connect disposed hosted MCP endpoint',
            500,
        )).rejects.toThrow();
    });

    it('rejects invalid hosted tool input without invoking the plugin handler', async () => {
        const handler = vi.fn(async () => ({
            content: [{ type: 'text' as const, text: 'unexpected' }],
        }));
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.validated',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    text: { type: 'string' },
                                },
                                required: ['text'],
                                additionalProperties: false,
                            },
                            handler,
                        },
                    ],
                },
            },
        });
        const client = new Client({ name: 'plugin-hosted-invalid-input-test', version: '1.0.0' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );

            const result = await withTimeout(
                client.callTool({ name: 'ext.acme.validated', arguments: { text: 12 } }),
                'call hosted MCP tool with invalid input',
            );
            expect(result).toEqual(expect.objectContaining({
                isError: true,
                content: [{ type: 'text', text: 'Invalid MCP tool input' }],
            }));
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await client.close();
            await server.dispose();
        }
    });

    it('rejects non-object hosted tool input schemas without invoking the plugin handler', async () => {
        const handler = vi.fn(async () => ({
            content: [{ type: 'text' as const, text: 'unexpected' }],
        }));
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.non_object_input_schema',
                            inputSchema: 'not-a-schema',
                            handler,
                        },
                    ],
                },
            },
        });
        const client = new Client({ name: 'plugin-hosted-non-object-input-schema-test', version: '1.0.0' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );

            const result = await withTimeout(
                client.callTool({ name: 'ext.acme.non_object_input_schema', arguments: { text: 'hello' } }),
                'call hosted MCP tool with non-object input schema',
            );
            expect(result).toEqual(expect.objectContaining({
                isError: true,
                content: [{ type: 'text', text: 'Invalid MCP tool input' }],
            }));
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await client.close();
            await server.dispose();
        }
    });

    it('rejects malformed hosted tool input schemas without invoking the plugin handler', async () => {
        const handler = vi.fn(async () => ({
            content: [{ type: 'text' as const, text: 'unexpected' }],
        }));
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.malformed_input_schema',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    text: { type: 'string' },
                                },
                                required: 'text',
                            },
                            handler,
                        },
                    ],
                },
            },
        });
        const client = new Client({ name: 'plugin-hosted-malformed-input-schema-test', version: '1.0.0' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );

            const result = await withTimeout(
                client.callTool({ name: 'ext.acme.malformed_input_schema', arguments: { text: 'hello' } }),
                'call hosted MCP tool with malformed input schema',
            );
            expect(result).toEqual(expect.objectContaining({
                isError: true,
                content: [{ type: 'text', text: 'Invalid MCP tool input' }],
            }));
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await client.close();
            await server.dispose();
        }
    });

    it('redacts plugin handler errors before returning MCP results', async () => {
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.fails',
                            handler: async () => {
                                throw new Error('raw-token: secret stack detail');
                            },
                        },
                    ],
                },
            },
        });
        const client = new Client({ name: 'plugin-hosted-error-redaction-test', version: '1.0.0' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );

            const result = await withTimeout(
                client.callTool({ name: 'ext.acme.fails', arguments: {} }),
                'call failing hosted MCP tool',
            );
            expect(result).toEqual(expect.objectContaining({
                isError: true,
                content: [{ type: 'text', text: 'Hosted MCP tool failed' }],
            }));
            expect(JSON.stringify(result)).not.toContain('raw-token');
        } finally {
            await client.close();
            await server.dispose();
        }
    });

    it('aborts in-flight hosted tool handlers when the endpoint is disposed', async () => {
        const started = createDeferred<void>();
        const aborted = createDeferred<void>();
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.waits',
                            handler: async (_args, context) => {
                                started.resolve();
                                if (!context.signal.aborted) {
                                    await new Promise<void>((resolve) => {
                                        context.signal.addEventListener('abort', () => resolve(), { once: true });
                                    });
                                }
                                aborted.resolve();
                                return {
                                    content: [{ type: 'text', text: 'aborted' }],
                                    isError: true,
                                };
                            },
                        },
                    ],
                },
            },
        });
        const client = new Client({ name: 'plugin-hosted-abort-test', version: '1.0.0' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );
            const call = client.callTool({ name: 'ext.acme.waits', arguments: {} }).catch((error: unknown) => error);
            await withTimeout(started.promise, 'start hosted MCP tool call');

            await server.dispose();

            await withTimeout(aborted.promise, 'abort hosted MCP tool call');
            await withTimeout(call, 'settle aborted hosted MCP tool call');
        } finally {
            await client.close().catch(() => undefined);
            await server.dispose();
        }
    });

    it('rejects malformed hosted tool output schemas without invoking the plugin handler', async () => {
        const handler = vi.fn(async () => ({
            content: [{ type: 'text' as const, text: 'unexpected' }],
            structuredContent: { echoed: 'hello' },
        }));
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.malformed_output_schema',
                            outputSchema: {
                                type: 'object',
                                properties: {
                                    echoed: { type: 'string' },
                                },
                                required: 'echoed',
                            },
                            handler,
                        },
                    ],
                },
            },
        });
        const client = new Client({ name: 'plugin-hosted-malformed-output-schema-test', version: '1.0.0' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );

            const result = await withTimeout(
                client.callTool({ name: 'ext.acme.malformed_output_schema', arguments: {} }),
                'call hosted MCP tool with malformed output schema',
            );
            expect(result).toEqual(expect.objectContaining({
                isError: true,
                content: [{ type: 'text', text: 'Invalid MCP tool output' }],
            }));
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await client.close();
            await server.dispose();
        }
    });

    it('rejects non-object hosted tool output schemas without invoking the plugin handler', async () => {
        const handler = vi.fn(async () => ({
            content: [{ type: 'text' as const, text: 'unexpected' }],
            structuredContent: { echoed: 'hello' },
        }));
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.non_object_output_schema',
                            outputSchema: 'not-a-schema',
                            handler,
                        },
                    ],
                },
            },
        });
        const client = new Client({ name: 'plugin-hosted-non-object-output-schema-test', version: '1.0.0' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );

            const result = await withTimeout(
                client.callTool({ name: 'ext.acme.non_object_output_schema', arguments: {} }),
                'call hosted MCP tool with non-object output schema',
            );
            expect(result).toEqual(expect.objectContaining({
                isError: true,
                content: [{ type: 'text', text: 'Invalid MCP tool output' }],
            }));
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await client.close();
            await server.dispose();
        }
    });

    it('rejects invalid hosted tool structured output without leaking plugin data', async () => {
        const server = await startPluginHostedMcpLoopbackServer({
            pluginId: 'acme',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted',
                    exposure: { kind: 'loopbackHttp', requested: true },
                },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.invalid_output',
                            outputSchema: {
                                type: 'object',
                                properties: {
                                    echoed: { type: 'string' },
                                },
                                required: ['echoed'],
                                additionalProperties: false,
                            },
                            handler: async () => ({
                                content: [{ type: 'text', text: 'raw-token: secret output detail' }],
                                structuredContent: { echoed: 12 },
                            }),
                        },
                    ],
                },
            },
        });
        const client = new Client({ name: 'plugin-hosted-invalid-output-test', version: '1.0.0' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint.url))),
                'connect hosted MCP endpoint',
            );

            const result = await withTimeout(
                client.callTool({ name: 'ext.acme.invalid_output', arguments: {} }),
                'call hosted MCP tool with invalid output',
            );
            expect(result).toEqual(expect.objectContaining({
                isError: true,
                content: [{ type: 'text', text: 'Invalid MCP tool output' }],
            }));
            expect(JSON.stringify(result)).not.toContain('raw-token');
        } finally {
            await client.close();
            await server.dispose();
        }
    });
});
