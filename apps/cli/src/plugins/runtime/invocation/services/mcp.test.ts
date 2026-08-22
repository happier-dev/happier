import { describe, expect, it, vi } from 'vitest';

import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { McpClient as PluginMcpClient, McpTool as PluginMcpTool } from '@happier-dev/plugin-sdk/mcp';
import type {
    ResolvedMcpDiscoverySourceContribution,
    ResolvedMcpServerContribution,
} from '@/plugins/projection/registry/types';

import {
    createStablePluginMcpHost,
    MAX_STABLE_PLUGIN_MCP_ITEMS,
    type StablePluginMcpDiscoveryRegistration,
    type StablePluginMcpServerRegistration,
} from './mcp';

function server(
    pluginId: string,
    localId: string,
    options: Readonly<{ kind?: 'dynamic' | 'static'; sessionScope?: 'global' | 'session' }> = {},
): ResolvedMcpServerContribution {
    return {
        provenance: 'external', source: { kind: 'path' }, pluginId,
        manifestPath: `/plugins/${pluginId}/plugin.json`,
        daemonEntryPath: `/plugins/${pluginId}/daemon.js`,
        definition: options.kind === 'static'
            ? {
                id: localId, title: `${pluginId} ${localId}`, kind: 'static',
                transport: { kind: 'http', url: 'https://mcp.example.test/' },
                ...(options.sessionScope ? { sessionScope: options.sessionScope } : {}),
            }
            : {
                id: localId, title: `${pluginId} ${localId}`, kind: 'dynamic',
                ...(options.sessionScope ? { sessionScope: options.sessionScope } : {}),
            },
    };
}

function discovery(pluginId: string, localId: string): ResolvedMcpDiscoverySourceContribution {
    return {
        provenance: 'external', source: { kind: 'path' }, pluginId,
        manifestPath: `/plugins/${pluginId}/plugin.json`,
        daemonEntryPath: `/plugins/${pluginId}/daemon.js`,
        definition: { id: localId, title: `${pluginId} ${localId}` },
    };
}

function seed(overrides: Partial<Parameters<ReturnType<typeof createStablePluginMcpHost>['bind']>[0]> = {}) {
    return {
        plugin: { id: 'caller.plugin', version: '1.0.0' },
        contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
        generation: 'generation-7', correlationId: 'correlation-1', surface: 'agent' as const,
        session: { id: 'session-1' }, signal: new AbortController().signal,
        isGenerationCurrent: () => true,
        ...overrides,
    };
}

function runtime(
    qualifiedId: string,
    overrides: Partial<StablePluginMcpServerRegistration> = {},
): StablePluginMcpServerRegistration {
    const tool: PluginMcpTool = { name: 'echo', inputSchema: { type: 'object' } };
    return {
        generation: 'generation-7', qualifiedId, isCurrent: () => true,
        listTools: async () => ({ items: [tool] }),
        callTool: async ({ name, input }) => ({ name, input }),
        listResources: async () => ({ items: [] }),
        listResourceTemplates: async () => ({ items: [] }),
        readResource: async ({ uri }) => ({ contents: [{ uri, text: '' }] }),
        subscribeResource: async () => ({ dispose: async () => {} }),
        listPrompts: async () => ({ items: [] }),
        getPrompt: async () => ({ messages: [] }),
        ...overrides,
    };
}

function connectedClient(overrides: Partial<PluginMcpClient> = {}): PluginMcpClient {
    return Object.freeze({
        listTools: async () => ({ items: [] }),
        callTool: async () => null,
        listResources: async () => ({ items: [] }),
        listResourceTemplates: async () => ({ items: [] }),
        readResource: async (uri: string) => ({ contents: [{ uri, text: '' }] }),
        subscribeResource: async () => ({ dispose: async () => {} }),
        listPrompts: async () => ({ items: [] }),
        getPrompt: async () => ({ messages: [] }),
        dispose: async () => {},
        ...overrides,
    });
}

