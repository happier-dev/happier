import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
    capabilities: null as unknown,
    handler: null as null | ((request: unknown, extra?: Readonly<{ signal: AbortSignal }>) => Promise<unknown>),
    close: vi.fn(async () => {}),
    connect: vi.fn(async (_options?: Readonly<{ signal?: AbortSignal }>) => {}),
    transportUrl: null as URL | null,
    stdioOptions: null as Readonly<Record<string, unknown>> | null,
    notificationHandler: null as null | ((notification: Readonly<{ params: Readonly<{ uri: string }> }>) => void | Promise<void>),
    subscribeResource: vi.fn(async () => ({})),
    unsubscribeResource: vi.fn(async () => ({})),
    onclose: null as null | (() => void),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class {
        constructor(_identity: unknown, options: Readonly<{ capabilities: unknown }>) {
            sdk.capabilities = options.capabilities;
        }
        setRequestHandler(
            _schema: unknown,
            handler: (request: unknown, extra?: Readonly<{ signal: AbortSignal }>) => Promise<unknown>,
        ) { sdk.handler = handler; }
        setNotificationHandler(_schema: unknown, handler: typeof sdk.notificationHandler) { sdk.notificationHandler = handler; }
        set onclose(handler: (() => void) | undefined) { sdk.onclose = handler ?? null; }
        async connect(_transport: unknown, options?: Readonly<{ signal?: AbortSignal }>) { await sdk.connect(options); }
        async listTools() {
            return { tools: [{ name: 'confirm', inputSchema: { type: 'object' } }] };
        }
        async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; }
        async listResources() {
            return {
                resources: [{
                    uri: 'file:///guide.md', name: 'guide', title: 'Guide', mimeType: 'text/markdown',
                    annotations: { audience: ['user'], priority: 0.75 }, _meta: { source: 'fixture' },
                }],
                nextCursor: 'resources-next',
            };
        }
        async listResourceTemplates() {
            return {
                resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file', description: 'A file' }],
                nextCursor: 'templates-next',
            };
        }
        async readResource() {
            return {
                contents: [
                    { uri: 'file:///guide.md', mimeType: 'text/markdown', text: '# Guide' },
                    { uri: 'file:///image.png', mimeType: 'image/png', blob: 'aW1hZ2U=' },
                ],
                _meta: { revision: 2 },
            };
        }
        async subscribeResource() { return sdk.subscribeResource(); }
        async unsubscribeResource() { return sdk.unsubscribeResource(); }
        async listPrompts() {
            return {
                prompts: [{ name: 'review', title: 'Review', arguments: [{ name: 'scope', required: true }] }],
                nextCursor: 'prompts-next',
            };
        }
        async getPrompt() {
            return {
                description: 'Rendered review',
                messages: [{
                    role: 'user',
                    content: { type: 'text', text: 'Review src', annotations: { audience: ['assistant'] } },
                }],
            };
        }
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
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({ ElicitRequestSchema: {}, ResourceUpdatedNotificationSchema: {} }));

