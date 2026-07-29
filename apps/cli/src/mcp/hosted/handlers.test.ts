import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { registerHostedMcpHandlers } from './handlers';

type RegisteredHandler = (
    args: unknown,
    extra?: Readonly<{ signal?: AbortSignal }>,
) => Promise<CallToolResult>;

function captureHostedHandler(params: Readonly<{
    inputSchema: unknown;
    outputSchema?: unknown;
    handler: (
        args: unknown,
        context: Readonly<{ signal: AbortSignal }>,
    ) => Promise<Readonly<{
        content: readonly Readonly<{ type: 'text'; text: string }>[];
        structuredContent?: Record<string, unknown>;
    }>>;
}>): RegisteredHandler {
    let registered: RegisteredHandler | null = null;
    const server = {
        registerTool(
            _name: string,
            _definition: unknown,
            handler: RegisteredHandler,
        ) {
            registered = handler;
        },
    } as unknown as McpServer;
    registerHostedMcpHandlers({
        server,
        pluginId: 'acme',
        spec: {
            id: 'acme.hosted',
            name: 'Acme hosted',
            transport: { kind: 'hosted', exposure: { kind: 'loopbackHttp', requested: true } },
            hosted: {
                tools: [{
                    name: 'ext.acme.safe_json',
                    inputSchema: params.inputSchema,
                    ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
                    handler: params.handler,
                }],
            },
        },
        signal: new AbortController().signal,
    });
    if (!registered) throw new Error('Hosted MCP handler was not registered');
    return registered;
}

describe('registerHostedMcpHandlers JSON Schema safety', () => {
    it('composes MCP request cancellation into the hosted tool context signal', async () => {
        const contextSignals: AbortSignal[] = [];
        const hostedHandler = captureHostedHandler({
            inputSchema: { type: 'object' },
            handler: async (_args, context) => {
                contextSignals.push(context.signal);
                return { content: [{ type: 'text' as const, text: 'ok' }] };
            },
        });
        const request = new AbortController();

        await hostedHandler({}, { signal: request.signal });
        request.abort();

        expect(contextSignals[0]?.aborted).toBe(true);
    });

    it('validates null-prototype enum input and const output as ordinary JSON', async () => {
        const output = Object.assign(Object.create(null) as Record<string, unknown>, {
            nested: [Object.assign(Object.create(null) as Record<string, unknown>, { accepted: true })],
            valueOf: 'result',
            amount: 4,
        });
        const pluginHandler = vi.fn(async () => ({
            content: [{ type: 'text' as const, text: 'ok' }],
            structuredContent: output,
        }));
        const hostedHandler = captureHostedHandler({
            inputSchema: {
                type: 'object',
                required: ['selection'],
                properties: {
                    selection: { enum: [{ valueOf: 'literal', nested: [{ enabled: true }], amount: 4 }] },
                },
                additionalProperties: false,
            },
            outputSchema: {
                type: 'object',
                const: { valueOf: 'result', nested: [{ accepted: true }], amount: 4 },
            },
            handler: pluginHandler,
        });
        const selection = Object.assign(Object.create(null) as Record<string, unknown>, {
            amount: 4,
            nested: [Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true })],
            valueOf: 'literal',
        });
        const input = Object.assign(Object.create(null) as Record<string, unknown>, { selection });

        const result = await hostedHandler(input);

        expect(result).toEqual(expect.objectContaining({
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: output,
        }));
        expect(pluginHandler).toHaveBeenCalledOnce();
    });

    it('returns invalid input without invoking an accessor-backed valueOf', async () => {
        let accessorReads = 0;
        const selection = { enabled: true } as Record<string, unknown>;
        Object.defineProperty(selection, 'valueOf', {
            enumerable: true,
            get() {
                accessorReads += 1;
                throw new Error('accessor must not execute');
            },
        });
        const pluginHandler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'unexpected' }] }));
        const hostedHandler = captureHostedHandler({
            inputSchema: {
                type: 'object',
                required: ['selection'],
                properties: { selection: { enum: [{ valueOf: 'literal', enabled: true }] } },
                additionalProperties: false,
            },
            handler: pluginHandler,
        });

        const result = await hostedHandler({ selection });

        expect(result).toEqual(expect.objectContaining({
            isError: true,
            content: [{ type: 'text', text: 'Invalid MCP tool input' }],
        }));
        expect(accessorReads).toBe(0);
        expect(pluginHandler).not.toHaveBeenCalled();
    });

    it('rejects accessor-backed JSON schemas without invoking schema accessors', async () => {
        let accessorReads = 0;
        const inputSchema: Record<string, unknown> = { type: 'object' };
        Object.defineProperty(inputSchema, 'parse', {
            enumerable: true,
            get() {
                accessorReads += 1;
                throw new Error('schema accessor must not execute');
            },
        });
        const pluginHandler = vi.fn(async () => ({
            content: [{ type: 'text' as const, text: 'unexpected' }],
        }));

        const hostedHandler = captureHostedHandler({ inputSchema, handler: pluginHandler });
        const result = await hostedHandler({});

        expect(result).toEqual(expect.objectContaining({
            isError: true,
            content: [{ type: 'text', text: 'Invalid MCP tool input' }],
        }));
        expect(accessorReads).toBe(0);
        expect(pluginHandler).not.toHaveBeenCalled();
    });
});