describe('stable plugin MCP host', () => {
    it('hides an MCP server revoked after binding before activating it for listing', async () => {
        let revoked = false;
        const activateOnDemand = vi.fn(async () => {});
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'tools')],
            discoverySources: [],
            activateOnDemand,
            readServer: () => runtime('acme.one/tools'),
            readDiscoverySource: () => null,
            revalidateFinalPolicy: async (effect) => {
                expect(effect).toMatchObject({
                    operation: 'list',
                    ref: { pluginId: 'acme.one', localId: 'tools' },
                });
                if (revoked) {
                    throw new PluginError({ code: 'plugin_final_policy_denied', message: 'Policy changed' });
                }
            },
        });
        const service = host.bind(seed(), [{
            serverRefs: [{ pluginId: 'acme.one', localId: 'tools' }],
            discoverySourceRefs: [],
            operations: ['listTools'],
        }]);

        await expect(service.list()).resolves.toMatchObject({
            items: [{ ref: { pluginId: 'acme.one', localId: 'tools' } }],
        });
        revoked = true;

        await expect(service.list()).resolves.toEqual({ items: [] });
        expect(activateOnDemand).toHaveBeenCalledTimes(1);
        await host.dispose();
    });

    it('revalidates current policy immediately before every terminal MCP operation', async () => {
        let revoked = false;
        const callTool = vi.fn(async () => ({ ok: true }));
        const revalidateFinalPolicy = vi.fn(async (effect: Readonly<{
            operation: 'list' | 'connect' | 'listTools' | 'callTools' | 'discover';
            ref?: Readonly<{ pluginId: string; localId: string }>;
        }>) => {
            if (revoked) {
                throw new PluginError({ code: 'plugin_final_policy_denied', message: 'Policy changed' });
            }
            expect(effect.ref).toEqual({ pluginId: 'acme.one', localId: 'tools' });
        });
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'tools')],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/tools', { callTool }),
            readDiscoverySource: () => null,
            revalidateFinalPolicy,
        } as Parameters<typeof createStablePluginMcpHost>[0] & Readonly<{
            revalidateFinalPolicy(effect: Readonly<{
                operation: 'list' | 'connect' | 'listTools' | 'callTools' | 'discover';
                ref?: Readonly<{ pluginId: string; localId: string }>;
            }>): Promise<void>;
        }>);

        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'tools' },
            { elicitation: { mode: 'reject' } },
        );
        revoked = true;

        await expect(client.callTool('echo', {})).rejects.toMatchObject({ code: 'plugin_final_policy_denied' });
        expect(callTool).not.toHaveBeenCalled();
        expect(revalidateFinalPolicy).toHaveBeenLastCalledWith({
            seed: expect.objectContaining({ correlationId: 'correlation-1' }),
            operation: 'callTools',
            ref: { pluginId: 'acme.one', localId: 'tools' },
        });
        await client.dispose();
    });

    it('revalidates current policy after a static transport connects and before terminal tool I/O', async () => {
        let revoked = false;
        const callTool = vi.fn(async () => ({ ok: true }));
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'remote', { kind: 'static' })],
            discoverySources: [], activateOnDemand: async () => {},
            readServer: () => null, readDiscoverySource: () => null,
            connectDeclaredTransport: async () => connectedClient({
                listTools: async () => ({ items: [] }), callTool, dispose: async () => {},
            }),
            revalidateFinalPolicy: async (effect) => {
                if (revoked) {
                    throw new PluginError({ code: 'plugin_final_policy_denied', message: 'Policy changed' });
                }
                expect(effect.ref).toEqual({ pluginId: 'acme.one', localId: 'remote' });
            },
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'remote' },
            { elicitation: { mode: 'reject' } },
        );
        revoked = true;

        await expect(client.callTool('echo', {})).rejects.toMatchObject({ code: 'plugin_final_policy_denied' });
        expect(callTool).not.toHaveBeenCalled();
        await client.dispose();
        await host.dispose();
    });

    it('keeps resources and prompts on the connected client and retires active subscriptions', async () => {
        const invocation = new AbortController();
        const subscriptionDispose = vi.fn(async () => {});
        const transportDispose = vi.fn(async () => {});
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'remote', { kind: 'static' })],
            discoverySources: [], activateOnDemand: async () => {},
            readServer: () => null, readDiscoverySource: () => null,
            connectDeclaredTransport: async () => connectedClient({
                listResources: async () => ({ items: [{ uri: 'file:///guide', name: 'guide' }] }),
                listResourceTemplates: async () => ({ items: [{ uriTemplate: 'file:///{path}', name: 'file' }] }),
                readResource: async (uri) => ({ contents: [{ uri, text: 'guide' }] }),
                subscribeResource: async () => ({ dispose: subscriptionDispose }),
                listPrompts: async () => ({ items: [{ name: 'review' }] }),
                getPrompt: async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Review' } }] }),
                dispose: transportDispose,
            }),
        });
        const client = await host.bind(seed({ signal: invocation.signal })).connect(
            { pluginId: 'acme.one', localId: 'remote' },
            { elicitation: { mode: 'reject' } },
        );

        await expect(client.listResources()).resolves.toMatchObject({ items: [{ name: 'guide' }] });
        await expect(client.listResourceTemplates()).resolves.toMatchObject({ items: [{ name: 'file' }] });
        await expect(client.readResource('file:///guide')).resolves.toMatchObject({ contents: [{ text: 'guide' }] });
        await expect(client.listPrompts()).resolves.toMatchObject({ items: [{ name: 'review' }] });
        await expect(client.getPrompt('review')).resolves.toMatchObject({ messages: [{ role: 'user' }] });
        await client.subscribeResource('file:///guide', async () => {});

        invocation.abort();
        await vi.waitFor(() => expect(subscriptionDispose).toHaveBeenCalledOnce());
        expect(transportDispose).toHaveBeenCalledOnce();
        await host.dispose();
    });

    it('rejects malformed dynamic resource and prompt DTOs at the stable client boundary', async () => {
        const publicListener = vi.fn();
        const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'dynamic')],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/dynamic', {
                listResources: async () => ({
                    items: [{ uri: 7, name: 'invalid-resource' }],
                }) as never,
                readResource: async () => ({
                    contents: [{ uri: 'file:///guide', text: 7 }],
                }) as never,
                getPrompt: async () => ({
                    messages: [{ role: 'system', content: { type: 'text', text: 'invalid-role' } }],
                }) as never,
                subscribeResource: async (_request, listener) => {
                    await listener({ uri: 7 } as never);
                    return { dispose: async () => {} };
                },
            }),
            readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'dynamic' },
            { elicitation: { mode: 'reject' } },
        );

        await expect(client.listResources()).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        await expect(client.readResource('file:///guide')).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        await expect(client.getPrompt('review')).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        await client.subscribeResource('file:///guide', publicListener);
        expect(publicListener).not.toHaveBeenCalled();
        expect(emitWarning).toHaveBeenCalledWith(
            'MCP resource subscription listener failed',
            { code: 'HAPPIER_MCP_RESOURCE_LISTENER_FAILED' },
        );

        await client.dispose();
        await host.dispose();
        emitWarning.mockRestore();
    });

    it('keeps public MCP DTO deltas while rejecting unknown nested fields', async () => {
        let includeUnknownField = false;
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'dynamic')],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/dynamic', {
                listResources: async () => ({
                    items: [{
                        uri: 'file:///guide',
                        name: 'guide',
                        annotations: {
                            priority: 2,
                            lastModified: 'recently',
                            ...(includeUnknownField ? { unsupported: true } : {}),
                        },
                        _meta: 'resource-meta',
                    }],
                    _meta: ['page-meta'],
                }),
                readResource: async () => ({
                    contents: [{ uri: 'file:///guide', blob: 'opaque-not-base64', _meta: null }],
                }),
                getPrompt: async () => ({
                    messages: [{
                        role: 'assistant',
                        content: {
                            type: 'image',
                            data: 'opaque-not-base64',
                            mimeType: 'image/test',
                            annotations: { priority: -1, lastModified: 'unknown' },
                            _meta: ['content-meta'],
                        },
                    }],
                    _meta: 'prompt-meta',
                }),
            }),
            readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'dynamic' },
            { elicitation: { mode: 'reject' } },
        );

        await expect(client.listResources()).resolves.toMatchObject({
            items: [{ annotations: { priority: 2, lastModified: 'recently' }, _meta: 'resource-meta' }],
            _meta: ['page-meta'],
        });
        await expect(client.readResource('file:///guide')).resolves.toMatchObject({
            contents: [{ blob: 'opaque-not-base64', _meta: null }],
        });
        await expect(client.getPrompt('review')).resolves.toMatchObject({
            messages: [{ content: { data: 'opaque-not-base64', _meta: ['content-meta'] } }],
            _meta: 'prompt-meta',
        });

        includeUnknownField = true;
        await expect(client.listResources()).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        await client.dispose();
        await host.dispose();
    });

    it('disposes a resource subscription when its caller signal aborts', async () => {
        const subscriptionDispose = vi.fn(async () => {});
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'remote', { kind: 'static' })],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => null,
            readDiscoverySource: () => null,
            connectDeclaredTransport: async () => connectedClient({
                subscribeResource: async () => ({ dispose: subscriptionDispose }),
            }),
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'remote' },
            { elicitation: { mode: 'reject' } },
        );
        const caller = new AbortController();

        await client.subscribeResource('file:///guide', async () => {}, { signal: caller.signal });
        caller.abort();

        await vi.waitFor(() => expect(subscriptionDispose).toHaveBeenCalledOnce());
        await client.dispose();
        await host.dispose();
        expect(subscriptionDispose).toHaveBeenCalledOnce();
    });

    it('rejects a dynamic resource result when its registration retires before settlement', async () => {
        let registrationCurrent = true;
        let releaseResult!: () => void;
        const waitForResult = new Promise<void>((resolve) => { releaseResult = resolve; });
        const listResources = vi.fn(async () => {
            await waitForResult;
            return { items: [{ uri: 'file:///guide', name: 'guide' }] };
        });
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'dynamic')],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/dynamic', {
                isCurrent: () => registrationCurrent,
                listResources,
            }),
            readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'dynamic' },
            { elicitation: { mode: 'reject' } },
        );

        const result = client.listResources();
        await vi.waitFor(() => expect(listResources).toHaveBeenCalledOnce());
        registrationCurrent = false;
        releaseResult();

        await expect(result).rejects.toMatchObject({ code: 'plugin_mcp_registration_stale' });
        await client.dispose();
        await host.dispose();
    });

    it('disposes a stale dynamic subscription and blocks its late events', async () => {
        let registrationCurrent = true;
        let emitUpdate!: (event: { uri: string }) => void | Promise<void>;
        const subscriptionDispose = vi.fn(async () => {});
        const publicListener = vi.fn();
        const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'dynamic')],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/dynamic', {
                isCurrent: () => registrationCurrent,
                subscribeResource: async (_request, listener) => {
                    emitUpdate = listener;
                    return { dispose: subscriptionDispose };
                },
            }),
            readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'dynamic' },
            { elicitation: { mode: 'reject' } },
        );
        const subscription = await client.subscribeResource('file:///guide', publicListener);

        registrationCurrent = false;
        await emitUpdate({ uri: 'file:///guide' });

        expect(publicListener).not.toHaveBeenCalled();
        expect(subscriptionDispose).toHaveBeenCalledOnce();
        await subscription.dispose();
        await client.dispose();
        await host.dispose();
        expect(subscriptionDispose).toHaveBeenCalledOnce();
        emitWarning.mockRestore();
    });

    it('settles every dynamic subscription cleanup once when one dispose throws synchronously', async () => {
        let registrationCurrent = true;
        let emitUpdate!: (event: { uri: string }) => void | Promise<void>;
        let releaseRemainingCleanup!: () => void;
        const remainingCleanup = new Promise<void>((resolve) => { releaseRemainingCleanup = resolve; });
        const throwingDispose = vi.fn(() => { throw new Error('subscription cleanup failed'); });
        const remainingDispose = vi.fn(async () => { await remainingCleanup; });
        const publicListener = vi.fn();
        const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
        let subscriptionIndex = 0;
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'dynamic')],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/dynamic', {
                isCurrent: () => registrationCurrent,
                subscribeResource: async (_request, listener) => {
                    subscriptionIndex += 1;
                    if (subscriptionIndex === 1) {
                        emitUpdate = listener;
                        return { dispose: throwingDispose };
                    }
                    return { dispose: remainingDispose };
                },
            }),
            readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'dynamic' },
            { elicitation: { mode: 'reject' } },
        );
        const throwingSubscription = await client.subscribeResource('file:///first', publicListener);
        await client.subscribeResource('file:///second', async () => {});
        registrationCurrent = false;

        const disposalResult = Promise.resolve(client.dispose()).then(
            () => ({ error: null }),
            (error: unknown) => ({ error }),
        );
        await vi.waitFor(() => {
            expect(throwingDispose).toHaveBeenCalledOnce();
            expect(remainingDispose).toHaveBeenCalledOnce();
        });
        let disposalSettled = false;
        void disposalResult.then(() => { disposalSettled = true; });
        await Promise.resolve();
        expect(disposalSettled).toBe(false);

        releaseRemainingCleanup();
        await expect(disposalResult).resolves.toMatchObject({
            error: expect.objectContaining({ message: 'subscription cleanup failed' }),
        });
        await expect(Promise.resolve().then(() => throwingSubscription.dispose()))
            .rejects.toThrow('subscription cleanup failed');
        await emitUpdate({ uri: 'file:///first' });

        expect(publicListener).not.toHaveBeenCalled();
        expect(throwingDispose).toHaveBeenCalledOnce();
        expect(remainingDispose).toHaveBeenCalledOnce();
        expect(emitWarning).toHaveBeenCalledWith(
            'MCP resource subscription listener failed',
            { code: 'HAPPIER_MCP_RESOURCE_LISTENER_FAILED' },
        );
        await expect(host.dispose()).rejects.toBeInstanceOf(AggregateError);
        emitWarning.mockRestore();
    });

    it('disposes a dynamic subscription acquired after its registration retires', async () => {
        let registrationCurrent = true;
        const subscriptionDispose = vi.fn(async () => {});
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'dynamic')],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/dynamic', {
                isCurrent: () => registrationCurrent,
                subscribeResource: async () => {
                    registrationCurrent = false;
                    return { dispose: subscriptionDispose };
                },
            }),
            readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'dynamic' },
            { elicitation: { mode: 'reject' } },
        );

        await expect(client.subscribeResource('file:///guide', async () => {}))
            .rejects.toMatchObject({ code: 'plugin_mcp_registration_stale' });

        expect(subscriptionDispose).toHaveBeenCalledOnce();
        await client.dispose();
        await host.dispose();
        expect(subscriptionDispose).toHaveBeenCalledOnce();
    });

    it('does not expose an inline subscription retired by final policy before its disposable is returned', async () => {
        let policyDenied = false;
        const subscriptionState: {
            transportListener: ((event: Readonly<{ uri: string }>) => void | Promise<void>) | null;
            exposedSubscription: Disposable | null;
        } = {
            transportListener: null,
            exposedSubscription: null,
        };
        const subscriptionDispose = vi.fn(async () => {});
        const publicListener = vi.fn();
        const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'dynamic')],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/dynamic', {
                subscribeResource: async (_request, listener) => {
                    policyDenied = true;
                    subscriptionState.transportListener = listener;
                    await listener({ uri: 'file:///guide' });
                    return { dispose: subscriptionDispose };
                },
            }),
            readDiscoverySource: () => null,
            revalidateFinalPolicy: async () => {
                if (policyDenied) {
                    throw new PluginError({ code: 'plugin_final_policy_denied', message: 'Policy changed' });
                }
            },
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'dynamic' },
            { elicitation: { mode: 'reject' } },
        );
        const subscribe = client.subscribeResource('file:///guide', publicListener).then((subscription) => {
            subscriptionState.exposedSubscription = subscription;
            return subscription;
        });

        try {
            await expect(subscribe).rejects.toMatchObject({ code: 'plugin_final_policy_denied' });
            expect(subscriptionState.exposedSubscription).toBeNull();
            expect(subscriptionDispose).toHaveBeenCalledOnce();
            expect(publicListener).not.toHaveBeenCalled();

            policyDenied = false;
            if (subscriptionState.transportListener === null) {
                throw new Error('Expected inline transport listener');
            }
            await subscriptionState.transportListener({ uri: 'file:///guide' });

            expect(publicListener).not.toHaveBeenCalled();
            expect(subscriptionDispose).toHaveBeenCalledOnce();
        } finally {
            await subscriptionState.exposedSubscription?.dispose();
            await client.dispose();
            await host.dispose();
            emitWarning.mockRestore();
        }
    });

    it('constrains a bound service to the selected server refs and operations', async () => {
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'selected'), server('acme.two', 'hidden')],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: (ref) => runtime(`${ref.pluginId}/${ref.localId}`),
            readDiscoverySource: () => null,
        });
        const service = host.bind(seed(), [{
            serverRefs: [{ pluginId: 'acme.one', localId: 'selected' }],
            discoverySourceRefs: [],
            operations: ['listTools'],
        }]);

        await expect(service.list()).resolves.toMatchObject({
            items: [{ ref: { pluginId: 'acme.one', localId: 'selected' } }],
        });
        const client = await service.connect(
            { pluginId: 'acme.one', localId: 'selected' },
            { elicitation: { mode: 'reject' } },
        );
        await expect(client.listTools()).resolves.toMatchObject({ items: [{ name: 'echo' }] });
        await expect(client.callTool('echo', {})).rejects.toMatchObject({ code: 'plugin_mcp_access_denied' });
        await expect(service.connect(
            { pluginId: 'acme.two', localId: 'hidden' },
            { elicitation: { mode: 'reject' } },
        )).rejects.toMatchObject({ code: 'plugin_mcp_access_denied' });

        await client.dispose();
        await host.dispose();
    });

    it('demands and re-reads the exact qualified dynamic server before connecting', async () => {
        const demands: string[] = [];
        const registrations = new Map<string, StablePluginMcpServerRegistration>();
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'tools'), server('acme.two', 'tools')],
            discoverySources: [],
            async activateOnDemand(ref, family) {
                demands.push(`${ref.pluginId}/${family}/${ref.localId}`);
                if (ref.pluginId === 'acme.two') registrations.set('acme.two/tools', runtime('acme.two/tools'));
            },
            readServer(ref) { return registrations.get(`${ref.pluginId}/${ref.localId}`) ?? null; },
            readDiscoverySource: () => null,
        });

        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.two', localId: 'tools' },
            { elicitation: { mode: 'reject' } },
        );
        await expect(client.callTool('echo', { value: 1 })).resolves.toEqual({
            name: 'echo', input: { value: 1 },
        });
        expect(demands).toEqual(['acme.two/mcp.servers/tools']);
        await expect(host.bind(seed()).connect(
            { pluginId: 'missing.plugin', localId: 'tools' },
            { elicitation: { mode: 'reject' } },
        )).rejects.toMatchObject({ code: 'plugin_mcp_server_undeclared' });
        await client.dispose();
    });

    it('lists bounded declared summaries with honest dynamic and transport availability', async () => {
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'dynamic'), server('acme.one', 'remote', { kind: 'static' })],
            discoverySources: [], activateOnDemand: async () => {},
            readServer: (ref) => ref.localId === 'dynamic' ? runtime('acme.one/dynamic') : null,
            readDiscoverySource: () => null,
        });

        await expect(host.bind(seed()).list({ limit: MAX_STABLE_PLUGIN_MCP_ITEMS })).resolves.toEqual({
            items: [
                { ref: { pluginId: 'acme.one', localId: 'dynamic' }, title: 'acme.one dynamic', state: 'available' },
                { ref: { pluginId: 'acme.one', localId: 'remote' }, title: 'acme.one remote', state: 'unavailable', code: 'plugin_mcp_transport_unavailable' },
            ],
        });
        await expect(host.bind(seed()).list({ limit: MAX_STABLE_PLUGIN_MCP_ITEMS + 1 }))
            .rejects.toMatchObject({ code: 'plugin_mcp_limit_invalid' });
        const firstPage = await host.bind(seed()).list({ limit: 1 });
        expect(firstPage).toMatchObject({
            items: [{ ref: { pluginId: 'acme.one', localId: 'dynamic' } }],
        });
        expect(firstPage.nextCursor).toBeTypeOf('string');
        const pagingService = host.bind(seed());
        const pagingFirstPage = await pagingService.list({ limit: 1 });
        await expect(pagingService.list({ cursor: pagingFirstPage.nextCursor, limit: 1 })).resolves.toEqual({
            items: [{
                ref: { pluginId: 'acme.one', localId: 'remote' }, title: 'acme.one remote',
                state: 'unavailable', code: 'plugin_mcp_transport_unavailable',
            }],
        });
    });

    it('keeps unsupported declared transports unavailable even when another static connector exists', async () => {
        const connectDeclaredTransport = vi.fn(async (): Promise<PluginMcpClient> => connectedClient({
            listTools: async () => ({ items: [] }),
            callTool: async () => null,
            dispose: async () => {},
        }));
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'remote', { kind: 'static' })],
            discoverySources: [], activateOnDemand: async () => {},
            readServer: () => null, readDiscoverySource: () => null,
            connectDeclaredTransport,
            isDeclaredTransportAvailable: () => false,
        });
        const service = host.bind(seed());

        await expect(service.list()).resolves.toEqual({
            items: [{
                ref: { pluginId: 'acme.one', localId: 'remote' },
                title: 'acme.one remote', state: 'unavailable', code: 'plugin_mcp_transport_unavailable',
            }],
        });
        await expect(service.connect(
            { pluginId: 'acme.one', localId: 'remote' },
            { elicitation: { mode: 'reject' } },
        )).rejects.toMatchObject({ code: 'plugin_mcp_transport_unavailable' });
        expect(connectDeclaredTransport).not.toHaveBeenCalled();
        await host.dispose();
    });

    it('keeps session-scoped servers and host-mediated elicitation on one exact session', async () => {
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'session-tools', { sessionScope: 'session' })],
            discoverySources: [], activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/session-tools'), readDiscoverySource: () => null,
        });
        const service = host.bind(seed());

        await expect(service.connect(
            { pluginId: 'acme.one', localId: 'session-tools' },
            { sessionId: 'session-2', elicitation: { mode: 'reject' } },
        )).rejects.toMatchObject({ code: 'plugin_mcp_session_mismatch' });
        await expect(service.connect(
            { pluginId: 'acme.one', localId: 'session-tools' },
            { sessionId: 'session-1', elicitation: { mode: 'hostMediated', sessionId: 'session-2' } },
        )).rejects.toMatchObject({ code: 'plugin_mcp_session_mismatch' });
        const client = await service.connect(
            { pluginId: 'acme.one', localId: 'session-tools' },
            { sessionId: 'session-1', elicitation: { mode: 'hostMediated', sessionId: 'session-1' } },
        );
        await expect(client.listTools()).resolves.toMatchObject({ items: [{ name: 'echo' }] });
        await client.dispose();
    });

    it('bounds tool catalogs, call input, and call output as strict plain JSON', async () => {
        const tooManyTools: readonly PluginMcpTool[] = Array.from(
            { length: MAX_STABLE_PLUGIN_MCP_ITEMS + 1 },
            (_, index) => ({
                name: `tool-${index}`, inputSchema: { type: 'object' },
            }),
        );
        let registration = runtime('acme.one/tools', {
            listTools: async (_request) => ({ items: tooManyTools }),
        });
        const host = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'tools')], discoverySources: [],
            activateOnDemand: async () => {}, readServer: () => registration, readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'tools' }, { elicitation: { mode: 'reject' } },
        );

        await expect(client.listTools()).rejects.toMatchObject({ code: 'plugin_mcp_result_limit_exceeded' });
        registration = runtime('acme.one/tools', { callTool: async () => new Date() as never });
        const invalidResultClient = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'tools' }, { elicitation: { mode: 'reject' } },
        );
        await expect(invalidResultClient.callTool('echo', {})).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        await expect(client.callTool('echo', cyclic as never)).rejects.toMatchObject({ code: 'plugin_mcp_input_invalid' });
        await invalidResultClient.dispose();
        await client.dispose();
    });

    it('uses the existing discovery demand owner and host-qualifies untrusted results', async () => {
        const demands: string[] = [];
        let activated = false;
        let registration: StablePluginMcpDiscoveryRegistration | null = null;
        const host = createStablePluginMcpHost({
            generation: 'generation-7', servers: [], discoverySources: [discovery('acme.one', 'detector')],
            async activateOnDemand(ref, family) {
                activated = true;
                demands.push(`${ref.pluginId}/${family}/${ref.localId}`);
                registration = {
                    generation: 'generation-7', qualifiedId: 'acme.one/detector', isCurrent: () => true,
                    discover: async () => ({
                        items: [{
                            source: { pluginId: 'spoofed.plugin', localId: 'other' },
                            discoveryId: 'found-1', title: 'Found server', metadata: { safe: true },
                        }],
                    }),
                };
            },
            readServer: () => null,
            readDiscoverySource: () => registration,
            revalidateFinalPolicy: async () => {
                if (!activated) throw new Error('Discovery policy must run after demand activation');
            },
        });

        await expect(host.bind(seed()).discover(
            { pluginId: 'acme.one', localId: 'detector' },
            { input: { query: 'repo' }, limit: 10 },
        )).resolves.toEqual({
            items: [{
                source: { pluginId: 'acme.one', localId: 'detector' },
                discoveryId: 'found-1', title: 'Found server', metadata: { safe: true },
            }],
        });
        expect(demands).toEqual(['acme.one/mcp.discoverySources/detector']);
    });

    it('keeps MCP server and discovery-source authorization family-specific', async () => {
        const registration: StablePluginMcpDiscoveryRegistration = {
            generation: 'generation-7',
            qualifiedId: 'acme.one/detector',
            isCurrent: () => true,
            discover: async () => ({ items: [] }),
        };
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'tools')],
            discoverySources: [discovery('acme.one', 'detector')],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/tools'),
            readDiscoverySource: () => registration,
        });
        const detector = { pluginId: 'acme.one', localId: 'detector' } as const;
        const tools = { pluginId: 'acme.one', localId: 'tools' } as const;

        const wrongFamilyCases = [{
            name: 'a server reference cannot authorize discovery',
            authorization: [{
                serverRefs: [detector],
                discoverySourceRefs: [],
                operations: ['discover' as const],
            }],
            invoke: (service: ReturnType<typeof host.bind>) => service.discover(detector),
        }, {
            name: 'a discovery-source reference cannot authorize a concrete server',
            authorization: [{
                serverRefs: [],
                discoverySourceRefs: [tools],
                operations: ['listTools' as const],
            }],
            invoke: (service: ReturnType<typeof host.bind>) => service.connect(
                tools,
                { elicitation: { mode: 'reject' as const } },
            ),
        }] as const;
        for (const testCase of wrongFamilyCases) {
            const wrongFamilyService = host.bind(seed(), testCase.authorization);
            await expect(testCase.invoke(wrongFamilyService), testCase.name)
                .rejects.toMatchObject({ code: 'plugin_mcp_access_denied' });
        }

        const service = host.bind(seed(), [{
            serverRefs: [tools],
            discoverySourceRefs: [detector],
            operations: ['listTools', 'discover'],
        }]);
        await expect(service.discover(detector)).resolves.toEqual({ items: [] });
        const client = await service.connect(tools, { elicitation: { mode: 'reject' } });
        await expect(client.listTools()).resolves.toMatchObject({ items: [{ name: 'echo' }] });
        await client.dispose();
        await host.dispose();
    });

    it('fences cancellation, client disposal, generation retirement, and transport cleanup', async () => {
        let releaseCall!: () => void;
        const waiting = new Promise<void>((resolve) => { releaseCall = resolve; });
        const transportDispose = vi.fn(async () => {});
        const transportClient: PluginMcpClient = connectedClient({
            listTools: async () => ({ items: [] }),
            callTool: async () => { await waiting; return { ok: true }; },
            dispose: transportDispose,
        });
        let generationCurrent = true;
        const host = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'remote', { kind: 'static' })], discoverySources: [],
            activateOnDemand: async () => {}, readServer: () => null, readDiscoverySource: () => null,
            connectDeclaredTransport: async () => transportClient,
        });
        const service = host.bind(seed({ isGenerationCurrent: () => generationCurrent }));
        const client = await service.connect(
            { pluginId: 'acme.one', localId: 'remote' }, { elicitation: { mode: 'reject' } },
        );
        const abort = new AbortController();
        const call = client.callTool('wait', {}, { signal: abort.signal });
        abort.abort();
        await expect(call).rejects.toMatchObject({ code: 'plugin_mcp_aborted' });
        releaseCall();
        await client.dispose();
        await expect(client.listTools()).rejects.toMatchObject({ code: 'plugin_mcp_client_disposed' });
        expect(transportDispose).toHaveBeenCalledTimes(1);

        generationCurrent = false;
        await expect(service.list()).rejects.toMatchObject({ code: 'plugin_mcp_generation_retired' });
        await expect(host.dispose()).resolves.toBeUndefined();
        await expect(host.dispose()).resolves.toBeUndefined();
        expect(transportDispose).toHaveBeenCalledTimes(1);
    });

    it('disposes a session-scoped transport exactly once when the bound session ends', async () => {
        const session = new AbortController();
        const transportDispose = vi.fn(async () => {});
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'remote', { kind: 'static', sessionScope: 'session' })],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => null,
            readDiscoverySource: () => null,
            connectDeclaredTransport: async () => connectedClient({
                listTools: async () => ({ items: [] }),
                callTool: async () => null,
                dispose: transportDispose,
            }),
        });
        const client = await host.bind(seed({ signal: session.signal })).connect(
            { pluginId: 'acme.one', localId: 'remote' },
            { sessionId: 'session-1', elicitation: { mode: 'reject' } },
        );

        session.abort();

        await vi.waitFor(() => expect(transportDispose).toHaveBeenCalledOnce());
        await client.dispose();
        await host.dispose();
        expect(transportDispose).toHaveBeenCalledTimes(1);
    });

    it('removes the session abort listener when registry teardown disposes the client first', async () => {
        const session = new AbortController();
        const addEventListener = vi.spyOn(session.signal, 'addEventListener');
        const removeEventListener = vi.spyOn(session.signal, 'removeEventListener');
        const transportDispose = vi.fn(async () => {});
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'remote', { kind: 'static', sessionScope: 'session' })],
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => null,
            readDiscoverySource: () => null,
            connectDeclaredTransport: async () => connectedClient({
                listTools: async () => ({ items: [] }),
                callTool: async () => null,
                dispose: transportDispose,
            }),
        });
        const client = await host.bind(seed({ signal: session.signal })).connect(
            { pluginId: 'acme.one', localId: 'remote' },
            { sessionId: 'session-1', elicitation: { mode: 'reject' } },
        );
        const abortListener = addEventListener.mock.calls.find(([event]) => event === 'abort')?.[1];

        await host.dispose();

        expect(abortListener).toBeTypeOf('function');
        expect(removeEventListener).toHaveBeenCalledWith('abort', abortListener);
        session.abort();
        await client.dispose();
        expect(transportDispose).toHaveBeenCalledTimes(1);
    });

    it('rejects strict-data accessors without invoking them and removes undeclared discovery authority', async () => {
        let accessorReads = 0;
        const accessorResult = Object.defineProperty({}, 'secret', {
            enumerable: true,
            get() {
                accessorReads += 1;
                return 'must-not-be-read';
            },
        });
        const injectedDiscovery = {
            source: { pluginId: 'spoofed.plugin', localId: 'other' },
            discoveryId: 'found-1',
            title: 'Found server',
            accountId: 'account-secret',
            workspaceId: 'workspace-secret',
            directory: '/secret/path',
        };
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'tools')],
            discoverySources: [discovery('acme.one', 'detector')],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/tools', {
                // Hostile plugin boundary fixture intentionally violates JsonValue.
                callTool: async () => accessorResult as never,
            }),
            readDiscoverySource: () => ({
                generation: 'generation-7', qualifiedId: 'acme.one/detector', isCurrent: () => true,
                discover: async () => ({ items: [injectedDiscovery] }),
            }),
        });
        const service = host.bind(seed());
        const client = await service.connect(
            { pluginId: 'acme.one', localId: 'tools' }, { elicitation: { mode: 'reject' } },
        );

        await expect(client.callTool('echo', {})).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        expect(accessorReads).toBe(0);
        await expect(service.discover({ pluginId: 'acme.one', localId: 'detector' })).resolves.toEqual({
            items: [{
                source: { pluginId: 'acme.one', localId: 'detector' },
                discoveryId: 'found-1',
                title: 'Found server',
            }],
        });
        await client.dispose();
    });

    it('rejects accessor-bearing peer envelopes before reading their fields', async () => {
        let accessorReads = 0;
        const accessorEnvelope = Object.defineProperty({}, 'items', {
            enumerable: true,
            get() {
                accessorReads += 1;
                return [];
            },
        });
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'tools')],
            discoverySources: [discovery('acme.one', 'detector')],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/tools', {
                listTools: async () => accessorEnvelope as never,
            }),
            readDiscoverySource: () => ({
                generation: 'generation-7', qualifiedId: 'acme.one/detector', isCurrent: () => true,
                discover: async () => accessorEnvelope as never,
            }),
        });
        const service = host.bind(seed());
        const client = await service.connect(
            { pluginId: 'acme.one', localId: 'tools' }, { elicitation: { mode: 'reject' } },
        );

        await expect(client.listTools()).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        await expect(service.discover({ pluginId: 'acme.one', localId: 'detector' }))
            .rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        expect(accessorReads).toBe(0);
        await client.dispose();
    });

    it('rejects over-limit peer collections before inspecting any item', async () => {
        let accessorReads = 0;
        const overLimitItems = Array.from({ length: MAX_STABLE_PLUGIN_MCP_ITEMS + 1 }, (_, index) => {
            if (index < MAX_STABLE_PLUGIN_MCP_ITEMS) {
                return { name: `tool-${index}`, inputSchema: { type: 'object' } };
            }
            return Object.defineProperty({}, 'name', {
                enumerable: true,
                get() {
                    accessorReads += 1;
                    return 'must-not-be-read';
                },
            });
        });
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'tools')],
            discoverySources: [discovery('acme.one', 'detector')],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/tools', {
                listTools: async () => ({ items: overLimitItems }) as never,
            }),
            readDiscoverySource: () => ({
                generation: 'generation-7', qualifiedId: 'acme.one/detector', isCurrent: () => true,
                discover: async () => ({ items: overLimitItems }) as never,
            }),
        });
        const service = host.bind(seed());
        const client = await service.connect(
            { pluginId: 'acme.one', localId: 'tools' }, { elicitation: { mode: 'reject' } },
        );

        await expect(client.listTools()).rejects.toMatchObject({ code: 'plugin_mcp_result_limit_exceeded' });
        await expect(service.discover({ pluginId: 'acme.one', localId: 'detector' }))
            .rejects.toMatchObject({ code: 'plugin_mcp_result_limit_exceeded' });
        expect(accessorReads).toBe(0);
        await client.dispose();
    });

    it('enforces aggregate result bytes at the exact boundary while accepting valid deep JSON', async () => {
        const resultByteLimit = 1024 * 1024;
        const resultForPayload = (payloadLength: number): Readonly<{ items: readonly PluginMcpTool[] }> => ({
            items: [{ name: 'echo', inputSchema: { description: 'x'.repeat(payloadLength) } }],
        });
        const emptyBytes = new TextEncoder().encode(JSON.stringify(resultForPayload(0))).byteLength;
        let nextResult = resultForPayload(resultByteLimit - emptyBytes);
        const callTool = vi.fn(async () => ({ ok: true }));
        const host = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'tools')], discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/tools', {
                listTools: async (_request) => nextResult,
                callTool,
            }),
            readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'tools' }, { elicitation: { mode: 'reject' } },
        );

        await expect(client.listTools()).resolves.toMatchObject({ items: [{ name: 'echo' }] });
        nextResult = resultForPayload(resultByteLimit - emptyBytes + 1);
        await expect(client.listTools()).rejects.toMatchObject({ code: 'plugin_mcp_result_limit_exceeded' });

        let deepInput: JsonValue = {};
        for (let depth = 0; depth < 512; depth += 1) deepInput = { value: deepInput };
        await expect(client.callTool('echo', deepInput)).resolves.toEqual({ ok: true });
        expect(callTool).toHaveBeenCalledOnce();
        await client.dispose();
    });

    it('maps symbol and non-enumerable strict-data rejection to the MCP boundary codes', async () => {
        const symbolInput = Object.defineProperty({}, Symbol('hidden'), {
            enumerable: true,
            value: 'must-not-be-dropped',
        });
        const nonEnumerableInput = Object.defineProperty({}, 'hidden', {
            enumerable: false,
            value: 'must-not-be-dropped',
        });
        const symbolResult = Object.defineProperty({ ok: true }, Symbol('hidden'), {
            enumerable: true,
            value: 'must-not-be-dropped',
        });
        const nonEnumerableResult = Object.defineProperty({ ok: true }, 'hidden', {
            enumerable: false,
            value: 'must-not-be-dropped',
        });
        let result: unknown = { ok: true };
        const callTool = vi.fn(async () => result as never);
        const host = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'tools')], discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/tools', { callTool }), readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'tools' }, { elicitation: { mode: 'reject' } },
        );

        await expect(client.callTool('echo', symbolInput as never))
            .rejects.toMatchObject({ code: 'plugin_mcp_input_invalid' });
        await expect(client.callTool('echo', nonEnumerableInput as never))
            .rejects.toMatchObject({ code: 'plugin_mcp_input_invalid' });
        expect(callTool).not.toHaveBeenCalled();

        result = symbolResult;
        await expect(client.callTool('echo', {})).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        result = nonEnumerableResult;
        await expect(client.callTool('echo', {})).rejects.toMatchObject({ code: 'plugin_mcp_result_invalid' });
        await client.dispose();
    });

    it('scopes server, tool, and discovery cursors to the exact bound owner', async () => {
        const tool: PluginMcpTool = { name: 'echo', inputSchema: { type: 'object' } };
        const host = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'one'), server('acme.one', 'two')],
            discoverySources: [discovery('acme.one', 'detector')],
            activateOnDemand: async () => {},
            readServer: (ref) => runtime(`acme.one/${ref.localId}`, {
                listTools: async () => ({ items: [tool], nextCursor: 'peer-tool-cursor' }),
            }),
            readDiscoverySource: () => ({
                generation: 'generation-7', qualifiedId: 'acme.one/detector', isCurrent: () => true,
                discover: async () => ({
                    items: [{
                        source: { pluginId: 'acme.one', localId: 'detector' },
                        discoveryId: 'found-1', title: 'Found server',
                    }],
                    nextCursor: 'peer-discovery-cursor',
                }),
            }),
        });
        const firstService = host.bind(seed());
        const serverPage = await firstService.list({ limit: 1 });
        expect(serverPage.nextCursor).toBeTypeOf('string');
        await expect(firstService.list({ cursor: serverPage.nextCursor, limit: 1 })).resolves.toMatchObject({
            items: [{ ref: { localId: 'two' } }],
        });
        await expect(host.bind(seed()).list({ cursor: serverPage.nextCursor, limit: 1 }))
            .rejects.toMatchObject({ code: 'plugin_mcp_cursor_invalid' });

        const firstClient = await firstService.connect(
            { pluginId: 'acme.one', localId: 'one' }, { elicitation: { mode: 'reject' } },
        );
        const secondClient = await firstService.connect(
            { pluginId: 'acme.one', localId: 'one' }, { elicitation: { mode: 'reject' } },
        );
        const toolPage = await firstClient.listTools();
        await expect(secondClient.listTools({ cursor: toolPage.nextCursor }))
            .rejects.toMatchObject({ code: 'plugin_mcp_cursor_invalid' });

        const discoveryPage = await firstService.discover({ pluginId: 'acme.one', localId: 'detector' });
        await expect(host.bind(seed()).discover(
            { pluginId: 'acme.one', localId: 'detector' },
            { cursor: discoveryPage.nextCursor },
        )).rejects.toMatchObject({ code: 'plugin_mcp_cursor_invalid' });
        await firstClient.dispose();
        await secondClient.dispose();
    });

    it('does not start pre-aborted demand and disposes a transport acquired after caller detachment', async () => {
        const activateOnDemand = vi.fn(async () => {});
        const dynamicHost = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'tools')], discoverySources: [],
            activateOnDemand, readServer: () => runtime('acme.one/tools'), readDiscoverySource: () => null,
        });
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await expect(dynamicHost.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'tools' },
            { elicitation: { mode: 'reject' }, signal: alreadyAborted.signal },
        )).rejects.toMatchObject({ code: 'plugin_mcp_aborted' });
        expect(activateOnDemand).not.toHaveBeenCalled();

        let resolveTransport!: (client: PluginMcpClient) => void;
        const transportPromise = new Promise<PluginMcpClient>((resolve) => { resolveTransport = resolve; });
        const transportDispose = vi.fn(async () => {});
        const staticHost = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'remote', { kind: 'static' })], discoverySources: [],
            activateOnDemand: async () => {}, readServer: () => null, readDiscoverySource: () => null,
            connectDeclaredTransport: async () => await transportPromise,
        });
        const abort = new AbortController();
        const connection = staticHost.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'remote' },
            { elicitation: { mode: 'reject' }, signal: abort.signal },
        );
        abort.abort();
        await expect(connection).rejects.toMatchObject({ code: 'plugin_mcp_aborted' });
        let hostDisposeSettled = false;
        const hostDispose = staticHost.dispose().then(() => { hostDisposeSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(hostDisposeSettled).toBe(false);
        resolveTransport(connectedClient({
            listTools: async () => ({ items: [] }),
            callTool: async () => null,
            dispose: transportDispose,
        }));
        await vi.waitFor(() => expect(transportDispose).toHaveBeenCalledOnce());
        await hostDispose;
    });

    it('redacts peer failures at the stable service boundary', async () => {
        const host = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'tools')], discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => runtime('acme.one/tools', {
                callTool: async () => { throw new Error('token=super-secret'); },
            }),
            readDiscoverySource: () => null,
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'tools' }, { elicitation: { mode: 'reject' } },
        );

        const failure = await client.callTool('echo', {}).catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: 'plugin_mcp_peer_failed' });
        expect(String((failure as Error).message)).not.toContain('super-secret');
        await client.dispose();
    });

    it('preserves the ordinary MCP method-not-found code without exposing remote error text', async () => {
        const remoteError = Object.assign(new Error('authorization=secret'), { code: -32601 });
        const host = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'remote', { kind: 'static' })], discoverySources: [],
            activateOnDemand: async () => {}, readServer: () => null, readDiscoverySource: () => null,
            connectDeclaredTransport: async () => connectedClient({
                listResources: async () => { throw remoteError; },
            }),
        });
        const client = await host.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'remote' }, { elicitation: { mode: 'reject' } },
        );

        const failure = await client.listResources().catch((error: unknown) => error);
        expect(failure).toMatchObject({
            code: 'plugin_mcp_method_not_found',
            details: { mcpCode: -32601 },
        });
        expect(String((failure as Error).message)).not.toContain('secret');
        await client.dispose();
        await host.dispose();
    });

    it('joins repeated client and host disposal and waits all cleanup before aggregate failure', async () => {
        let releaseClient!: () => void;
        const clientWait = new Promise<void>((resolve) => { releaseClient = resolve; });
        const clientDispose = vi.fn(async () => { await clientWait; });
        const clientHost = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'remote', { kind: 'static' })], discoverySources: [],
            activateOnDemand: async () => {}, readServer: () => null, readDiscoverySource: () => null,
            connectDeclaredTransport: async () => connectedClient({
                listTools: async () => ({ items: [] }), callTool: async () => null, dispose: clientDispose,
            }),
        });
        const client = await clientHost.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'remote' }, { elicitation: { mode: 'reject' } },
        );
        const firstClientDispose = Promise.resolve(client.dispose());
        let secondClientDisposeSettled = false;
        const secondClientDispose = Promise.resolve(client.dispose()).then(() => { secondClientDisposeSettled = true; });
        await Promise.resolve();
        expect(secondClientDisposeSettled).toBe(false);
        releaseClient();
        await Promise.all([firstClientDispose, secondClientDispose]);
        expect(clientDispose).toHaveBeenCalledOnce();

        const failedManualHost = createStablePluginMcpHost({
            generation: 'generation-7', servers: [server('acme.one', 'failed', { kind: 'static' })], discoverySources: [],
            activateOnDemand: async () => {}, readServer: () => null, readDiscoverySource: () => null,
            connectDeclaredTransport: async () => connectedClient({
                listTools: async () => ({ items: [] }), callTool: async () => null,
                dispose: async () => { throw new Error('manual cleanup failed'); },
            }),
        });
        const failedManualClient = await failedManualHost.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'failed' }, { elicitation: { mode: 'reject' } },
        );
        await expect(failedManualClient.dispose()).rejects.toThrow('manual cleanup failed');
        await expect(failedManualHost.dispose()).rejects.toBeInstanceOf(AggregateError);

        let releaseSlow!: () => void;
        const slowWait = new Promise<void>((resolve) => { releaseSlow = resolve; });
        let connectionIndex = 0;
        const aggregateHost = createStablePluginMcpHost({
            generation: 'generation-7',
            servers: [server('acme.one', 'first', { kind: 'static' }), server('acme.one', 'second', { kind: 'static' })],
            discoverySources: [], activateOnDemand: async () => {}, readServer: () => null, readDiscoverySource: () => null,
            connectDeclaredTransport: async () => {
                connectionIndex += 1;
                return connectedClient({
                    listTools: async () => ({ items: [] }), callTool: async () => null,
                    dispose: connectionIndex === 1
                        ? async () => { throw new Error('first cleanup failed'); }
                        : async () => { await slowWait; },
                });
            },
        });
        await aggregateHost.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'first' }, { elicitation: { mode: 'reject' } },
        );
        await aggregateHost.bind(seed()).connect(
            { pluginId: 'acme.one', localId: 'second' }, { elicitation: { mode: 'reject' } },
        );
        const firstHostDispose = aggregateHost.dispose();
        let firstHostDisposeSettled = false;
        void firstHostDispose.then(
            () => { firstHostDisposeSettled = true; },
            () => { firstHostDisposeSettled = true; },
        );
        let secondHostDisposeSettled = false;
        const secondHostDispose = aggregateHost.dispose().then(
            () => { secondHostDisposeSettled = true; },
            () => { secondHostDisposeSettled = true; },
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(firstHostDisposeSettled).toBe(false);
        expect(secondHostDisposeSettled).toBe(false);
        releaseSlow();
        await expect(firstHostDispose).rejects.toBeInstanceOf(AggregateError);
        await secondHostDispose;
    });
});