import type { ResolvedMcpServerContribution } from '@/plugins/projection/registry/types';
import type { HostCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';
import { createStableDeclaredMcpTransportConnector } from './mcpDeclaredTransport';

describe('stable declared MCP transport connector', () => {
    it('consumes a static HTTP declaration and routes form elicitation through the current session owner', async () => {
        const interactions = vi.fn(async () => ({
            requestId: 'interaction-1',
            kind: 'questions' as const,
            status: 'answered' as const,
            answers: {
                approved: {
                    kind: 'singleChoice' as const,
                    answer: { kind: 'choice' as const, choiceId: 'true' },
                },
                retries: { kind: 'text' as const, value: '3' },
                mode: {
                    kind: 'singleChoice' as const,
                    answer: { kind: 'choice' as const, choiceId: 'safe' },
                },
                checks: {
                    kind: 'multipleChoice' as const,
                    answers: [
                        { kind: 'choice' as const, choiceId: 'lint' },
                        { kind: 'choice' as const, choiceId: 'test' },
                    ] as const,
                },
            },
        }));
        const declaration: ResolvedMcpServerContribution = {
            provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.static',
            manifestPath: '/plugins/acme.static/plugin.json', daemonEntryPath: '/plugins/acme.static/daemon.js',
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
                signal: abort.signal,
                readActiveTurnAdmissionWitness: () => ({
                    inputId: 'input-mcp-1',
                    turnId: 'turn-mcp-1',
                    userMessageSeq: 1,
                    userMessageSeqs: [1],
                    causalPermissionAuthority: {
                        kind: 'admittedSessionInputV1' as const,
                        admittedPermissionCeiling: 'read-only' as const,
                    },
                }),
                isGenerationCurrent: () => true,
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
                    properties: {
                        approved: { type: 'boolean', title: 'Approved' },
                        retries: { type: 'integer', title: 'Retry count' },
                        mode: {
                            type: 'string',
                            enum: ['safe', 'fast'],
                            enumNames: ['Safe mode', 'Fast mode'],
                        },
                        checks: {
                            type: 'array',
                            title: 'Checks',
                            items: {
                                anyOf: [
                                    { const: 'lint', title: 'Lint' },
                                    { const: 'test', title: 'Tests' },
                                ],
                            },
                        },
                    },
                    required: ['approved', 'retries', 'mode'],
                },
            },
        })).resolves.toEqual({
            action: 'accept',
            content: {
                approved: true,
                retries: 3,
                mode: 'safe',
                checks: ['lint', 'test'],
            },
        });
        expect(interactions).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'questions',
            title: 'Approve?',
            questions: expect.arrayContaining([
                expect.objectContaining({ id: 'approved', type: 'singleChoice' }),
                expect.objectContaining({ id: 'retries', type: 'text' }),
                expect.objectContaining({
                    id: 'mode',
                    type: 'singleChoice',
                    choices: [
                        { id: 'safe', label: 'Safe mode' },
                        { id: 'fast', label: 'Fast mode' },
                    ],
                }),
                expect.objectContaining({
                    id: 'checks',
                    type: 'multipleChoice',
                    choices: [
                        { id: 'lint', label: 'Lint' },
                        { id: 'test', label: 'Tests' },
                    ],
                }),
            ]),
        }), expect.objectContaining({
            signal: abort.signal,
            permissionContext: expect.objectContaining({
                owner: {
                    kind: 'plugin',
                    pluginId: 'caller.plugin',
                    runtimeId: 'caller.plugin/actions/run',
                },
                turnId: 'turn-mcp-1',
                causalPermissionAuthority: {
                    kind: 'admittedSessionInputV1',
                    admittedPermissionCeiling: 'read-only',
                },
            }),
            requester: {
                pluginId: 'caller.plugin',
                contributionId: 'run',
                generationId: 'generation-1',
                invocationId: 'correlation-1',
            },
        }));
        await client.dispose();
        expect(sdk.close).toHaveBeenCalledTimes(1);
    });

    it('composes seed, connector, and per-request cancellation and fences late elicitation results', async () => {
        const pendingInteractions: Array<() => void> = [];
        let observedRequestSignal: AbortSignal | undefined;
        const interactions = vi.fn(async (
            _request: unknown,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            observedRequestSignal = options?.signal;
            await new Promise<void>((resolve) => { pendingInteractions.push(resolve); });
            return {
                kind: 'questions' as const,
                status: 'answered' as const,
                answers: [{
                    questionId: 'approved', selection: 'single' as const,
                    answer: { kind: 'choice' as const, choiceId: 'true' },
                }],
            };
        });
        const declaration: ResolvedMcpServerContribution = {
            provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.static',
            manifestPath: '/plugins/acme.static/plugin.json', daemonEntryPath: '/plugins/acme.static/daemon.js',
            definition: {
                id: 'remote', title: 'Remote', kind: 'static',
                transport: { kind: 'http', url: 'https://mcp.example.test/' }, sessionScope: 'session',
            },
        };
        const seedAbort = new AbortController();
        const connectorAbort = new AbortController();
        let generationCurrent = true;
        await createStableDeclaredMcpTransportConnector()({
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
                        request: interactions as unknown as HostCurrentSessionInteractionsService['request'],
                    },
                },
                signal: seedAbort.signal,
                isGenerationCurrent: () => generationCurrent,
            },
            signal: connectorAbort.signal,
        });
        const connectSignal = sdk.connect.mock.calls.at(-1)?.[0]?.signal;
        expect(connectSignal).toBeDefined();
        expect(connectSignal).not.toBe(seedAbort.signal);
        expect(connectSignal).not.toBe(connectorAbort.signal);

        const requestAbort = new AbortController();
        const response = sdk.handler?.({
            params: {
                mode: 'form', message: 'Approve?',
                requestedSchema: {
                    type: 'object',
                    properties: { approved: { type: 'boolean', title: 'Approved' } },
                },
            },
        }, { signal: requestAbort.signal });
        await Promise.resolve();
        const requestSignal = observedRequestSignal;
        expect(requestSignal).toBeDefined();
        requestAbort.abort(new Error('peer cancelled'));
        expect(requestSignal?.aborted).toBe(true);
        pendingInteractions.shift()?.();
        await expect(response).resolves.toEqual({ action: 'cancel' });

        const generationResponse = sdk.handler?.({
            params: {
                mode: 'form', message: 'Approve?',
                requestedSchema: {
                    type: 'object',
                    properties: { approved: { type: 'boolean', title: 'Approved' } },
                },
            },
        }, { signal: new AbortController().signal });
        await Promise.resolve();
        generationCurrent = false;
        pendingInteractions.shift()?.();
        await expect(generationResponse).resolves.toEqual({ action: 'cancel' });

        seedAbort.abort(new Error('generation retired'));
        expect(connectSignal?.aborted).toBe(true);
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
            manifestPath: '/plugins/acme.static/plugin.json', daemonEntryPath: '/plugins/acme.static/daemon.js',
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

    it('projects resources and prompts through the connected client and owns subscription cleanup', async () => {
        const declaration: ResolvedMcpServerContribution = {
            provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.static',
            manifestPath: '/plugins/acme.static/plugin.json', daemonEntryPath: '/plugins/acme.static/daemon.js',
            definition: {
                id: 'remote', title: 'Remote', kind: 'static',
                transport: { kind: 'http', url: 'https://mcp.example.test/' },
            },
        };
        const client = await createStableDeclaredMcpTransportConnector()({
            declaration,
            ref: { pluginId: 'acme.static', localId: 'remote' },
            elicitation: { mode: 'reject' },
            seed: {
                plugin: { id: 'caller.plugin', version: '1.0.0' },
                contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
                generation: 'generation-1', correlationId: 'correlation-1', surface: 'agent',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
        });

        await expect(client.listResources()).resolves.toEqual({
            items: [{
                uri: 'file:///guide.md', name: 'guide', title: 'Guide', mimeType: 'text/markdown',
                annotations: { audience: ['user'], priority: 0.75 }, _meta: { source: 'fixture' },
            }],
            nextCursor: 'resources-next',
        });
        await expect(client.listResourceTemplates()).resolves.toEqual({
            items: [{ uriTemplate: 'file:///{path}', name: 'file', description: 'A file' }],
            nextCursor: 'templates-next',
        });
        await expect(client.readResource('file:///guide.md')).resolves.toEqual({
            contents: [
                { uri: 'file:///guide.md', mimeType: 'text/markdown', text: '# Guide' },
                { uri: 'file:///image.png', mimeType: 'image/png', blob: 'aW1hZ2U=' },
            ],
            _meta: { revision: 2 },
        });
        await expect(client.listPrompts()).resolves.toEqual({
            items: [{ name: 'review', title: 'Review', arguments: [{ name: 'scope', required: true }] }],
            nextCursor: 'prompts-next',
        });
        await expect(client.getPrompt('review', { scope: 'src' })).resolves.toEqual({
            description: 'Rendered review',
            messages: [{
                role: 'user',
                content: { type: 'text', text: 'Review src', annotations: { audience: ['assistant'] } },
            }],
        });

        const observed: string[] = [];
        let releaseFirst!: () => void;
        const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const subscription = await client.subscribeResource('file:///guide.md', async ({ uri }) => {
            observed.push(uri);
            if (observed.length === 1) await firstPending;
        });
        expect(sdk.subscribeResource).toHaveBeenCalledOnce();
        const first = Promise.resolve(sdk.notificationHandler?.({ params: { uri: 'file:///guide.md' } }));
        const second = Promise.resolve(sdk.notificationHandler?.({ params: { uri: 'file:///guide.md' } }));
        await Promise.resolve();
        expect(observed).toEqual(['file:///guide.md']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(observed).toEqual(['file:///guide.md', 'file:///guide.md']);

        await subscription.dispose();
        await subscription.dispose();
        expect(sdk.unsubscribeResource).toHaveBeenCalledOnce();
        const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
        const failingSubscription = await client.subscribeResource('file:///guide.md', async () => {
            throw new Error('listener failed');
        });
        await sdk.notificationHandler?.({ params: { uri: 'file:///guide.md' } });
        expect(emitWarning).toHaveBeenCalledWith(expect.any(String), {
            code: 'HAPPIER_MCP_RESOURCE_LISTENER_FAILED',
        });
        await expect(client.listPrompts()).resolves.toMatchObject({ items: [{ name: 'review' }] });
        await failingSubscription.dispose();
        expect(sdk.unsubscribeResource).toHaveBeenCalledTimes(2);
        const remoteClosedSubscription = await client.subscribeResource('file:///guide.md', async () => {});
        sdk.onclose?.();
        await remoteClosedSubscription.dispose();
        expect(sdk.unsubscribeResource).toHaveBeenCalledTimes(2);
        await client.dispose();
        expect(sdk.unsubscribeResource).toHaveBeenCalledTimes(2);
        emitWarning.mockRestore();
    });
});
